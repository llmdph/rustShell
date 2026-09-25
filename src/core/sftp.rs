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
        let entry = entry?;
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
) -> std::io::Result<Vec<FileEntry>> {
    let mut output = Vec::new();
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(output);
    }
    search_local_recursive(
        Path::new(root),
        &needle,
        max_results.clamp(1, 1000),
        &mut output,
    )?;
    output.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(output)
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
    let segments = validate_relative_dir_path(name)?;
    let mut path = PathBuf::from(parent);
    for segment in segments {
        path.push(segment);
    }
    if local_path_exists(&path) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "目标已存在",
        ));
    }
    fs::create_dir_all(path)
}

pub fn local_create_file(parent: &str, name: &str) -> std::io::Result<String> {
    let segments = validate_relative_dir_path(name)?;
    let mut path = PathBuf::from(parent);
    for segment in segments {
        path.push(segment);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    Ok(path.display().to_string())
}

pub fn local_create_symlink(parent: &str, name: &str, target: &str) -> std::io::Result<String> {
    let segments = validate_relative_dir_path(name)?;
    if target.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "链接目标不能为空",
        ));
    }
    let mut link_path = PathBuf::from(parent);
    for segment in segments {
        link_path.push(segment);
    }
    if local_path_exists(&link_path) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "目标已存在",
        ));
    }
    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent)?;
    }
    create_local_symlink(Path::new(target), &link_path)?;
    Ok(link_path.display().to_string())
}

pub fn local_remove(path: &str, is_dir: bool) -> std::io::Result<()> {
    if is_dir {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
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
    if target.is_dir() {
        let file_name = source.file_name().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "无法确定文件名")
        })?;
        target = target.join(file_name);
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
) -> std::io::Result<()> {
    if output.len() >= max_results {
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        if output.len() >= max_results {
            break;
        }
        let entry = entry?;
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        let walk = metadata.is_dir() && !local_path_is_link(&path, &metadata);
        let file_entry = local_entry_from_path(path.clone(), metadata);
        if entry_matches_query(&file_entry, query) {
            output.push(file_entry.clone());
        }
        if walk {
            let _ = search_local_recursive(&path, query, max_results, output);
        }
    }
    Ok(())
}

fn entry_matches_query(entry: &FileEntry, query: &str) -> bool {
    entry.name.to_lowercase().contains(query)
        || entry.path.to_lowercase().contains(query)
        || entry
            .link_target
            .as_deref()
            .is_some_and(|target| target.to_lowercase().contains(query))
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
    let is_symlink = metadata.file_type().is_symlink();
    let link_target = if is_symlink {
        fs::read_link(&path_buf)
            .ok()
            .map(|target| target.display().to_string())
    } else {
        None
    };
    let is_dir = metadata.is_dir() && !is_symlink;
    let file_type = if is_symlink {
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
    fn file_names_are_validated() {
        assert!(validate_file_name("ok.txt").is_ok());
        assert!(validate_file_name("").is_err());
        assert!(validate_file_name("a/b").is_err());
        assert!(validate_file_name("a\\b").is_err());
        assert!(validate_file_name("..").is_err());
    }
}
