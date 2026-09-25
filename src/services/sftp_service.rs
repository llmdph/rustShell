use crate::core::{
    session::SessionProfile,
    sftp::{
        dir_entry_metadata, local_path_is_link, path_contains_query, remote_child_path,
        remote_parent_path, sort_entries_by_folded_text, text_contains_query,
        DirListing,
        FileEntry, FileSearchResult,
        TransferConflictStrategy, DIR_ENTRY_LIMIT,
    },
};
use crate::services::ssh;
use anyhow::{anyhow, bail, Context, Result};
use filetime::{set_file_times, FileTime};
use sha2::{Digest, Sha256};
use ssh2::{OpenFlags, OpenType};
use std::{
    collections::{HashMap, HashSet},
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
const ENCODED_CHAR_SCAN: u64 = 8;
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const REMOTE_LINK_KEPT: &str =
    "远程已有同名链接，没有改动它指向的文件。若要替换这个链接，请改用覆盖。";
const LOCAL_LINK_KEPT: &str =
    "本地已有同名链接，没有改动它指向的文件。若要替换这个链接，请改用覆盖。";
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

    pub fn list_dir(&self, path: &str) -> Result<DirListing> {
        list_with_sftp(&self.sftp, path)
    }

    pub fn search(&self, root: &str, query: &str, max_results: usize) -> Result<FileSearchResult> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            bail!("search query is empty");
        }
        let mut output = Vec::new();
        let mut incomplete = false;
        let mut limited = false;
        search_remote_recursive(
            &self.sftp,
            Path::new(root),
            &query,
            max_results.clamp(1, 1000),
            &mut output,
            &mut incomplete,
            &mut limited,
        )?;
        sort_entries_by_folded_text(&mut output, |entry| entry.path.as_str());
        Ok(FileSearchResult {
            entries: output,
            incomplete,
            limited,
        })
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
        let source_name = Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if source_name == new_name {
            return Ok(path.to_owned());
        }
        let target = remote_child_path(&remote_parent_path(path), new_name);
        let target_path = Path::new(&target);
        if self.sftp.lstat(target_path).is_ok() {
            if remote_name_change_is_case_only(&self.sftp, path, &source_name, new_name)? {
                rename_remote_case_only(&self.sftp, path, &target)?;
                return Ok(target);
            }
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
        let (target, case_only) = resolve_remote_move_target(&self.sftp, path, target_path)?;
        if target == path {
            bail!("remote target is the same as source");
        }
        // The server already has this name with different letters. A plain
        // rename fails, and a folder would be moved inside itself.
        if case_only {
            rename_remote_case_only(&self.sftp, path, &target)?;
            return Ok(target);
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
        let lookbehind = if start > 0 && !is_utf8_charset(charset) {
            start.min(ENCODED_CHAR_SCAN)
        } else {
            0
        };
        let probe = start - lookbehind;
        let mut file = self
            .sftp
            .open(Path::new(path))
            .with_context(|| format!("failed to open remote file {}", path))?;
        file.seek(SeekFrom::Start(probe))
            .with_context(|| format!("failed to seek remote file {}", path))?;
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(REMOTE_TEXT_PREVIEW_LIMIT + lookbehind)
            .read_to_end(&mut bytes)
            .with_context(|| format!("failed to read remote file {}", path))?;
        if start > 0 {
            trim_partial_text_prefix(&mut bytes, charset, lookbehind as usize);
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
        let Some(previous) = previous else {
            write_new_remote_file(&self.sftp, path, &bytes, mode)?;
            return Ok(());
        };
        replace_remote_file(&self.sftp, path, &bytes, mode, &previous)
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
) -> Result<DirListing> {
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
) -> Result<bool> {
    let mut dir = sftp
        .opendir(dirname)
        .with_context(|| format!("failed to list {}", dirname.display()))?;
    let parent = remote_path_text(dirname);
    let mut seen = 0usize;
    let mut truncated = false;
    loop {
        if limit.is_some_and(|limit| seen >= limit) {
            truncated = remote_dir_has_another_entry(&mut dir, dirname)?;
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
    Ok(truncated)
}

fn remote_dir_has_another_entry(dir: &mut ssh2::File, dirname: &Path) -> Result<bool> {
    loop {
        match dir.readdir() {
            Ok((filename, _)) => {
                let name = filename.to_string_lossy();
                if name == "." || name == ".." {
                    continue;
                }
                return Ok(true);
            }
            Err(error) if is_libssh2_session_code(&error, LIBSSH2_ERROR_FILE) => return Ok(false),
            Err(error) if is_libssh2_session_code(&error, LIBSSH2_ERROR_EAGAIN) => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => {
                return Err(error).with_context(|| format!("failed to list {}", dirname.display()));
            }
        }
    }
}

fn sftp_item_is_unavailable(error: &ssh2::Error) -> bool {
    // NO_SUCH_FILE, PERMISSION_DENIED, NO_SUCH_PATH. A dead session is not one of these.
    matches!(
        error.code(),
        ssh2::ErrorCode::SFTP(2) | ssh2::ErrorCode::SFTP(3) | ssh2::ErrorCode::SFTP(10)
    )
}

fn is_libssh2_session_code(error: &ssh2::Error, code: i32) -> bool {
    error.code() == ssh2::ErrorCode::Session(code)
}

fn list_with_sftp(sftp: &ssh2::Sftp, path: &str) -> Result<DirListing> {
    let mut raw_entries = Vec::new();
    let truncated = visit_remote_entries(
        sftp,
        Path::new(path),
        Some(DIR_ENTRY_LIMIT),
        |path_buf, stat| {
            raw_entries.push((path_buf, stat));
            true
        },
    )?;

    let mut entries = Vec::with_capacity(raw_entries.len());
    for (path_buf, stat) in raw_entries {
        entries.push(entry_from_stat(sftp, path_buf, stat, None));
    }

    sort_entries_by_folded_text(&mut entries, |entry| entry.name.as_str());
    Ok(DirListing { entries, truncated })
}

fn search_remote_recursive(
    sftp: &ssh2::Sftp,
    root: &Path,
    query: &str,
    max_results: usize,
    output: &mut Vec<FileEntry>,
    incomplete: &mut bool,
    limited: &mut bool,
) -> Result<()> {
    if output.len() >= max_results {
        *limited = true;
        return Ok(());
    }

    let mut directories = Vec::new();
    let visited = visit_remote_entries(sftp, root, None, |path_buf, stat| {
        if output.len() >= max_results {
            *limited = true;
            return false;
        }
        // A name without permissions looks like a file, so the search would
        // never open that folder or match the target of a link.
        let stat = resolve_remote_listing_stat(sftp, &path_buf, stat);
        let should_descend = stat.is_dir() && !stat.file_type().is_symlink();
        let is_symlink = stat.file_type().is_symlink();
        let name = path_buf
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| remote_path_text(&path_buf));
        let mut matched = text_contains_query(&name, query) || path_contains_query(&path_buf, query);
        let known_link = if is_symlink {
            let target = sftp.readlink(&path_buf).ok();
            if !matched {
                if let Some(target) = target.as_ref() {
                    matched = path_contains_query(target, query);
                }
            }
            Some(target.map(|path| remote_path_text(&path)))
        } else {
            None
        };
        if matched {
            output.push(entry_from_stat(sftp, path_buf.clone(), stat, known_link));
        }
        if should_descend {
            directories.push(path_buf);
        }
        if output.len() >= max_results {
            *limited = true;
            return false;
        }
        true
    });
    if let Err(error) = visited {
        if output.is_empty() && directories.is_empty() {
            return Err(error);
        }
        *incomplete = true;
    }

    for directory in directories {
        if output.len() >= max_results {
            *limited = true;
            break;
        }
        if search_remote_recursive(
            sftp,
            &directory,
            query,
            max_results,
            output,
            incomplete,
            limited,
        )
        .is_err()
        {
            *incomplete = true;
        }
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
        return;
    }
    trim_partial_encoded_suffix(bytes, text_encoding(charset));
}

fn trim_partial_text_prefix(bytes: &mut Vec<u8>, charset: &str, cut_at: usize) {
    if bytes.is_empty() {
        return;
    }
    if is_utf8_charset(charset) {
        let mut index = 0;
        while index < bytes.len() && bytes[index] & 0b1100_0000 == 0b1000_0000 {
            index += 1;
        }
        if index > 0 {
            bytes.drain(..index);
        }
        return;
    }
    trim_partial_encoded_prefix(bytes, text_encoding(charset), cut_at);
}

fn trim_partial_encoded_suffix(bytes: &mut Vec<u8>, encoding: &'static encoding_rs::Encoding) {
    let floor = bytes.len().saturating_sub(ENCODED_CHAR_SCAN as usize);
    while bytes.len() > floor && encoded_tail_is_partial(bytes, encoding) {
        bytes.pop();
    }
}

fn trim_partial_encoded_prefix(
    bytes: &mut Vec<u8>,
    encoding: &'static encoding_rs::Encoding,
    cut_at: usize,
) {
    if cut_at == 0 || cut_at >= bytes.len() {
        return;
    }
    let last = (cut_at + ENCODED_CHAR_SCAN as usize).min(bytes.len());
    let mut keep_from = last;
    for boundary in cut_at..=last {
        if !encoded_tail_is_partial(&bytes[..boundary], encoding) {
            keep_from = boundary;
            break;
        }
    }
    if keep_from > 0 {
        bytes.drain(..keep_from);
    }
}

fn encoded_tail_is_partial(bytes: &[u8], encoding: &'static encoding_rs::Encoding) -> bool {
    !bytes.is_empty()
        && decode_text_for_boundary(bytes, encoding, true)
            != decode_text_for_boundary(bytes, encoding, false)
}

fn decode_text_for_boundary(
    bytes: &[u8],
    encoding: &'static encoding_rs::Encoding,
    last: bool,
) -> String {
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut output = String::new();
    let mut offset = 0usize;
    loop {
        let remaining = bytes.len().saturating_sub(offset);
        let needed = decoder
            .max_utf8_buffer_length(remaining)
            .unwrap_or(remaining.saturating_mul(4).saturating_add(32));
        output.reserve(needed.max(8));
        let (result, read, _) = decoder.decode_to_string(&bytes[offset..], &mut output, last);
        if read == 0 {
            break;
        }
        offset += read;
        if matches!(result, encoding_rs::CoderResult::InputEmpty) || offset >= bytes.len() {
            break;
        }
    }
    output
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

fn entry_from_stat(
    sftp: &ssh2::Sftp,
    path_buf: PathBuf,
    stat: ssh2::FileStat,
    known_link: Option<Option<String>>,
) -> FileEntry {
    // Some servers omit permissions in a directory listing, and without them
    // every entry looks like a file. A follow-up stat is only needed then.
    let stat = if stat.perm.is_some() {
        stat
    } else {
        sftp.lstat(&path_buf).unwrap_or(stat)
    };
    let name = path_buf
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| remote_path_text(&path_buf));
    let is_dir = stat.is_dir();
    let is_symlink = stat.file_type().is_symlink();
    let link_target = if is_symlink {
        if let Some(known_link) = known_link {
            known_link
        } else {
            sftp.readlink(&path_buf)
                .ok()
                .map(|path| remote_path_text(&path))
        }
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
    upload_with_sftp(
        &sftp,
        local_path,
        remote_dir,
        conflict,
        None,
        cancel,
        on_progress,
    )
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
    destination_name: Option<&str>,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<String>
where
    F: FnMut(u64, u64),
{
    let local_path = Path::new(local_path);
    let file_name = match preferred_transfer_name(destination_name)? {
        Some(name) => name,
        None => local_path
            .file_name()
            .ok_or_else(|| anyhow!("local file name is missing"))?
            .to_string_lossy()
            .into_owned(),
    };
    let remote_path = resolve_remote_child_path(sftp, remote_dir, &file_name, conflict)?;

    let total = local_total_size(local_path, &cancel)?;
    let root_metadata = fs::symlink_metadata(local_path).ok();
    let mut transferred = 0_u64;
    on_progress(transferred, total);
    ensure_upload_directory(sftp, remote_dir)?;
    if root_metadata
        .as_ref()
        .is_some_and(|metadata| local_path_is_link(local_path, metadata))
    {
        upload_symlink(
            sftp,
            local_path,
            Path::new(&remote_path),
            total,
            &mut transferred,
            conflict,
            None,
            &mut on_progress,
        )
        .context("failed to upload symlink")?;
    } else if root_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.is_dir())
    {
        if open_remote_upload_dir(sftp, Path::new(&remote_path), conflict)? {
            upload_dir_recursive(
                sftp,
                local_path,
                &remote_path,
                total,
                &mut transferred,
                cancel,
                conflict,
                &mut on_progress,
                true,
            )
            .context("failed to upload directory")?;
            if let Some(metadata) = root_metadata.as_ref() {
                preserve_remote_metadata(sftp, Path::new(&remote_path), metadata);
            }
        } else {
            transferred = total;
            on_progress(transferred, total);
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
            None,
            None,
            RemoteStatCache::Unknown,
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
    download_with_sftp(
        &sftp,
        remote_path,
        local_dir,
        conflict,
        None,
        cancel,
        on_progress,
    )
}

/// Download over an already-open SFTP channel. See [`upload_with_sftp`].
pub fn download_with_sftp<F>(
    sftp: &ssh2::Sftp,
    remote_path: &str,
    local_dir: &str,
    conflict: TransferConflictStrategy,
    destination_name: Option<&str>,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> Result<PathBuf>
where
    F: FnMut(u64, u64),
{
    let file_name = match preferred_transfer_name(destination_name)? {
        Some(name) => name,
        None => Path::new(remote_path)
            .file_name()
            .ok_or_else(|| anyhow!("remote file name is missing"))?
            .to_string_lossy()
            .into_owned(),
    };
    let local_path = resolve_local_child_path(Path::new(local_dir), Path::new(&file_name).as_os_str(), conflict)?;
    let remote_path_text = remote_path.to_owned();
    let remote_path = Path::new(&remote_path_text);
    let stat = sftp
        .lstat(remote_path)
        .with_context(|| format!("failed to stat remote path {}", remote_path.display()))?;
    // A folder is listed once while its size is measured. The copy below uses
    // that listing. A file or link does not read any children.
    let cached_tree = if stat.file_type().is_symlink() || !stat.is_dir() {
        None
    } else {
        Some(measure_remote_tree(
            sftp,
            remote_path,
            Some(stat.clone()),
            &cancel,
        )?)
    };
    let total = match &cached_tree {
        Some((size, _)) => *size,
        None => remote_total_size(sftp, remote_path, &cancel)?,
    };
    let mut transferred = 0_u64;
    on_progress(transferred, total);
    if !local_dir.is_empty() && local_dir != "." {
        ensure_local_dir(Path::new(local_dir))?;
    }
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
        if open_local_download_dir(&local_path, conflict)? {
            download_dir_recursive(
                sftp,
                &remote_path_text,
                &local_path,
                total,
                &mut transferred,
                cancel,
                conflict,
                &mut on_progress,
                cached_tree.as_ref().map(|(_, listing)| listing),
                true,
            )
            .context("failed to download directory")?;
            preserve_local_permissions(&local_path, stat.perm);
            preserve_local_times(&local_path, stat.atime, stat.mtime);
        } else {
            transferred = total;
            on_progress(transferred, total);
        }
    } else {
        download_single_file(
            sftp,
            remote_path,
            &local_path,
            total,
            &mut transferred,
            cancel,
            conflict,
            None,
            None,
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



fn write_new_remote_file(
    sftp: &ssh2::Sftp,
    path: &Path,
    bytes: &[u8],
    mode: u32,
) -> Result<()> {
    let mut file = sftp
        .open_mode(
            path,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
            mode as i32,
            OpenType::File,
        )
        .with_context(|| format!("failed to open remote file for writing {}", path.display()))?;
    let mut offset = 0;
    while offset < bytes.len() {
        let wrote = file
            .write(&bytes[offset..])
            .with_context(|| format!("failed to write remote file {}", path.display()))?;
        if wrote == 0 {
            bail!("保存中断，没有写入新的数据");
        }
        offset += wrote;
    }
    file.flush().ok();
    Ok(())
}

fn replace_remote_file(
    sftp: &ssh2::Sftp,
    path: &Path,
    bytes: &[u8],
    mode: u32,
    previous: &ssh2::FileStat,
) -> Result<()> {
    let temp = remote_sibling_path(path, "rustshell-new")?;
    let backup = remote_sibling_path(path, "rustshell-bak")?;
    if sftp.lstat(&temp).is_ok() || sftp.lstat(&backup).is_ok() {
        bail!("保存失败：同目录下有未完成的临时文件，原文件未改动");
    }
    if let Err(error) = write_new_remote_file(sftp, &temp, bytes, mode) {
        let _ = sftp.unlink(&temp);
        return Err(error);
    }
    if let Err(error) = sftp.rename(path, &backup, None) {
        let _ = sftp.unlink(&temp);
        return Err(error).with_context(|| {
            format!("failed to preserve remote file {}", path.display())
        });
    }
    if let Err(error) = sftp.rename(&temp, path, None) {
        let restored = sftp.rename(&backup, path, None);
        let _ = sftp.unlink(&temp);
        if restored.is_err() {
            bail!("保存失败：原文件已改为备份，但新内容没有就位");
        }
        return Err(error).with_context(|| {
            format!("failed to replace remote file {}", path.display())
        });
    }
    let _ = sftp.unlink(&backup);
    if previous.uid.is_some() || previous.gid.is_some() {
        let _ = chown_one(sftp, path, previous.uid, previous.gid);
    }
    if let Some(mode) = previous.perm {
        let _ = set_remote_permissions(sftp, path, mode);
    }
    Ok(())
}

fn remote_sibling_path(path: &Path, suffix: &str) -> Result<PathBuf> {
    let name = path
        .file_name()
        .ok_or_else(|| anyhow!("remote file name is missing"))?
        .to_string_lossy();
    let parent = path
        .parent()
        .map(remote_path_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_owned());
    Ok(PathBuf::from(remote_child_path(
        &parent,
        &format!("{name}.{suffix}"),
    )))
}

fn copy_until_eof<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> Result<()> {
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let mut offset = 0;
        while offset < read {
            let wrote = writer.write(&buffer[offset..read])?;
            if wrote == 0 {
                bail!("复制中断，没有写入新的数据");
            }
            offset += wrote;
        }
    }
    Ok(())
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
    known_exists: Option<bool>,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let exists = match known_exists {
        Some(exists) => exists,
        None => sftp.lstat(remote_path).is_ok(),
    };
    if exists {
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

enum RemoteStatCache {
    Unknown,
    Missing,
    Found(ssh2::FileStat),
}

fn remote_resume_cache(sftp: &ssh2::Sftp, remote_path: &Path) -> Result<RemoteStatCache> {
    // lstat catches a link without following it. Size is usually included;
    // stat is only for servers that leave the size out.
    match sftp.lstat(remote_path) {
        Ok(stat) if stat.file_type().is_symlink() => bail!(REMOTE_LINK_KEPT),
        Ok(stat) if stat.size.is_some() => Ok(RemoteStatCache::Found(stat)),
        Ok(stat) => Ok(match sftp.stat(remote_path) {
            Ok(full) => RemoteStatCache::Found(full),
            Err(_) => RemoteStatCache::Found(stat),
        }),
        Err(_) => Ok(RemoteStatCache::Missing),
    }
}

fn resume_needs_source_bytes(choice: ResumeChoice) -> bool {
    matches!(choice, ResumeChoice::Append(_) | ResumeChoice::Restart)
}

fn resume_download_can_skip_open(local_path: &Path, remote_size: Option<u64>) -> bool {
    let Some(remote_size) = remote_size else {
        return false;
    };
    let Ok(metadata) = fs::symlink_metadata(local_path) else {
        return false;
    };
    metadata.is_file()
        && !resume_needs_source_bytes(choose_resume(Some(metadata.len()), Some(remote_size)))
}

fn upload_single_file<F>(
    sftp: &ssh2::Sftp,
    local_path: &Path,
    remote_path: &Path,
    total: u64,
    transferred: &mut u64,
    cancel: Arc<AtomicBool>,
    conflict: TransferConflictStrategy,
    opened: Option<File>,
    known_metadata: Option<fs::Metadata>,
    mut known_remote: RemoteStatCache,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    // A folder listing already has the size and time. Statting each file
    // again is another pass over the disk.
    let metadata = match known_metadata {
        Some(metadata) => metadata,
        None => fs::metadata(local_path)
            .with_context(|| format!("failed to stat {}", local_path.display()))?,
    };
    // A folder upload already checked this and does not open a file it will skip.
    if opened.is_none() && matches!(conflict, TransferConflictStrategy::Skip) {
        let exists = match &known_remote {
            RemoteStatCache::Missing => false,
            RemoteStatCache::Found(_) => true,
            RemoteStatCache::Unknown => sftp.lstat(remote_path).is_ok(),
        };
        if exists {
            *transferred += metadata.len();
            on_progress(*transferred, total);
            return Ok(());
        }
    }

    // One lookup decides resume. A finished file can return before it is opened.
    if matches!(conflict, TransferConflictStrategy::Resume)
        && matches!(known_remote, RemoteStatCache::Unknown)
    {
        known_remote = remote_resume_cache(sftp, remote_path)?;
    }

    let resume_append_at = if matches!(conflict, TransferConflictStrategy::Resume) {
        match &known_remote {
            RemoteStatCache::Found(stat) => match choose_resume(stat.size, Some(metadata.len())) {
                ResumeChoice::Append(remote_size) => Some(remote_size),
                ResumeChoice::Restart => None,
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
            },
            RemoteStatCache::Missing | RemoteStatCache::Unknown => None,
        }
    } else {
        None
    };

    let mut local = match opened {
        Some(file) => file,
        None => File::open(local_path)
            .with_context(|| format!("failed to open {}", local_path.display()))?,
    };
    // Resume already refused a link. A folder listing answers this for the
    // other files, so only an unknown name asks the server again.
    if !matches!(conflict, TransferConflictStrategy::Resume) {
        match &known_remote {
            RemoteStatCache::Missing => {}
            RemoteStatCache::Found(stat) if !stat.file_type().is_symlink() => {}
            RemoteStatCache::Found(_) => apply_known_remote_link(sftp, remote_path, conflict)?,
            RemoteStatCache::Unknown => {
                replace_remote_link_for_write(sftp, remote_path, conflict)?;
            }
        }
    }
    let mut remote = if let Some(remote_size) = resume_append_at {
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
            .with_context(|| format!("failed to seek remote file {}", remote_path.display()))?;
        *transferred += remote_size;
        on_progress(*transferred, total);
        remote
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


#[derive(Clone, Copy)]
enum ListedRemote<'a> {
    Unknown,
    Missing,
    Found(&'a ssh2::FileStat),
}

impl ListedRemote<'_> {
    fn known_exists(self) -> Option<bool> {
        match self {
            Self::Unknown => None,
            Self::Missing => Some(false),
            Self::Found(_) => Some(true),
        }
    }
}

enum FoldedName {
    One(String),
    Many,
}

#[derive(Default)]
struct RemoteUploadListing {
    by_name: HashMap<String, ssh2::FileStat>,
    by_folded: HashMap<String, FoldedName>,
}

impl RemoteUploadListing {
    fn remember(&mut self, name: String, stat: ssh2::FileStat) {
        let folded = name.to_lowercase();
        let same_name = matches!(
            self.by_folded.get(&folded),
            Some(FoldedName::One(existing)) if existing == &name
        );
        let missing = !self.by_folded.contains_key(&folded);
        if missing {
            self.by_folded
                .insert(folded, FoldedName::One(name.clone()));
        } else if !same_name {
            self.by_folded.insert(folded, FoldedName::Many);
        }
        self.by_name.insert(name, stat);
    }

    fn get(&self, name: &str) -> ListedRemote<'_> {
        if let Some(stat) = self.by_name.get(name) {
            return listed_stat(stat);
        }
        let original = match self.by_folded.get(&name.to_lowercase()) {
            Some(FoldedName::One(original)) => original.clone(),
            // Two files differ only by letter case. Ask the server which path
            // this exact name is, instead of writing over the wrong one.
            Some(FoldedName::Many) => return ListedRemote::Unknown,
            None => return ListedRemote::Missing,
        };
        match self.by_name.get(&original) {
            Some(stat) => listed_stat(stat),
            None => ListedRemote::Unknown,
        }
    }
}

fn listed_stat(stat: &ssh2::FileStat) -> ListedRemote<'_> {
    if stat.perm.is_some() {
        ListedRemote::Found(stat)
    } else {
        ListedRemote::Unknown
    }
}

fn listed_remote<'a>(
    listing: Option<&'a RemoteUploadListing>,
    remote_path: &str,
) -> ListedRemote<'a> {
    match listing {
        Some(listing) => listing.get(remote_basename(remote_path)),
        None => ListedRemote::Unknown,
    }
}

fn remote_basename(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

fn remote_upload_listing(
    sftp: &ssh2::Sftp,
    remote_dir: &str,
    cancel: &AtomicBool,
) -> Result<Option<RemoteUploadListing>> {
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }
    let mut listing = RemoteUploadListing::default();
    let mut cancelled = false;
    let visited = visit_remote_entries(sftp, Path::new(remote_dir), None, |path, stat| {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            return false;
        }
        if let Some(name) = path.file_name() {
            listing.remember(name.to_string_lossy().into_owned(), stat);
        }
        true
    });
    if cancelled || cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }
    match visited {
        Ok(_) => Ok(Some(listing)),
        // Keep the old per-file checks when this directory cannot be listed.
        Err(_) => Ok(None),
    }
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
    fail_if_unreadable: bool,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let entries = match fs::read_dir(local_dir) {
        Ok(entries) => entries,
        Err(error) if fail_if_unreadable => {
            return Err(error).with_context(|| format!("failed to read {}", local_dir.display()));
        }
        Err(_) if cancel.load(Ordering::Relaxed) => bail!("transfer cancelled"),
        Err(_) => return Ok(()),
    };
    let mut local_entries = Vec::new();
    for entry in entries {
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        local_entries.push(entry);
    }
    // An empty folder has nothing to compare with the server.
    if local_entries.is_empty() {
        return Ok(());
    }
    // One listing answers existence and link type for every child. Resume
    // still checks each file immediately: a size from this listing would be
    // stale by the time a later file is appended.
    let remote_names = if matches!(conflict, TransferConflictStrategy::Resume) {
        None
    } else {
        remote_upload_listing(sftp, remote_dir, &cancel)?
    };
    // Read this folder's names once, and only after a file actually needs a
    // numbered copy. Later files reuse that list instead of reading it again.
    let mut listed_names = remote_names.as_ref().map(|listing| {
        listing
            .by_name
            .keys()
            .cloned()
            .collect::<HashSet<_>>()
    });
    for entry in local_entries {
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let local_path = entry.path();
        let remote_name = entry.file_name().to_string_lossy().to_string();
        let metadata = match dir_entry_metadata(&entry) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if local_path_is_link(&local_path, &metadata) {
            let remote_path = remote_child_for_conflict(
                sftp,
                remote_dir,
                &remote_name,
                conflict,
                &mut listed_names,
            )?;
            upload_symlink(
                sftp,
                &local_path,
                Path::new(&remote_path),
                total,
                transferred,
                conflict,
                listed_remote(remote_names.as_ref(), &remote_path).known_exists(),
                on_progress,
            )?;
        } else if metadata.is_dir() {
            let remote_path = remote_child_for_conflict(
                sftp,
                remote_dir,
                &remote_name,
                conflict,
                &mut listed_names,
            )?;
            if !open_listed_remote_dir(
                sftp,
                Path::new(&remote_path),
                conflict,
                listed_remote(remote_names.as_ref(), &remote_path),
            )? {
                add_skipped_local_tree(&local_path, transferred, total, &cancel, on_progress)?;
                continue;
            }
            upload_dir_recursive(
                sftp,
                &local_path,
                &remote_path,
                total,
                transferred,
                cancel.clone(),
                conflict,
                on_progress,
                false,
            )?;
            preserve_remote_metadata(sftp, Path::new(&remote_path), &metadata);
        } else if metadata.is_file() {
            let remote_path = remote_child_for_conflict(
                sftp,
                remote_dir,
                &remote_name,
                conflict,
                &mut listed_names,
            )?;
            let listed = listed_remote(remote_names.as_ref(), &remote_path);
            // An existing file that will be left alone does not need to be opened.
            if matches!(conflict, TransferConflictStrategy::Skip) {
                let exists = match listed {
                    ListedRemote::Found(_) => true,
                    ListedRemote::Missing => false,
                    ListedRemote::Unknown => {
                        remote_path_exists(sftp, Path::new(&remote_path))
                    }
                };
                if exists {
                    *transferred += metadata.len();
                    on_progress(*transferred, total);
                    continue;
                }
            }
            // Resume can see a finished file from one lookup. Opening it first
            // locks every completed file in the folder. Other conflicts reuse
            // the listing instead of asking about this name again.
            let known_remote = if matches!(conflict, TransferConflictStrategy::Resume) {
                remote_resume_cache(sftp, Path::new(&remote_path))?
            } else {
                match listed {
                    ListedRemote::Found(stat) => RemoteStatCache::Found(stat.clone()),
                    ListedRemote::Missing => RemoteStatCache::Missing,
                    ListedRemote::Unknown => RemoteStatCache::Unknown,
                }
            };
            if matches!(conflict, TransferConflictStrategy::Resume) {
                if let RemoteStatCache::Found(stat) = &known_remote {
                    match choose_resume(stat.size, Some(metadata.len())) {
                        ResumeChoice::Complete => {
                            *transferred += metadata.len();
                            on_progress(*transferred, total);
                            preserve_remote_metadata(sftp, Path::new(&remote_path), &metadata);
                            continue;
                        }
                        ResumeChoice::TargetLarger { target, source } => {
                            bail!(
                                "{}",
                                resume_target_larger_message(
                                    Path::new(&remote_path),
                                    target,
                                    source,
                                    false
                                )
                            );
                        }
                        ResumeChoice::SizeUnknown => {
                            bail!("{}", resume_size_unknown_message(Path::new(&remote_path)));
                        }
                        ResumeChoice::Append(_) | ResumeChoice::Restart => {}
                    }
                }
            }
            // Keep this handle for the copy. A second open can fail on a busy
            // file and stop the rest of the folder. Finished files were handled
            // above, so an unreadable file is skipped only when its bytes are needed.
            let opened = match File::open(&local_path) {
                Ok(file) => Some(file),
                Err(_) => {
                    note_skipped_bytes(transferred, total, metadata.len(), on_progress);
                    continue;
                }
            };
            upload_single_file(
                sftp,
                &local_path,
                Path::new(&remote_path),
                total,
                transferred,
                cancel.clone(),
                conflict,
                opened,
                Some(metadata),
                known_remote,
                on_progress,
            )?;
        }
    }
    Ok(())
}

fn trusted_listing_stat(stat: ssh2::FileStat) -> Option<ssh2::FileStat> {
    if stat.size.is_some() && stat.perm.is_some() && stat.mtime.is_some() {
        Some(stat)
    } else {
        None
    }
}

fn reuse_or_open_remote(
    sftp: &ssh2::Sftp,
    remote_path: &Path,
    opened: Option<ssh2::File>,
) -> Result<ssh2::File> {
    if let Some(file) = opened {
        return Ok(file);
    }
    sftp.open(remote_path)
        .with_context(|| format!("failed to open remote file {}", remote_path.display()))
}

fn download_single_file<F>(
    sftp: &ssh2::Sftp,
    remote_path: &Path,
    local_path: &Path,
    total: u64,
    transferred: &mut u64,
    cancel: Arc<AtomicBool>,
    conflict: TransferConflictStrategy,
    mut opened: Option<ssh2::File>,
    known: Option<ssh2::FileStat>,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let known = known.and_then(trusted_listing_stat);
    if matches!(conflict, TransferConflictStrategy::Skip) && local_path_exists(local_path) {
        let size = known.and_then(|stat| stat.size).unwrap_or_else(|| {
            sftp.stat(remote_path)
                .ok()
                .and_then(|stat| stat.size)
                .unwrap_or_default()
        });
        *transferred += size;
        on_progress(*transferred, total);
        return Ok(());
    }
    let stat = if let Some(stat) = known {
        stat
    } else {
        sftp.stat(remote_path)
            .with_context(|| format!("failed to stat remote file {}", remote_path.display()))?
    };
    replace_local_link_for_write(local_path, conflict)?;
    let (mut remote, mut local) =
        if matches!(conflict, TransferConflictStrategy::Resume) && local_path.exists() {
            let local_size = fs::metadata(local_path)
                .with_context(|| format!("failed to stat {}", local_path.display()))?
                .len();
            match choose_resume(Some(local_size), stat.size) {
                ResumeChoice::Append(offset) => {
                    let mut remote = reuse_or_open_remote(sftp, remote_path, opened.take())?;
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
                    let remote = reuse_or_open_remote(sftp, remote_path, opened.take())?;
                    let local = File::create(local_path)
                        .with_context(|| format!("failed to create {}", local_path.display()))?;
                    (remote, local)
                }
            }
        } else {
            let remote = reuse_or_open_remote(sftp, remote_path, opened.take())?;
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

fn queue_remote_download_entry(
    files: &mut Vec<(PathBuf, PathBuf, bool, ssh2::FileStat)>,
    directories: &mut Vec<(String, PathBuf, Option<u32>, Option<u64>, Option<u64>)>,
    remote_path: PathBuf,
    stat: ssh2::FileStat,
    local_dir: &Path,
) {
    let Some(name) = remote_path.file_name() else {
        return;
    };
    let local_path = local_dir.join(name);
    if stat.file_type().is_symlink() {
        files.push((remote_path, local_path, true, stat));
    } else if stat.is_dir() {
        directories.push((
            remote_path_text(&remote_path),
            local_path,
            stat.perm,
            stat.atime,
            stat.mtime,
        ));
    } else {
        files.push((remote_path, local_path, false, stat));
    }
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
    listing: Option<&RemoteListing>,
    fail_if_unreadable: bool,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let mut directories = Vec::new();
    let mut files = Vec::new();
    if let Some(listing) = listing {
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        for (remote_path, stat) in &listing.entries {
            if cancel.load(Ordering::Relaxed) {
                bail!("transfer cancelled");
            }
            queue_remote_download_entry(
                &mut files,
                &mut directories,
                remote_path.clone(),
                stat.clone(),
                local_dir,
            );
        }
    } else {
        let mut raw_entries = Vec::new();
        let visited = visit_remote_entries(sftp, Path::new(remote_dir), None, |remote_path, stat| {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            raw_entries.push((remote_path, stat));
            true
        });
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        for (remote_path, stat) in raw_entries {
            if cancel.load(Ordering::Relaxed) {
                bail!("transfer cancelled");
            }
            let stat = resolve_remote_listing_stat(sftp, &remote_path, stat);
            queue_remote_download_entry(
                &mut files,
                &mut directories,
                remote_path,
                stat,
                local_dir,
            );
        }
        if let Err(error) = visited {
            if cancel.load(Ordering::Relaxed) {
                bail!("transfer cancelled");
            }
            if fail_if_unreadable {
                return Err(error);
            }
            // The listing stopped early. Keep names already read instead of
            // leaving this folder empty.
            if files.is_empty() && directories.is_empty() {
                return Ok(());
            }
        }
    }
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }

    let mut listed_names = None;

    for (remote_path, local_path, is_symlink, stat) in files {
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        let local_path = local_child_for_conflict(&local_path, conflict, &mut listed_names)?;
        if is_symlink {
            download_symlink(
                sftp,
                &remote_path,
                &local_path,
                total,
                transferred,
                conflict,
                on_progress,
            )?;
            continue;
        }
        // An existing file that will be left alone does not need to be opened.
        if matches!(conflict, TransferConflictStrategy::Skip) && local_path_exists(&local_path) {
            download_single_file(
                sftp,
                &remote_path,
                &local_path,
                total,
                transferred,
                cancel.clone(),
                conflict,
                None,
                trusted_listing_stat(stat),
                on_progress,
            )?;
            continue;
        }
        // The listing already has the size. A finished file does not need the
        // remote file opened, and a larger local file fails before that open.
        if matches!(conflict, TransferConflictStrategy::Resume)
            && resume_download_can_skip_open(&local_path, stat.size)
        {
            download_single_file(
                sftp,
                &remote_path,
                &local_path,
                total,
                transferred,
                cancel.clone(),
                conflict,
                None,
                trusted_listing_stat(stat),
                on_progress,
            )?;
            continue;
        }
        // The handle is reused for the copy. Opening it again would be another
        // round trip for every file in the folder.
        let opened = match sftp.open(&remote_path) {
            Ok(file) => file,
            Err(error) if sftp_item_is_unavailable(&error) => {
                let size = trusted_listing_stat(stat).and_then(|stat| stat.size).unwrap_or_else(|| {
                    sftp.lstat(&remote_path)
                        .ok()
                        .and_then(|stat| stat.size)
                        .unwrap_or(0)
                });
                note_skipped_bytes(transferred, total, size, on_progress);
                continue;
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to open remote file {}", remote_path.display())
                });
            }
        };
        download_single_file(
            sftp,
            &remote_path,
            &local_path,
            total,
            transferred,
            cancel.clone(),
            conflict,
            Some(opened),
            trusted_listing_stat(stat),
            on_progress,
        )?;
    }

    for (remote_child, local_path, perm, atime, mtime) in directories {
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        let local_path =
            local_child_for_conflict(&local_path, conflict, &mut listed_names)?;
        let cached = listing.and_then(|listing| listing.children.get(&remote_child));
        if !open_local_download_dir(&local_path, conflict)? {
            // This subtree was already measured with the download total. Ask
            // the server again only when that measurement was not kept.
            let skipped = if let Some((size, _)) = cached {
                *size
            } else {
                match remote_total_size(sftp, Path::new(&remote_child), &cancel) {
                    Ok(size) => size,
                    Err(_) if cancel.load(Ordering::Relaxed) => bail!("transfer cancelled"),
                    Err(_) => 0,
                }
            };
            note_skipped_bytes(transferred, total, skipped, on_progress);
            continue;
        }
        download_dir_recursive(
            sftp,
            &remote_child,
            &local_path,
            total,
            transferred,
            cancel.clone(),
            conflict,
            on_progress,
            cached.map(|(_, child)| child),
            false,
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
    local_total_size_metadata(path, &metadata, cancel)
}

fn local_total_size_metadata(
    path: &Path,
    metadata: &fs::Metadata,
    cancel: &AtomicBool,
) -> Result<u64> {
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }
    if local_path_is_link(path, metadata) {
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
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let child = entry.path();
        let child_metadata = match dir_entry_metadata(&entry) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        match local_total_size_metadata(&child, &child_metadata, cancel) {
            Ok(size) => total += size,
            Err(_) if cancel.load(Ordering::Relaxed) => bail!("transfer cancelled"),
            Err(_) => continue,
        }
    }
    Ok(total)
}

fn local_symlink_target_text(path: &Path) -> Result<String> {
    fs::read_link(path)
        .with_context(|| format!("failed to read symlink {}", path.display()))
        .map(|target| target.to_string_lossy().replace('\\', "/"))
}

#[derive(Default)]
struct RemoteListing {
    entries: Vec<(PathBuf, ssh2::FileStat)>,
    children: HashMap<String, (u64, RemoteListing)>,
}

fn remote_total_size(sftp: &ssh2::Sftp, path: &Path, cancel: &AtomicBool) -> Result<u64> {
    remote_total_size_known(sftp, path, None, cancel)
}

fn remote_total_size_known(
    sftp: &ssh2::Sftp,
    path: &Path,
    known: Option<ssh2::FileStat>,
    cancel: &AtomicBool,
) -> Result<u64> {
    Ok(measure_remote_tree(sftp, path, known, cancel)?.0)
}

fn measure_remote_tree(
    sftp: &ssh2::Sftp,
    path: &Path,
    known: Option<ssh2::FileStat>,
    cancel: &AtomicBool,
) -> Result<(u64, RemoteListing)> {
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }
    // Nested folders were already described by the parent listing.
    let stat = match known.and_then(listing_stat_with_type) {
        Some(stat) => stat,
        None => sftp
            .lstat(path)
            .with_context(|| format!("failed to stat remote path {}", path.display()))?,
    };
    if stat.file_type().is_symlink() {
        return Ok((0, RemoteListing::default()));
    }
    if !stat.is_dir() {
        return Ok((stat.size.unwrap_or_default(), RemoteListing::default()));
    }

    let mut total = 0_u64;
    let mut entries = Vec::new();
    let mut directories = Vec::new();
    let mut raw_entries = Vec::new();
    visit_remote_entries(sftp, path, None, |child, child_stat| {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        raw_entries.push((child, child_stat));
        true
    })?;
    // Finish reading the names before asking for a type. Without permissions
    // every name looks like a file, so a folder would be saved without the
    // files inside it.
    for (child, child_stat) in raw_entries {
        if cancel.load(Ordering::Relaxed) {
            bail!("transfer cancelled");
        }
        let child_stat = resolve_remote_listing_stat(sftp, &child, child_stat);
        if !child_stat.file_type().is_symlink() {
            if child_stat.is_dir() {
                directories.push((child.clone(), child_stat.clone()));
            } else {
                total += child_stat.size.unwrap_or_default();
            }
        }
        entries.push((child, child_stat));
    }
    // A cancelled walk must not be reused. The names read so far are dropped.
    if cancel.load(Ordering::Relaxed) {
        bail!("transfer cancelled");
    }
    let mut children = HashMap::new();
    for (child, child_stat) in directories {
        let child_key = remote_path_text(&child);
        match measure_remote_tree(sftp, &child, Some(child_stat), cancel) {
            Ok((size, listing)) => {
                total += size;
                children.insert(child_key, (size, listing));
            }
            // The copy lists this folder again. Leave it out of the total too,
            // which is what a failed measurement did before.
            Err(_) if cancel.load(Ordering::Relaxed) => bail!("transfer cancelled"),
            Err(_) => continue,
        }
    }
    Ok((
        total,
        RemoteListing {
            entries,
            children,
        },
    ))
}

fn resolve_remote_child_path(
    sftp: &ssh2::Sftp,
    parent: &str,
    name: &str,
    conflict: TransferConflictStrategy,
) -> Result<String> {
    resolve_remote_child_path_with_names(sftp, parent, name, conflict, None)
}

fn resolve_remote_child_path_with_names(
    sftp: &ssh2::Sftp,
    parent: &str,
    name: &str,
    conflict: TransferConflictStrategy,
    known_names: Option<&mut Option<HashSet<String>>>,
) -> Result<String> {
    let candidate = remote_child_path(parent, name);
    if !matches!(conflict, TransferConflictStrategy::Rename)
        || !remote_path_exists(sftp, Path::new(&candidate))
    {
        return Ok(candidate);
    }

    let (stem, suffix) = split_file_name(name);
    let first = numbered_copy_name(&stem, &suffix, 1);
    let first_path = remote_child_path(parent, &first);
    if !remote_path_exists(sftp, Path::new(&first_path)) {
        return Ok(first_path);
    }

    // Later numbers can run into the hundreds. One directory listing is cheaper
    // than asking the server about every number, and the rest of this folder
    // reuses that listing.
    if let Some(next_name) = next_free_remote_name(sftp, parent, &stem, &suffix, known_names) {
        return Ok(remote_child_path(parent, &next_name));
    }
    bail!("failed to allocate unique remote path for {}", candidate)
}

fn next_free_remote_name(
    sftp: &ssh2::Sftp,
    parent: &str,
    stem: &str,
    suffix: &str,
    known_names: Option<&mut Option<HashSet<String>>>,
) -> Option<String> {
    if let Some(known) = known_names {
        if known.is_none() {
            *known = remote_directory_names(sftp, parent);
        }
        if let Some(names) = known.as_mut() {
            return take_free_remote_name(sftp, parent, stem, suffix, names);
        }
    } else if let Some(names) = remote_directory_names(sftp, parent) {
        return next_free_numbered_name(stem, suffix, &names, 2, false);
    }

    for index in 2..10_000 {
        let next_name = numbered_copy_name(stem, suffix, index);
        let next_path = remote_child_path(parent, &next_name);
        if !remote_path_exists(sftp, Path::new(&next_path)) {
            return Some(next_name);
        }
    }
    None
}

fn take_free_remote_name(
    sftp: &ssh2::Sftp,
    parent: &str,
    stem: &str,
    suffix: &str,
    names: &mut HashSet<String>,
) -> Option<String> {
    loop {
        let next_name = next_free_numbered_name(stem, suffix, names, 2, false)?;
        let next_path = remote_child_path(parent, &next_name);
        names.insert(next_name.clone());
        if !remote_path_exists(sftp, Path::new(&next_path)) {
            return Some(next_name);
        }
    }
}

fn remote_child_for_conflict(
    sftp: &ssh2::Sftp,
    parent: &str,
    name: &str,
    conflict: TransferConflictStrategy,
    listed: &mut Option<HashSet<String>>,
) -> Result<String> {
    resolve_remote_child_path_with_names(sftp, parent, name, conflict, Some(listed))
}

fn remote_directory_names(sftp: &ssh2::Sftp, parent: &str) -> Option<HashSet<String>> {
    let mut names = HashSet::new();
    let listed = visit_remote_entries(sftp, Path::new(parent), None, |path_buf, _stat| {
        if let Some(name) = path_buf.file_name() {
            names.insert(name.to_string_lossy().into_owned());
        }
        true
    });
    listed.ok().map(|_| names)
}

fn remote_path_exists(sftp: &ssh2::Sftp, path: &Path) -> bool {
    sftp.lstat(path).is_ok()
}

fn resolve_remote_move_target(
    sftp: &ssh2::Sftp,
    source: &str,
    target_path: &str,
) -> Result<(String, bool)> {
    let target = target_path.trim().replace('\\', "/");
    if target.is_empty() {
        bail!("remote target path is empty");
    }

    if let Ok(stat) = sftp.lstat(Path::new(&target)) {
        if stat.file_type().is_symlink() {
            bail!("remote target is a link");
        }
        if remote_paths_differ_only_by_case(source, &target) {
            let source_name = remote_file_name(source);
            let target_name = remote_file_name(&target);
            if remote_name_change_is_case_only(sftp, source, &source_name, &target_name)? {
                return Ok((target, true));
            }
        }
        if stat.is_dir() {
            let source_name = Path::new(source)
                .file_name()
                .ok_or_else(|| anyhow!("remote file name is missing"))?
                .to_string_lossy();
            let destination = remote_child_path(&target, &source_name);
            if remote_move_lands_inside(source, &destination) {
                bail!("remote target is inside the source");
            }
            return Ok((destination, false));
        }
        bail!("remote target already exists: {}", target);
    }

    if target.ends_with('/') {
        bail!("remote target directory does not exist: {}", target);
    }
    if remote_move_lands_inside(source, &target) {
        bail!("remote target is inside the source");
    }
    Ok((target, false))
}

fn remote_file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn remote_paths_differ_only_by_case(source: &str, target: &str) -> bool {
    let source_name = remote_file_name(source);
    let target_name = remote_file_name(target);
    !source_name.is_empty()
        && source_name != target_name
        && source_name.to_lowercase() == target_name.to_lowercase()
        && remote_parent_path(source).to_lowercase() == remote_parent_path(target).to_lowercase()
}

fn remote_move_lands_inside(source: &str, destination: &str) -> bool {
    let source = normalize_remote_move_path(source);
    let destination = normalize_remote_move_path(destination);
    if source.is_empty() || source == "." {
        return false;
    }
    if source == "/" {
        return destination != "/";
    }
    destination == source || destination.starts_with(&(source.clone() + "/"))
}

fn normalize_remote_move_path(path: &str) -> String {
    let trimmed = path.trim();
    let absolute = trimmed.starts_with('/');
    let mut parts = Vec::new();
    for part in trimmed.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if parts.last().is_some_and(|item| *item != "..") {
                parts.pop();
            } else if !absolute {
                parts.push("..");
            }
            continue;
        }
        parts.push(part);
    }
    if absolute {
        if parts.is_empty() {
            "/".to_owned()
        } else {
            format!("/{}", parts.join("/"))
        }
    } else {
        parts.join("/")
    }
}

fn resolve_local_child_path(
    parent: &Path,
    name: &std::ffi::OsStr,
    conflict: TransferConflictStrategy,
) -> Result<PathBuf> {
    resolve_local_path(&parent.join(name), conflict)
}

fn resolve_local_path(path: &Path, conflict: TransferConflictStrategy) -> Result<PathBuf> {
    resolve_local_path_with_names(path, conflict, None)
}

fn resolve_local_path_with_names(
    path: &Path,
    conflict: TransferConflictStrategy,
    known_names: Option<&mut Option<HashSet<String>>>,
) -> Result<PathBuf> {
    if !matches!(conflict, TransferConflictStrategy::Rename) || !local_path_exists(path) {
        return Ok(path.to_path_buf());
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow!("local file name is missing"))?
        .to_string_lossy();
    let (stem, suffix) = split_file_name(&file_name);
    let first = numbered_copy_name(&stem, &suffix, 1);
    let first_path = parent.join(&first);
    if !local_path_exists(&first_path) {
        return Ok(first_path);
    }

    if let Some(next_name) = next_free_local_name(parent, &stem, &suffix, known_names) {
        return Ok(parent.join(next_name));
    }
    bail!(
        "failed to allocate unique local path for {}",
        path.display()
    )
}

fn next_free_local_name(
    parent: &Path,
    stem: &str,
    suffix: &str,
    known_names: Option<&mut Option<HashSet<String>>>,
) -> Option<String> {
    if let Some(known) = known_names {
        if known.is_none() {
            *known = local_directory_names(parent);
        }
        if let Some(names) = known.as_mut() {
            return take_free_local_name(parent, stem, suffix, names);
        }
    } else if let Some(names) = local_directory_names(parent) {
        return next_free_numbered_name(stem, suffix, &names, 2, cfg!(windows));
    }

    for index in 2..10_000 {
        let next_name = numbered_copy_name(stem, suffix, index);
        if !local_path_exists(&parent.join(&next_name)) {
            return Some(next_name);
        }
    }
    None
}

fn take_free_local_name(
    parent: &Path,
    stem: &str,
    suffix: &str,
    names: &mut HashSet<String>,
) -> Option<String> {
    loop {
        let next_name = next_free_numbered_name(stem, suffix, names, 2, cfg!(windows))?;
        names.insert(fold_local_file_name(&next_name));
        if !local_path_exists(&parent.join(&next_name)) {
            return Some(next_name);
        }
    }
}

fn local_child_for_conflict(
    path: &Path,
    conflict: TransferConflictStrategy,
    listed: &mut Option<HashSet<String>>,
) -> Result<PathBuf> {
    resolve_local_path_with_names(path, conflict, Some(listed))
}

fn local_directory_names(parent: &Path) -> Option<HashSet<String>> {
    let entries = fs::read_dir(parent).ok()?;
    let mut names = HashSet::new();
    for entry in entries.flatten() {
        names.insert(fold_local_file_name(&entry.file_name().to_string_lossy()));
    }
    Some(names)
}

fn fold_local_file_name(name: &str) -> String {
    #[cfg(windows)]
    {
        name.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        name.to_owned()
    }
}

fn local_path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}


fn replace_remote_link_for_write(
    sftp: &ssh2::Sftp,
    path: &Path,
    conflict: TransferConflictStrategy,
) -> Result<()> {
    let Ok(stat) = sftp.lstat(path) else {
        return Ok(());
    };
    if !stat.file_type().is_symlink() {
        return Ok(());
    }
    match directory_link_action(conflict) {
        DirectoryLinkAction::Replace => {
            sftp.unlink(path)
                .with_context(|| format!("failed to replace remote link {}", path.display()))?;
        }
        DirectoryLinkAction::Skip | DirectoryLinkAction::Refuse => {
            bail!(REMOTE_LINK_KEPT);
        }
    }
    Ok(())
}

fn replace_local_link_for_write(path: &Path, conflict: TransferConflictStrategy) -> Result<()> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if !local_path_is_link(path, &metadata) {
        return Ok(());
    }
    match directory_link_action(conflict) {
        DirectoryLinkAction::Replace => {
            remove_local_link(path)
                .with_context(|| format!("failed to replace {}", path.display()))?;
        }
        DirectoryLinkAction::Skip | DirectoryLinkAction::Refuse => {
            bail!(LOCAL_LINK_KEPT);
        }
    }
    Ok(())
}

fn remove_local_link(path: &Path) -> std::io::Result<()> {
    fs::remove_file(path).or_else(|_| fs::remove_dir(path))
}

fn remote_path_is_link(sftp: &ssh2::Sftp, path: &Path) -> bool {
    sftp.lstat(path)
        .ok()
        .is_some_and(|stat| stat.file_type().is_symlink())
}

fn apply_known_remote_link(
    sftp: &ssh2::Sftp,
    path: &Path,
    conflict: TransferConflictStrategy,
) -> Result<()> {
    match directory_link_action(conflict) {
        DirectoryLinkAction::Replace => sftp
            .unlink(path)
            .with_context(|| format!("failed to replace remote link {}", path.display())),
        DirectoryLinkAction::Skip | DirectoryLinkAction::Refuse => bail!(REMOTE_LINK_KEPT),
    }
}

fn open_listed_remote_dir(
    sftp: &ssh2::Sftp,
    path: &Path,
    conflict: TransferConflictStrategy,
    listed: ListedRemote<'_>,
) -> Result<bool> {
    match listed {
        ListedRemote::Unknown => open_remote_upload_dir(sftp, path, conflict),
        ListedRemote::Found(stat) if stat.file_type().is_symlink() => {
            if matches!(directory_link_action(conflict), DirectoryLinkAction::Skip) {
                return Ok(false);
            }
            apply_known_remote_link(sftp, path, conflict)?;
            ensure_remote_dir(sftp, path)?;
            Ok(true)
        }
        ListedRemote::Found(stat) if stat.is_dir() => Ok(true),
        ListedRemote::Found(_) => {
            bail!(
                "remote path exists and is not a directory: {}",
                path.display()
            )
        }
        ListedRemote::Missing => match sftp.mkdir(path, 0o755) {
            Ok(()) => Ok(true),
            Err(_) => {
                ensure_remote_dir(sftp, path)?;
                Ok(true)
            }
        },
    }
}

fn open_remote_upload_dir(
    sftp: &ssh2::Sftp,
    path: &Path,
    conflict: TransferConflictStrategy,
) -> Result<bool> {
    if remote_path_is_link(sftp, path)
        && matches!(directory_link_action(conflict), DirectoryLinkAction::Skip)
    {
        return Ok(false);
    }
    replace_remote_link_for_write(sftp, path, conflict)?;
    ensure_remote_dir(sftp, path)?;
    Ok(true)
}

fn open_local_download_dir(path: &Path, conflict: TransferConflictStrategy) -> Result<bool> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if local_path_is_link(path, &metadata)
            && matches!(directory_link_action(conflict), DirectoryLinkAction::Skip)
        {
            return Ok(false);
        }
    }
    replace_local_link_for_write(path, conflict)?;
    ensure_local_dir(path)?;
    Ok(true)
}

fn ensure_local_dir(path: &Path) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.is_dir() && !local_path_is_link(path, &metadata) {
            return Ok(());
        }
        bail!(
            "local path exists and is not a directory: {}",
            path.display()
        );
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
    }
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)
                .with_context(|| format!("failed to stat {}", path.display()))?;
            if metadata.is_dir() && !local_path_is_link(path, &metadata) {
                Ok(())
            } else {
                bail!(
                    "local path exists and is not a directory: {}",
                    path.display()
                )
            }
        }
        Err(error) => Err(error).with_context(|| format!("failed to create {}", path.display())),
    }
}

fn note_skipped_bytes<F>(transferred: &mut u64, total: u64, size: u64, on_progress: &mut F)
where
    F: FnMut(u64, u64),
{
    *transferred = transferred.saturating_add(size).min(total);
    on_progress(*transferred, total);
}

fn add_skipped_local_tree<F>(
    path: &Path,
    transferred: &mut u64,
    total: u64,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64),
{
    let size = match local_total_size(path, cancel) {
        Ok(size) => size,
        Err(_) if cancel.load(Ordering::Relaxed) => bail!("transfer cancelled"),
        Err(_) => 0,
    };
    note_skipped_bytes(transferred, total, size, on_progress);
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectoryLinkAction {
    Skip,
    Refuse,
    Replace,
}

fn directory_link_action(conflict: TransferConflictStrategy) -> DirectoryLinkAction {
    match conflict {
        TransferConflictStrategy::Skip => DirectoryLinkAction::Skip,
        TransferConflictStrategy::Resume => DirectoryLinkAction::Refuse,
        TransferConflictStrategy::Overwrite | TransferConflictStrategy::Rename => {
            DirectoryLinkAction::Replace
        }
    }
}

fn remove_local_existing_path(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if local_path_is_link(path, &metadata) {
        return remove_local_link(path);
    }
    if metadata.is_dir() {
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

fn preferred_transfer_name(requested: Option<&str>) -> Result<Option<String>> {
    let Some(name) = requested.map(str::trim).filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if name == "."
        || name == ".."
        || name.chars().any(|ch| ch == '/' || ch == '\\' || ch == '\0')
    {
        bail!("transfer name is invalid");
    }
    Ok(Some(name.to_owned()))
}


fn numbered_copy_name(stem: &str, suffix: &str, index: u32) -> String {
    format!("{stem} ({index}){suffix}")
}

fn next_free_numbered_name(
    stem: &str,
    suffix: &str,
    occupied: &HashSet<String>,
    start: u32,
    case_insensitive: bool,
) -> Option<String> {
    for index in start..10_000 {
        let name = numbered_copy_name(stem, suffix, index);
        // Remote names stay case-sensitive. Folding every candidate makes
        // Readme (2).txt look taken when only readme (2).txt exists.
        let taken = if case_insensitive {
            occupied.contains(&fold_local_file_name(&name))
        } else {
            occupied.contains(&name)
        };
        if !taken {
            return Some(name);
        }
    }
    None
}

fn split_file_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(index) if index > 0 => (name[..index].to_owned(), name[index..].to_owned()),
        _ => (name.to_owned(), String::new()),
    }
}

fn ensure_upload_directory(sftp: &ssh2::Sftp, remote_dir: &str) -> Result<()> {
    let dir = remote_dir.trim().replace('\\', "/");
    if dir.is_empty() || dir == "." {
        return Ok(());
    }
    match sftp.lstat(Path::new(&dir)) {
        Ok(stat) if stat.is_dir() && !stat.file_type().is_symlink() => return Ok(()),
        Ok(_) => bail!("remote path exists and is not a directory: {}", dir),
        Err(_) => {}
    }

    let absolute = dir.starts_with('/');
    let mut current = String::new();
    for part in dir.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            bail!("remote upload directory is invalid: {}", dir);
        }
        current = if current.is_empty() || current == "/" {
            if absolute {
                format!("/{part}")
            } else {
                part.to_owned()
            }
        } else {
            format!("{current}/{part}")
        };
        ensure_remote_dir(sftp, Path::new(&current))?;
    }
    Ok(())
}

fn ensure_remote_dir(sftp: &ssh2::Sftp, path: &Path) -> Result<()> {
    // lstat: a link to a directory is not the directory itself.
    if let Ok(stat) = sftp.lstat(path) {
        if stat.is_dir() && !stat.file_type().is_symlink() {
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
    preserve_remote_mode_and_times(
        sftp,
        remote_path,
        local_mode(metadata),
        local_accessed_seconds(metadata),
        local_modified_seconds(metadata),
    );
}

fn remote_mode_and_times(
    mode: Option<u32>,
    atime: Option<u64>,
    mtime: Option<u64>,
) -> Option<ssh2::FileStat> {
    let perm = mode.map(|mode| mode & 0o7777);
    if perm.is_none() && atime.is_none() && mtime.is_none() {
        return None;
    }
    Some(ssh2::FileStat {
        size: None,
        uid: None,
        gid: None,
        perm,
        atime,
        mtime,
    })
}

fn preserve_remote_mode_and_times(
    sftp: &ssh2::Sftp,
    path: &Path,
    mode: Option<u32>,
    atime: Option<u64>,
    mtime: Option<u64>,
) {
    let Some(stat) = remote_mode_and_times(mode, atime, mtime) else {
        return;
    };
    if sftp.setstat(path, stat).is_ok() {
        return;
    }
    // Some servers reject a combined update. Each part can still succeed alone.
    if let Some(mode) = mode {
        let _ = set_remote_permissions(sftp, path, mode);
    }
    let _ = set_remote_times(sftp, path, atime, mtime);
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
            let child_stat = resolve_remote_listing_stat(sftp, &child, child_stat);
            collect_remote_path_stats_from_stat(sftp, &child, child_stat, stats)?;
        }
    } else {
        stats.file_count += 1;
        stats.total_size += stat.size.unwrap_or_default();
    }

    Ok(())
}

fn remove_remote_recursive(sftp: &ssh2::Sftp, path: &Path) -> Result<()> {
    remove_remote_recursive_known(sftp, path, None)
}

fn remove_remote_recursive_known(
    sftp: &ssh2::Sftp,
    path: &Path,
    known: Option<ssh2::FileStat>,
) -> Result<()> {
    // The parent listing already named the type. Another stat for every child
    // only repeats that round trip.
    let stat = match known.and_then(trusted_listing_stat) {
        Some(stat) => stat,
        None => sftp
            .lstat(path)
            .with_context(|| format!("failed to stat remote path {}", path.display()))?,
    };
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return sftp
            .unlink(path)
            .with_context(|| format!("failed to remove remote file {}", path.display()));
    }

    let children = read_remote_entries(sftp, path, None)?;
    for (child, child_stat) in children {
        remove_remote_recursive_known(sftp, &child, Some(child_stat))?;
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
    copy_remote_path_inner(sftp, source, target, is_dir_hint, true, None, false)
}

fn copy_remote_path_inner(
    sftp: &ssh2::Sftp,
    source: &Path,
    target: &Path,
    is_dir_hint: bool,
    strict: bool,
    known: Option<ssh2::FileStat>,
    fresh_target: bool,
) -> Result<()> {
    // A folder created below is empty. Checking every new child is a round
    // trip whose answer is no. The original target is still checked.
    if !fresh_target && sftp.lstat(target).is_ok() {
        bail!("remote target already exists: {}", target.display());
    }

    // A directory listing already carried size, type, and time. Asking again
    // costs a round trip for every file in the folder.
    let stat = if let Some(stat) = known.and_then(trusted_listing_stat) {
        stat
    } else {
        match sftp.lstat(source) {
            Ok(stat) => stat,
            Err(error) if strict => {
                return Err(error)
                    .with_context(|| format!("failed to stat remote path {}", source.display()));
            }
            Err(_) => return Ok(()),
        }
    };

    if stat.file_type().is_symlink() {
        let link_target = match sftp.readlink(source) {
            Ok(link_target) => link_target,
            Err(error) if strict => {
                return Err(error)
                    .with_context(|| format!("failed to read symlink {}", source.display()));
            }
            Err(_) => return Ok(()),
        };
        return match sftp.symlink(&link_target, target) {
            Ok(()) => Ok(()),
            Err(error) if strict => Err(error)
                .with_context(|| format!("failed to copy symlink to {}", target.display())),
            Err(_) => Ok(()),
        };
    }

    if stat.is_dir() || is_dir_hint {
        let mode = (stat.perm.unwrap_or(0o755) & 0o7777) as i32;
        sftp.mkdir(target, mode)
            .with_context(|| format!("failed to create remote directory {}", target.display()))?;
        let children = match read_remote_entries(sftp, source, None) {
            Ok(children) => children,
            Err(error) if strict => return Err(error),
            Err(_) => {
                preserve_remote_owner(sftp, target, stat.uid, stat.gid);
                preserve_remote_mode_and_times(sftp, target, stat.perm, stat.atime, stat.mtime);
                return Ok(());
            }
        };
        let mut created_names = HashSet::new();
        let mut created_folded = HashSet::new();
        for (child, child_stat) in children {
            let Some(name) = child.file_name() else {
                continue;
            };
            let name_owned = name.to_string_lossy().into_owned();
            let child_target = remote_child_path(&remote_path_text(target), &name_owned);
            let folded = name_owned.to_lowercase();
            let duplicate = !created_names.insert(name_owned);
            let case_collision = !created_folded.insert(folded);
            // A repeated name, or one that differs only by letter case, can
            // land on a file this copy already created.
            if (duplicate || case_collision) && sftp.lstat(Path::new(&child_target)).is_ok() {
                bail!("remote target already exists: {}", child_target);
            }
            copy_remote_path_inner(
                sftp,
                &child,
                Path::new(&child_target),
                false,
                false,
                Some(child_stat),
                true,
            )?;
        }
        preserve_remote_owner(sftp, target, stat.uid, stat.gid);
        preserve_remote_mode_and_times(sftp, target, stat.perm, stat.atime, stat.mtime);
        return Ok(());
    }

    let mut input = match sftp.open(source) {
        Ok(input) => input,
        Err(error) if strict => {
            return Err(error)
                .with_context(|| format!("failed to open remote file {}", source.display()));
        }
        Err(_) => return Ok(()),
    };
    let mut output = sftp
        .create(target)
        .with_context(|| format!("failed to create remote file {}", target.display()))?;
    copy_until_eof(&mut input, &mut output)
        .with_context(|| format!("failed to copy remote file {}", source.display()))?;
    output.flush().ok();
    preserve_remote_owner(sftp, target, stat.uid, stat.gid);
    preserve_remote_mode_and_times(sftp, target, stat.perm, stat.atime, stat.mtime);
    Ok(())
}

fn preserve_remote_permissions(sftp: &ssh2::Sftp, path: &Path, mode: Option<u32>) {
    if let Some(mode) = mode {
        let _ = set_remote_permissions(sftp, path, mode);
    }
}

fn preserve_remote_owner(sftp: &ssh2::Sftp, path: &Path, uid: Option<u32>, gid: Option<u32>) {
    if uid.is_some() || gid.is_some() {
        // The copy already skipped links. Another stat would repeat that check
        // for every file in the folder.
        let _ = chown_one_stat(sftp, path, uid, gid);
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

fn resolve_remote_listing_stat(
    sftp: &ssh2::Sftp,
    path: &Path,
    stat: ssh2::FileStat,
) -> ssh2::FileStat {
    if stat.perm.is_some() {
        return stat;
    }
    sftp.lstat(path).unwrap_or(stat)
}

fn listing_stat_with_type(stat: ssh2::FileStat) -> Option<ssh2::FileStat> {
    if stat.perm.is_some() {
        Some(stat)
    } else {
        None
    }
}

fn remote_stat_for_update(
    sftp: &ssh2::Sftp,
    path: &Path,
    known: Option<ssh2::FileStat>,
    strict: bool,
) -> Result<Option<ssh2::FileStat>> {
    if let Some(stat) = known.and_then(listing_stat_with_type) {
        return Ok(Some(stat));
    }
    match sftp.lstat(path) {
        Ok(stat) => Ok(Some(stat)),
        Err(error) if strict => Err(error).with_context(|| {
            format!("failed to stat remote path {}", path.display())
        }),
        Err(_) => Ok(None),
    }
}

fn chmod_recursive(sftp: &ssh2::Sftp, path: &Path, mode: u32) -> Result<()> {
    chmod_recursive_inner(sftp, path, mode, true, None)
}

fn chmod_recursive_inner(
    sftp: &ssh2::Sftp,
    path: &Path,
    mode: u32,
    strict: bool,
    known: Option<ssh2::FileStat>,
) -> Result<()> {
    let Some(stat) = remote_stat_for_update(sftp, path, known, strict)? else {
        return Ok(());
    };
    if stat.file_type().is_symlink() {
        return Ok(());
    }
    if strict {
        set_remote_permissions(sftp, path, mode)?;
    } else if set_remote_permissions(sftp, path, mode).is_err() {
        return Ok(());
    }
    if !stat.is_dir() {
        return Ok(());
    }

    let children = match read_remote_entries(sftp, path, None) {
        Ok(children) => children,
        Err(error) if strict => return Err(error),
        Err(_) => return Ok(()),
    };
    for (child, child_stat) in children {
        chmod_recursive_inner(sftp, &child, mode, false, Some(child_stat))?;
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
    chown_one_stat(sftp, path, uid, gid)
}

fn chown_one_stat(
    sftp: &ssh2::Sftp,
    path: &Path,
    uid: Option<u32>,
    gid: Option<u32>,
) -> Result<()> {
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
    chown_recursive_inner(sftp, path, uid, gid, true, None)
}

fn chown_recursive_inner(
    sftp: &ssh2::Sftp,
    path: &Path,
    uid: Option<u32>,
    gid: Option<u32>,
    strict: bool,
    known: Option<ssh2::FileStat>,
) -> Result<()> {
    let Some(stat) = remote_stat_for_update(sftp, path, known, strict)? else {
        return Ok(());
    };
    if stat.file_type().is_symlink() {
        return Ok(());
    }
    if strict {
        chown_one_stat(sftp, path, uid, gid)?;
    } else if chown_one_stat(sftp, path, uid, gid).is_err() {
        return Ok(());
    }
    if !stat.is_dir() {
        return Ok(());
    }

    let children = match read_remote_entries(sftp, path, None) {
        Ok(children) => children,
        Err(error) if strict => return Err(error),
        Err(_) => return Ok(()),
    };
    for (child, child_stat) in children {
        chown_recursive_inner(sftp, &child, uid, gid, false, Some(child_stat))?;
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
    touch_recursive_inner(sftp, path, mtime, true, None)
}

fn touch_recursive_inner(
    sftp: &ssh2::Sftp,
    path: &Path,
    mtime: u64,
    strict: bool,
    known: Option<ssh2::FileStat>,
) -> Result<()> {
    let Some(stat) = remote_stat_for_update(sftp, path, known, strict)? else {
        return Ok(());
    };
    if stat.file_type().is_symlink() {
        return Ok(());
    }
    let updated = set_remote_times(sftp, path, None, Some(mtime))
        .with_context(|| format!("failed to update modified time for {}", path.display()));
    if strict {
        updated?;
    } else if updated.is_err() {
        return Ok(());
    }
    if !stat.is_dir() {
        return Ok(());
    }

    let children = match read_remote_entries(sftp, path, None) {
        Ok(children) => children,
        Err(error) if strict => return Err(error),
        Err(_) => return Ok(()),
    };
    for (child, child_stat) in children {
        touch_recursive_inner(sftp, &child, mtime, false, Some(child_stat))?;
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

fn remote_name_change_is_case_only(
    sftp: &ssh2::Sftp,
    path: &str,
    source_name: &str,
    new_name: &str,
) -> Result<bool> {
    if source_name.is_empty() || source_name.to_lowercase() != new_name.to_lowercase() {
        return Ok(false);
    }
    let parent = remote_parent_path(path);
    let folded = new_name.to_lowercase();
    let mut matched = Vec::new();
    visit_remote_entries(sftp, Path::new(&parent), None, |path_buf, _stat| {
        let name = path_buf
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.to_lowercase() == folded {
            matched.push(name);
            if matched.len() > 1 {
                return false;
            }
        }
        true
    })?;
    let matched_refs: Vec<&str> = matched.iter().map(String::as_str).collect();
    Ok(only_case_variant_is_source(
        source_name,
        new_name,
        &matched_refs,
    ))
}

fn only_case_variant_is_source(source_name: &str, new_name: &str, folded_matches: &[&str]) -> bool {
    !source_name.is_empty()
        && source_name != new_name
        && source_name.to_lowercase() == new_name.to_lowercase()
        && folded_matches.len() == 1
        && folded_matches[0].to_lowercase() == new_name.to_lowercase()
}

fn rename_remote_case_only(sftp: &ssh2::Sftp, path: &str, target: &str) -> Result<()> {
    let parent = remote_parent_path(path);
    let nanos = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = remote_child_path(
        &parent,
        &format!(".{}.{}.rename-tmp", std::process::id(), nanos),
    );
    let temp_path = Path::new(&temp);
    if sftp.lstat(temp_path).is_ok() {
        bail!("重命名失败：同目录下有未完成的临时文件，原文件未改动");
    }
    sftp.rename(Path::new(path), temp_path, None)
        .with_context(|| format!("failed to rename {} to {}", path, temp))?;
    if let Err(error) = sftp.rename(temp_path, Path::new(target), None) {
        if sftp.rename(temp_path, Path::new(path), None).is_err() {
            bail!("重命名没有完成，文件暂时改成了临时名字，请再改回原来的名字");
        }
        return Err(error);
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
mod preferred_transfer_name_tests {
    use super::preferred_transfer_name;

    #[test]
    fn keeps_a_single_file_name() {
        assert_eq!(
            preferred_transfer_name(Some(" readme.md ")).unwrap().as_deref(),
            Some("readme.md")
        );
        assert_eq!(preferred_transfer_name(None).unwrap(), None);
        assert_eq!(preferred_transfer_name(Some("  ")).unwrap(), None);
    }

    #[test]
    fn rejects_a_path_instead_of_a_name() {
        assert!(preferred_transfer_name(Some("a/b")).is_err());
        assert!(preferred_transfer_name(Some(r"a\b")).is_err());
        assert!(preferred_transfer_name(Some("..")).is_err());
        assert!(preferred_transfer_name(Some(".")).is_err());
    }
}

#[cfg(test)]
mod resume_choice_tests {
    use super::{choose_resume, resume_needs_source_bytes, ResumeChoice};

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

    #[test]
    fn finished_or_refused_resume_does_not_read_the_source() {
        assert!(!resume_needs_source_bytes(choose_resume(
            Some(10),
            Some(10)
        )));
        assert!(resume_needs_source_bytes(choose_resume(Some(4), Some(10))));
        assert!(resume_needs_source_bytes(choose_resume(None, Some(10))));
        assert!(!resume_needs_source_bytes(choose_resume(
            Some(11),
            Some(10)
        )));
        assert!(!resume_needs_source_bytes(choose_resume(Some(8), None)));
    }
}

#[cfg(test)]
mod text_boundary_tests {
    use super::{trim_partial_text_prefix, trim_partial_text_suffix};

    fn gbk_bytes(text: &str) -> Vec<u8> {
        let (bytes, _, unmappable) = encoding_rs::GBK.encode(text);
        assert!(!unmappable);
        bytes.into_owned()
    }

    #[test]
    fn gbk_head_preview_drops_a_split_ending() {
        let full = gbk_bytes("甲乙丙");
        assert_eq!(full.len(), 6);
        let mut head = full[..5].to_vec();
        trim_partial_text_suffix(&mut head, "gbk");
        let (text, _, errors) = encoding_rs::GBK.decode(&head);
        assert!(!errors);
        assert_eq!(text, "甲乙");
    }

    #[test]
    fn gbk_tail_preview_starts_on_the_next_character() {
        let full = gbk_bytes("甲乙丙");
        let mut window = full[2..].to_vec();
        trim_partial_text_prefix(&mut window, "gbk", 1);
        let (text, _, errors) = encoding_rs::GBK.decode(&window);
        assert!(!errors);
        assert_eq!(text, "丙");
    }

    #[test]
    fn complete_gbk_text_is_not_trimmed() {
        let full = gbk_bytes("甲乙丙");
        let mut bytes = full.clone();
        trim_partial_text_suffix(&mut bytes, "gbk");
        assert_eq!(bytes, full);
    }

    #[test]
    fn utf8_preview_still_drops_a_split_ending() {
        let mut bytes = "你好".as_bytes().to_vec();
        bytes.pop();
        trim_partial_text_suffix(&mut bytes, "utf-8");
        assert_eq!(std::str::from_utf8(&bytes).unwrap(), "你");
    }
}

#[cfg(test)]
mod remote_move_tests {
    use super::{ListedRemote, RemoteUploadListing};

    #[test]
    fn remote_move_does_not_land_inside_the_source() {
        assert!(super::remote_move_lands_inside("/a/box", "/a/box/child/box"));
        assert!(super::remote_move_lands_inside("/a/box", "/a/box"));
        assert!(!super::remote_move_lands_inside("/a/box", "/a/box2/box"));
        assert!(!super::remote_move_lands_inside("/a/file", "/b/file"));
        assert!(super::remote_move_lands_inside("/a/box", "/a/box/../box/child"));
    }

    #[test]
    fn upload_listing_finds_one_different_case_and_a_missing_name() {
        let mut listing = RemoteUploadListing::default();
        listing.remember("Foo.txt".to_owned(), upload_listing_stat());
        assert!(matches!(listing.get("Foo.txt"), ListedRemote::Found(_)));
        assert!(matches!(listing.get("foo.txt"), ListedRemote::Found(_)));
        assert!(matches!(listing.get("other.txt"), ListedRemote::Missing));
    }

    #[test]
    fn upload_listing_asks_again_when_two_names_differ_only_by_case() {
        let mut listing = RemoteUploadListing::default();
        listing.remember("Foo.txt".to_owned(), upload_listing_stat());
        listing.remember("foo.txt".to_owned(), upload_listing_stat());
        assert!(matches!(listing.get("foo.txt"), ListedRemote::Found(_)));
        assert!(matches!(listing.get("FOO.txt"), ListedRemote::Unknown));
    }

    fn upload_listing_stat() -> ssh2::FileStat {
        ssh2::FileStat {
            size: Some(1),
            uid: None,
            gid: None,
            perm: Some(0o100644),
            atime: None,
            mtime: None,
        }
    }

    #[test]
    fn remote_move_can_change_only_letter_case() {
        assert!(super::remote_paths_differ_only_by_case(
            "/a/Readme.TXT",
            "/a/readme.txt"
        ));
        assert!(super::remote_paths_differ_only_by_case("/a/Box", "/A/box"));
        assert!(!super::remote_paths_differ_only_by_case(
            "/a/Readme.TXT",
            "/b/readme.txt"
        ));
        assert!(!super::remote_paths_differ_only_by_case(
            "/a/Readme.TXT",
            "/a/Readme.TXT"
        ));
        assert!(!super::remote_paths_differ_only_by_case(
            "/a/Readme.TXT",
            "/a/other.txt"
        ));
    }
}

#[cfg(test)]
mod directory_link_tests {
    use super::{
        directory_link_action, ensure_local_dir, local_path_is_link, open_local_download_dir,
        DirectoryLinkAction,
    };
    use crate::core::sftp::TransferConflictStrategy;
    use std::path::{Path, PathBuf};

    #[test]
    fn resume_keeps_a_directory_link_and_overwrite_replaces_it() {
        assert_eq!(
            directory_link_action(TransferConflictStrategy::Resume),
            DirectoryLinkAction::Refuse
        );
        assert_eq!(
            directory_link_action(TransferConflictStrategy::Skip),
            DirectoryLinkAction::Skip
        );
        assert_eq!(
            directory_link_action(TransferConflictStrategy::Overwrite),
            DirectoryLinkAction::Replace
        );
        assert_eq!(
            directory_link_action(TransferConflictStrategy::Rename),
            DirectoryLinkAction::Replace
        );
    }

    #[test]
    fn ensure_local_dir_reuses_a_real_directory_and_rejects_a_file() {
        let root = scratch_dir("plain");
        let _cleanup = Cleanup(root.clone());
        let dir = root.join("dir");
        std::fs::create_dir(&dir).unwrap();
        ensure_local_dir(&dir).unwrap();
        let file = root.join("file");
        std::fs::write(&file, b"x").unwrap();
        let error = ensure_local_dir(&file).unwrap_err();
        assert!(error.to_string().contains("not a directory"));
    }

    #[test]
    fn download_directory_does_not_enter_an_existing_link() {
        let root = scratch_dir("link");
        let _cleanup = Cleanup(root.clone());
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep.txt"), b"keep").unwrap();
        let link = root.join("link");
        make_directory_link(&target, &link);
        let metadata = std::fs::symlink_metadata(&link).unwrap();
        assert!(local_path_is_link(&link, &metadata));

        let error = ensure_local_dir(&link).unwrap_err();
        assert!(error.to_string().contains("not a directory"));
        assert_eq!(std::fs::read(target.join("keep.txt")).unwrap(), b"keep");

        assert!(!open_local_download_dir(&link, TransferConflictStrategy::Skip).unwrap());
        assert!(local_path_is_link(
            &link,
            &std::fs::symlink_metadata(&link).unwrap()
        ));

        let error = open_local_download_dir(&link, TransferConflictStrategy::Resume).unwrap_err();
        assert!(error.to_string().contains("\u{94fe}\u{63a5}"));
        assert!(local_path_is_link(
            &link,
            &std::fs::symlink_metadata(&link).unwrap()
        ));

        assert!(open_local_download_dir(&link, TransferConflictStrategy::Overwrite).unwrap());
        let replaced = std::fs::symlink_metadata(&link).unwrap();
        assert!(!local_path_is_link(&link, &replaced));
        assert!(replaced.is_dir());
        assert!(std::fs::read_dir(&link).unwrap().next().is_none());
        assert_eq!(std::fs::read(target.join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn replacing_a_directory_link_removes_only_the_link() {
        let root = scratch_dir("replace-link");
        let _cleanup = Cleanup(root.clone());
        let target = root.join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep.txt"), b"keep").unwrap();
        let link = root.join("link");
        make_directory_link(&target, &link);

        super::remove_local_existing_path(&link).unwrap();

        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(std::fs::read(target.join("keep.txt")).unwrap(), b"keep");

        let dir = root.join("dir");
        std::fs::create_dir(&dir).unwrap();
        let error = super::remove_local_existing_path(&dir).unwrap_err();
        assert!(error.to_string().contains("目录"));
        assert!(dir.is_dir());
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "rustshell-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn make_directory_link(target: &Path, link: &Path) {
        if super::create_local_symlink(target, link).is_ok() {
            return;
        }
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .arg("/C")
                .arg(format!(
                    "mklink /J \"{}\" \"{}\"",
                    link.display(),
                    target.display()
                ))
                .status()
                .expect("start mklink");
            assert!(status.success(), "could not create a directory junction");
            return;
        }
        #[cfg(not(windows))]
        panic!("could not create a directory link");
    }

    struct Cleanup(PathBuf);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let link = self.0.join("link");
            let _ = std::fs::remove_file(&link);
            let _ = std::fs::remove_dir(&link);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(all(test, windows))]
mod local_size_tests {
    use std::sync::atomic::AtomicBool;

    #[test]
    fn folder_size_skips_an_unreadable_child() {
        let root = scratch_dir("unreadable-child");
        let _cleanup = AclCleanup(root.clone());
        std::fs::write(root.join("ok.txt"), b"hello").unwrap();
        let locked = root.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("secret.txt"), b"secret-data").unwrap();
        deny_list_access(&locked);

        let cancel = AtomicBool::new(false);
        let size = super::local_total_size(&root, &cancel).unwrap();
        assert_eq!(size, 5, "one locked folder should not fail the rest");

        let error = super::local_total_size(&locked, &cancel).unwrap_err();
        assert!(
            error.to_string().contains("failed to read"),
            "the locked folder itself should still fail: {error}"
        );

        let mut transferred = 0_u64;
        super::add_skipped_local_tree(&locked, &mut transferred, 5, &cancel, &mut |_, _| {}).unwrap();
        assert_eq!(transferred, 0);
        super::add_skipped_local_tree(&root.join("ok.txt"), &mut transferred, 5, &cancel, &mut |_, _| {})
            .unwrap();
        assert_eq!(transferred, 5);
    }

    fn deny_list_access(path: &std::path::Path) {
        let user = std::env::var("USERNAME").expect("USERNAME");
        let deny_user = format!("{user}:(RX)");
        let commands: [&[&str]; 3] = [
            &["/inheritance:r"],
            &["/deny", deny_user.as_str()],
            &["/deny", "*S-1-1-0:(RX)"],
        ];
        for args in commands {
            let status = std::process::Command::new("icacls")
                .arg(path)
                .args(args)
                .status()
                .expect("icacls");
            assert!(status.success(), "icacls failed");
        }
    }

    fn allow_list_access(path: &std::path::Path) {
        let user = std::env::var("USERNAME").unwrap_or_default();
        let _ = std::process::Command::new("icacls")
            .arg(path)
            .arg("/grant")
            .arg(format!("{user}:(OI)(CI)F"))
            .status();
    }

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "rustshell-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    struct AclCleanup(std::path::PathBuf);

    impl Drop for AclCleanup {
        fn drop(&mut self) {
            allow_list_access(&self.0.join("locked"));
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod case_rename_tests {
    use super::only_case_variant_is_source;

    #[test]
    fn one_folded_name_can_change_case() {
        assert!(only_case_variant_is_source(
            "Readme.TXT",
            "readme.txt",
            &["Readme.TXT"]
        ));
        assert!(only_case_variant_is_source(
            "readme.txt",
            "README.txt",
            &["Readme.TXT"]
        ));
        assert!(!only_case_variant_is_source(
            "Readme.TXT",
            "readme.txt",
            &["Readme.TXT", "readme.txt"]
        ));
        assert!(!only_case_variant_is_source("Readme.TXT", "other.txt", &["other.txt"]));
        assert!(!only_case_variant_is_source("Readme.TXT", "Readme.TXT", &["Readme.TXT"]));
        assert!(!only_case_variant_is_source("Readme.TXT", "readme.txt", &[]));
    }
}

#[cfg(test)]
mod numbered_copy_tests {
    use super::{next_free_numbered_name, resolve_local_path, TransferConflictStrategy};
    use std::collections::HashSet;

    #[test]
    fn the_first_free_number_is_used() {
        let mut occupied = HashSet::new();
        occupied.insert("report (1).txt".to_owned());
        occupied.insert("report (3).txt".to_owned());
        assert_eq!(
            next_free_numbered_name("report", ".txt", &occupied, 1, false).as_deref(),
            Some("report (2).txt")
        );
        occupied.insert("report (2).txt".to_owned());
        assert_eq!(
            next_free_numbered_name("report", ".txt", &occupied, 1, false).as_deref(),
            Some("report (4).txt")
        );
    }

    #[test]
    fn an_existing_copy_keeps_its_bytes_and_the_new_name_is_free() {
        let root = std::env::temp_dir().join(format!(
            "rustshell-rename-copy-{}-{}",
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
        std::fs::write(root.join("report.txt"), b"original").unwrap();
        std::fs::write(root.join("report (1).txt"), b"first").unwrap();
        std::fs::write(root.join("report (2).txt"), b"second").unwrap();
        let resolved = resolve_local_path(
            &root.join("report.txt"),
            TransferConflictStrategy::Rename,
        )
        .unwrap();
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some("report (3).txt")
        );
        assert_eq!(std::fs::read(root.join("report (1).txt")).unwrap(), b"first");
        assert_eq!(std::fs::read(root.join("report (2).txt")).unwrap(), b"second");

        std::fs::remove_file(root.join("report (1).txt")).unwrap();
        let resolved = resolve_local_path(
            &root.join("report.txt"),
            TransferConflictStrategy::Rename,
        )
        .unwrap();
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some("report (1).txt")
        );
    }

    #[test]
    fn a_numbered_name_taken_from_the_list_is_not_offered_again() {
        let mut occupied = HashSet::new();
        occupied.insert("report.txt".to_owned());
        occupied.insert("report (1).txt".to_owned());
        let first = next_free_numbered_name("report", ".txt", &occupied, 2, false).unwrap();
        occupied.insert(first.clone());
        let second = next_free_numbered_name("report", ".txt", &occupied, 2, false).unwrap();
        assert_eq!(first, "report (2).txt");
        assert_eq!(second, "report (3).txt");
    }

    #[test]
    fn a_remote_name_with_different_case_is_still_free() {
        let mut occupied = HashSet::new();
        occupied.insert("readme (2).txt".to_owned());
        assert_eq!(
            next_free_numbered_name("Readme", ".txt", &occupied, 2, false).as_deref(),
            Some("Readme (2).txt")
        );
        assert_eq!(
            next_free_numbered_name("Readme", ".txt", &occupied, 2, true).as_deref(),
            Some("Readme (3).txt")
        );
    }
}

#[cfg(test)]
mod remote_attribute_tests {
    use super::remote_mode_and_times;

    #[test]
    fn permission_and_time_go_out_together() {
        let stat = remote_mode_and_times(Some(0o1644), Some(10), Some(20)).unwrap();
        assert_eq!(stat.perm, Some(0o644));
        assert_eq!(stat.atime, Some(10));
        assert_eq!(stat.mtime, Some(20));
        assert_eq!(stat.uid, None);
        assert_eq!(stat.size, None);
    }

    #[test]
    fn nothing_to_preserve_makes_no_update() {
        assert!(remote_mode_and_times(None, None, None).is_none());
    }
}

#[cfg(test)]
mod listing_stat_tests {
    use super::listing_stat_with_type;

    #[test]
    fn a_listing_without_a_type_is_not_reused() {
        let bare = ssh2::FileStat {
            size: Some(1),
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: None,
        };
        assert!(listing_stat_with_type(bare).is_none());
        let typed = ssh2::FileStat {
            perm: Some(0o100644),
            ..bare
        };
        assert_eq!(listing_stat_with_type(typed).and_then(|stat| stat.perm), Some(0o100644));
    }
}
