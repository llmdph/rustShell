use crate::core::{
    session::SessionProfile,
    sftp::{
        local_path_is_link, remote_child_path, remote_parent_path, FileEntry,
        TransferConflictStrategy,
    },
};
use crate::services::ssh;
use anyhow::{anyhow, bail, Context, Result};
use filetime::{set_file_times, FileTime};
use sha2::{Digest, Sha256};
use ssh2::{OpenFlags, OpenType};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const REMOTE_TEXT_PREVIEW_LIMIT: u64 = 1024 * 1024;
const REMOTE_DIR_ENTRY_LIMIT: usize = 10_000;
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const LIBSSH2_ERROR_FILE: i32 = -16;
const LIBSSH2_ERROR_EAGAIN: i32 = -37;

pub struct SftpConnection {
    session: ssh2::Session,
    sftp: ssh2::Sftp,
}


const EXEC_OUTPUT_LIMIT: usize = 256 * 1024;
const EXEC_TIMEOUT: Duration = Duration::from_secs(12);

fn read_command_output(session: &ssh2::Session, channel: &mut ssh2::Channel) -> Result<String> {
    let _mode = ExecModeGuard::nonblocking(session);
    let mut stdout = Vec::new();
    let mut buf = [0_u8; 8 * 1024];
    let started = Instant::now();
    loop {
        let mut waiting = true;
        match channel.read(&mut buf) {
            Ok(0) => {}
            Ok(n) => {
                stdout.extend_from_slice(&buf[..n]);
                waiting = false;
            }
            Err(error) if is_would_block(&error) => {}
            Err(error) => return Err(error).context("failed to read command output"),
        }
        match channel.stderr().read(&mut buf) {
            Ok(0) => {}
            Ok(_) => waiting = false,
            Err(error) if is_would_block(&error) => {}
            Err(error) => return Err(error).context("failed to read command error output"),
        }
        if channel.eof() || stdout.len() >= EXEC_OUTPUT_LIMIT {
            break;
        }
        if started.elapsed() > EXEC_TIMEOUT {
            bail!("remote command timed out");
        }
        if waiting {
            thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

struct ExecModeGuard<'a> {
    session: &'a ssh2::Session,
    was_blocking: bool,
}

impl<'a> ExecModeGuard<'a> {
    fn nonblocking(session: &'a ssh2::Session) -> Self {
        let was_blocking = session.is_blocking();
        session.set_blocking(false);
        Self {
            session,
            was_blocking,
        }
    }
}

impl Drop for ExecModeGuard<'_> {
    fn drop(&mut self) {
        self.session.set_blocking(self.was_blocking);
    }
}

fn is_would_block(error: &io::Error) -> bool {
    error.kind() == ErrorKind::WouldBlock
        || error
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<ssh2::Error>())
            .is_some_and(|ssh_error| matches!(ssh_error.code(), ssh2::ErrorCode::Session(-37)))
}

impl SftpConnection {
    pub fn connect(profile: &SessionProfile, password: Option<&str>) -> Result<Self> {
        let session = connect(profile, password)?;
        let sftp = session.sftp().context("failed to start SFTP subsystem")?;
        Ok(Self { session, sftp })
    }

    /// The open SFTP channel, so transfer code can stream over this session
    /// rather than opening one of its own.
    pub fn sftp(&self) -> &ssh2::Sftp {
        &self.sftp
    }

    /// Run a shell command over this connection's SSH session and return its
    /// stdout. Opening another channel on an authenticated session costs one
    /// round trip, versus a full TCP connect plus handshake plus auth for a
    /// fresh session.
    pub fn exec(&self, command: &str) -> Result<String> {
        let mut channel = self
            .session
            .channel_session()
            .context("failed to open SSH command channel")?;
        channel.exec(command).context("failed to run command")?;

        // Read stdout and stderr together. A blocking stdout read never drains
        // stderr, so a noisy command fills the channel window and stalls the
        // shared session until the pool gives up.
        let output = read_command_output(&self.session, &mut channel);
        self.session.set_blocking(true);
        channel.close().ok();
        channel.wait_close().ok();
        output
    }

    pub fn home_dir(&self) -> Result<String> {
        self.sftp
            .realpath(Path::new("."))
            .context("failed to resolve remote home")
            .map(|path| remote_path_text(&path))
    }

    pub fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        list_with_sftp(&self.sftp, path)
    }

    pub fn search(&self, root: &str, query: &str, max_results: usize) -> Result<Vec<FileEntry>> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            bail!("search query is empty");
        }
        let mut output = Vec::new();
        search_remote_recursive(
            &self.sftp,
            Path::new(root),
            &query,
            max_results.clamp(1, 1000),
            &mut output,
        )?;
        output.sort_by_key(|entry| (!entry.is_dir, entry.path.to_lowercase()));
        Ok(output)
    }

    pub fn create_dir(&self, parent: &str, name: &str) -> Result<()> {
        let segments = validate_remote_relative_dir_path(name)?;
        let mut path = parent.trim().replace('\\', "/");
        for segment in &segments {
            path = remote_child_path(&path, segment);
        }
        if remote_path_exists(&self.sftp, Path::new(&path)) {
            bail!("remote target already exists: {}", path);
        }

        let mut current = parent.trim().replace('\\', "/");
        for segment in segments {
            current = remote_child_path(&current, segment);
            ensure_remote_dir(&self.sftp, Path::new(&current))?;
        }
        Ok(())
    }

    pub fn remove_path(&self, path: &str, is_dir: bool, recursive: bool) -> Result<()> {
        let remote_path = Path::new(path);
        let stat = self
            .sftp
            .lstat(remote_path)
            .with_context(|| format!("failed to stat remote path {}", path))?;
        let is_symlink = stat.file_type().is_symlink();

        if stat.is_dir() && !is_symlink {
            if recursive {
                remove_remote_recursive(&self.sftp, remote_path)
            } else {
                self.sftp
                    .rmdir(remote_path)
                    .with_context(|| format!("failed to remove remote directory {}", path))
            }
        } else if is_dir && !is_symlink {
            self.sftp
                .rmdir(Path::new(path))
                .with_context(|| format!("failed to remove remote directory {}", path))
        } else {
            self.sftp
                .unlink(Path::new(path))
                .with_context(|| format!("failed to remove remote file {}", path))
        }
    }

    pub fn create_symlink(&self, parent: &str, name: &str, target: &str) -> Result<String> {
        let (link_path, parent_dirs) = resolve_remote_relative_create_path(parent, name)?;
        if target.trim().is_empty() {
            bail!("remote symlink target is empty");
        }
        if self.sftp.lstat(Path::new(&link_path)).is_ok() {
            bail!("remote target already exists: {}", link_path);
        }
        ensure_remote_parent_dirs(&self.sftp, parent, &parent_dirs)?;
        self.sftp
            .symlink(Path::new(target), Path::new(&link_path))
            .with_context(|| format!("failed to create symlink {} -> {}", link_path, target))?;
        Ok(link_path)
    }

    pub fn rename_path(&self, path: &str, new_name: &str) -> Result<String> {
        validate_remote_name(new_name)?;
        let target = remote_child_path(&remote_parent_path(path), new_name);
        let target_path = Path::new(&target);
        if self.sftp.lstat(target_path).is_ok() {
            bail!("remote target already exists: {}", target);
        }
        self.sftp
            .rename(Path::new(path), target_path, None)
            .with_context(|| format!("failed to rename {} to {}", path, target))?;
        Ok(target)
    }

    pub fn duplicate_path(&self, path: &str, is_dir: bool, new_name: &str) -> Result<String> {
        validate_remote_name(new_name)?;
        let source = Path::new(path);
        let target = remote_child_path(&remote_parent_path(path), new_name);
        copy_remote_path(&self.sftp, source, Path::new(&target), is_dir)
            .with_context(|| format!("failed to duplicate {} to {}", path, target))?;
        Ok(target)
    }

    pub fn move_path(&self, path: &str, target_path: &str) -> Result<String> {
        let target = resolve_remote_move_target(&self.sftp, path, target_path)?;
        if target == path {
            bail!("remote target is the same as source");
        }
        self.sftp
            .rename(Path::new(path), Path::new(&target), None)
            .with_context(|| format!("failed to move {} to {}", path, target))?;
        Ok(target)
    }

    pub fn chmod_path(&self, path: &str, mode: u32, recursive: bool) -> Result<()> {
        validate_mode(mode)?;
        if recursive {
            chmod_recursive(&self.sftp, Path::new(path), mode)
        } else {
            chmod_one(&self.sftp, Path::new(path), mode)
        }
    }

    pub fn chown_path(
        &self,
        path: &str,
        uid: Option<u32>,
        gid: Option<u32>,
        recursive: bool,
    ) -> Result<()> {
        validate_owner_change(uid, gid)?;
        if recursive {
            chown_recursive(&self.sftp, Path::new(path), uid, gid)
        } else {
            chown_one(&self.sftp, Path::new(path), uid, gid)
        }
    }

    pub fn touch_path(&self, path: &str, mtime: u64, recursive: bool) -> Result<()> {
        if recursive {
            touch_recursive(&self.sftp, Path::new(path), mtime)
        } else {
            touch_one(&self.sftp, Path::new(path), mtime)
        }
    }

    pub fn path_stats(&self, path: &str) -> Result<RemotePathStats> {
        let mut stats = RemotePathStats::default();
        collect_remote_path_stats(&self.sftp, Path::new(path), &mut stats)?;
        Ok(stats)
    }

    pub fn create_file(&self, parent: &str, name: &str) -> Result<String> {
        let (path, parent_dirs) = resolve_remote_relative_create_path(parent, name)?;
        let remote_path = Path::new(&path);
        if self.sftp.lstat(remote_path).is_ok() {
            bail!("remote target already exists: {}", path);
        }
        ensure_remote_parent_dirs(&self.sftp, parent, &parent_dirs)?;

        let mut file = self
            .sftp
            .create(remote_path)
            .with_context(|| format!("failed to create remote file {}", path))?;
        file.flush().ok();
        Ok(path)
    }

    pub fn read_text_file(&self, path: &str, charset: &str) -> Result<RemoteTextFile> {
        let stat = self
            .sftp
            .lstat(Path::new(path))
            .with_context(|| format!("failed to stat remote file {}", path))?;
        if stat.file_type().is_symlink() {
            bail!("cannot edit a symlink");
        }
        if stat.is_dir() {
            bail!("cannot edit a directory");
        }

        let size = stat.size.unwrap_or_default();
        let read_limit = REMOTE_TEXT_PREVIEW_LIMIT + 1;
        let mut file = self
            .sftp
            .open(Path::new(path))
            .with_context(|| format!("failed to open remote file {}", path))?;
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(read_limit)
            .read_to_end(&mut bytes)
            .with_context(|| format!("failed to read remote file {}", path))?;
        let truncated = bytes.len() as u64 > REMOTE_TEXT_PREVIEW_LIMIT;
        if truncated {
            bytes.truncate(REMOTE_TEXT_PREVIEW_LIMIT as usize);
            trim_partial_text_suffix(&mut bytes, charset);
        }
        let is_binary = bytes.iter().any(|byte| *byte == 0);
        let content = decode_text_bytes(&bytes, charset);

        Ok(RemoteTextFile {
            path: path.to_owned(),
            content,
            size,
            truncated,
            is_binary,
        })
    }

    pub fn read_text_file_tail(&self, path: &str, charset: &str) -> Result<RemoteTextFile> {
        let stat = self
            .sftp
            .lstat(Path::new(path))
            .with_context(|| format!("failed to stat remote file {}", path))?;
        if stat.file_type().is_symlink() {
            bail!("cannot edit a symlink");
        }
        if stat.is_dir() {
            bail!("cannot edit a directory");
        }

        let size = stat.size.unwrap_or_default();
        let start = size.saturating_sub(REMOTE_TEXT_PREVIEW_LIMIT);
        let mut file = self
            .sftp
            .open(Path::new(path))
            .with_context(|| format!("failed to open remote file {}", path))?;
        file.seek(SeekFrom::Start(start))
            .with_context(|| format!("failed to seek remote file {}", path))?;
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(REMOTE_TEXT_PREVIEW_LIMIT)
            .read_to_end(&mut bytes)
            .with_context(|| format!("failed to read remote file {}", path))?;
        if start > 0 {
            trim_partial_text_prefix(&mut bytes, charset);
        }
        let is_binary = bytes.iter().any(|byte| *byte == 0);
        let content = decode_text_bytes(&bytes, charset);

        Ok(RemoteTextFile {
            path: path.to_owned(),
            content,
            size,
            truncated: start > 0,
            is_binary,
        })
    }

    pub fn write_text_file(&self, path: &str, content: &str, charset: &str) -> Result<()> {
        let path = Path::new(path);
        let previous = self.sftp.lstat(path).ok();
        if previous
            .as_ref()
            .is_some_and(|stat| stat.file_type().is_symlink())
        {
            bail!("cannot edit a symlink");
        }
        if previous.as_ref().is_some_and(|stat| stat.is_dir()) {
            bail!("cannot edit a directory");
        }
        let mode = previous
            .as_ref()
            .and_then(|stat| stat.perm)
            .unwrap_or(0o644)
            & 0o7777;
        let bytes = encode_text_bytes(content, charset)?;
        let mut file = self
            .sftp
            .open_mode(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                mode as i32,
                OpenType::File,
            )
            .with_context(|| {
                format!("failed to open remote file for writing {}", path.display())
            })?;
        file.write_all(&bytes)
            .with_context(|| format!("failed to write remote file {}", path.display()))?;
        file.flush().ok();
        drop(file);
        if let Some(previous) = previous {
            if previous.uid.is_some() || previous.gid.is_some() {
                let _ = chown_one(&self.sftp, path, previous.uid, previous.gid);
            }
            if let Some(mode) = previous.perm {
                let _ = set_remote_permissions(&self.sftp, path, mode);
            }
        }
        Ok(())
    }

    pub fn file_sha256(&self, path: &str) -> Result<String> {
        let path = Path::new(path);
        let stat = self
            .sftp
            .lstat(path)
            .with_context(|| format!("failed to stat remote file {}", path.display()))?;
        if stat.file_type().is_symlink() {
            bail!("cannot checksum a symlink");
        }
        if stat.is_dir() {
            bail!("cannot checksum a directory");
        }

        let mut file = self
            .sftp
            .open(path)
            .with_context(|| format!("failed to open remote file {}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file
                .read(&mut buffer)
                .with_context(|| format!("failed to read remote file {}", path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        let digest = hasher.finalize();
        Ok(hex_digest(&digest))
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextFile {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub is_binary: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePathStats {
    pub total_size: u64,
    pub file_count: u64,
    pub dir_count: u64,
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

pub fn list_remote_dir(
    profile: &SessionProfile,
    password: Option<&str>,
    path: &str,
) -> Result<Vec<FileEntry>> {
    let session = connect(profile, password)?;
    let sftp = session.sftp().context("failed to start SFTP subsystem")?;
    list_with_sftp(&sftp, path)
}


fn read_remote_entries(
    sftp: &ssh2::Sftp,
    dirname: &Path,
    limit: Option<usize>,
) -> Result<Vec<(PathBuf, ssh2::FileStat)>> {
    let mut entries = Vec::new();
    visit_remote_entries(sftp, dirname, limit, |path, stat| {
        entries.push((path, stat));
        true
    })?;
    Ok(entries)
}

fn visit_remote_entries(
    sftp: &ssh2::Sftp,
    dirname: &Path,
    limit: Option<usize>,
    mut visit: impl FnMut(PathBuf, ssh2::FileStat) -> bool,
) -> Result<()> {
    let mut dir = sftp
        .opendir(dirname)
        .with_context(|| format!("failed to list {}", dirname.display()))?;
    let parent = remote_path_text(dirname);
    let mut seen = 0usize;
    loop {
        if limit.is_some_and(|limit| seen >= limit) {
            break;
        }
        match dir.readdir() {
            Ok((filename, stat)) => {
                let name = filename.to_string_lossy();
                if name == "." || name == ".." {
                    continue;
                }
                seen += 1;
                let joined = remote_child_path(&parent, &name);
                if !visit(PathBuf::from(joined), stat) {
                    break;
                }
            }
            Err(error) if is_libssh2_session_code(&error, LIBSSH2_ERROR_FILE) => break,
            Err(error) if is_libssh2_session_code(&error, LIBSSH2_ERROR_EAGAIN) => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to list {}", dirname.display()));
            }
        }
    }
    Ok(())
}

fn is_libssh2_session_code(error: &ssh2::Error, code: i32) -> bool {
    error.code() == ssh2::ErrorCode::Session(code)
}

fn list_with_sftp(sftp: &ssh2::Sftp, path: &str) -> Result<Vec<FileEntry>> {
    let entries = read_remote_entries(sftp, Path::new(path), Some(REMOTE_DIR_ENTRY_LIMIT))?;

    let mut output = Vec::with_capacity(entries.len());
    for (path_buf, stat) in entries {
        output.push(entry_from_stat(sftp, path_buf, stat));
    }

    output.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(output)
}

fn search_remote_recursive(
    sftp: &ssh2::Sftp,
    root: &Path,
    query: &str,
    max_results: usize,
    output: &mut Vec<FileEntry>,
) -> Result<()> {
    if output.len() >= max_results {
        return Ok(());
    }

    let mut directories = Vec::new();
    visit_remote_entries(sftp, root, None, |path_buf, stat| {
        if output.len() >= max_results {
            return false;
        }
        let should_descend = stat.is_dir() && !stat.file_type().is_symlink();
        let entry = entry_from_stat(sftp, path_buf.clone(), stat);
        if entry_matches_query(&entry, query) {
            output.push(entry);
        }
        if should_descend {
            directories.push(path_buf);
        }
        output.len() < max_results
    })?;

    for directory in directories {
        if output.len() >= max_results {
            break;
        }
        search_remote_recursive(sftp, &directory, query, max_results, output)?;
    }
    Ok(())
}


fn text_encoding(charset: &str) -> &'static encoding_rs::Encoding {
    encoding_rs::Encoding::for_label(charset.trim().as_bytes()).unwrap_or(encoding_rs::UTF_8)
}

fn decode_text_bytes(bytes: &[u8], charset: &str) -> String {
    let (text, _, _) = text_encoding(charset).decode(bytes);
    text.into_owned()
}

fn encode_text_bytes(text: &str, charset: &str) -> Result<Vec<u8>> {
    let (bytes, _, unmappable) = text_encoding(charset).encode(text);
    if unmappable {
        bail!("当前字符集无法保存文本中的部分字符");
    }
    Ok(bytes.into_owned())
}

fn is_utf8_charset(charset: &str) -> bool {
    let value = charset.trim().to_ascii_lowercase();
    value.is_empty() || value == "utf-8" || value == "utf8"
}

fn trim_partial_text_suffix(bytes: &mut Vec<u8>, charset: &str) {
    if is_utf8_charset(charset) {
        trim_partial_utf8_suffix(bytes);
    }
}

fn trim_partial_text_prefix(bytes: &mut Vec<u8>, charset: &str) {
    if !is_utf8_charset(charset) || bytes.is_empty() {
        return;
    }
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

fn entry_matches_query(entry: &FileEntry, query: &str) -> bool {
    entry.name.to_lowercase().contains(query)
        || entry.path.to_lowercase().contains(query)
        || entry
            .link_target
            .as_deref()
            .is_some_and(|target| target.to_lowercase().contains(query))
}

fn entry_from_stat(sftp: &ssh2::Sftp, path_buf: PathBuf, stat: ssh2::FileStat) -> FileEntry {
    let name = path_buf
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| remote_path_text(&path_buf));
    let is_dir = stat.is_dir();
    let is_symlink = stat.file_type().is_symlink();
    let link_target = if is_symlink {
        sftp.readlink(&path_buf)
            .ok()
            .map(|path| remote_path_text(&path))
    } else {
        None
    };
    let file_type = if is_symlink {
        "symlink"
    } else if is_dir {
        "directory"
    } else {
        "file"
    };
    let size = stat.size.unwrap_or_default();
    let modified_at = stat
        .mtime
        .and_then(|seconds| {
            SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(seconds))
        })
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(|| chrono::DateTime::<chrono::Utc>::from(SystemTime::UNIX_EPOCH));

    FileEntry {
        name,
        path: remote_path_text(&path_buf),
        size,
        modified_at,
        is_dir,
        file_type: file_type.to_owned(),
        link_target,
        permissions: stat.perm.map(|perm| perm & 0o7777),
        uid: stat.uid,
        gid: stat.gid,
    }
}

fn remote_path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn upload_file(
    profile: &SessionProfile,
    password: Option<&str>,
    local_path: &str,
    remote_dir: &str,
) -> Result<()> {
    upload_file_with_progress(
        profile,
        password,
        local_path,
        remote_dir,
        Arc::new(AtomicBool::new(false)),
        |_, _| {},
    )
    .map(|_| ())
}

pub fn upload_file_with_progress<F>(
    profile: &SessionProfile,
    password: Option<&str>,
    local_path: &str,
    remote_dir: &str,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<String>
where
    F: FnMut(u64, u64),
{
    upload_file_with_progress_with_strategy(
        profile,
        password,
        local_path,
        remote_dir,
        TransferConflictStrategy::Overwrite,
        cancel,
        on_progress,
    )
}

pub fn upload_file_with_progress_with_strategy<F>(
    profile: &SessionProfile,
    password: Option<&str>,
    local_path: &str,
    remote_dir: &str,
    conflict: TransferConflictStrategy,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<String>
where
    F: FnMut(u64, u64),
{
    let session = connect(profile, password)?;
    let sftp = session.sftp().context("failed to start SFTP subsystem")?;
    upload_with_sftp(&sftp, local_path, remote_dir, conflict, cancel, on_progress)
}

/// Upload over an already-open SFTP channel.
///
/// Split out from the connecting wrapper so a transfer queue can reuse one
/// authenticated session instead of paying a TCP connect plus handshake plus
/// auth per file.
pub fn upload_with_sftp<F>(
    sftp: &ssh2::Sftp,
    local_path: &str,
    remote_dir: &str,
    conflict: TransferConflictStrategy,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<String>
where
    F: FnMut(u64, u64),
{
    let local_path = Path::new(local_path);
    let file_name = local_path
        .file_name()
        .ok_or_else(|| anyhow!("local file name is missing"))?
        .to_string_lossy();
    let remote_path = resolve_remote_child_path(sftp, remote_dir, &file_name, conflict)?;

    let total = local_total_size(local_path, &cancel)?;
    let root_metadata = fs::symlink_metadata(local_path).ok();
    let mut transferred = 0_u64;
    on_progress(transferred, total);
    if root_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_symlink())
    {
        upload_symlink(
            sftp,
            local_path,
            Path::new(&remote_path),
            total,
            &mut transferred,
            conflict,
            &mut on_progress,
        )
        .context("failed to upload symlink")?;
    } else if root_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.is_dir())
    {
        ensure_remote_dir(sftp, Path::new(&remote_path))?;
        upload_dir_recursive(
            sftp,
            local_path,
            &remote_path,
            total,
            &mut transferred,
            cancel,
            conflict,
            &mut on_progress,
        )
        .context("failed to upload directory")?;
        if let Some(metadata) = root_metadata.as_ref() {
            preserve_remote_metadata(sftp, Path::new(&remote_path), metadata);
        }
    } else {
        upload_single_file(
            sftp,
            local_path,
            Path::new(&remote_path),
            total,
            &mut transferred,
            cancel,
            conflict,
            &mut on_progress,
        )
        .context("failed to upload file")?;
    }
    Ok(remote_path)
}

pub fn download_file(
    profile: &SessionProfile,
    password: Option<&str>,
    remote_path: &str,
    local_dir: &str,
) -> Result<PathBuf> {
    download_file_with_progress(
        profile,
        password,
        remote_path,
        local_dir,
        Arc::new(AtomicBool::new(false)),
        |_, _| {},
    )
}

pub fn download_file_with_progress<F>(
    profile: &SessionProfile,
    password: Option<&str>,
    remote_path: &str,
    local_dir: &str,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<PathBuf>
where
    F: FnMut(u64, u64),
{
    download_file_with_progress_with_strategy(
        profile,
        password,
        remote_path,
        local_dir,
        TransferConflictStrategy::Overwrite,
        cancel,
        on_progress,
    )
}

pub fn download_file_with_progress_with_strategy<F>(
    profile: &SessionProfile,
    password: Option<&str>,
    remote_path: &str,
    local_dir: &str,
    conflict: TransferConflictStrategy,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<PathBuf>
where
    F: FnMut(u64, u64),
{
    let session = connect(profile, password)?;
    let sftp = session.sftp().context("failed to start SFTP subsystem")?;
    download_with_sftp(&sftp, remote_path, local_dir, conflict, cancel, on_progress)
}

/// Download over an already-open SFTP channel. See [`upload_with_sftp`].
pub fn download_with_sftp<F>(
    sftp: &ssh2::Sftp,
    remote_path: &str,
    local_dir: &str,
    conflict: TransferConflictStrategy,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<PathBuf>
where
    F: FnMut(u64, u64),
{
    let file_name = Path::new(remote_path)
        .file_name()
        .ok_or_else(|| anyhow!("remote file name is missing"))?;
    let local_path = resolve_local_child_path(Path::new(local_dir), file_name, conflict)?;
    let remote_path_text = remote_path.to_owned();
    let remote_path = Path::new(&remote_path_text);
    let stat = sftp
        .lstat(remote_path)
        .with_context(|| format!("failed to stat remote path {}", remote_path.display()))?;
    let total = remote_total_size(sftp, remote_path, &cancel)?;
    let mut transferred = 0_u64;
    on_progress(transferred, total);
    if stat.file_type().is_symlink() {
        download_symlink(
            sftp,
            remote_path,
            &local_path,
            total,
            &mut transferred,
            conflict,
            &mut on_progress,
        )
        .context("failed to download symlink")?;
    } else if stat.is_dir() {
        fs::create_dir_all(&local_path)
            .with_context(|| format!("failed to create {}", local_path.display()))?;
        download_dir_recursive(
            sftp,
            &remote_path_text,
            &local_path,
            total,
            &mut transferred,
            cancel,
            conflict,
            &mut on_progress,
        )
        .context("failed to download directory")?;
        preserve_local_permissions(&local_path, stat.perm);
        preserve_local_times(&local_path, stat.atime, stat.mtime);
    } else {
        download_single_file(
            sftp,
            remote_path,
            &local_path,
            total,
            &mut transferred,
            cancel,
            conflict,
            &mut on_progress,
        )
        .context("failed to download file")?;
    }
    Ok(local_path)
}

pub fn create_remote_dir(
    profile: &SessionProfile,
    password: Option<&str>,
    parent: &str,
    name: &str,
) -> Result<()> {
    SftpConnection::connect(profile, password)?.create_dir(parent, name)
}

pub fn remove_remote_path(
    profile: &SessionProfile,
    password: Option<&str>,
    path: &str,
    is_dir: bool,
    recursive: bool,
) -> Result<()> {
    SftpConnection::connect(profile, password)?.remove_path(path, is_dir, recursive)
}

pub fn rename_remote_path(
    profile: &SessionProfile,
    password: Option<&str>,
    path: &str,
    new_name: &str,
) -> Result<String> {
    SftpConnection::connect(profile, password)?.rename_path(path, new_name)
}

fn connect(profile: &SessionProfile, password: Option<&str>) -> Result<ssh2::Session> {
    ssh::establish(profile, password).map_err(|error| anyhow!(error.to_string()))
}

fn copy_with_progress<R, W, F>(
    reader: &mut R,
    writer: &mut W,
    total: u64,
    cancel: Arc<AtomicBool>,
    on_progress: &mut F,
) -> Result<()>
where
    R: Read,
    W: Write,
    F: FnMut(u64, u64),
{
    let mut transferred = 0_u64;
    on_progress(transferred, total);
    copy_with_progress_accum(reader, writer, total, &mut transferred, cancel, on_progress)
}

fn copy_with_progress_accum<R, W, F>(
    reader: &mut R,
    writer: &mut W,
    total: u64,
    transferred: &mut u64,
    cancel: Arc<AtomicBool>,
    on_progress: &mut F,
) -> Result<()>
where
    R: Read,
    W: Write,
    F: FnMut(u64, u64),
{
    let mut buffer = [0_u8; 64 * 1024];
    let mut last_progress = Instant::now()
        .checked_sub(TRANSFER_PROGRESS_INTERVAL)
        .unwrap_or_else(Instant::now);
    loop {
        if cancel.load(Ordering::Relaxed) {
            on_progress(*transferred, total);
            bail!("transfer cancelled");
        }

        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let mut offset = 0;
        while offset < read {
            if cancel.load(Ordering::Relaxed) {
                on_progress(*transferred, total);
                bail!("transfer cancelled");
            }
            let wrote = writer.write(&buffer[offset..read])?;
            if wrote == 0 {
                bail!(
                    "传输中断，没有写入新的数据",
                );
            }
            offset += wrote;
            *transferred += wrote as u64;
            let now = Instant::now();
            if now.duration_since(last_progress) >= TRANSFER_PROGRESS_INTERVAL {
                on_progress(*transferred, total);
                last_progress = now;
            }
        }
    }
    on_progress(*transferred, total);
    writer.flush().ok();
    Ok(())
}

fn upload_symlink<F>(
    sftp: &ssh2::Sftp,
    local_path: &Path,
    remote_path: &Path,
    total: u64,
    transferred: &mut u64,
    conflict: TransferConflictStrategy,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    if sftp.lstat(remote_path).is_ok() {
        if matches!(
            conflict,
            TransferConflictStrategy::Skip | TransferConflictStrategy::Resume
        ) {
            on_progress(*transferred, total);
            return Ok(());
        }
        sftp.unlink(remote_path)
            .with_context(|| format!("failed to replace remote path {}", remote_path.display()))?;
    }

    let target = local_symlink_target_text(local_path)?;
    sftp.symlink(Path::new(&target), remote_path)
        .with_context(|| format!("failed to create remote symlink {}", remote_path.display()))?;
    on_progress(*transferred, total);
    Ok(())
}


enum ResumeChoice {
    Append(u64),
    Complete,
    Restart,
    TargetLarger { target: u64, source: u64 },
    SizeUnknown,
}

fn choose_resume(target_size: Option<u64>, source_size: Option<u64>) -> ResumeChoice {
    if matches!(target_size, Some(0) | None) && source_size.is_none() {
        return ResumeChoice::Restart;
    }
    let Some(source_size) = source_size else {
        return ResumeChoice::SizeUnknown;
    };
    match target_size {
        Some(target) if target > source_size => ResumeChoice::TargetLarger {
            target,
            source: source_size,
        },
        Some(target) if target > 0 && target < source_size => ResumeChoice::Append(target),
        Some(target) if target == source_size && source_size > 0 => ResumeChoice::Complete,
        _ => ResumeChoice::Restart,
    }
}

fn resume_target_larger_message(
    path: &Path,
    target: u64,
    source: u64,
    target_is_local: bool,
) -> String {
    if target_is_local {
        format!(
            "无法续传 {}：本地文件比远程文件更大（本地 {} 字节，远程 {} 字节）。如需替换，请改用覆盖",
            path.display(),
            target,
            source
        )
    } else {
        format!(
            "无法续传 {}：远程文件比本地文件更大（远程 {} 字节，本地 {} 字节）。如需替换，请改用覆盖",
            path.display(),
            target,
            source
        )
    }
}

fn resume_size_unknown_message(path: &Path) -> String {
    format!("无法续传 {}：无法确认远程文件大小，已保留现有文件。如需替换，请改用覆盖", path.display())
}

fn upload_single_file<F>(
    sftp: &ssh2::Sftp,
    local_path: &Path,
    remote_path: &Path,
    total: u64,
    transferred: &mut u64,
    cancel: Arc<AtomicBool>,
    conflict: TransferConflictStrategy,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let metadata = fs::metadata(local_path)
        .with_context(|| format!("failed to stat {}", local_path.display()))?;
    if matches!(conflict, TransferConflictStrategy::Skip) && sftp.stat(remote_path).is_ok() {
        *transferred += metadata.len();
        on_progress(*transferred, total);
        return Ok(());
    }

    let mut local = File::open(local_path)
        .with_context(|| format!("failed to open {}", local_path.display()))?;
    let mut remote = if matches!(conflict, TransferConflictStrategy::Resume) {
        if let Ok(stat) = sftp.stat(remote_path) {
            match choose_resume(stat.size, Some(metadata.len())) {
                ResumeChoice::Append(remote_size) => {
                    local
                        .seek(SeekFrom::Start(remote_size))
                        .with_context(|| format!("failed to seek {}", local_path.display()))?;
                    let mut remote = sftp
                        .open_mode(remote_path, OpenFlags::WRITE, 0o644, OpenType::File)
                        .with_context(|| {
                            format!("failed to resume remote file {}", remote_path.display())
                        })?;
                    remote
                        .seek(SeekFrom::Start(remote_size))
                        .with_context(|| {
                            format!("failed to seek remote file {}", remote_path.display())
                        })?;
                    *transferred += remote_size;
                    on_progress(*transferred, total);
                    remote
                }
                ResumeChoice::Complete => {
                    *transferred += metadata.len();
                    on_progress(*transferred, total);
                    preserve_remote_metadata(sftp, remote_path, &metadata);
                    return Ok(());
                }
                ResumeChoice::TargetLarger { target, source } => {
                    bail!(
                        "{}",
                        resume_target_larger_message(remote_path, target, source, false)
                    );
                }
                ResumeChoice::SizeUnknown => {
                    bail!("{}", resume_size_unknown_message(remote_path));
                }
                ResumeChoice::Restart => sftp.create(remote_path).with_context(|| {
                    format!("failed to create remote file {}", remote_path.display())
                })?,
            }
        } else {
            sftp.create(remote_path).with_context(|| {
                format!("failed to create remote file {}", remote_path.display())
            })?
        }
    } else {
        sftp.create(remote_path)
            .with_context(|| format!("failed to create remote file {}", remote_path.display()))?
    };
    copy_with_progress_accum(
        &mut local,
        &mut remote,
        total,
        transferred,
        cancel,
        on_progress,
    )?;
    drop(remote);
    drop(local);
    preserve_remote_metadata(sftp, remote_path, &metadata);
    Ok(())
}

fn upload_dir_recursive<F>(
    sftp: &ssh2::Sftp,
    local_dir: &Path,
    remote_dir: &str,
    total: u64,
    transferred: &mut u64,
    cancel: Arc<AtomicBool>,
    conflict: TransferConflictStrategy,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    for entry in fs::read_dir(local_dir)
        .with_context(|| format!("failed to read {}", local_dir.display()))?
    {
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        let entry = entry?;
        let local_path = entry.path();
        let remote_name = entry.file_name().to_string_lossy().to_string();
        let metadata = fs::symlink_metadata(&local_path)
            .with_context(|| format!("failed to stat {}", local_path.display()))?;
        if local_path_is_link(&local_path, &metadata) {
            let remote_path = resolve_remote_child_path(sftp, remote_dir, &remote_name, conflict)?;
            upload_symlink(
                sftp,
                &local_path,
                Path::new(&remote_path),
                total,
                transferred,
                conflict,
                on_progress,
            )?;
        } else if metadata.is_dir() {
            let remote_path = resolve_remote_child_path(sftp, remote_dir, &remote_name, conflict)?;
            ensure_remote_dir(sftp, Path::new(&remote_path))?;
            upload_dir_recursive(
                sftp,
                &local_path,
                &remote_path,
                total,
                transferred,
                cancel.clone(),
                conflict,
                on_progress,
            )?;
            preserve_remote_metadata(sftp, Path::new(&remote_path), &metadata);
        } else if metadata.is_file() {
            let remote_path = resolve_remote_child_path(sftp, remote_dir, &remote_name, conflict)?;
            upload_single_file(
                sftp,
                &local_path,
                Path::new(&remote_path),
                total,
                transferred,
                cancel.clone(),
                conflict,
                on_progress,
            )?;
        }
    }
    Ok(())
}

fn download_single_file<F>(
    sftp: &ssh2::Sftp,
    remote_path: &Path,
    local_path: &Path,
    total: u64,
    transferred: &mut u64,
    cancel: Arc<AtomicBool>,
    conflict: TransferConflictStrategy,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    if matches!(conflict, TransferConflictStrategy::Skip) && local_path.exists() {
        let size = sftp
            .stat(remote_path)
            .ok()
            .and_then(|stat| stat.size)
            .unwrap_or_default();
        *transferred += size;
        on_progress(*transferred, total);
        return Ok(());
    }

    let stat = sftp
        .stat(remote_path)
        .with_context(|| format!("failed to stat remote file {}", remote_path.display()))?;
    let (mut remote, mut local) =
        if matches!(conflict, TransferConflictStrategy::Resume) && local_path.exists() {
            let local_size = fs::metadata(local_path)
                .with_context(|| format!("failed to stat {}", local_path.display()))?
                .len();
            match choose_resume(Some(local_size), stat.size) {
                ResumeChoice::Append(offset) => {
                    let mut remote = sftp.open(remote_path).with_context(|| {
                        format!("failed to open remote file {}", remote_path.display())
                    })?;
                    remote.seek(SeekFrom::Start(offset)).with_context(|| {
                        format!("failed to seek remote file {}", remote_path.display())
                    })?;
                    *transferred += offset;
                    on_progress(*transferred, total);
                    let local = OpenOptions::new().append(true).open(local_path).with_context(
                        || format!("failed to resume {}", local_path.display()),
                    )?;
                    (remote, local)
                }
                ResumeChoice::Complete => {
                    *transferred += local_size;
                    on_progress(*transferred, total);
                    preserve_local_permissions(local_path, stat.perm);
                    preserve_local_times(local_path, stat.atime, stat.mtime);
                    return Ok(());
                }
                ResumeChoice::TargetLarger { target, source } => {
                    bail!(
                        "{}",
                        resume_target_larger_message(local_path, target, source, true)
                    );
                }
                ResumeChoice::SizeUnknown => {
                    bail!("{}", resume_size_unknown_message(local_path));
                }
                ResumeChoice::Restart => {
                    let remote = sftp.open(remote_path).with_context(|| {
                        format!("failed to open remote file {}", remote_path.display())
                    })?;
                    let local = File::create(local_path)
                        .with_context(|| format!("failed to create {}", local_path.display()))?;
                    (remote, local)
                }
            }
        } else {
            let remote = sftp.open(remote_path).with_context(|| {
                format!("failed to open remote file {}", remote_path.display())
            })?;
            let local = File::create(local_path)
                .with_context(|| format!("failed to create {}", local_path.display()))?;
            (remote, local)
        };
    copy_with_progress_accum(
        &mut remote,
        &mut local,
        total,
        transferred,
        cancel,
        on_progress,
    )?;
    preserve_local_permissions(local_path, stat.perm);
    drop(local);
    preserve_local_times(local_path, stat.atime, stat.mtime);
    Ok(())
}

fn download_symlink<F>(
    sftp: &ssh2::Sftp,
    remote_path: &Path,
    local_path: &Path,
    total: u64,
    transferred: &mut u64,
    conflict: TransferConflictStrategy,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    if local_path.exists() || fs::symlink_metadata(local_path).is_ok() {
        if matches!(
            conflict,
            TransferConflictStrategy::Skip | TransferConflictStrategy::Resume
        ) {
            on_progress(*transferred, total);
            return Ok(());
        }
        remove_local_existing_path(local_path)
            .with_context(|| format!("failed to replace {}", local_path.display()))?;
    }

    let target = sftp
        .readlink(remote_path)
        .with_context(|| format!("failed to read remote symlink {}", remote_path.display()))?;
    create_local_symlink(&target, local_path)
        .with_context(|| format!("failed to create local symlink {}", local_path.display()))?;
    on_progress(*transferred, total);
    Ok(())
}

fn download_dir_recursive<F>(
    sftp: &ssh2::Sftp,
    remote_dir: &str,
    local_dir: &Path,
    total: u64,
    transferred: &mut u64,
    cancel: Arc<AtomicBool>,
    conflict: TransferConflictStrategy,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let mut directories = Vec::new();
    let mut failure = None;
    visit_remote_entries(sftp, Path::new(remote_dir), None, |remote_path, stat| {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        let Some(name) = remote_path.file_name() else {
            failure = Some(anyhow!("remote file name is missing"));
            return false;
        };
        let local_path = local_dir.join(name);
        let result = if stat.file_type().is_symlink() {
            match resolve_local_path(&local_path, conflict) {
                Ok(local_path) => download_symlink(
                    sftp,
                    &remote_path,
                    &local_path,
                    total,
                    transferred,
                    conflict,
                    on_progress,
                ),
                Err(error) => Err(error),
            }
        } else if stat.is_dir() {
            directories.push((
                remote_path_text(&remote_path),
                local_path,
                stat.perm,
                stat.atime,
                stat.mtime,
            ));
            Ok(())
        } else {
            match resolve_local_path(&local_path, conflict) {
                Ok(local_path) => download_single_file(
                    sftp,
                    &remote_path,
                    &local_path,
                    total,
                    transferred,
                    cancel.clone(),
                    conflict,
                    on_progress,
                ),
                Err(error) => Err(error),
            }
        };
        if let Err(error) = result {
            failure = Some(error);
            return false;
        }
        true
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }

    for (remote_child, local_path, perm, atime, mtime) in directories {
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        let local_path = resolve_local_path(&local_path, conflict)?;
        fs::create_dir_all(&local_path)
            .with_context(|| format!("failed to create {}", local_path.display()))?;
        download_dir_recursive(
            sftp,
            &remote_child,
            &local_path,
            total,
            transferred,
            cancel.clone(),
            conflict,
            on_progress,
        )?;
        preserve_local_permissions(&local_path, perm);
        preserve_local_times(&local_path, atime, mtime);
    }
    Ok(())
}

fn local_total_size(path: &Path, cancel: &AtomicBool) -> Result<u64> {
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("failed to stat {}", path.display()))?;
    if local_path_is_link(path, &metadata) {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }

    let mut total = 0_u64;
    for entry in fs::read_dir(path).with_context(|| format!("failed to read {}", path.display()))? {
        total += local_total_size(&entry?.path(), cancel)?;
    }
    Ok(total)
}

fn local_symlink_target_text(path: &Path) -> Result<String> {
    fs::read_link(path)
        .with_context(|| format!("failed to read symlink {}", path.display()))
        .map(|target| target.to_string_lossy().replace('\\', "/"))
}

fn remote_total_size(sftp: &ssh2::Sftp, path: &Path, cancel: &AtomicBool) -> Result<u64> {
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    if stat.file_type().is_symlink() {
        return Ok(0);
    }
    if !stat.is_dir() {
        return Ok(stat.size.unwrap_or_default());
    }

    let mut total = 0_u64;
    let mut directories = Vec::new();
    visit_remote_entries(sftp, path, None, |child, child_stat| {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        if child_stat.file_type().is_symlink() {
            return true;
        }
        if child_stat.is_dir() {
            directories.push(child);
        } else {
            total += child_stat.size.unwrap_or_default();
        }
        true
    })?;
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }
    for child in directories {
        total += remote_total_size(sftp, &child, cancel)?;
    }
    Ok(total)
}

fn resolve_remote_child_path(
    sftp: &ssh2::Sftp,
    parent: &str,
    name: &str,
    conflict: TransferConflictStrategy,
) -> Result<String> {
    let candidate = remote_child_path(parent, name);
    if !matches!(conflict, TransferConflictStrategy::Rename)
        || !remote_path_exists(sftp, Path::new(&candidate))
    {
        return Ok(candidate);
    }

    let (stem, suffix) = split_file_name(name);
    for index in 1..10_000 {
        let next_name = format!("{} ({}){}", stem, index, suffix);
        let next_path = remote_child_path(parent, &next_name);
        if !remote_path_exists(sftp, Path::new(&next_path)) {
            return Ok(next_path);
        }
    }
    bail!("failed to allocate unique remote path for {}", candidate)
}

fn remote_path_exists(sftp: &ssh2::Sftp, path: &Path) -> bool {
    sftp.lstat(path).is_ok()
}

fn resolve_remote_move_target(
    sftp: &ssh2::Sftp,
    source: &str,
    target_path: &str,
) -> Result<String> {
    let target = target_path.trim().replace('\\', "/");
    if target.is_empty() {
        bail!("remote target path is empty");
    }

    if let Ok(stat) = sftp.stat(Path::new(&target)) {
        if stat.is_dir() {
            let source_name = Path::new(source)
                .file_name()
                .ok_or_else(|| anyhow!("remote file name is missing"))?
                .to_string_lossy();
            return Ok(remote_child_path(&target, &source_name));
        }
        bail!("remote target already exists: {}", target);
    }

    if target.ends_with('/') {
        bail!("remote target directory does not exist: {}", target);
    }
    Ok(target)
}

fn resolve_local_child_path(
    parent: &Path,
    name: &std::ffi::OsStr,
    conflict: TransferConflictStrategy,
) -> Result<PathBuf> {
    resolve_local_path(&parent.join(name), conflict)
}

fn resolve_local_path(path: &Path, conflict: TransferConflictStrategy) -> Result<PathBuf> {
    if !matches!(conflict, TransferConflictStrategy::Rename) || !local_path_exists(path) {
        return Ok(path.to_path_buf());
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow!("local file name is missing"))?
        .to_string_lossy();
    let (stem, suffix) = split_file_name(&file_name);
    for index in 1..10_000 {
        let candidate = parent.join(format!("{} ({}){}", stem, index, suffix));
        if !local_path_exists(&candidate) {
            return Ok(candidate);
        }
    }
    bail!(
        "failed to allocate unique local path for {}",
        path.display()
    )
}

fn local_path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn remove_local_existing_path(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "本地目标是目录，不能用符号链接覆盖",
        ));
    }
    fs::remove_file(path)
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

fn split_file_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(index) if index > 0 => (name[..index].to_owned(), name[index..].to_owned()),
        _ => (name.to_owned(), String::new()),
    }
}

fn ensure_remote_dir(sftp: &ssh2::Sftp, path: &Path) -> Result<()> {
    if let Ok(stat) = sftp.stat(path) {
        if stat.is_dir() {
            return Ok(());
        }
        bail!(
            "remote path exists and is not a directory: {}",
            path.display()
        );
    }
    sftp.mkdir(path, 0o755)
        .with_context(|| format!("failed to create remote directory {}", path.display()))
}

fn resolve_remote_relative_create_path<'a>(
    parent: &str,
    name: &'a str,
) -> Result<(String, Vec<&'a str>)> {
    let segments = validate_remote_relative_dir_path(name)?;
    let mut path = parent.trim().replace('\\', "/");
    for segment in &segments {
        path = remote_child_path(&path, segment);
    }
    let parent_dirs = segments.iter().take(segments.len() - 1).copied().collect();
    Ok((path, parent_dirs))
}

fn ensure_remote_parent_dirs(sftp: &ssh2::Sftp, parent: &str, segments: &[&str]) -> Result<()> {
    let mut current = parent.trim().replace('\\', "/");
    for segment in segments {
        current = remote_child_path(&current, *segment);
        ensure_remote_dir(sftp, Path::new(&current))?;
    }
    Ok(())
}

fn preserve_remote_metadata(sftp: &ssh2::Sftp, remote_path: &Path, metadata: &fs::Metadata) {
    if let Some(mode) = local_mode(metadata) {
        let _ = set_remote_permissions(sftp, remote_path, mode);
    }
    let atime = local_accessed_seconds(metadata);
    let mtime = local_modified_seconds(metadata);
    let _ = set_remote_times(sftp, remote_path, atime, mtime);
}

#[cfg(unix)]
fn local_mode(metadata: &fs::Metadata) -> Option<u32> {
    Some(metadata.permissions().mode() & 0o7777)
}

#[cfg(not(unix))]
fn local_mode(metadata: &fs::Metadata) -> Option<u32> {
    let readonly = metadata.permissions().readonly();
    match (metadata.is_dir(), readonly) {
        (true, true) => Some(0o555),
        (true, false) => Some(0o755),
        (false, true) => Some(0o444),
        (false, false) => Some(0o644),
    }
}

fn local_modified_seconds(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn local_accessed_seconds(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .accessed()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

#[cfg(unix)]
fn preserve_local_permissions(path: &Path, mode: Option<u32>) {
    let Some(mode) = mode else {
        return;
    };
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777));
}

#[cfg(not(unix))]
fn preserve_local_permissions(path: &Path, mode: Option<u32>) {
    let Some(mode) = mode else {
        return;
    };
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_readonly((mode & 0o200) == 0);
        let _ = fs::set_permissions(path, permissions);
    }
}

fn preserve_local_times(path: &Path, atime: Option<u64>, mtime: Option<u64>) {
    let Some(mtime) = mtime else {
        return;
    };
    let accessed = FileTime::from_unix_time(atime.unwrap_or(mtime) as i64, 0);
    let modified = FileTime::from_unix_time(mtime as i64, 0);
    let _ = set_file_times(path, accessed, modified);
}

fn collect_remote_path_stats(
    sftp: &ssh2::Sftp,
    path: &Path,
    stats: &mut RemotePathStats,
) -> Result<()> {
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    collect_remote_path_stats_from_stat(sftp, path, stat, stats)
}

fn collect_remote_path_stats_from_stat(
    sftp: &ssh2::Sftp,
    path: &Path,
    stat: ssh2::FileStat,
    stats: &mut RemotePathStats,
) -> Result<()> {
    if stat.is_dir() && !stat.file_type().is_symlink() {
        stats.dir_count += 1;
        let mut children = Vec::new();
        visit_remote_entries(sftp, path, None, |child, child_stat| {
            children.push((child, child_stat));
            true
        })?;
        for (child, child_stat) in children {
            collect_remote_path_stats_from_stat(sftp, &child, child_stat, stats)?;
        }
    } else {
        stats.file_count += 1;
        stats.total_size += stat.size.unwrap_or_default();
    }

    Ok(())
}

fn remove_remote_recursive(sftp: &ssh2::Sftp, path: &Path) -> Result<()> {
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return sftp
            .unlink(path)
            .with_context(|| format!("failed to remove remote file {}", path.display()));
    }

    let children = read_remote_entries(sftp, path, None)?;
    for (child, _) in children {
        remove_remote_recursive(sftp, &child)?;
    }

    sftp.rmdir(path)
        .with_context(|| format!("failed to remove remote directory {}", path.display()))
}

fn copy_remote_path(
    sftp: &ssh2::Sftp,
    source: &Path,
    target: &Path,
    is_dir_hint: bool,
) -> Result<()> {
    if sftp.lstat(target).is_ok() {
        bail!("remote target already exists: {}", target.display());
    }

    let stat = sftp
        .lstat(source)
        .with_context(|| format!("failed to stat remote path {}", source.display()))?;

    if stat.file_type().is_symlink() {
        let link_target = sftp
            .readlink(source)
            .with_context(|| format!("failed to read symlink {}", source.display()))?;
        return sftp
            .symlink(&link_target, target)
            .with_context(|| format!("failed to copy symlink to {}", target.display()));
    }

    if stat.is_dir() || is_dir_hint {
        let mode = (stat.perm.unwrap_or(0o755) & 0o7777) as i32;
        sftp.mkdir(target, mode)
            .with_context(|| format!("failed to create remote directory {}", target.display()))?;
        let children = read_remote_entries(sftp, source, None)?;
        for (child, _) in children {
            let name = child
                .file_name()
                .ok_or_else(|| anyhow!("remote file name is missing"))?;
            let child_target =
                remote_child_path(&remote_path_text(target), &name.to_string_lossy());
            copy_remote_path(sftp, &child, Path::new(&child_target), false)?;
        }
        preserve_remote_owner(sftp, target, stat.uid, stat.gid);
        preserve_remote_permissions(sftp, target, stat.perm);
        let _ = set_remote_times(sftp, target, stat.atime, stat.mtime);
        return Ok(());
    }

    let mut input = sftp
        .open(source)
        .with_context(|| format!("failed to open remote file {}", source.display()))?;
    let mut output = sftp
        .create(target)
        .with_context(|| format!("failed to create remote file {}", target.display()))?;
    std::io::copy(&mut input, &mut output)
        .with_context(|| format!("failed to copy remote file {}", source.display()))?;
    output.flush().ok();
    preserve_remote_owner(sftp, target, stat.uid, stat.gid);
    preserve_remote_permissions(sftp, target, stat.perm);
    let _ = set_remote_times(sftp, target, stat.atime, stat.mtime);
    Ok(())
}

fn preserve_remote_permissions(sftp: &ssh2::Sftp, path: &Path, mode: Option<u32>) {
    if let Some(mode) = mode {
        let _ = set_remote_permissions(sftp, path, mode);
    }
}

fn preserve_remote_owner(sftp: &ssh2::Sftp, path: &Path, uid: Option<u32>, gid: Option<u32>) {
    if uid.is_some() || gid.is_some() {
        let _ = chown_one(sftp, path, uid, gid);
    }
}

fn set_remote_permissions(sftp: &ssh2::Sftp, path: &Path, mode: u32) -> Result<()> {
    sftp.setstat(
        path,
        ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(mode & 0o7777),
            atime: None,
            mtime: None,
        },
    )
    .with_context(|| format!("failed to chmod {}", path.display()))
}

fn chmod_one(sftp: &ssh2::Sftp, path: &Path, mode: u32) -> Result<()> {
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    if stat.file_type().is_symlink() {
        return Ok(());
    }
    set_remote_permissions(sftp, path, mode)
}

fn chmod_recursive(sftp: &ssh2::Sftp, path: &Path, mode: u32) -> Result<()> {
    chmod_one(sftp, path, mode)?;
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return Ok(());
    }

    let children = read_remote_entries(sftp, path, None)?;
    for (child, _) in children {
        chmod_recursive(sftp, &child, mode)?;
    }
    Ok(())
}

fn chown_one(sftp: &ssh2::Sftp, path: &Path, uid: Option<u32>, gid: Option<u32>) -> Result<()> {
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    if stat.file_type().is_symlink() {
        return Ok(());
    }
    sftp.setstat(
        path,
        ssh2::FileStat {
            size: None,
            uid,
            gid,
            perm: None,
            atime: None,
            mtime: None,
        },
    )
    .with_context(|| format!("failed to change owner/group for {}", path.display()))
}

fn chown_recursive(
    sftp: &ssh2::Sftp,
    path: &Path,
    uid: Option<u32>,
    gid: Option<u32>,
) -> Result<()> {
    chown_one(sftp, path, uid, gid)?;
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return Ok(());
    }

    let children = read_remote_entries(sftp, path, None)?;
    for (child, _) in children {
        chown_recursive(sftp, &child, uid, gid)?;
    }
    Ok(())
}

fn set_remote_times(
    sftp: &ssh2::Sftp,
    path: &Path,
    atime: Option<u64>,
    mtime: Option<u64>,
) -> Result<()> {
    if atime.is_none() && mtime.is_none() {
        return Ok(());
    }
    sftp.setstat(
        path,
        ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime,
            mtime,
        },
    )
    .with_context(|| format!("failed to update times for {}", path.display()))
}

fn touch_one(sftp: &ssh2::Sftp, path: &Path, mtime: u64) -> Result<()> {
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    if stat.file_type().is_symlink() {
        return Ok(());
    }
    set_remote_times(sftp, path, None, Some(mtime))
        .with_context(|| format!("failed to update modified time for {}", path.display()))
}

fn touch_recursive(sftp: &ssh2::Sftp, path: &Path, mtime: u64) -> Result<()> {
    touch_one(sftp, path, mtime)?;
    let stat = sftp
        .lstat(path)
        .with_context(|| format!("failed to stat remote path {}", path.display()))?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return Ok(());
    }

    let children = read_remote_entries(sftp, path, None)?;
    for (child, _) in children {
        touch_recursive(sftp, &child, mtime)?;
    }
    Ok(())
}

fn validate_mode(mode: u32) -> Result<()> {
    if mode > 0o7777 {
        bail!("permission mode is invalid");
    }
    Ok(())
}

fn validate_owner_change(uid: Option<u32>, gid: Option<u32>) -> Result<()> {
    if uid.is_none() && gid.is_none() {
        bail!("uid or gid is required");
    }
    Ok(())
}

fn validate_remote_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.contains('/') || name == "." || name == ".." {
        bail!("remote file name is invalid");
    }
    Ok(())
}

fn validate_remote_relative_dir_path(path: &str) -> Result<Vec<&str>> {
    let trimmed = path.trim();
    if trimmed.is_empty()
        || trimmed.starts_with(['/', '\\'])
        || trimmed.as_bytes().get(1) == Some(&b':')
    {
        bail!("remote directory path is invalid");
    }
    let mut segments = Vec::new();
    for segment in trimmed.split(['/', '\\']) {
        if segment.is_empty() || segment == "." || segment == ".." {
            bail!("remote directory path is invalid");
        }
        segments.push(segment);
    }
    Ok(segments)
}

#[cfg(test)]
mod resume_choice_tests {
    use super::{choose_resume, ResumeChoice};

    #[test]
    fn appends_when_existing_file_is_shorter() {
        assert!(matches!(
            choose_resume(Some(4), Some(10)),
            ResumeChoice::Append(4)
        ));
    }

    #[test]
    fn skips_when_sizes_match() {
        assert!(matches!(
            choose_resume(Some(10), Some(10)),
            ResumeChoice::Complete
        ));
    }

    #[test]
    fn restarts_when_there_is_nothing_to_keep() {
        assert!(matches!(
            choose_resume(Some(0), Some(10)),
            ResumeChoice::Restart
        ));
        assert!(matches!(choose_resume(None, Some(10)), ResumeChoice::Restart));
        assert!(matches!(choose_resume(Some(0), None), ResumeChoice::Restart));
        assert!(matches!(
            choose_resume(Some(0), Some(0)),
            ResumeChoice::Restart
        ));
    }

    #[test]
    fn refuses_when_existing_file_is_larger() {
        assert!(matches!(
            choose_resume(Some(11), Some(10)),
            ResumeChoice::TargetLarger {
                target: 11,
                source: 10
            }
        ));
    }

    #[test]
    fn refuses_when_source_size_is_unknown_and_target_has_data() {
        assert!(matches!(
            choose_resume(Some(8), None),
            ResumeChoice::SizeUnknown
        ));
    }
}
