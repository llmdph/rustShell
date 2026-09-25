use chrono::{DateTime, Utc};
use filetime::{set_file_mtime, FileTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const LOCAL_TEXT_PREVIEW_LIMIT: u64 = 1024 * 1024;
pub const DIR_ENTRY_LIMIT: usize = 10_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: DateTime<Utc>,
    pub is_dir: bool,
    pub file_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gid: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub entries: Vec<FileEntry>,
    pub incomplete: bool,
    pub limited: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTextFile {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub is_binary: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathStats {
    pub total_size: u64,
    pub file_count: u64,
    pub dir_count: u64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferConflictStrategy {
    Overwrite,
    Skip,
    Rename,
    Resume,
}

impl Default for TransferConflictStrategy {
    fn default() -> Self {
        Self::Overwrite
    }
}

pub fn list_local_dir(path: &str) -> std::io::Result<DirListing> {
    let mut entries = Vec::new();
    let mut truncated = false;
    let dir = Path::new(path);

    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if entries.len() >= DIR_ENTRY_LIMIT {
            truncated = true;
            break;
        }
        entries.push(local_entry_from_path(path, metadata, None));
    }

    sort_entries_by_folded_text(&mut entries, |entry| entry.name.as_str());
    Ok(DirListing { entries, truncated })
}

pub fn search_local(
    root: &str,
    query: &str,
    max_results: usize,
) -> std::io::Result<FileSearchResult> {
    let mut output = Vec::new();
    let mut incomplete = false;
    let mut limited = false;
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(FileSearchResult {
            entries: output,
            incomplete,
            limited,
        });
    }
    search_local_recursive(
        Path::new(root),
        &needle,
        max_results.clamp(1, 1000),
        &mut output,
        &mut incomplete,
        &mut limited,
    )?;
    sort_entries_by_folded_text(&mut output, |entry| entry.name.as_str());
    Ok(FileSearchResult {
        entries: output,
        incomplete,
        limited,
    })
}

/// Directories first, then case-insensitive text. The folded text is built
/// once; sorting by a fresh lowercase copy on every comparison is much slower
/// on a large folder.
pub(crate) fn sort_entries_by_folded_text(entries: &mut Vec<FileEntry>, text: impl Fn(&FileEntry) -> &str) {
    let mut decorated = Vec::with_capacity(entries.len());
    for entry in entries.drain(..) {
        let rank = !entry.is_dir;
        let folded = text(&entry).to_lowercase();
        decorated.push((rank, folded, entry));
    }
    decorated.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    entries.extend(decorated.into_iter().map(|(_, _, entry)| entry));
}

pub fn local_home() -> String {
    directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().display().to_string())
        .unwrap_or_else(|| ".".to_owned())
}

pub fn local_parent(path: &str) -> Option<String> {
    if unc_without_share(path) {
        return None;
    }
    Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.display().to_string())
}

fn unc_without_share(path: &str) -> bool {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    let Some(rest) = trimmed
        .strip_prefix("\\\\")
        .or_else(|| trimmed.strip_prefix("//"))
    else {
        return false;
    };
    !rest.is_empty() && !rest.contains('\\') && !rest.contains('/')
}

pub fn local_mkdir(parent: &str, name: &str) -> std::io::Result<()> {
    let path = prepare_local_create_path(parent, name)?;
    fs::create_dir(path)
}

pub fn local_create_file(parent: &str, name: &str) -> std::io::Result<String> {
    let path = prepare_local_create_path(parent, name)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    Ok(path.display().to_string())
}

pub fn local_create_symlink(parent: &str, name: &str, target: &str) -> std::io::Result<String> {
    if target.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "链接目标不能为空",
        ));
    }
    let link_path = prepare_local_create_path(parent, name)?;
    create_local_symlink(Path::new(target), &link_path)?;
    Ok(link_path.display().to_string())
}

fn prepare_local_create_path(parent: &str, relative: &str) -> std::io::Result<PathBuf> {
    let segments = validate_relative_dir_path(relative)?;
    let mut current = PathBuf::from(parent);
    if !current.as_os_str().is_empty() && fs::symlink_metadata(&current).is_err() {
        fs::create_dir_all(&current)?;
    }
    for (index, segment) in segments.iter().enumerate() {
        current.push(segment);
        let is_leaf = index + 1 == segments.len();
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if local_path_is_link(&current, &metadata) {
                    if is_leaf {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::AlreadyExists,
                            "目标已存在",
                        ));
                    }
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "路径经过链接，没有在链接指向的位置新建",
                    ));
                }
                if is_leaf || !metadata.is_dir() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::AlreadyExists,
                        "目标已存在",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !is_leaf {
                    fs::create_dir(&current)?;
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(current)
}

pub fn local_remove(path: &str, is_dir: bool) -> std::io::Result<()> {
    let target = Path::new(path);
    if let Ok(metadata) = fs::symlink_metadata(target) {
        if local_path_is_link(target, &metadata) {
            return remove_local_link(target);
        }
    }
    if is_dir {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn remove_local_link(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) => fs::remove_dir(path).or(Err(error)),
    }
}

pub fn local_duplicate(path: &str, new_name: &str) -> std::io::Result<String> {
    validate_file_name(new_name)?;
    let source = PathBuf::from(path);
    let target = source
        .parent()
        .map(|parent| parent.join(new_name))
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "无法确定父目录"))?;
    if local_path_exists(&target) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "目标已存在",
        ));
    }

    let metadata = fs::symlink_metadata(&source)?;
    if local_path_is_link(&source, &metadata) {
        copy_local_symlink(&source, &target)?;
    } else if metadata.is_dir() {
        copy_dir_recursive(&source, &target)?;
    } else {
        fs::copy(&source, &target)?;
        preserve_local_metadata(&target, &metadata)?;
    }
    Ok(target.display().to_string())
}

pub fn local_move(path: &str, target_path: &str) -> std::io::Result<String> {
    let source = PathBuf::from(path);
    let mut target = PathBuf::from(target_path);
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if local_path_is_link(&target, &metadata) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "目标是链接，没有把文件移进链接指向的位置",
            ));
        }
        if metadata.is_dir() {
            let file_name = source.file_name().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "无法确定文件名")
            })?;
            target = target.join(file_name);
        }
    }
    if local_move_lands_inside(&source, &target) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不能把项目移动到它自己或它里面",
        ));
    }
    if local_path_exists(&target) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "目标已存在",
        ));
    }
    fs::rename(&source, &target)?;
    Ok(target.display().to_string())
}

fn local_move_lands_inside(source: &Path, destination: &Path) -> bool {
    let source = normalize_local_move_path(source);
    let destination = normalize_local_move_path(destination);
    if source.is_empty() || source == "." {
        return false;
    }
    if destination == source {
        return true;
    }
    let mut prefix = source;
    if !prefix.ends_with("\\") {
        prefix.push("\\");
    }
    destination.starts_with(&prefix)
}

/// Compare move paths after `.` and `..`, so a path that steps out and
/// back in is still inside the folder, and a sibling path is not.
fn normalize_local_move_path(path: &Path) -> String {
    let mut text = path.to_string_lossy().replace("/", "\\");
    let unc = text.starts_with("\\\\");
    let has_drive = text.as_bytes().get(1) == Some(&b':');
    #[cfg(windows)]
    {
        text = text.to_lowercase();
    }
    let mut parts: Vec<String> = Vec::new();
    for part in text.split("\\") {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if unc && !parts.is_empty() && parts.len() <= 2 {
                continue;
            }
            if has_drive && parts.len() == 1 && parts[0].ends_with(":") {
                continue;
            }
            if parts.last().is_some_and(|item| item != "..") {
                parts.pop();
            } else if !unc && !has_drive {
                parts.push("..".to_owned());
            }
            continue;
        }
        parts.push(part.to_owned());
    }
    if unc {
        if parts.is_empty() {
            return "\\\\".to_owned();
        }
        return format!("\\\\{}", parts.join("\\"));
    }
    if has_drive {
        if parts.is_empty() || (parts.len() == 1 && parts[0].ends_with(":")) {
            let drive = parts.first().map(String::as_str).unwrap_or(".");
            return format!("{drive}\\");
        }
        return parts.join("\\");
    }
    if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("\\")
    }
}

pub fn local_touch(path: &str, mtime: u64, recursive: bool) -> std::io::Result<()> {
    let file_time = FileTime::from_unix_time(mtime as i64, 0);
    touch_path(Path::new(path), file_time, recursive)
}

pub fn local_chmod(path: &str, mode: u32, recursive: bool) -> std::io::Result<()> {
    if mode > 0o7777 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "权限格式不正确",
        ));
    }
    chmod_path(Path::new(path), mode, recursive)
}

pub fn local_path_stats(path: &str) -> std::io::Result<LocalPathStats> {
    let mut stats = LocalPathStats::default();
    collect_local_path_stats(Path::new(path), &mut stats)?;
    Ok(stats)
}

pub fn local_read_text_file(path: &str) -> std::io::Result<LocalTextFile> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不能直接编辑符号链接",
        ));
    }
    if metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不能编辑目录",
        ));
    }

    let read_limit = LOCAL_TEXT_PREVIEW_LIMIT + 1;
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(read_limit)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > LOCAL_TEXT_PREVIEW_LIMIT;
    if truncated {
        bytes.truncate(LOCAL_TEXT_PREVIEW_LIMIT as usize);
    }
    let is_binary = bytes.iter().any(|byte| *byte == 0);
    let content = local_text_from_bytes(&bytes, false, truncated);

    Ok(LocalTextFile {
        path: path.to_owned(),
        content,
        size: metadata.len(),
        truncated,
        is_binary,
    })
}

pub fn local_read_text_file_tail(path: &str) -> std::io::Result<LocalTextFile> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不能直接编辑符号链接",
        ));
    }
    if metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不能编辑目录",
        ));
    }

    let size = metadata.len();
    let start = size.saturating_sub(LOCAL_TEXT_PREVIEW_LIMIT);
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(LOCAL_TEXT_PREVIEW_LIMIT)
        .read_to_end(&mut bytes)?;
    let is_binary = bytes.iter().any(|byte| *byte == 0);
    let content = local_text_from_bytes(&bytes, start > 0, false);

    Ok(LocalTextFile {
        path: path.to_owned(),
        content,
        size,
        truncated: start > 0,
        is_binary,
    })
}

pub fn local_write_text_file(path: &str, content: &str) -> std::io::Result<()> {
    let path = Path::new(path);
    let link_metadata = fs::symlink_metadata(path)?;
    if link_metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不能直接编辑符号链接",
        ));
    }
    if link_metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不能编辑目录",
        ));
    }
    let previous_mode = local_mode(&link_metadata);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "无法确定文件名")
    })?;
    let temp = parent.join(format!(".{}.rustshell-tmp", file_name.to_string_lossy()));
    if fs::symlink_metadata(&temp).is_ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "保存失败：同目录下有未完成的临时文件，原文件未改动",
        ));
    }
    let encoding = local_text_encoding(path)?;
    let encoded = encode_local_text(content, encoding)?;
    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    let _ = set_local_permissions(path, previous_mode);
    Ok(())
}

pub fn local_file_sha256(path: &str) -> std::io::Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot checksum a symlink",
        ));
    }
    if metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "cannot checksum a directory",
        ));
    }
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Ok(hex_digest(&digest))
}

fn touch_path(path: &Path, file_time: FileTime, recursive: bool) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if local_path_is_link(path, &metadata) {
        return Ok(());
    }
    set_file_mtime(path, file_time)?;
    if recursive && metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if touch_path(&entry.path(), file_time, true).is_err() {
                continue;
            }
        }
    }
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn chmod_path(path: &Path, mode: u32, recursive: bool) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if local_path_is_link(path, &metadata) {
        return Ok(());
    }
    set_local_permissions(path, mode)?;
    if recursive && metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if chmod_path(&entry.path(), mode, true).is_err() {
                continue;
            }
        }
    }
    Ok(())
}

fn collect_local_path_stats(path: &Path, stats: &mut LocalPathStats) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !local_path_is_link(path, &metadata) {
        stats.dir_count += 1;
        for entry in fs::read_dir(path)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            // One locked or missing child should not hide the rest of the folder.
            if collect_local_path_stats(&entry.path(), stats).is_err() {
                continue;
            }
        }
    } else {
        stats.file_count += 1;
        stats.total_size += metadata.len();
    }
    Ok(())
}

fn search_local_recursive(
    root: &Path,
    query: &str,
    max_results: usize,
    output: &mut Vec<FileEntry>,
    incomplete: &mut bool,
    limited: &mut bool,
) -> std::io::Result<()> {
    if output.len() >= max_results {
        *limited = true;
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        if output.len() >= max_results {
            *limited = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                *incomplete = true;
                continue;
            }
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                *incomplete = true;
                continue;
            }
        };
        let known_target = if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            Some(fs::read_link(&path).ok())
        } else {
            None
        };
        let is_link = metadata.file_type().is_symlink()
            || known_target.as_ref().is_some_and(|target| target.is_some());
        let walk = metadata.is_dir() && !is_link;
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut matched = text_contains_query(&name, query) || path_contains_query(&path, query);
        if !matched {
            if let Some(Some(target)) = known_target.as_ref() {
                matched = path_contains_query(target, query);
            }
        }
        if matched {
            output.push(local_entry_from_path(path.clone(), metadata, known_target));
        }
        if walk && search_local_recursive(&path, query, max_results, output, incomplete, limited).is_err() {
            *incomplete = true;
        }
    }
    Ok(())
}

pub(crate) fn text_contains_query(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.is_ascii() {
        if haystack.len() < needle.len() {
            return false;
        }
        let needle_bytes = needle.as_bytes();
        return haystack
            .as_bytes()
            .windows(needle_bytes.len())
            .any(|window| window.eq_ignore_ascii_case(needle_bytes));
    }
    // Chinese and other caseless text can match in place. Letters such as
    // E-acute still need case folding, even when the query has no A-Z.
    if !needle_has_cased_letter(needle) {
        return haystack.contains(needle);
    }
    let folded_needle = needle.to_lowercase();
    haystack.to_lowercase().contains(&folded_needle)
}

fn needle_has_cased_letter(needle: &str) -> bool {
    needle
        .chars()
        .any(|ch| ch.is_uppercase() || ch.is_lowercase())
}

/// Match a path without copying it first. Filename searches never need a
/// separator-normalized copy, and slash direction only matters when the
/// query itself contains a slash.
pub(crate) fn path_contains_query(path: &Path, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    match path.to_str() {
        Some(text) if !query_has_separator(query) => text_contains_query(text, query),
        Some(text) => separator_folded_contains(text, query),
        None => {
            let text = path.to_string_lossy();
            if !query_has_separator(query) {
                text_contains_query(&text, query)
            } else {
                separator_folded_contains(&text, query)
            }
        }
    }
}

fn query_has_separator(query: &str) -> bool {
    query.bytes().any(|byte| byte == b'/' || byte == b'\\')
}

fn separator_folded_contains(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.is_ascii() && needle.is_ascii() {
        let haystack = haystack.as_bytes();
        let needle = needle.as_bytes();
        if haystack.len() < needle.len() {
            return false;
        }
        return haystack.windows(needle.len()).any(|window| {
            window
                .iter()
                .zip(needle)
                .all(|(left, right)| fold_ascii_path_byte(*left) == fold_ascii_path_byte(*right))
        });
    }
    haystack
        .char_indices()
        .any(|(index, _)| folded_chars_match(haystack[index..].chars(), needle.chars()))
}

fn folded_chars_match(
    haystack: impl Iterator<Item = char>,
    needle: impl Iterator<Item = char>,
) -> bool {
    // Lowercase can be longer than the original character. Comparing only the
    // first letter makes a lowered search miss the capital it came from.
    let mut haystack = haystack.flat_map(FoldedChars::new);
    for expected in needle.flat_map(FoldedChars::new) {
        match haystack.next() {
            Some(actual) if actual == expected => {}
            _ => return false,
        }
    }
    true
}

fn fold_ascii_path_byte(byte: u8) -> u8 {
    match byte {
        b'\\' => b'/',
        b'A'..=b'Z' => byte + 32,
        other => other,
    }
}

struct FoldedChars {
    chars: [char; 3],
    index: u8,
    len: u8,
}

impl FoldedChars {
    fn new(ch: char) -> Self {
        let mut folded = Self {
            chars: ['\0'; 3],
            index: 0,
            len: 0,
        };
        if ch == '\\' {
            folded.chars[0] = '/';
            folded.len = 1;
            return folded;
        }
        for lower in ch.to_lowercase() {
            if folded.len as usize >= folded.chars.len() {
                break;
            }
            folded.chars[folded.len as usize] = lower;
            folded.len += 1;
        }
        if folded.len == 0 {
            folded.chars[0] = ch;
            folded.len = 1;
        }
        folded
    }
}

impl Iterator for FoldedChars {
    type Item = char;

    fn next(&mut self) -> Option<char> {
        if self.index >= self.len {
            return None;
        }
        let ch = self.chars[self.index as usize];
        self.index += 1;
        Some(ch)
    }
}


fn local_fallback_charset() -> &'static encoding_rs::Encoding {
    encoding_rs::Encoding::for_label(local_fallback_charset_label().as_bytes())
        .unwrap_or(encoding_rs::UTF_8)
}

#[cfg(windows)]
fn local_fallback_charset_label() -> &'static str {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetACP() -> u32;
    }
    charset_label_for_code_page(unsafe { GetACP() })
}

#[cfg(not(windows))]
fn local_fallback_charset_label() -> &'static str {
    "utf-8"
}

fn charset_label_for_code_page(code_page: u32) -> &'static str {
    match code_page {
        936 => "gbk",
        54936 => "gb18030",
        950 => "big5",
        932 => "shift_jis",
        949 => "euc-kr",
        874 => "windows-874",
        1250 => "windows-1250",
        1251 => "windows-1251",
        1252 => "windows-1252",
        1253 => "windows-1253",
        1254 => "windows-1254",
        1255 => "windows-1255",
        1256 => "windows-1256",
        1257 => "windows-1257",
        1258 => "windows-1258",
        _ => "utf-8",
    }
}

fn local_text_encoding(path: &Path) -> std::io::Result<&'static encoding_rs::Encoding> {
    if local_file_is_utf8(path)? {
        Ok(encoding_rs::UTF_8)
    } else {
        Ok(local_fallback_charset())
    }
}

fn local_file_is_utf8(path: &Path) -> std::io::Result<bool> {
    let mut file = fs::File::open(path)?;
    let mut buffer = [0_u8; 8 * 1024];
    let mut pending = [0_u8; 3];
    let mut pending_len = 0_usize;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(pending_len == 0);
        }
        let mut chunk = [0_u8; 8 * 1024 + 3];
        chunk[..pending_len].copy_from_slice(&pending[..pending_len]);
        chunk[pending_len..pending_len + read].copy_from_slice(&buffer[..read]);
        let end = pending_len + read;
        match std::str::from_utf8(&chunk[..end]) {
            Ok(_) => pending_len = 0,
            Err(error) => {
                if error.error_len().is_some() {
                    return Ok(false);
                }
                let rest = &chunk[error.valid_up_to()..end];
                if rest.len() > pending.len() {
                    return Ok(false);
                }
                pending[..rest.len()].copy_from_slice(rest);
                pending_len = rest.len();
            }
        }
    }
}

fn local_text_from_bytes(bytes: &[u8], trim_prefix: bool, trim_suffix: bool) -> String {
    if trim_prefix || trim_suffix {
        let mut sample = bytes.to_vec();
        if trim_prefix {
            trim_partial_utf8_prefix(&mut sample);
        }
        if trim_suffix {
            trim_partial_utf8_suffix(&mut sample);
        }
        if let Ok(text) = std::str::from_utf8(&sample) {
            return text.to_owned();
        }
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    local_fallback_charset().decode(bytes).0.into_owned()
}

fn encode_local_text(
    content: &str,
    encoding: &'static encoding_rs::Encoding,
) -> std::io::Result<Vec<u8>> {
    if encoding == encoding_rs::UTF_8 {
        return Ok(content.as_bytes().to_vec());
    }
    let (bytes, _, unmappable) = encoding.encode(content);
    if unmappable {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "当前编码无法保存这些字符，原文件未改动",
        ));
    }
    Ok(bytes.into_owned())
}

fn trim_partial_utf8_prefix(bytes: &mut Vec<u8>) {
    let mut index = 0;
    while index < bytes.len() && bytes[index] & 0b1100_0000 == 0b1000_0000 {
        index += 1;
    }
    if index > 0 {
        bytes.drain(..index);
    }
}

fn trim_partial_utf8_suffix(bytes: &mut Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    let mut index = bytes.len() - 1;
    let mut continuations = 0usize;
    loop {
        let byte = bytes[index];
        if byte & 0b1100_0000 != 0b1000_0000 {
            let needed = match byte {
                0x00..=0x7F => 1,
                0xC0..=0xDF => 2,
                0xE0..=0xEF => 3,
                0xF0..=0xF7 => 4,
                _ => 1,
            };
            if continuations + 1 < needed {
                bytes.truncate(index);
            }
            return;
        }
        if index == 0 {
            bytes.clear();
            return;
        }
        index -= 1;
        continuations += 1;
        if continuations >= 3 {
            bytes.truncate(index);
            return;
        }
    }
}

fn local_entry_from_path(
    path_buf: PathBuf,
    metadata: fs::Metadata,
    known_target: Option<Option<PathBuf>>,
) -> FileEntry {
    let modified_at = metadata
        .modified()
        .map(DateTime::<Utc>::from)
        .unwrap_or_else(|_| DateTime::<Utc>::from(SystemTime::UNIX_EPOCH));
    // Junctions are reparse points, not symlinks, but they still point elsewhere.
    let is_symlink = metadata.file_type().is_symlink();
    let read_target = if let Some(known_target) = known_target {
        known_target
    } else if is_symlink || is_reparse_point(&metadata) {
        fs::read_link(&path_buf).ok()
    } else {
        None
    };
    let is_link = is_symlink || read_target.is_some();
    let link_target = read_target.map(|target| target.display().to_string());
    let is_dir = metadata.is_dir() && !is_link;
    let file_type = if is_link {
        "symlink"
    } else if is_dir {
        "directory"
    } else {
        "file"
    };
    FileEntry {
        name: path_buf
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| path_buf.display().to_string()),
        path: path_buf.display().to_string(),
        size: metadata.len(),
        modified_at,
        is_dir,
        file_type: file_type.to_owned(),
        link_target,
        permissions: Some(local_mode(&metadata)),
        uid: None,
        gid: None,
    }
}

#[cfg(unix)]
fn local_mode(metadata: &fs::Metadata) -> u32 {
    metadata.permissions().mode() & 0o7777
}

#[cfg(not(unix))]
fn local_mode(metadata: &fs::Metadata) -> u32 {
    match (metadata.is_dir(), metadata.permissions().readonly()) {
        (true, true) => 0o555,
        (true, false) => 0o755,
        (false, true) => 0o444,
        (false, false) => 0o644,
    }
}

#[cfg(unix)]
fn set_local_permissions(path: &Path, mode: u32) -> std::io::Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))
}

#[cfg(not(unix))]
fn set_local_permissions(path: &Path, mode: u32) -> std::io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly((mode & 0o200) == 0);
    fs::set_permissions(path, permissions)
}

pub fn local_rename(path: &str, new_name: &str) -> std::io::Result<()> {
    validate_file_name(new_name)?;
    let source = PathBuf::from(path);
    let parent = source.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "无法确定父目录",
        )
    })?;
    let target = parent.join(new_name);
    if source.file_name().is_some_and(|name| name == std::ffi::OsStr::new(new_name)) {
        return Ok(());
    }
    if local_path_exists(&target) {
        // Path equality is case-sensitive, but Windows still reports the new
        // letter case as an existing file. That is the same file, not a conflict.
        if local_rename_is_case_only(&source, &target) {
            return rename_local_case_only(&source, &target);
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "目标已存在",
        ));
    }
    fs::rename(source, target)
}


fn local_rename_is_case_only(source: &Path, target: &Path) -> bool {
    let (Some(source_name), Some(target_name)) = (source.file_name(), target.file_name()) else {
        return false;
    };
    if source_name == target_name {
        return false;
    }
    #[cfg(windows)]
    {
        source_name.to_string_lossy().to_lowercase()
            == target_name.to_string_lossy().to_lowercase()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn rename_local_case_only(source: &Path, target: &Path) -> std::io::Result<()> {
    let parent = source.parent().unwrap_or(Path::new("."));
    let nanos = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(
        ".{}.{}.rename-tmp",
        std::process::id(),
        nanos
    ));
    if local_path_exists(&temp) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "重命名失败：同目录下有未完成的临时文件，原文件未改动",
        ));
    }
    fs::rename(source, &temp)?;
    if let Err(error) = fs::rename(&temp, target) {
        if fs::rename(&temp, source).is_err() {
            return Err(std::io::Error::new(error.kind(), "重命名没有完成，文件暂时改成了临时名字，请再改回原来的名字"));
        }
        return Err(error);
    }
    Ok(())
}

fn copy_dir_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    copy_dir_entries(source, target, true)
}

fn copy_dir_entries(source: &Path, target: &Path, fail_if_unreadable: bool) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    fs::create_dir(target)?;
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(error) if fail_if_unreadable => return Err(error),
        Err(_) => {
            preserve_local_metadata(target, &metadata)?;
            return Ok(());
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let child_source = entry.path();
        let child_target = target.join(entry.file_name());
        let child_metadata = match fs::symlink_metadata(&child_source) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if local_path_is_link(&child_source, &child_metadata) {
            copy_local_symlink(&child_source, &child_target)?;
        } else if child_metadata.is_dir() {
            copy_dir_entries(&child_source, &child_target, false)?;
        } else if copy_nested_file(&child_source, &child_target)? {
            preserve_local_metadata(&child_target, &child_metadata)?;
        }
    }
    preserve_local_metadata(target, &metadata)?;
    Ok(())
}


fn copy_nested_file(source: &Path, target: &Path) -> std::io::Result<bool> {
    // A locked or unreadable file is skipped. Failure to create or write the
    // destination still stops the copy, so a full disk is not reported as success.
    // The handle is reused for the copy. Opening the file again would read it twice.
    let mut input = match fs::File::open(source) {
        Ok(file) => file,
        Err(_) => return Ok(false),
    };
    let mut output = fs::File::create(target)?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(target);
        return Err(error);
    }
    Ok(true)
}

fn preserve_local_metadata(path: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    set_file_mtime(path, FileTime::from_last_modification_time(metadata))?;
    set_local_permissions(path, local_mode(metadata))
}

fn local_path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Symlinks and Windows directory junctions. Junctions look like directories,
/// so a recursive walk would loop or leave the selected folder.
pub(crate) fn local_path_is_link(path: &Path, metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    if !is_reparse_point(metadata) {
        return false;
    }
    fs::read_link(path).is_ok()
}

/// True when showing a path in the system folder should select it.
/// A link is selected even when it points at a folder, so a junction or a
/// broken shortcut is not replaced by the directory it names.
pub(crate) fn local_reveal_selects_item(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(metadata) => local_path_is_link(path, &metadata) || !metadata.is_dir(),
        Err(_) => true,
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}


fn copy_local_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    let link_target = fs::read_link(source)?;
    create_local_symlink(&link_target, target)
}

#[cfg(unix)]
fn create_local_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_local_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
        .or_else(|_| std::os::windows::fs::symlink_dir(target, link))
}

fn validate_file_name(name: &str) -> std::io::Result<()> {
    if name.trim().is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "文件名不合法",
        ));
    }
    Ok(())
}

fn validate_relative_dir_path(path: &str) -> std::io::Result<Vec<&str>> {
    let trimmed = path.trim();
    let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidInput, "目录路径不合法");
    if trimmed.is_empty()
        || trimmed.starts_with(['/', '\\'])
        || trimmed.as_bytes().get(1) == Some(&b':')
    {
        return Err(invalid());
    }
    let mut segments = Vec::new();
    for segment in trimmed.split(['/', '\\']) {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(invalid());
        }
        segments.push(segment);
    }
    Ok(segments)
}

/// Join a remote POSIX directory and child name.
pub fn remote_child_path(parent: &str, child: &str) -> String {
    let parent = parent.trim();
    let parent = if parent.is_empty() { "." } else { parent };
    if parent == "/" {
        format!("/{}", child)
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), child)
    }
}

/// Parent of a remote POSIX path ("/a/b" -> "/a", "/a" -> "/").
pub fn remote_parent_path(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".to_owned();
    }
    match trimmed.rfind('/') {
        Some(0) => "/".to_owned(),
        Some(index) => trimmed[..index].to_owned(),
        None => ".".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_child_path_joins_correctly() {
        assert_eq!(remote_child_path("/", "a.txt"), "/a.txt");
        assert_eq!(remote_child_path("/root", "a.txt"), "/root/a.txt");
        assert_eq!(remote_child_path("/root/", "a.txt"), "/root/a.txt");
        assert_eq!(remote_child_path("", "a.txt"), "./a.txt");
        assert_eq!(remote_child_path("  ", "a.txt"), "./a.txt");
    }

    #[test]
    fn remote_parent_path_walks_up() {
        assert_eq!(remote_parent_path("/a/b"), "/a");
        assert_eq!(remote_parent_path("/a/b/"), "/a");
        assert_eq!(remote_parent_path("/a"), "/");
        assert_eq!(remote_parent_path("/"), "/");
        assert_eq!(remote_parent_path("rel"), ".");
    }

    #[test]
    fn reveal_selects_a_link_instead_of_the_folder_it_points_at() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-reveal-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let link = self.0.join("link");
                let _ = std::fs::remove_file(&link);
                let _ = std::fs::remove_dir(&link);
                let _ = std::fs::remove_file(self.0.join("note.txt"));
                let _ = std::fs::remove_dir_all(self.0.join("target"));
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        let note = root.join("note.txt");
        std::fs::write(&note, b"note").unwrap();
        let link = root.join("link");
        make_directory_link(&target, &link);

        assert!(local_reveal_selects_item(&note));
        assert!(!local_reveal_selects_item(&target));
        assert!(local_reveal_selects_item(&link));
        assert!(local_reveal_selects_item(&root.join("missing.txt")));
    }

    #[test]
    fn large_folder_sort_keeps_directories_first_without_rebuilding_names() {
        let names = ["b", "A", "c", "Dir"];
        let dirs = [false, false, false, true];
        let mut entries = Vec::new();
        for (name, is_dir) in names.into_iter().zip(dirs) {
            entries.push(FileEntry {
                name: name.to_owned(),
                path: name.to_owned(),
                size: 0,
                modified_at: chrono::Utc::now(),
                is_dir,
                file_type: if is_dir { "directory" } else { "file" }.to_owned(),
                link_target: None,
                permissions: None,
                uid: None,
                gid: None,
            });
        }
        sort_entries_by_folded_text(&mut entries, |entry| entry.name.as_str());
        let ordered: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(ordered, ["Dir", "A", "b", "c"]);
    }

    #[test]
    fn local_charset_labels_cover_the_common_ansi_code_pages() {
        assert_eq!(charset_label_for_code_page(936), "gbk");
        assert_eq!(charset_label_for_code_page(54936), "gb18030");
        assert_eq!(charset_label_for_code_page(950), "big5");
        assert_eq!(charset_label_for_code_page(932), "shift_jis");
        assert_eq!(charset_label_for_code_page(949), "euc-kr");
        assert_eq!(charset_label_for_code_page(1252), "windows-1252");
        assert_eq!(charset_label_for_code_page(65001), "utf-8");
        assert_eq!(charset_label_for_code_page(0), "utf-8");
        assert!(encoding_rs::Encoding::for_label(
            charset_label_for_code_page(936).as_bytes()
        )
        .is_some());
    }

    #[test]
    fn local_text_encoding_reads_past_the_first_chunk() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-local-charset-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let path = root.join("sample.txt");

        let mut utf8 = Vec::new();
        while utf8.len() < 9_000 {
            utf8.extend_from_slice("\u{4e2d}".as_bytes());
        }
        std::fs::write(&path, &utf8).unwrap();
        assert!(local_file_is_utf8(&path).unwrap());

        let mut bytes = vec![b'a'; 9_000];
        bytes.push(0xFF);
        std::fs::write(&path, &bytes).unwrap();
        assert!(!local_file_is_utf8(&path).unwrap());
    }

    #[test]
    fn local_text_round_trip_keeps_utf8_and_the_system_encoding() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-local-text-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());

        let utf8_path = root.join("utf8.txt");
        let original = "\u{4e2d}\u{6587}".as_bytes();
        std::fs::write(&utf8_path, original).unwrap();
        let path = utf8_path.display().to_string();
        let read = local_read_text_file(&path).unwrap();
        assert_eq!(read.content, "\u{4e2d}\u{6587}");
        assert!(!read.truncated);
        local_write_text_file(&path, "\u{4e2d}\u{6587}!").unwrap();
        assert_eq!(
            std::fs::read(&utf8_path).unwrap(),
            "\u{4e2d}\u{6587}!".as_bytes()
        );

        let probe = 64 * 1024;
        let mut raw = Vec::new();
        while raw.len() <= probe + 4 {
            raw.extend_from_slice("\u{4e2d}".as_bytes());
        }
        assert!(std::str::from_utf8(&raw[..probe]).is_err());
        let big_path = root.join("big-utf8.txt");
        std::fs::write(&big_path, &raw).unwrap();
        let big_name = big_path.display().to_string();
        let edited = String::from_utf8(raw).unwrap() + "!";
        local_write_text_file(&big_name, &edited).unwrap();
        assert_eq!(std::fs::read(&big_path).unwrap(), edited.as_bytes());

        let encoding = local_fallback_charset();
        if encoding == encoding_rs::UTF_8 {
            return;
        }
        let (encoded, _, unmappable) = encoding.encode("\u{4e2d}\u{6587}");
        if unmappable {
            return;
        }
        let encoded = encoded.into_owned();
        assert!(std::str::from_utf8(&encoded).is_err());
        let legacy_path = root.join("legacy.txt");
        std::fs::write(&legacy_path, &encoded).unwrap();
        let legacy = legacy_path.display().to_string();
        let read = local_read_text_file(&legacy).unwrap();
        assert_eq!(read.content, "\u{4e2d}\u{6587}");
        let tail = local_read_text_file_tail(&legacy).unwrap();
        assert_eq!(tail.content, "\u{4e2d}\u{6587}");
        local_write_text_file(&legacy, "\u{4e2d}\u{6587}\u{4e2d}").unwrap();
        let (expected, _, expected_unmappable) = encoding.encode("\u{4e2d}\u{6587}\u{4e2d}");
        assert!(!expected_unmappable);
        assert_eq!(std::fs::read(&legacy_path).unwrap(), expected.as_ref());

        let mut prefixed = vec![b'A'; 64 * 1024 + 32];
        prefixed.extend_from_slice(&encoded);
        assert!(std::str::from_utf8(&prefixed).is_err());
        let late_path = root.join("late-legacy.txt");
        std::fs::write(&late_path, &prefixed).unwrap();
        let late = late_path.display().to_string();
        let read = local_read_text_file(&late).unwrap();
        assert!(read.content.starts_with("AAAA"));
        assert!(read.content.ends_with("\u{4e2d}\u{6587}"));
        let rewritten = format!("{}\u{4e2d}", read.content);
        local_write_text_file(&late, &rewritten).unwrap();
        let (late_expected, _, late_unmappable) = encoding.encode(&rewritten);
        assert!(!late_unmappable);
        let saved = std::fs::read(&late_path).unwrap();
        assert_eq!(saved, late_expected.as_ref());
        assert_ne!(saved, rewritten.as_bytes());

        let (_emoji, _, emoji_unmappable) = encoding.encode("\u{1f600}");
        if emoji_unmappable {
            let before = std::fs::read(&legacy_path).unwrap();
            assert!(local_write_text_file(&legacy, "\u{1f600}").is_err());
            assert_eq!(std::fs::read(&legacy_path).unwrap(), before);
        }
    }


    #[test]
    fn local_rename_keeps_a_different_existing_file() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-rename-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let file = root.join("Readme.TXT");
        std::fs::write(&file, b"keep").unwrap();
        let path = file.display().to_string();
        local_rename(&path, "Readme.TXT").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"keep");
        std::fs::write(root.join("other.txt"), b"other").unwrap();
        assert!(local_rename(&path, "other.txt").is_err());
        assert_eq!(std::fs::read(root.join("other.txt")).unwrap(), b"other");
        assert_eq!(std::fs::read(&file).unwrap(), b"keep");
    }

    #[cfg(windows)]
    #[test]
    fn local_rename_changes_only_letter_case() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-rename-case-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let file = root.join("Readme.TXT");
        std::fs::write(&file, b"keep").unwrap();
        local_rename(&file.display().to_string(), "readme.txt").unwrap();
        let names: Vec<_> = list_local_dir(&root.display().to_string())
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["readme.txt".to_owned()]);
        assert_eq!(std::fs::read(root.join("readme.txt")).unwrap(), b"keep");
    }

    #[cfg(windows)]
    #[test]
    fn local_parent_stays_on_a_unc_root() {
        assert_eq!(local_parent(r"C:\Windows").as_deref(), Some(r"C:\"));
        assert_eq!(local_parent(r"C:\"), None);
        assert_eq!(
            local_parent(r"\\server\share\folder").as_deref(),
            Some(r"\\server\share\")
        );
        assert_eq!(local_parent(r"\\server\share"), None);
        assert_eq!(local_parent(r"\\server"), None);
        assert_eq!(local_parent(r"\\server\"), None);
    }

    #[test]
    fn local_listing_reports_when_more_entries_exist() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-dir-limit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());

        for index in 0..=DIR_ENTRY_LIMIT {
            std::fs::write(root.join(format!("f{index:05}")), b"x").unwrap();
        }
        let listing = list_local_dir(&root.display().to_string()).unwrap();
        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), DIR_ENTRY_LIMIT);

        std::fs::remove_file(root.join(format!("f{DIR_ENTRY_LIMIT:05}"))).unwrap();
        let listing = list_local_dir(&root.display().to_string()).unwrap();
        assert!(!listing.truncated);
        assert_eq!(listing.entries.len(), DIR_ENTRY_LIMIT);
    }

    #[test]
    fn search_text_matches_ascii_case_and_other_letters() {
        assert!(text_contains_query("Hello.TXT", "hello"));
        assert!(text_contains_query("notes.txt", "TXT"));
        assert!(text_contains_query("\u{76ee}\u{5f55}/\u{62a5}\u{544a}.txt", "\u{62a5}\u{544a}"));
        assert!(text_contains_query("\u{76ee}\u{5f55}/File.TXT", "txt"));
        assert!(text_contains_query("\u{76ee}\u{5f55}.TXT", "\u{76ee}\u{5f55}.txt"));
        assert!(text_contains_query("\u{c9}t\u{e9}.txt", "\u{e9}t\u{e9}"));
        assert!(text_contains_query("\u{e9}t\u{e9}.txt", "\u{c9}"));
        assert!(text_contains_query("\u{3a9}\u{3bc}\u{3ad}\u{3b3}\u{3b1}", "\u{3c9}"));
        assert!(!text_contains_query("\u{3a9}\u{3bc}\u{3ad}\u{3b3}\u{3b1}", "\u{3b1}\u{3b1}"));
        assert!(!text_contains_query("notes.txt", "png"));
        assert!(!text_contains_query("notes.txt", "\u{62a5}\u{544a}"));
        assert!(path_contains_query(Path::new(r"C:\Projects\Notes.TXT"), "notes"));
        assert!(path_contains_query(Path::new(r"C:\Projects\Notes.TXT"), "projects/notes"));
        assert!(path_contains_query(Path::new(r"C:\Projects\Notes.TXT"), r"projects\notes"));
        assert!(path_contains_query(
            Path::new("\u{76ee}\u{5f55}/\u{62a5}\u{544a}.TXT"),
            "\u{76ee}\u{5f55}\\\u{62a5}\u{544a}"
        ));
        assert!(!path_contains_query(Path::new(r"C:\Projects\Notes.TXT"), "png"));
        // Search lowercases the query first. U+0130 lowercases to two characters.
        assert!(path_contains_query(
            Path::new("\u{130}/rapor.txt"),
            "i\u{0307}/rapor"
        ));
        assert!(path_contains_query(
            Path::new("\u{130}\\rapor.txt"),
            "\u{130}/rapor"
        ));
        assert!(!path_contains_query(Path::new("i/rapor.txt"), "i\u{0307}/rapor"));
    }

    #[test]
    fn file_names_are_validated() {
        assert!(validate_file_name("ok.txt").is_ok());
        assert!(validate_file_name("").is_err());
        assert!(validate_file_name("a/b").is_err());
        assert!(validate_file_name("a\\b").is_err());
        assert!(validate_file_name("..").is_err());
    }

    #[test]
    fn deleting_a_directory_link_keeps_the_folder_it_points_to() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-dir-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let link = self.0.join("link");
                let _ = std::fs::remove_file(&link);
                let _ = std::fs::remove_dir(&link);
                let _ = std::fs::remove_file(self.0.join("target").join("keep.txt"));
                let _ = std::fs::remove_dir(self.0.join("target"));
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep.txt"), b"keep").unwrap();
        let link = root.join("link");
        make_directory_link(&target, &link);

        local_remove(&link.display().to_string(), false).unwrap();

        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(std::fs::read(target.join("keep.txt")).unwrap(), b"keep");
    }

    fn make_directory_link(target: &std::path::Path, link: &std::path::Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .status()
                .expect("start mklink");
            assert!(status.success(), "could not create a directory junction");
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).unwrap();
        }
    }

    #[test]
    fn creating_through_a_directory_link_does_not_enter_it() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-create-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let link = self.0.join("link");
                let _ = std::fs::remove_dir(self.0.join("link").join("child"));
                let _ = std::fs::remove_file(self.0.join("link").join("note.txt"));
                let _ = std::fs::remove_file(&link);
                let _ = std::fs::remove_dir(&link);
                let _ = std::fs::remove_dir_all(self.0.join("real"));
                let _ = std::fs::remove_file(self.0.join("target").join("keep.txt"));
                let _ = std::fs::remove_dir(self.0.join("target").join("child"));
                let _ = std::fs::remove_file(self.0.join("target").join("note.txt"));
                let _ = std::fs::remove_dir(self.0.join("target"));
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep.txt"), b"keep").unwrap();
        let link = root.join("link");
        make_directory_link(&target, &link);

        let mkdir_error = local_mkdir(&root.display().to_string(), "link/child").unwrap_err();
        assert!(mkdir_error.to_string().contains("\u{94fe}\u{63a5}"));
        assert!(!target.join("child").exists());

        let file_error = local_create_file(&root.display().to_string(), "link/note.txt").unwrap_err();
        assert!(file_error.to_string().contains("\u{94fe}\u{63a5}"));
        assert!(!target.join("note.txt").exists());
        assert_eq!(std::fs::read(target.join("keep.txt")).unwrap(), b"keep");

        local_mkdir(&root.display().to_string(), "real/child").unwrap();
        assert!(root.join("real").join("child").is_dir());
        let created = local_create_file(&root.display().to_string(), "real/note.txt").unwrap();
        assert_eq!(
            std::fs::read(&created).unwrap(),
            b""
        );
    }


    #[test]
    fn directory_link_is_listed_as_a_link() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-list-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let link = self.0.join("listed").join("link");
                let _ = std::fs::remove_file(&link);
                let _ = std::fs::remove_dir(&link);
                let _ = std::fs::remove_file(self.0.join("outside").join("secret.txt"));
                let _ = std::fs::remove_dir(self.0.join("outside"));
                let _ = std::fs::remove_dir(self.0.join("listed"));
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        let listed = root.join("listed");
        std::fs::create_dir(&listed).unwrap();
        let link = listed.join("link");
        make_directory_link(&outside, &link);

        let listing = list_local_dir(&listed.display().to_string()).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "link");
        assert_eq!(listing.entries[0].file_type, "symlink");
        assert!(!listing.entries[0].is_dir);
        let target = listing.entries[0].link_target.clone().unwrap_or_default();
        assert!(target.contains("outside"), "{target}");

        let found = search_local(&listed.display().to_string(), "secret", 10).unwrap();
        assert!(found.entries.is_empty());
    }

    #[test]
    fn move_does_not_enter_a_directory_link_or_its_own_child() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-move-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let link = self.0.join("link");
                let _ = std::fs::remove_file(&link);
                let _ = std::fs::remove_dir(&link);
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let real = root.join("real");
        std::fs::create_dir(&real).unwrap();
        let link = root.join("link");
        make_directory_link(&real, &link);
        let source = root.join("keep.txt");
        std::fs::write(&source, b"keep").unwrap();

        let error = local_move(&source.display().to_string(), &link.display().to_string()).unwrap_err();
        assert!(error.to_string().contains("\u94fe\u63a5"));
        assert_eq!(std::fs::read(&source).unwrap(), b"keep");
        assert!(!real.join("keep.txt").exists());

        let moved = local_move(&source.display().to_string(), &real.display().to_string()).unwrap();
        assert_eq!(std::fs::read(&moved).unwrap(), b"keep");

        let tree = root.join("box");
        let child = tree.join("child");
        std::fs::create_dir_all(&child).unwrap();
        let error = local_move(&tree.display().to_string(), &child.display().to_string()).unwrap_err();
        assert!(error.to_string().contains("\u81ea\u5df1"));
        assert!(child.is_dir());
        assert!(tree.is_dir());
    }

    #[test]
    fn search_finds_a_nested_name_and_reports_a_missing_root() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-search-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("nested").join("hello.txt"), b"hi").unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(self.0.join("nested").join("hello.txt"));
                let _ = std::fs::remove_dir(self.0.join("nested"));
                let _ = std::fs::remove_dir(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());

        let found = search_local(&root.display().to_string(), "hello", 10).unwrap();
        assert!(!found.incomplete);
        assert!(!found.limited);
        assert_eq!(found.entries.len(), 1);
        assert_eq!(found.entries[0].name, "hello.txt");

        let missing = root.join("missing");
        assert!(search_local(&missing.display().to_string(), "hello", 10).is_err());
    }

    #[test]
    fn local_move_does_not_land_inside_the_source() {
        assert!(local_move_lands_inside(Path::new(r"C:\a\box"), Path::new(r"C:\a\box\child")));
        assert!(local_move_lands_inside(Path::new(r"C:\a\box"), Path::new(r"C:\a\box")));
        assert!(!local_move_lands_inside(Path::new(r"C:\a\box"), Path::new(r"C:\a\box2\box")));
        assert!(!local_move_lands_inside(Path::new(r"C:\a\file"), Path::new(r"D:\a\file")));
        assert!(local_move_lands_inside(Path::new(r"C:\a\box"), Path::new(r"C:\a\box\..\box\child")));
        assert!(local_move_lands_inside(Path::new(r"C:\a\box"), Path::new(r"C:\a\box2\..\box\child")));
        assert!(!local_move_lands_inside(Path::new(r"C:\a\box"), Path::new(r"C:\a\box\..\box2")));
        assert!(!local_move_lands_inside(Path::new(r"C:\a\box"), Path::new(r"C:\a\box2\..\other")));
        assert!(local_move_lands_inside(Path::new(r"\\server\share\box"), Path::new(r"\\server\share\box\..\box\child")));
        assert!(!local_move_lands_inside(Path::new(r"\\server\share\box"), Path::new(r"\\server\share\box2")));
        assert!(local_move_lands_inside(Path::new(r"C:\"), Path::new(r"C:\foo")));
        assert!(!local_move_lands_inside(Path::new(r"C:\"), Path::new(r"D:\foo")));
        assert!(!local_move_lands_inside(Path::new(r"foo"), Path::new(r"foo\..\bar")));
        assert!(local_move_lands_inside(Path::new(r"foo"), Path::new(r"foo\..\foo\child")));
        #[cfg(windows)]
        {
            assert!(local_move_lands_inside(Path::new(r"C:\a\Box"), Path::new(r"c:\a\box\Child")));
        }
    }

    #[cfg(windows)]
    #[test]
    fn folder_stats_skip_an_unreadable_child() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-stats-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let user = std::env::var("USERNAME").unwrap_or_default();
                let _ = std::process::Command::new("icacls")
                    .arg(self.0.join("locked"))
                    .arg("/grant")
                    .arg(format!("{user}:(OI)(CI)F"))
                    .status();
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        std::fs::write(root.join("ok.txt"), b"hello").unwrap();
        let locked = root.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("secret.txt"), b"secret-data").unwrap();
        let user = std::env::var("USERNAME").expect("USERNAME");
        let deny_user = format!("{user}:(RX)");
        let commands: [&[&str]; 3] = [
            &["/inheritance:r"],
            &["/deny", deny_user.as_str()],
            &["/deny", "*S-1-1-0:(RX)"],
        ];
        for args in commands {
            let status = std::process::Command::new("icacls")
                .arg(&locked)
                .args(args)
                .status()
                .expect("icacls");
            assert!(status.success(), "icacls failed");
        }

        let stats = local_path_stats(&root.display().to_string()).unwrap();
        assert_eq!(stats.total_size, 5);
        assert_eq!(stats.file_count, 1);
        assert_eq!(stats.dir_count, 2);
        assert!(local_path_stats(&locked.display().to_string()).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn duplicating_a_folder_skips_an_unreadable_child() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-dup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let user = std::env::var("USERNAME").unwrap_or_default();
                let _ = std::process::Command::new("icacls")
                    .arg(self.0.join("source").join("locked"))
                    .arg("/grant")
                    .arg(format!("{user}:(OI)(CI)F"))
                    .status();
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let source = root.join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("ok.txt"), b"hello").unwrap();
        let locked = source.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("secret.txt"), b"secret-data").unwrap();
        let user = std::env::var("USERNAME").expect("USERNAME");
        let deny_user = format!("{user}:(RX)");
        let commands: [&[&str]; 3] = [
            &["/inheritance:r"],
            &["/deny", deny_user.as_str()],
            &["/deny", "*S-1-1-0:(RX)"],
        ];
        for args in commands {
            let status = std::process::Command::new("icacls")
                .arg(&locked)
                .args(args)
                .status()
                .expect("icacls");
            assert!(status.success(), "icacls failed");
        }

        let copied = local_duplicate(&source.display().to_string(), "copy").unwrap();
        let copied = std::path::PathBuf::from(copied);
        assert_eq!(std::fs::read(copied.join("ok.txt")).unwrap(), b"hello");
        assert!(copied.join("locked").is_dir());
        assert!(!copied.join("locked").join("secret.txt").exists());
        assert!(local_duplicate(&locked.display().to_string(), "locked-copy").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn duplicating_a_folder_skips_an_unreadable_file() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-dup-file-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let user = std::env::var("USERNAME").unwrap_or_default();
                let _ = std::process::Command::new("icacls")
                    .arg(self.0.join("source").join("locked.txt"))
                    .arg("/grant")
                    .arg(format!("{user}:F"))
                    .status();
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let source = root.join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("ok.txt"), b"hello").unwrap();
        let locked = source.join("locked.txt");
        std::fs::write(&locked, b"secret").unwrap();
        let user = std::env::var("USERNAME").expect("USERNAME");
        let deny_user = format!("{user}:(RD)");
        let commands: [&[&str]; 2] = [
            &["/deny", deny_user.as_str()],
            &["/deny", "*S-1-1-0:(RD)"],
        ];
        for args in commands {
            let status = std::process::Command::new("icacls")
                .arg(&locked)
                .args(args)
                .status()
                .expect("icacls");
            assert!(status.success(), "icacls failed");
        }

        let copied = local_duplicate(&source.display().to_string(), "copy").unwrap();
        let copied = std::path::PathBuf::from(copied);
        assert_eq!(std::fs::read(copied.join("ok.txt")).unwrap(), b"hello");
        assert!(!copied.join("locked.txt").exists());
        assert!(local_duplicate(&locked.display().to_string(), "locked-copy").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn recursive_touch_skips_an_unreadable_child() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-touch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let user = std::env::var("USERNAME").unwrap_or_default();
                let _ = std::process::Command::new("icacls")
                    .arg(self.0.join("locked"))
                    .arg("/grant")
                    .arg(format!("{user}:(OI)(CI)F"))
                    .status();
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let file = root.join("ok.txt");
        std::fs::write(&file, b"hello").unwrap();
        let locked = root.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("secret.txt"), b"secret-data").unwrap();
        let user = std::env::var("USERNAME").expect("USERNAME");
        let deny_user = format!("{user}:(RX)");
        let commands: [&[&str]; 3] = [
            &["/inheritance:r"],
            &["/deny", deny_user.as_str()],
            &["/deny", "*S-1-1-0:(RX)"],
        ];
        for args in commands {
            let status = std::process::Command::new("icacls")
                .arg(&locked)
                .args(args)
                .status()
                .expect("icacls");
            assert!(status.success(), "icacls failed");
        }

        let when = 1_700_000_000_u64;
        local_touch(&root.display().to_string(), when, true).unwrap();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        let secs = modified
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert_eq!(secs, when);
        assert!(local_touch(&locked.display().to_string(), when, true).is_err());
        assert!(local_chmod(&root.display().to_string(), 0o644, true).is_ok());
        assert!(local_chmod(&locked.display().to_string(), 0o644, true).is_err());
    }
}
