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
        entries.push(local_entry_from_path(path, metadata));
    }

    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
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
    output.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(FileSearchResult {
        entries: output,
        incomplete,
        limited,
    })
}

pub fn local_home() -> String {
    directories::UserDirs::new()
        .map(|dirs| dirs.home_dir().display().to_string())
        .unwrap_or_else(|| ".".to_owned())
}

pub fn local_parent(path: &str) -> Option<String> {
    Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.display().to_string())
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
    let source = local_move_cmp(source);
    let destination = local_move_cmp(destination);
    destination == source || destination.starts_with(&source)
}

fn local_move_cmp(path: &Path) -> PathBuf {
    let mut text = path.to_string_lossy().replace('/', "\\");
    while text.len() > 3 && text.ends_with('\\') {
        text.pop();
    }
    #[cfg(windows)]
    let text = text.to_lowercase();
    PathBuf::from(text)
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
        trim_partial_utf8_suffix(&mut bytes);
    }
    let is_binary = bytes.iter().any(|byte| *byte == 0);
    let content = String::from_utf8_lossy(&bytes).to_string();

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
    if start > 0 {
        trim_partial_utf8_prefix(&mut bytes);
    }
    let is_binary = bytes.iter().any(|byte| *byte == 0);
    let content = String::from_utf8_lossy(&bytes).to_string();

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
    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(content.as_bytes())?;
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
            let entry = entry?;
            touch_path(&entry.path(), file_time, true)?;
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
            let entry = entry?;
            chmod_path(&entry.path(), mode, true)?;
        }
    }
    Ok(())
}

fn collect_local_path_stats(path: &Path, stats: &mut LocalPathStats) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !local_path_is_link(path, &metadata) {
        stats.dir_count += 1;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            collect_local_path_stats(&entry.path(), stats)?;
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
        let is_link = local_path_is_link(&path, &metadata);
        let walk = metadata.is_dir() && !is_link;
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut matched = text_contains_query(&name, query)
            || text_contains_query(&path.display().to_string(), query);
        if !matched && is_link {
            if let Ok(target) = fs::read_link(&path) {
                matched = text_contains_query(&target.display().to_string(), query);
            }
        }
        if matched {
            output.push(local_entry_from_path(path.clone(), metadata));
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
    if haystack.is_ascii() && needle.is_ascii() {
        let needle_bytes = needle.as_bytes();
        return haystack
            .as_bytes()
            .windows(needle_bytes.len())
            .any(|window| window.eq_ignore_ascii_case(needle_bytes));
    }
    haystack.to_lowercase().contains(needle)
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

fn local_entry_from_path(path_buf: PathBuf, metadata: fs::Metadata) -> FileEntry {
    let modified_at = metadata
        .modified()
        .map(DateTime::<Utc>::from)
        .unwrap_or_else(|_| DateTime::<Utc>::from(SystemTime::UNIX_EPOCH));
    // Junctions are reparse points, not symlinks, but they still point elsewhere.
    let is_symlink = metadata.file_type().is_symlink();
    let read_target = if is_symlink || is_reparse_point(&metadata) {
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
    fs::rename(&source, target)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    fs::create_dir(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let child_source = entry.path();
        let child_target = target.join(entry.file_name());
        let child_metadata = fs::symlink_metadata(&child_source)?;
        if local_path_is_link(&child_source, &child_metadata) {
            copy_local_symlink(&child_source, &child_target)?;
        } else if child_metadata.is_dir() {
            copy_dir_recursive(&child_source, &child_target)?;
        } else {
            fs::copy(&child_source, &child_target)?;
            preserve_local_metadata(&child_target, &child_metadata)?;
        }
    }
    preserve_local_metadata(target, &metadata)?;
    Ok(())
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
        assert!(text_contains_query("目录/报告.txt", "报告"));
        assert!(!text_contains_query("notes.txt", "png"));
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
}
