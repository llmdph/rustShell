use crate::{
    core::{
        session::{AuthProfile, SessionProfile, SessionProtocol},
        sftp::{
            list_local_dir, local_chmod, local_create_file, local_create_symlink, local_duplicate,
            local_file_sha256, local_home, local_mkdir, local_move, local_parent, local_path_stats,
            local_read_text_file, local_read_text_file_tail, local_remove, local_rename,
            local_touch, local_write_text_file, remote_parent_path, search_local, FileEntry,
            TransferConflictStrategy, TransferDirection,
        },
    },
    services::{
        sftp_service::{self, SftpConnection},
        storage,
        storage::{SessionStore, TransferHistoryRecord},
    },
};
use chrono::{DateTime, Datelike, Local, Utc};
use std::cmp::Ordering as SortOrdering;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const NATIVE_TRANSFER_HISTORY_LIMIT: usize = 200;

#[derive(Clone, Debug)]
pub struct NativePreviewSummary {
    pub session_count: usize,
    pub remote_session_count: usize,
    pub session_listing: String,
    pub default_remote_selector: String,
    pub local_preview: NativeLocalPreview,
}

#[derive(Clone, Debug)]
pub struct NativeLocalPreview {
    pub path: String,
    pub local_file_count: usize,
    pub local_dir_count: usize,
    pub local_listing: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NativeRemotePreview {
    pub selector: String,
    pub path: String,
    pub remote_file_count: usize,
    pub remote_dir_count: usize,
    pub remote_listing: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NativeRemoteTextPreview {
    pub path: String,
    pub summary: String,
    pub content: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NativeLocalTextPreview {
    pub path: String,
    pub summary: String,
    pub content: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NativeTransferPreview {
    pub summary: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct NativeTransferHistoryPreview {
    pub summary: String,
    pub listing: String,
    pub error: Option<String>,
}

impl NativePreviewSummary {
    pub fn session_text(&self) -> String {
        format!(
            "已加载 {} 个会话，其中远程会话 {} 个",
            self.session_count, self.remote_session_count
        )
    }

    pub fn local_text(&self) -> String {
        self.local_preview.local_text()
    }
}

impl NativeLocalPreview {
    pub fn local_text(&self) -> String {
        let base = format!(
            "{}\n目录 {} 个，文件 {} 个",
            self.path, self.local_dir_count, self.local_file_count
        );
        match &self.error {
            Some(error) => format!("{}\n{}", base, error),
            None => base,
        }
    }
}

impl NativeRemotePreview {
    pub fn remote_text(&self) -> String {
        let base = if self.selector.trim().is_empty() {
            "未选择远程会话".to_owned()
        } else {
            format!(
                "{}\n{}\n目录 {} 个，文件 {} 个",
                self.selector, self.path, self.remote_dir_count, self.remote_file_count
            )
        };
        match &self.error {
            Some(error) => format!("{}\n{}", base, error),
            None => base,
        }
    }
}

impl NativeRemoteTextPreview {
    pub fn status_text(&self) -> String {
        match &self.error {
            Some(error) => format!("远程文本失败: {}", error),
            None => format!("远程文本已加载: {}", self.path),
        }
    }
}

impl NativeLocalTextPreview {
    pub fn status_text(&self) -> String {
        match &self.error {
            Some(error) => format!("本地文本失败: {}", error),
            None => format!("本地文本已加载: {}", self.path),
        }
    }
}

impl NativeTransferPreview {
    pub fn status_text(&self) -> String {
        match &self.error {
            Some(error) => format!("传输失败: {}", error),
            None => self.summary.clone(),
        }
    }
}

impl NativeTransferHistoryPreview {
    pub fn status_text(&self) -> String {
        match &self.error {
            Some(error) => format!("传输历史失败: {}", error),
            None => self.summary.clone(),
        }
    }
}

pub fn native_preview_summary() -> NativePreviewSummary {
    let profiles = SessionStore::new().load_or_seed();
    let remote_session_count = profiles
        .iter()
        .filter(|profile| is_remote_file_profile(profile))
        .count();
    let default_remote_selector = profiles
        .iter()
        .find(|profile| is_remote_file_profile(profile))
        .map(|profile| profile.name.clone())
        .unwrap_or_default();

    NativePreviewSummary {
        session_count: profiles.len(),
        remote_session_count,
        session_listing: format_session_listing(&profiles, 16),
        default_remote_selector,
        local_preview: native_local_preview(&local_home()),
    }
}

pub fn native_session_connection_command(selector: &str) -> String {
    let profiles = SessionStore::new().load_or_seed();
    match find_remote_profile(&profiles, selector) {
        Some(profile) => session_connection_command(profile),
        None => "远程会话未找到，请输入会话名称、完整 UUID 或短 UUID 前缀".to_owned(),
    }
}

pub fn native_remote_command_preview(
    selector: &str,
    target_path: &str,
    mode: &str,
    uid: &str,
    gid: &str,
    mtime: &str,
    recursive: bool,
    link_target: &str,
) -> String {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return "请输入远程目标路径后生成命令".to_owned();
    }

    let profiles = SessionStore::new().load_or_seed();
    let Some(profile) = find_remote_profile(&profiles, selector) else {
        return "远程会话未找到，请输入会话名称、完整 UUID 或短 UUID 前缀".to_owned();
    };

    remote_path_command_preview(
        profile,
        target_path,
        mode,
        uid,
        gid,
        mtime,
        recursive,
        link_target,
    )
}

pub fn native_local_preview(path: &str) -> NativeLocalPreview {
    let path = if path.trim().is_empty() {
        local_home()
    } else {
        path.trim().to_owned()
    };
    match list_local_dir(&path) {
        Ok(local_entries) => {
            let (local_dir_count, local_file_count) =
                local_entries.iter().fold((0, 0), |(dirs, files), entry| {
                    if entry.is_dir {
                        (dirs + 1, files)
                    } else {
                        (dirs, files + 1)
                    }
                });
            NativeLocalPreview {
                path,
                local_file_count,
                local_dir_count,
                local_listing: format_local_listing(&local_entries, 14),
                error: None,
            }
        }
        Err(error) => NativeLocalPreview {
            path,
            local_file_count: 0,
            local_dir_count: 0,
            local_listing: "目录无法读取".to_owned(),
            error: Some(format!("读取失败: {}", error)),
        },
    }
}

pub fn native_local_csv_preview(path: &str) -> NativeLocalPreview {
    let path = if path.trim().is_empty() {
        local_home()
    } else {
        path.trim().to_owned()
    };
    match list_local_dir(&path) {
        Ok(local_entries) => {
            let (local_dir_count, local_file_count) =
                local_entries.iter().fold((0, 0), |(dirs, files), entry| {
                    if entry.is_dir {
                        (dirs + 1, files)
                    } else {
                        (dirs, files + 1)
                    }
                });
            NativeLocalPreview {
                path,
                local_file_count,
                local_dir_count,
                local_listing: format_file_csv(&local_entries),
                error: None,
            }
        }
        Err(error) => NativeLocalPreview {
            path,
            local_file_count: 0,
            local_dir_count: 0,
            local_listing: "本地 CSV 清单无法读取".to_owned(),
            error: Some(format!("读取失败: {}", error)),
        },
    }
}

pub fn native_local_home_preview() -> NativeLocalPreview {
    native_local_preview(&local_home())
}

pub fn native_local_parent_preview(path: &str) -> NativeLocalPreview {
    let path = path.trim();
    let parent = if path.is_empty() {
        Some(local_home())
    } else {
        local_parent(path)
    };
    match parent {
        Some(parent) => native_local_preview(&parent),
        None => NativeLocalPreview {
            path: path.to_owned(),
            local_file_count: 0,
            local_dir_count: 0,
            local_listing: "没有可打开的上级目录".to_owned(),
            error: Some("没有可打开的上级目录".to_owned()),
        },
    }
}

pub fn native_local_create_dir(current_path: &str, name: &str) -> NativeLocalPreview {
    let parent = normalize_local_path(current_path);
    let name = name.trim();
    if name.is_empty() {
        return local_error_preview(&parent, "目录未创建", "请输入目录名称");
    }
    match local_mkdir(&parent, name) {
        Ok(()) => native_local_preview(&parent),
        Err(error) => {
            local_error_preview(&parent, "目录未创建", format!("创建目录失败: {}", error))
        }
    }
}

pub fn native_local_create_file(current_path: &str, name: &str) -> NativeLocalPreview {
    let parent = normalize_local_path(current_path);
    let name = name.trim();
    if name.is_empty() {
        return local_error_preview(&parent, "文件未创建", "请输入文件名称");
    }
    match local_create_file(&parent, name) {
        Ok(_) => native_local_preview(&parent),
        Err(error) => {
            local_error_preview(&parent, "文件未创建", format!("创建文件失败: {}", error))
        }
    }
}

pub fn native_local_create_symlink(
    current_path: &str,
    name: &str,
    target_path: &str,
) -> NativeLocalPreview {
    let parent = normalize_local_path(current_path);
    let name = name.trim();
    let target_path = target_path.trim();
    if name.is_empty() || target_path.is_empty() {
        return local_error_preview(&parent, "软链接未创建", "请输入链接名称和目标路径");
    }
    match local_create_symlink(&parent, name, target_path) {
        Ok(_) => native_local_preview(&parent),
        Err(error) => local_error_preview(
            &parent,
            "软链接未创建",
            format!("创建软链接失败: {}", error),
        ),
    }
}

pub fn native_local_delete_path(
    current_path: &str,
    target_path: &str,
    is_dir: bool,
) -> NativeLocalPreview {
    let target_path = target_path.trim();
    let refresh_path = target_path
        .is_empty()
        .then(|| normalize_local_path(current_path))
        .or_else(|| local_parent(target_path))
        .unwrap_or_else(|| normalize_local_path(current_path));
    if target_path.is_empty() {
        return local_error_preview(&refresh_path, "路径未删除", "请输入要删除的本地路径");
    }
    match local_remove(target_path, is_dir) {
        Ok(()) => native_local_preview(&refresh_path),
        Err(error) => {
            local_error_preview(&refresh_path, "路径未删除", format!("删除失败: {}", error))
        }
    }
}

pub fn native_local_delete_preview(current_path: &str, target_path: &str) -> NativeLocalPreview {
    let target_path = target_path.trim();
    let refresh_path = target_path
        .is_empty()
        .then(|| normalize_local_path(current_path))
        .or_else(|| local_parent(target_path))
        .unwrap_or_else(|| normalize_local_path(current_path));
    if target_path.is_empty() {
        return local_error_preview(&refresh_path, "删除预览不可用", "请输入要删除的本地路径");
    }

    match local_entry_for_path(target_path) {
        Some(entry) => NativeLocalPreview {
            path: refresh_path,
            local_file_count: usize::from(!entry.is_dir),
            local_dir_count: usize::from(entry.is_dir),
            local_listing: format_delete_preview_listing("local", &entry, entry.is_dir),
            error: None,
        },
        None => local_error_preview(&refresh_path, "删除预览不可用", "本地路径不存在或无法读取"),
    }
}

pub fn native_local_rename_path(
    current_path: &str,
    target_path: &str,
    new_name: &str,
) -> NativeLocalPreview {
    let target_path = target_path.trim();
    let new_name = new_name.trim();
    let refresh_path = target_path
        .is_empty()
        .then(|| normalize_local_path(current_path))
        .or_else(|| local_parent(target_path))
        .unwrap_or_else(|| normalize_local_path(current_path));
    if target_path.is_empty() || new_name.is_empty() {
        return local_error_preview(&refresh_path, "路径未重命名", "请输入本地路径和新名称");
    }
    match local_rename(target_path, new_name) {
        Ok(()) => native_local_preview(&refresh_path),
        Err(error) => local_error_preview(
            &refresh_path,
            "路径未重命名",
            format!("重命名失败: {}", error),
        ),
    }
}

pub fn native_local_duplicate_path(
    current_path: &str,
    target_path: &str,
    new_name: &str,
) -> NativeLocalPreview {
    let target_path = target_path.trim();
    let new_name = new_name.trim();
    let refresh_path = local_refresh_path(current_path, target_path);
    if target_path.is_empty() || new_name.is_empty() {
        return local_error_preview(&refresh_path, "路径未复制", "请输入本地路径和副本名称");
    }
    match local_duplicate(target_path, new_name) {
        Ok(_) => native_local_preview(&refresh_path),
        Err(error) => {
            local_error_preview(&refresh_path, "路径未复制", format!("复制失败: {}", error))
        }
    }
}

pub fn native_local_move_path(
    current_path: &str,
    target_path: &str,
    destination_path: &str,
) -> NativeLocalPreview {
    let target_path = target_path.trim();
    let destination_path = destination_path.trim();
    let refresh_path = local_refresh_path(current_path, target_path);
    if target_path.is_empty() || destination_path.is_empty() {
        return local_error_preview(&refresh_path, "路径未移动", "请输入本地路径和目标位置");
    }
    match local_move(target_path, destination_path) {
        Ok(path) => native_local_preview(
            &local_parent(&path).unwrap_or_else(|| normalize_local_path(current_path)),
        ),
        Err(error) => {
            local_error_preview(&refresh_path, "路径未移动", format!("移动失败: {}", error))
        }
    }
}

pub fn native_local_chmod_path(
    current_path: &str,
    target_path: &str,
    mode: &str,
    recursive: bool,
) -> NativeLocalPreview {
    let target_path = target_path.trim();
    let refresh_path = local_refresh_path(current_path, target_path);
    if target_path.is_empty() {
        return local_error_preview(&refresh_path, "权限未修改", "请输入要修改权限的本地路径");
    }
    let target_entry = local_entry_for_path(target_path);
    let Some(mode) = resolve_chmod_mode(
        mode,
        target_entry.as_ref().and_then(|entry| entry.permissions),
        target_entry.as_ref().is_some_and(|entry| entry.is_dir),
    ) else {
        return local_error_preview(
            &refresh_path,
            "权限未修改",
            "权限格式必须是 0000-7777 八进制或 u+rw,g-w,o= 等符号模式",
        );
    };
    match local_chmod(target_path, mode, recursive) {
        Ok(()) => native_local_preview(&refresh_path),
        Err(error) => local_error_preview(
            &refresh_path,
            "权限未修改",
            format!("chmod 失败: {}", error),
        ),
    }
}

pub fn native_local_touch_path(
    current_path: &str,
    target_path: &str,
    mtime: &str,
    recursive: bool,
) -> NativeLocalPreview {
    let target_path = target_path.trim();
    let refresh_path = local_refresh_path(current_path, target_path);
    if target_path.is_empty() {
        return local_error_preview(&refresh_path, "时间未修改", "请输入要修改时间的本地路径");
    }
    let Some(mtime) = parse_mtime(mtime) else {
        return local_error_preview(&refresh_path, "时间未修改", "mtime 必须是 Unix 秒时间戳");
    };
    match local_touch(target_path, mtime, recursive) {
        Ok(()) => native_local_preview(&refresh_path),
        Err(error) => local_error_preview(
            &refresh_path,
            "时间未修改",
            format!("touch 失败: {}", error),
        ),
    }
}

pub fn native_local_path_stats(current_path: &str, target_path: &str) -> NativeLocalPreview {
    let path = if target_path.trim().is_empty() {
        normalize_local_path(current_path)
    } else {
        target_path.trim().to_owned()
    };
    match local_path_stats(&path) {
        Ok(stats) => NativeLocalPreview {
            path,
            local_file_count: stats.file_count as usize,
            local_dir_count: stats.dir_count as usize,
            local_listing: format!(
                "统计结果\n目录: {}\n文件: {}\n总大小: {}",
                stats.dir_count,
                stats.file_count,
                format_size(stats.total_size)
            ),
            error: None,
        },
        Err(error) => local_error_preview(&path, "统计失败", format!("统计失败: {}", error)),
    }
}

pub fn native_local_search(current_path: &str, query: &str) -> NativeLocalPreview {
    let root = normalize_local_path(current_path);
    let query = query.trim();
    if query.is_empty() {
        return local_error_preview(&root, "搜索未执行", "请输入搜索关键词");
    }

    match search_local(&root, query, 200) {
        Ok(entries) => NativeLocalPreview {
            path: root,
            local_file_count: entries.iter().filter(|entry| !entry.is_dir).count(),
            local_dir_count: entries.iter().filter(|entry| entry.is_dir).count(),
            local_listing: format_local_listing(&entries, 60),
            error: None,
        },
        Err(error) => local_error_preview(&root, "搜索失败", format!("本地搜索失败: {}", error)),
    }
}

pub fn native_local_read_text(target_path: &str) -> NativeLocalTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return local_text_error("", "请输入要读取的本地文件路径");
    }

    match local_read_text_file(target_path) {
        Ok(file) => NativeLocalTextPreview {
            path: file.path,
            summary: text_file_segment_summary(
                "开头预览",
                file.size,
                file.truncated,
                file.is_binary,
            ),
            content: file.content,
            error: None,
        },
        Err(error) => local_text_error(target_path, format!("读取失败: {}", error)),
    }
}

pub fn native_local_read_text_tail(target_path: &str) -> NativeLocalTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return local_text_error("", "请输入要读取的本地文件路径");
    }

    match local_read_text_file_tail(target_path) {
        Ok(file) => NativeLocalTextPreview {
            path: file.path,
            summary: text_file_segment_summary(
                "末尾预览",
                file.size,
                file.truncated,
                file.is_binary,
            ),
            content: file.content,
            error: None,
        },
        Err(error) => local_text_error(target_path, format!("读取失败: {}", error)),
    }
}

pub fn native_local_write_text(target_path: &str, content: &str) -> NativeLocalTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return local_text_error("", "请输入要写入的本地文件路径");
    }

    match local_write_text_file(target_path, content) {
        Ok(()) => native_local_read_text(target_path),
        Err(error) => local_text_error(target_path, format!("写入失败: {}", error)),
    }
}

pub fn native_local_sha256(target_path: &str) -> NativeLocalTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return local_text_error("", "请输入要校验的本地文件路径");
    }

    match local_file_sha256(target_path) {
        Ok(checksum) => NativeLocalTextPreview {
            path: target_path.to_owned(),
            summary: format!("SHA-256: {}", checksum),
            content: checksum,
            error: None,
        },
        Err(error) => local_text_error(target_path, format!("校验失败: {}", error)),
    }
}

pub fn native_local_sha256_csv(target_path: &str) -> NativeLocalTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return local_text_error("", "请输入要校验的本地文件路径");
    }

    match local_file_sha256(target_path) {
        Ok(checksum) => {
            let content = format_sha256_csv(
                "local",
                local_entry_for_path(target_path).as_ref(),
                target_path,
                &checksum,
            );
            NativeLocalTextPreview {
                path: target_path.to_owned(),
                summary: "SHA-256 CSV 审计已生成".to_owned(),
                content,
                error: None,
            }
        }
        Err(error) => local_text_error(target_path, format!("校验失败: {}", error)),
    }
}

pub fn native_remote_preview(
    selector: &str,
    path: &str,
    password: Option<&str>,
) -> NativeRemotePreview {
    let (selector, connection) = match open_remote_connection(selector, password) {
        Ok(connection) => connection,
        Err(error) => return remote_error_preview(selector, path, "远程目录无法读取", error),
    };

    let path = if path.trim().is_empty() {
        connection.home_dir().unwrap_or_else(|_| ".".to_owned())
    } else {
        path.trim().to_owned()
    };

    match connection.list_dir(&path) {
        Ok(remote_entries) => {
            let (remote_dir_count, remote_file_count) =
                remote_entries.iter().fold((0, 0), |(dirs, files), entry| {
                    if entry.is_dir {
                        (dirs + 1, files)
                    } else {
                        (dirs, files + 1)
                    }
                });
            NativeRemotePreview {
                selector,
                path,
                remote_file_count,
                remote_dir_count,
                remote_listing: format_file_listing(&remote_entries, 16),
                error: None,
            }
        }
        Err(error) => NativeRemotePreview {
            selector,
            path,
            remote_file_count: 0,
            remote_dir_count: 0,
            remote_listing: "远程目录无法读取".to_owned(),
            error: Some(format!("读取失败: {}", error)),
        },
    }
}

pub fn native_remote_csv_preview(
    selector: &str,
    path: &str,
    password: Option<&str>,
) -> NativeRemotePreview {
    let (selector, connection) = match open_remote_connection(selector, password) {
        Ok(connection) => connection,
        Err(error) => return remote_error_preview(selector, path, "远程 CSV 清单无法读取", error),
    };

    let path = if path.trim().is_empty() {
        connection.home_dir().unwrap_or_else(|_| ".".to_owned())
    } else {
        path.trim().to_owned()
    };

    match connection.list_dir(&path) {
        Ok(remote_entries) => {
            let (remote_dir_count, remote_file_count) =
                remote_entries.iter().fold((0, 0), |(dirs, files), entry| {
                    if entry.is_dir {
                        (dirs + 1, files)
                    } else {
                        (dirs, files + 1)
                    }
                });
            NativeRemotePreview {
                selector,
                path,
                remote_file_count,
                remote_dir_count,
                remote_listing: format_file_csv(&remote_entries),
                error: None,
            }
        }
        Err(error) => NativeRemotePreview {
            selector,
            path,
            remote_file_count: 0,
            remote_dir_count: 0,
            remote_listing: "远程 CSV 清单无法读取".to_owned(),
            error: Some(format!("读取失败: {}", error)),
        },
    }
}

pub fn native_remote_home_preview(selector: &str, password: Option<&str>) -> NativeRemotePreview {
    native_remote_preview(selector, "", password)
}

pub fn native_remote_parent_preview(
    selector: &str,
    path: &str,
    password: Option<&str>,
) -> NativeRemotePreview {
    let path = normalize_remote_path(path);
    let parent = if path == "." {
        String::new()
    } else {
        remote_parent_path(&path)
    };
    native_remote_preview(selector, &parent, password)
}

pub fn native_remote_create_dir(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    name: &str,
) -> NativeRemotePreview {
    let parent = normalize_remote_path(current_path);
    let name = name.trim();
    if name.is_empty() {
        return remote_error_preview(selector, &parent, "目录未创建", "请输入目录名称");
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.create_dir(&parent, name) {
            Ok(()) => native_remote_preview(selector, &parent, password),
            Err(error) => remote_error_preview(
                selector,
                &parent,
                "目录未创建",
                format!("创建目录失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &parent, "目录未创建", error),
    }
}

pub fn native_remote_create_file(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    name: &str,
) -> NativeRemotePreview {
    let parent = normalize_remote_path(current_path);
    let name = name.trim();
    if name.is_empty() {
        return remote_error_preview(selector, &parent, "文件未创建", "请输入文件名称");
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.create_file(&parent, name) {
            Ok(_) => native_remote_preview(selector, &parent, password),
            Err(error) => remote_error_preview(
                selector,
                &parent,
                "文件未创建",
                format!("创建文件失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &parent, "文件未创建", error),
    }
}

pub fn native_remote_create_symlink(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    name: &str,
    link_target: &str,
) -> NativeRemotePreview {
    let parent = normalize_remote_path(current_path);
    let name = name.trim();
    let link_target = link_target.trim();
    if name.is_empty() || link_target.is_empty() {
        return remote_error_preview(
            selector,
            &parent,
            "符号链接未创建",
            "请输入链接名称和目标路径",
        );
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.create_symlink(&parent, name, link_target) {
            Ok(_) => native_remote_preview(selector, &parent, password),
            Err(error) => remote_error_preview(
                selector,
                &parent,
                "符号链接未创建",
                format!("创建符号链接失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &parent, "符号链接未创建", error),
    }
}

pub fn native_remote_delete_path(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
    is_dir: bool,
    recursive: bool,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let refresh_path = if target_path.is_empty() {
        normalize_remote_path(current_path)
    } else {
        remote_parent_path(target_path)
    };
    if target_path.is_empty() {
        return remote_error_preview(
            selector,
            &refresh_path,
            "路径未删除",
            "请输入要删除的远程路径",
        );
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.remove_path(target_path, is_dir, recursive) {
            Ok(()) => native_remote_preview(selector, &refresh_path, password),
            Err(error) => remote_error_preview(
                selector,
                &refresh_path,
                "路径未删除",
                format!("删除失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &refresh_path, "路径未删除", error),
    }
}

pub fn native_remote_delete_preview(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
    recursive: bool,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let refresh_path = if target_path.is_empty() {
        normalize_remote_path(current_path)
    } else {
        remote_parent_path(target_path)
    };
    if target_path.is_empty() {
        return remote_error_preview(
            selector,
            &refresh_path,
            "删除预览不可用",
            "请输入要删除的远程路径",
        );
    }

    match open_remote_connection(selector, password) {
        Ok((selector, connection)) => match remote_entry_for_path(&connection, target_path) {
            Some(entry) => NativeRemotePreview {
                selector,
                path: refresh_path,
                remote_file_count: usize::from(!entry.is_dir),
                remote_dir_count: usize::from(entry.is_dir),
                remote_listing: format_delete_preview_listing("remote", &entry, recursive),
                error: None,
            },
            None => remote_error_preview(
                &selector,
                &refresh_path,
                "删除预览不可用",
                "远程路径不存在或无法读取",
            ),
        },
        Err(error) => remote_error_preview(selector, &refresh_path, "删除预览不可用", error),
    }
}

pub fn native_remote_duplicate_path(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
    new_name: &str,
    is_dir: bool,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let new_name = new_name.trim();
    let refresh_path = if target_path.is_empty() {
        normalize_remote_path(current_path)
    } else {
        remote_parent_path(target_path)
    };
    if target_path.is_empty() || new_name.is_empty() {
        return remote_error_preview(
            selector,
            &refresh_path,
            "路径未复制",
            "请输入路径和复制后的名称",
        );
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.duplicate_path(target_path, is_dir, new_name) {
            Ok(_) => native_remote_preview(selector, &refresh_path, password),
            Err(error) => remote_error_preview(
                selector,
                &refresh_path,
                "路径未复制",
                format!("复制失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &refresh_path, "路径未复制", error),
    }
}

pub fn native_remote_move_path(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
    destination_path: &str,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let destination_path = destination_path.trim();
    let refresh_path = if current_path.trim().is_empty() {
        remote_parent_path(target_path)
    } else {
        normalize_remote_path(current_path)
    };
    if target_path.is_empty() || destination_path.is_empty() {
        return remote_error_preview(
            selector,
            &refresh_path,
            "路径未移动",
            "请输入源路径和目标目录/完整路径",
        );
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.move_path(target_path, destination_path) {
            Ok(_) => native_remote_preview(selector, &refresh_path, password),
            Err(error) => remote_error_preview(
                selector,
                &refresh_path,
                "路径未移动",
                format!("移动失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &refresh_path, "路径未移动", error),
    }
}

pub fn native_remote_rename_path(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
    new_name: &str,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let new_name = new_name.trim();
    let refresh_path = if target_path.is_empty() {
        normalize_remote_path(current_path)
    } else {
        remote_parent_path(target_path)
    };
    if target_path.is_empty() || new_name.is_empty() {
        return remote_error_preview(
            selector,
            &refresh_path,
            "路径未重命名",
            "请输入路径和新名称",
        );
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.rename_path(target_path, new_name) {
            Ok(_) => native_remote_preview(selector, &refresh_path, password),
            Err(error) => remote_error_preview(
                selector,
                &refresh_path,
                "路径未重命名",
                format!("重命名失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &refresh_path, "路径未重命名", error),
    }
}

pub fn native_remote_chmod_path(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
    mode: &str,
    recursive: bool,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let refresh_path = if target_path.is_empty() {
        normalize_remote_path(current_path)
    } else {
        remote_parent_path(target_path)
    };
    if target_path.is_empty() {
        return remote_error_preview(
            selector,
            &refresh_path,
            "权限未修改",
            "请输入要修改权限的远程路径",
        );
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => {
            let target_entry = remote_entry_for_path(&connection, target_path);
            let Some(mode) = resolve_chmod_mode(
                mode,
                target_entry.as_ref().and_then(|entry| entry.permissions),
                target_entry.as_ref().is_some_and(|entry| entry.is_dir),
            ) else {
                return remote_error_preview(
                    selector,
                    &refresh_path,
                    "权限未修改",
                    "权限格式必须是 0000-7777 八进制或 u+rw,g-w,o= 等符号模式",
                );
            };
            match connection.chmod_path(target_path, mode, recursive) {
                Ok(()) => native_remote_preview(selector, &refresh_path, password),
                Err(error) => remote_error_preview(
                    selector,
                    &refresh_path,
                    "权限未修改",
                    format!("chmod 失败: {}", error),
                ),
            }
        }
        Err(error) => remote_error_preview(selector, &refresh_path, "权限未修改", error),
    }
}

pub fn native_remote_chown_path(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
    uid: &str,
    gid: &str,
    recursive: bool,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let refresh_path = if target_path.is_empty() {
        normalize_remote_path(current_path)
    } else {
        remote_parent_path(target_path)
    };
    if target_path.is_empty() {
        return remote_error_preview(
            selector,
            &refresh_path,
            "属主未修改",
            "请输入要修改属主的远程路径",
        );
    }
    let uid = match parse_optional_u32(uid) {
        Ok(uid) => uid,
        Err(error) => return remote_error_preview(selector, &refresh_path, "属主未修改", error),
    };
    let gid = match parse_optional_u32(gid) {
        Ok(gid) => gid,
        Err(error) => return remote_error_preview(selector, &refresh_path, "属主未修改", error),
    };
    if uid.is_none() && gid.is_none() {
        return remote_error_preview(selector, &refresh_path, "属主未修改", "请输入 UID 或 GID");
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.chown_path(target_path, uid, gid, recursive) {
            Ok(()) => native_remote_preview(selector, &refresh_path, password),
            Err(error) => remote_error_preview(
                selector,
                &refresh_path,
                "属主未修改",
                format!("chown 失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &refresh_path, "属主未修改", error),
    }
}

pub fn native_remote_touch_path(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
    mtime: &str,
    recursive: bool,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let refresh_path = if target_path.is_empty() {
        normalize_remote_path(current_path)
    } else {
        remote_parent_path(target_path)
    };
    if target_path.is_empty() {
        return remote_error_preview(
            selector,
            &refresh_path,
            "时间未修改",
            "请输入要修改时间的远程路径",
        );
    }
    let Some(mtime) = parse_mtime(mtime) else {
        return remote_error_preview(
            selector,
            &refresh_path,
            "时间未修改",
            "请输入 Unix 秒级时间戳，留空则使用当前时间",
        );
    };

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.touch_path(target_path, mtime, recursive) {
            Ok(()) => native_remote_preview(selector, &refresh_path, password),
            Err(error) => remote_error_preview(
                selector,
                &refresh_path,
                "时间未修改",
                format!("touch 失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &refresh_path, "时间未修改", error),
    }
}

pub fn native_remote_search(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    query: &str,
) -> NativeRemotePreview {
    let root = normalize_remote_path(current_path);
    let query = query.trim();
    if query.is_empty() {
        return remote_error_preview(selector, &root, "搜索未执行", "请输入搜索关键词");
    }

    match open_remote_connection(selector, password) {
        Ok((selector, connection)) => match connection.search(&root, query, 200) {
            Ok(entries) => NativeRemotePreview {
                selector,
                path: root,
                remote_file_count: entries.iter().filter(|entry| !entry.is_dir).count(),
                remote_dir_count: entries.iter().filter(|entry| entry.is_dir).count(),
                remote_listing: format_file_listing(&entries, 60),
                error: None,
            },
            Err(error) => remote_error_preview(
                &selector,
                &root,
                "搜索失败",
                format!("远程搜索失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &root, "搜索失败", error),
    }
}

pub fn native_remote_path_stats(
    selector: &str,
    current_path: &str,
    password: Option<&str>,
    target_path: &str,
) -> NativeRemotePreview {
    let target_path = target_path.trim();
    let path = if target_path.is_empty() {
        normalize_remote_path(current_path)
    } else {
        target_path.to_owned()
    };

    match open_remote_connection(selector, password) {
        Ok((selector, connection)) => match connection.path_stats(&path) {
            Ok(stats) => NativeRemotePreview {
                selector,
                path: path.clone(),
                remote_file_count: stats.file_count as usize,
                remote_dir_count: stats.dir_count as usize,
                remote_listing: format!(
                    "路径: {}\n目录: {}\n文件: {}\n总大小: {}",
                    path,
                    stats.dir_count,
                    stats.file_count,
                    format_size(stats.total_size)
                ),
                error: None,
            },
            Err(error) => remote_error_preview(
                &selector,
                &path,
                "属性统计失败",
                format!("读取属性失败: {}", error),
            ),
        },
        Err(error) => remote_error_preview(selector, &path, "属性统计失败", error),
    }
}

pub fn native_remote_read_text(
    selector: &str,
    password: Option<&str>,
    target_path: &str,
) -> NativeRemoteTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return remote_text_error("", "请输入要读取的远程文件路径");
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.read_text_file(target_path) {
            Ok(file) => NativeRemoteTextPreview {
                path: file.path,
                summary: text_file_segment_summary(
                    "开头预览",
                    file.size,
                    file.truncated,
                    file.is_binary,
                ),
                content: file.content,
                error: None,
            },
            Err(error) => remote_text_error(target_path, format!("读取失败: {}", error)),
        },
        Err(error) => remote_text_error(target_path, error),
    }
}

pub fn native_remote_read_text_tail(
    selector: &str,
    password: Option<&str>,
    target_path: &str,
) -> NativeRemoteTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return remote_text_error("", "请输入要读取的远程文件路径");
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.read_text_file_tail(target_path) {
            Ok(file) => NativeRemoteTextPreview {
                path: file.path,
                summary: text_file_segment_summary(
                    "末尾预览",
                    file.size,
                    file.truncated,
                    file.is_binary,
                ),
                content: file.content,
                error: None,
            },
            Err(error) => remote_text_error(target_path, format!("读取失败: {}", error)),
        },
        Err(error) => remote_text_error(target_path, error),
    }
}

pub fn native_remote_write_text(
    selector: &str,
    password: Option<&str>,
    target_path: &str,
    content: &str,
) -> NativeRemoteTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return remote_text_error("", "请输入要写入的远程文件路径");
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.write_text_file(target_path, content) {
            Ok(()) => native_remote_read_text(selector, password, target_path),
            Err(error) => remote_text_error(target_path, format!("写入失败: {}", error)),
        },
        Err(error) => remote_text_error(target_path, error),
    }
}

pub fn native_remote_sha256(
    selector: &str,
    password: Option<&str>,
    target_path: &str,
) -> NativeRemoteTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return remote_text_error("", "请输入要校验的远程文件路径");
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.file_sha256(target_path) {
            Ok(checksum) => NativeRemoteTextPreview {
                path: target_path.to_owned(),
                summary: format!("SHA-256: {}", checksum),
                content: checksum,
                error: None,
            },
            Err(error) => remote_text_error(target_path, format!("校验失败: {}", error)),
        },
        Err(error) => remote_text_error(target_path, error),
    }
}

pub fn native_remote_sha256_csv(
    selector: &str,
    password: Option<&str>,
    target_path: &str,
) -> NativeRemoteTextPreview {
    let target_path = target_path.trim();
    if target_path.is_empty() {
        return remote_text_error("", "请输入要校验的远程文件路径");
    }

    match open_remote_connection(selector, password) {
        Ok((_, connection)) => match connection.file_sha256(target_path) {
            Ok(checksum) => {
                let entry = remote_entry_for_path(&connection, target_path);
                let content = format_sha256_csv("remote", entry.as_ref(), target_path, &checksum);
                NativeRemoteTextPreview {
                    path: target_path.to_owned(),
                    summary: "SHA-256 CSV 审计已生成".to_owned(),
                    content,
                    error: None,
                }
            }
            Err(error) => remote_text_error(target_path, format!("校验失败: {}", error)),
        },
        Err(error) => remote_text_error(target_path, error),
    }
}

pub fn native_transfer_upload(
    selector: &str,
    password: Option<&str>,
    local_path: &str,
    remote_dir: &str,
    conflict: &str,
) -> NativeTransferPreview {
    let local_path = local_path.trim();
    let remote_dir = normalize_remote_path(remote_dir);
    if local_path.is_empty() {
        return transfer_error("请输入本地文件或目录路径");
    }
    let Some(conflict) = parse_conflict_strategy(conflict) else {
        return transfer_error("冲突策略必须是 overwrite、skip、rename 或 resume");
    };

    let (profile, secret) = match resolve_remote_profile_secret(selector, password) {
        Ok(value) => value,
        Err(error) => return transfer_error(error),
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let mut last_progress = (0_u64, 0_u64);
    match sftp_service::upload_file_with_progress_with_strategy(
        &profile,
        secret.as_deref(),
        local_path,
        &remote_dir,
        conflict,
        cancel.clone(),
        |transferred, total| {
            last_progress = (transferred, total);
        },
    ) {
        Ok(remote_path) => {
            let summary = format!(
                "上传完成: {} -> {} ({}/{})",
                local_path,
                remote_path,
                format_size(last_progress.0),
                format_size(last_progress.1)
            );
            record_native_transfer(
                &profile,
                TransferDirection::Upload,
                conflict,
                local_path,
                &remote_path,
                "done",
                last_progress,
                None,
            );
            NativeTransferPreview {
                summary,
                error: None,
            }
        }
        Err(error) => {
            cancel.store(true, Ordering::Relaxed);
            let message = format!("上传失败: {}", error);
            record_native_transfer(
                &profile,
                TransferDirection::Upload,
                conflict,
                local_path,
                &remote_dir,
                "failed",
                last_progress,
                Some(message.clone()),
            );
            transfer_error(message)
        }
    }
}

pub fn native_transfer_download(
    selector: &str,
    password: Option<&str>,
    remote_path: &str,
    local_dir: &str,
    conflict: &str,
) -> NativeTransferPreview {
    let remote_path = remote_path.trim();
    let local_dir = local_dir.trim();
    if remote_path.is_empty() || local_dir.is_empty() {
        return transfer_error("请输入远程路径和本地目录");
    }
    let Some(conflict) = parse_conflict_strategy(conflict) else {
        return transfer_error("冲突策略必须是 overwrite、skip、rename 或 resume");
    };

    let (profile, secret) = match resolve_remote_profile_secret(selector, password) {
        Ok(value) => value,
        Err(error) => return transfer_error(error),
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let mut last_progress = (0_u64, 0_u64);
    match sftp_service::download_file_with_progress_with_strategy(
        &profile,
        secret.as_deref(),
        remote_path,
        local_dir,
        conflict,
        cancel.clone(),
        |transferred, total| {
            last_progress = (transferred, total);
        },
    ) {
        Ok(path) => {
            let target = path.display().to_string();
            let summary = format!(
                "下载完成: {} -> {} ({}/{})",
                remote_path,
                target,
                format_size(last_progress.0),
                format_size(last_progress.1)
            );
            record_native_transfer(
                &profile,
                TransferDirection::Download,
                conflict,
                remote_path,
                &target,
                "done",
                last_progress,
                None,
            );
            NativeTransferPreview {
                summary,
                error: None,
            }
        }
        Err(error) => {
            cancel.store(true, Ordering::Relaxed);
            let message = format!("下载失败: {}", error);
            record_native_transfer(
                &profile,
                TransferDirection::Download,
                conflict,
                remote_path,
                local_dir,
                "failed",
                last_progress,
                Some(message.clone()),
            );
            transfer_error(message)
        }
    }
}

pub fn native_transfer_history_preview() -> NativeTransferHistoryPreview {
    let history = storage::load_transfer_history();
    NativeTransferHistoryPreview {
        summary: format!("最近传输历史 {} 条", history.len()),
        listing: format_transfer_history_listing(&history, 24),
        error: None,
    }
}

pub fn native_transfer_history_csv() -> NativeTransferHistoryPreview {
    let history = storage::load_transfer_history();
    NativeTransferHistoryPreview {
        summary: format!("传输历史 CSV {} 条", history.len()),
        listing: format_transfer_history_csv(&history),
        error: None,
    }
}

pub fn native_transfer_history_json() -> NativeTransferHistoryPreview {
    let history = storage::load_transfer_history();
    NativeTransferHistoryPreview {
        summary: format!("传输历史 JSON {} 条", history.len()),
        listing: format_transfer_history_json(&history),
        error: None,
    }
}

pub fn native_transfer_history_clear() -> NativeTransferHistoryPreview {
    match storage::clear_transfer_history() {
        Ok(()) => NativeTransferHistoryPreview {
            summary: "传输历史已清空".to_owned(),
            listing: "暂无传输历史".to_owned(),
            error: None,
        },
        Err(error) => NativeTransferHistoryPreview {
            summary: "传输历史清空失败".to_owned(),
            listing: String::new(),
            error: Some(error.to_string()),
        },
    }
}

fn format_local_listing(entries: &[FileEntry], limit: usize) -> String {
    format_file_listing(entries, limit)
}

fn format_file_csv(entries: &[FileEntry]) -> String {
    let header = [
        "name",
        "type",
        "mode",
        "owner",
        "size",
        "modified",
        "path",
        "link_target",
    ]
    .map(str::to_owned);
    let mut rows = vec![csv_row(&header)];
    rows.extend(entries.iter().map(|entry| {
        let values = vec![
            entry.name.clone(),
            file_entry_kind(entry).to_owned(),
            format_mode(entry.permissions),
            format_owner(entry),
            if entry.is_dir {
                "-".to_owned()
            } else {
                entry.size.to_string()
            },
            format_file_timestamp(entry.modified_at),
            entry.path.clone(),
            entry.link_target.clone().unwrap_or_default(),
        ];
        csv_row(&values)
    }));
    rows.join("\n")
}

fn format_sha256_csv(
    side: &str,
    entry: Option<&FileEntry>,
    target_path: &str,
    checksum: &str,
) -> String {
    let header = [
        "side",
        "generated_at",
        "name",
        "path",
        "type",
        "size",
        "modified",
        "mode",
        "owner",
        "sha256",
    ]
    .map(str::to_owned);
    let generated_at = Local::now().format("%Y/%m/%d %H:%M:%S").to_string();
    let values = match entry {
        Some(entry) => vec![
            side.to_owned(),
            generated_at,
            entry.name.clone(),
            entry.path.clone(),
            file_entry_kind(entry).to_owned(),
            if entry.is_dir {
                String::new()
            } else {
                entry.size.to_string()
            },
            format_file_timestamp(entry.modified_at),
            format_mode(entry.permissions),
            format_owner(entry),
            checksum.to_owned(),
        ],
        None => vec![
            side.to_owned(),
            generated_at,
            String::new(),
            target_path.to_owned(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            checksum.to_owned(),
        ],
    };
    [csv_row(&header), csv_row(&values)].join("\n")
}

fn record_native_transfer(
    profile: &SessionProfile,
    direction: TransferDirection,
    conflict_strategy: TransferConflictStrategy,
    source: &str,
    target: &str,
    status: &str,
    progress: (u64, u64),
    message: Option<String>,
) {
    let record = TransferHistoryRecord {
        id: Uuid::new_v4().to_string(),
        profile_id: profile.id.to_string(),
        direction,
        conflict_strategy,
        source: source.to_owned(),
        target: target.to_owned(),
        status: status.to_owned(),
        transferred: progress.0,
        total: progress.1,
        speed_bps: 0,
        eta_seconds: None,
        attempts: 1,
        message,
        finished_at: Some(Utc::now()),
    };
    storage::append_transfer_history(record, NATIVE_TRANSFER_HISTORY_LIMIT).ok();
}

fn format_transfer_history_listing(history: &[TransferHistoryRecord], limit: usize) -> String {
    if history.is_empty() {
        return "暂无传输历史".to_owned();
    }
    history
        .iter()
        .take(limit)
        .map(|item| {
            format!(
                "{}  {:<8} {:<6} {:>9}/{:<9}  {} -> {}{}",
                item.finished_at
                    .as_ref()
                    .map(|value| format_file_timestamp(value.clone()))
                    .unwrap_or_else(|| "-".to_owned()),
                transfer_direction_label(item.direction),
                transfer_status_label(&item.status),
                format_size(item.transferred),
                if item.total == 0 {
                    "-".to_owned()
                } else {
                    format_size(item.total)
                },
                item.source,
                item.target,
                item.message
                    .as_ref()
                    .map(|message| format!("  ({})", message))
                    .unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_transfer_history_csv(history: &[TransferHistoryRecord]) -> String {
    let header = [
        "id",
        "profile_id",
        "direction",
        "status",
        "conflict_strategy",
        "source",
        "target",
        "transferred_bytes",
        "total_bytes",
        "attempts",
        "finished_at",
        "message",
    ]
    .map(str::to_owned);
    let mut rows = vec![csv_row(&header)];
    rows.extend(history.iter().map(|item| {
        csv_row(&[
            item.id.clone(),
            item.profile_id.clone(),
            transfer_direction_label(item.direction).to_owned(),
            item.status.clone(),
            transfer_conflict_label(item.conflict_strategy).to_owned(),
            item.source.clone(),
            item.target.clone(),
            item.transferred.to_string(),
            item.total.to_string(),
            item.attempts.to_string(),
            item.finished_at
                .as_ref()
                .map(|value| format_file_timestamp(value.clone()))
                .unwrap_or_default(),
            item.message.clone().unwrap_or_default(),
        ])
    }));
    rows.join("\n")
}

fn format_transfer_history_json(history: &[TransferHistoryRecord]) -> String {
    let payload = serde_json::json!({
        "generatedAt": Utc::now(),
        "summary": {
            "total": history.len(),
            "done": history.iter().filter(|item| item.status == "done").count(),
            "failed": history.iter().filter(|item| item.status == "failed").count(),
            "cancelled": history.iter().filter(|item| item.status == "cancelled").count(),
            "uploaded": history.iter().filter(|item| matches!(item.direction, TransferDirection::Upload)).count(),
            "downloaded": history.iter().filter(|item| matches!(item.direction, TransferDirection::Download)).count(),
        },
        "transfers": history,
    });
    serde_json::to_string_pretty(&payload).unwrap_or_else(|error| {
        format!(
            "{{\n  \"error\": \"transfer history json encode failed: {}\"\n}}",
            json_escape(&error.to_string())
        )
    })
}

fn transfer_direction_label(direction: TransferDirection) -> &'static str {
    match direction {
        TransferDirection::Upload => "upload",
        TransferDirection::Download => "download",
    }
}

fn transfer_conflict_label(conflict: TransferConflictStrategy) -> &'static str {
    match conflict {
        TransferConflictStrategy::Overwrite => "overwrite",
        TransferConflictStrategy::Skip => "skip",
        TransferConflictStrategy::Rename => "rename",
        TransferConflictStrategy::Resume => "resume",
    }
}

fn transfer_status_label(status: &str) -> &'static str {
    match status {
        "done" => "done",
        "failed" => "failed",
        "cancelled" => "cancel",
        "running" => "running",
        _ => "unknown",
    }
}

fn format_delete_preview_listing(side: &str, entry: &FileEntry, recursive: bool) -> String {
    let mut rows = vec![
        "删除预览：请核对后再执行删除。".to_owned(),
        if entry.is_dir && !recursive {
            "提示：目标是目录，但未启用递归；执行删除时可能失败。".to_owned()
        } else if entry.is_dir {
            "提示：目录会递归删除其全部内容。".to_owned()
        } else {
            "提示：普通文件将直接删除。".to_owned()
        },
        csv_row(&[
            "side".to_owned(),
            "action".to_owned(),
            "name".to_owned(),
            "type".to_owned(),
            "recursive".to_owned(),
            "mode".to_owned(),
            "owner".to_owned(),
            "size".to_owned(),
            "modified".to_owned(),
            "path".to_owned(),
        ]),
    ];
    let values = vec![
        side.to_owned(),
        "delete".to_owned(),
        entry.name.clone(),
        file_entry_kind(entry).to_owned(),
        if entry.is_dir && recursive {
            "true".to_owned()
        } else {
            "false".to_owned()
        },
        format_mode(entry.permissions),
        format_owner(entry),
        if entry.is_dir {
            String::new()
        } else {
            entry.size.to_string()
        },
        format_file_timestamp(entry.modified_at),
        entry.path.clone(),
    ];
    rows.push(csv_row(&values));
    rows.join("\n")
}

fn csv_row(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("\"{}\"", value.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(",")
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn file_entry_kind(entry: &FileEntry) -> &'static str {
    if entry.file_type == "symlink" {
        "link"
    } else if entry.is_dir {
        "dir"
    } else {
        "file"
    }
}

fn format_owner(entry: &FileEntry) -> String {
    match (entry.uid, entry.gid) {
        (Some(uid), Some(gid)) => format!("{}:{}", uid, gid),
        (Some(uid), None) => format!("{}:-", uid),
        (None, Some(gid)) => format!("-:{}", gid),
        (None, None) => "-".to_owned(),
    }
}

fn format_file_timestamp(value: DateTime<Utc>) -> String {
    value
        .with_timezone(&Local)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn format_file_listing(entries: &[FileEntry], limit: usize) -> String {
    if entries.is_empty() {
        return "当前目录没有可显示项目".to_owned();
    }

    let mut lines: Vec<String> = vec!["类型 权限      大小  名称".to_owned()];
    lines.extend(entries.iter().take(limit).map(|entry| {
        let kind = if entry.file_type == "symlink" {
            "link"
        } else if entry.is_dir {
            "dir"
        } else {
            "file"
        };
        let name = match &entry.link_target {
            Some(target) => format!("{} -> {}", entry.name, target),
            None => entry.name.clone(),
        };
        format!(
            "{:<4} {:<4} {:>9}  {}",
            kind,
            format_mode(entry.permissions),
            if entry.is_dir {
                "-".to_owned()
            } else {
                format_size(entry.size)
            },
            name
        )
    }));

    if entries.len() > limit {
        lines.push(format!("... 另有 {} 个项目", entries.len() - limit));
    }

    lines.join("\n")
}

fn format_session_listing(profiles: &[SessionProfile], limit: usize) -> String {
    if profiles.is_empty() {
        return "暂无会话配置".to_owned();
    }

    let mut sorted: Vec<&SessionProfile> = profiles.iter().collect();
    sorted.sort_by(compare_profiles_by_recent);

    let mut lines: Vec<String> = sorted
        .into_iter()
        .take(limit)
        .map(|profile| {
            format!(
                "{:<8} {:<12} {:<5} {:<8} {:<8} {}",
                short_id(profile),
                format_recent_connected(profile.last_connected_at.as_ref()),
                profile.protocol,
                auth_label(profile),
                profile.username,
                session_title(profile)
            )
        })
        .collect();

    if profiles.len() > limit {
        lines.push(format!("... 另有 {} 个会话", profiles.len() - limit));
    }

    lines.join("\n")
}

fn compare_profiles_by_recent(left: &&SessionProfile, right: &&SessionProfile) -> SortOrdering {
    let left_time = profile_sort_time(left);
    let right_time = profile_sort_time(right);
    right_time
        .cmp(&left_time)
        .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
}

fn profile_sort_time(profile: &SessionProfile) -> DateTime<Utc> {
    profile
        .last_connected_at
        .as_ref()
        .unwrap_or(&profile.created_at)
        .clone()
}

fn format_recent_connected(value: Option<&DateTime<Utc>>) -> String {
    let Some(value) = value else {
        return "未连接".to_owned();
    };

    let connected = value.with_timezone(&Local);
    let now = Local::now();
    let diff = now.signed_duration_since(connected);
    if diff.num_seconds() < 60 {
        return "刚刚".to_owned();
    }
    if diff.num_minutes() < 60 {
        return format!("{} 分钟前", diff.num_minutes());
    }
    if connected.date_naive() == now.date_naive() {
        return format!("今天 {}", connected.format("%H:%M"));
    }
    if connected.year() == now.year() {
        return connected.format("%m/%d").to_string();
    }
    connected.format("%Y/%m/%d").to_string()
}

fn find_remote_profile<'a>(
    profiles: &'a [SessionProfile],
    selector: &str,
) -> Option<&'a SessionProfile> {
    let selector = selector.trim();
    if selector.is_empty() {
        return profiles
            .iter()
            .find(|profile| is_remote_file_profile(profile));
    }

    if let Ok(id) = Uuid::parse_str(selector) {
        return profiles
            .iter()
            .find(|profile| profile.id == id && is_remote_file_profile(profile));
    }

    profiles.iter().find(|profile| {
        is_remote_file_profile(profile)
            && (profile.name.eq_ignore_ascii_case(selector)
                || profile.id.to_string().starts_with(selector))
    })
}

fn open_remote_connection(
    selector: &str,
    password: Option<&str>,
) -> Result<(String, SftpConnection), String> {
    let (profile, secret) = resolve_remote_profile_secret(selector, password)?;
    let selector = remote_selector_label(&profile);

    SftpConnection::connect(&profile, secret.as_deref())
        .map(|connection| (selector, connection))
        .map_err(|error| format!("连接失败: {}", error))
}

fn resolve_remote_profile_secret(
    selector: &str,
    password: Option<&str>,
) -> Result<(SessionProfile, Option<String>), String> {
    let profiles = SessionStore::new().load_or_seed();
    let profile = find_remote_profile(&profiles, selector)
        .ok_or_else(|| "远程会话未找到，请输入会话名称、完整 UUID 或短 UUID 前缀".to_owned())?;
    let secret = password
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            if profile.remember_password {
                storage::load_password(profile)
            } else {
                None
            }
        });

    Ok((profile.clone(), secret))
}

fn remote_error_preview(
    selector: &str,
    path: &str,
    listing: &str,
    error: impl Into<String>,
) -> NativeRemotePreview {
    NativeRemotePreview {
        selector: selector.trim().to_owned(),
        path: path.trim().to_owned(),
        remote_file_count: 0,
        remote_dir_count: 0,
        remote_listing: listing.to_owned(),
        error: Some(error.into()),
    }
}

fn local_error_preview(path: &str, listing: &str, error: impl Into<String>) -> NativeLocalPreview {
    NativeLocalPreview {
        path: path.trim().to_owned(),
        local_file_count: 0,
        local_dir_count: 0,
        local_listing: listing.to_owned(),
        error: Some(error.into()),
    }
}

fn remote_text_error(path: &str, error: impl Into<String>) -> NativeRemoteTextPreview {
    NativeRemoteTextPreview {
        path: path.trim().to_owned(),
        summary: "远程文本不可用".to_owned(),
        content: String::new(),
        error: Some(error.into()),
    }
}

fn local_text_error(path: &str, error: impl Into<String>) -> NativeLocalTextPreview {
    NativeLocalTextPreview {
        path: path.trim().to_owned(),
        summary: "本地文本不可用".to_owned(),
        content: String::new(),
        error: Some(error.into()),
    }
}

fn text_file_summary(size: u64, truncated: bool, is_binary: bool) -> String {
    format!(
        "大小: {}{}{}",
        format_size(size),
        if truncated { "，已截断" } else { "" },
        if is_binary {
            "，检测到二进制内容"
        } else {
            ""
        }
    )
}

fn text_file_segment_summary(segment: &str, size: u64, truncated: bool, is_binary: bool) -> String {
    format!(
        "{} / {}",
        segment,
        text_file_summary(size, truncated, is_binary)
    )
}

fn transfer_error(error: impl Into<String>) -> NativeTransferPreview {
    NativeTransferPreview {
        summary: "传输未完成".to_owned(),
        error: Some(error.into()),
    }
}

fn normalize_remote_path(path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        ".".to_owned()
    } else {
        path.to_owned()
    }
}

fn normalize_local_path(path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        local_home()
    } else {
        path.to_owned()
    }
}

fn local_refresh_path(current_path: &str, target_path: &str) -> String {
    if target_path.trim().is_empty() {
        normalize_local_path(current_path)
    } else {
        local_parent(target_path).unwrap_or_else(|| normalize_local_path(current_path))
    }
}

fn local_entry_for_path(target_path: &str) -> Option<FileEntry> {
    let parent = local_parent(target_path)?;
    list_local_dir(&parent)
        .ok()?
        .into_iter()
        .find(|entry| entry.path == target_path)
}

fn remote_entry_for_path(connection: &SftpConnection, target_path: &str) -> Option<FileEntry> {
    let parent = remote_parent_path(target_path);
    connection
        .list_dir(&parent)
        .ok()?
        .into_iter()
        .find(|entry| entry.path == target_path)
}

fn parse_mode(value: &str) -> Option<u32> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4 || !value.bytes().all(|byte| matches!(byte, b'0'..=b'7'))
    {
        return None;
    }
    u32::from_str_radix(value, 8)
        .ok()
        .filter(|mode| *mode <= 0o7777)
}

fn resolve_chmod_mode(value: &str, current_mode: Option<u32>, is_dir: bool) -> Option<u32> {
    parse_mode(value).or_else(|| apply_symbolic_mode(value, current_mode?, is_dir))
}

fn apply_symbolic_mode(value: &str, current_mode: u32, is_dir: bool) -> Option<u32> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let mut mode = current_mode & 0o7777;
    for clause in value.split(',') {
        let clause = clause.trim();
        let operator_index = clause
            .char_indices()
            .find(|(_, ch)| matches!(*ch, '+' | '-' | '='))
            .map(|(index, _)| index)?;
        let (who, rest) = clause.split_at(operator_index);
        let mut rest = rest.chars();
        let operator = rest.next()?;
        let perms: String = rest.collect();
        let classes = permission_classes(if who.is_empty() { "a" } else { who })?;
        if operator == '=' {
            mode &= !permission_class_mask(&classes);
        }
        let bits = symbolic_permission_bits(&perms, &classes, mode, is_dir)?;
        match operator {
            '+' | '=' => mode |= bits,
            '-' => mode &= !bits,
            _ => return None,
        }
    }
    Some(mode & 0o7777)
}

fn permission_classes(value: &str) -> Option<Vec<char>> {
    let mut classes = Vec::new();
    for ch in value.chars() {
        match ch {
            'a' => {
                for target in ['u', 'g', 'o'] {
                    if !classes.contains(&target) {
                        classes.push(target);
                    }
                }
            }
            'u' | 'g' | 'o' => {
                if !classes.contains(&ch) {
                    classes.push(ch);
                }
            }
            _ => return None,
        }
    }
    if classes.is_empty() {
        classes.extend(['u', 'g', 'o']);
    }
    Some(classes)
}

fn permission_class_mask(classes: &[char]) -> u32 {
    classes.iter().fold(0, |mask, class| {
        mask | match class {
            'u' => 0o4700,
            'g' => 0o2070,
            'o' => 0o1007,
            _ => 0,
        }
    })
}

fn symbolic_permission_bits(perms: &str, classes: &[char], mode: u32, is_dir: bool) -> Option<u32> {
    let mut bits = 0;
    for perm in perms.chars() {
        match perm {
            'r' | 'w' | 'x' => bits |= permission_letter_bits(classes, perm),
            'X' => {
                if is_dir || (mode & 0o111) != 0 {
                    bits |= permission_letter_bits(classes, 'x');
                }
            }
            's' => {
                if classes.contains(&'u') {
                    bits |= 0o4000;
                }
                if classes.contains(&'g') {
                    bits |= 0o2000;
                }
            }
            't' => {
                if classes.contains(&'o') {
                    bits |= 0o1000;
                }
            }
            'u' | 'g' | 'o' => bits |= copy_permission_class_bits(mode, perm, classes),
            _ => return None,
        }
    }
    Some(bits)
}

fn permission_letter_bits(classes: &[char], permission: char) -> u32 {
    classes.iter().fold(0, |bits, class| {
        bits | match (class, permission) {
            ('u', 'r') => 0o400,
            ('u', 'w') => 0o200,
            ('u', 'x') => 0o100,
            ('g', 'r') => 0o040,
            ('g', 'w') => 0o020,
            ('g', 'x') => 0o010,
            ('o', 'r') => 0o004,
            ('o', 'w') => 0o002,
            ('o', 'x') => 0o001,
            _ => 0,
        }
    })
}

fn copy_permission_class_bits(mode: u32, source: char, targets: &[char]) -> u32 {
    let shift_from = match source {
        'u' => 6,
        'g' => 3,
        'o' => 0,
        _ => return 0,
    };
    let source_bits = (mode >> shift_from) & 0o7;
    targets.iter().fold(0, |bits, target| {
        let shift_to = match target {
            'u' => 6,
            'g' => 3,
            'o' => 0,
            _ => return bits,
        };
        bits | (source_bits << shift_to)
    })
}

fn parse_optional_u32(value: &str) -> Result<Option<u32>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    value
        .parse::<u32>()
        .map(Some)
        .map_err(|_| format!("无效数字: {}", value))
}

fn parse_mtime(value: &str) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() {
        return SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_secs());
    }
    value.parse::<u64>().ok()
}

fn parse_conflict_strategy(value: &str) -> Option<TransferConflictStrategy> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "overwrite" => Some(TransferConflictStrategy::Overwrite),
        "skip" => Some(TransferConflictStrategy::Skip),
        "rename" => Some(TransferConflictStrategy::Rename),
        "resume" => Some(TransferConflictStrategy::Resume),
        _ => None,
    }
}

fn auth_label(profile: &SessionProfile) -> &'static str {
    match &profile.auth {
        AuthProfile::Password => "password",
        AuthProfile::KeyFile { .. } => "keyfile",
        AuthProfile::Agent => "agent",
    }
}

fn session_connection_command(profile: &SessionProfile) -> String {
    let mut args = vec![match profile.protocol {
        SessionProtocol::SftpOnly => "sftp".to_owned(),
        _ => "ssh".to_owned(),
    }];
    if profile.port != 22 {
        args.push(match profile.protocol {
            SessionProtocol::SftpOnly => "-P".to_owned(),
            _ => "-p".to_owned(),
        });
        args.push(profile.port.to_string());
    }
    if let AuthProfile::KeyFile { path } = &profile.auth {
        if !path.trim().is_empty() {
            args.push("-i".to_owned());
            args.push(shell_quote(path.trim()));
        }
    }
    args.push(remote_command_target(profile));
    args.join(" ")
}

fn remote_path_command_preview(
    profile: &SessionProfile,
    target_path: &str,
    mode: &str,
    uid: &str,
    gid: &str,
    mtime: &str,
    recursive: bool,
    link_target: &str,
) -> String {
    let remote_target = remote_command_target(profile);
    let remote_path = shell_quote(target_path);
    let scp_remote_spec = format!("{}:{}", remote_target, remote_path);
    let rsync_remote_spec = format!("{}:{}", remote_target, target_path);
    let ssh_transport = ssh_transport_command(profile);
    let chmod_mode = non_empty(mode, "644");
    let recursive_flag = if recursive { "-R " } else { "" };
    let owner = remote_owner_arg(uid, gid);
    let touch_args = remote_touch_args(mtime);
    let delete_args = if recursive { "-r --" } else { "--" };
    let link_target = shell_quote(non_empty(link_target, "./target"));
    [
        format!("sftp: {}", session_connection_command(profile)),
        format!(
            "scp download: {} {} .",
            scp_command_prefix(profile, recursive),
            scp_remote_spec
        ),
        format!(
            "scp upload: {} ./local-file {}",
            scp_command_prefix(profile, recursive),
            scp_remote_spec
        ),
        format!(
            "rsync download: rsync -a --partial --progress -e {} {} .",
            shell_quote(&ssh_transport),
            shell_quote(&rsync_remote_spec)
        ),
        format!(
            "rsync dry-run download: rsync --dry-run --itemize-changes -a --partial --progress -e {} {} .",
            shell_quote(&ssh_transport),
            shell_quote(&rsync_remote_spec)
        ),
        format!(
            "rsync upload: rsync -a --partial --progress -e {} ./local-file {}",
            shell_quote(&ssh_transport),
            shell_quote(&rsync_remote_spec)
        ),
        format!(
            "rsync dry-run upload: rsync --dry-run --itemize-changes -a --partial --progress -e {} ./local-file {}",
            shell_quote(&ssh_transport),
            shell_quote(&rsync_remote_spec)
        ),
        format!(
            "chmod: {} -- {} chmod {}{} {}",
            ssh_transport, remote_target, recursive_flag, chmod_mode, remote_path
        ),
        format!(
            "chown: {} -- {} chown {}{} {}",
            ssh_transport, remote_target, recursive_flag, owner, remote_path
        ),
        format!(
            "touch: {} -- {} touch {} {}",
            ssh_transport, remote_target, touch_args, remote_path
        ),
        format!(
            "symlink: {} -- {} ln -s -- {} {}",
            ssh_transport, remote_target, link_target, remote_path
        ),
        format!(
            "stat: {} -- {} stat -- {}",
            ssh_transport, remote_target, remote_path
        ),
        format!(
            "sha256: {} -- {} sha256sum -- {}",
            ssh_transport, remote_target, remote_path
        ),
        format!(
            "du: {} -- {} du -sh -- {}",
            ssh_transport, remote_target, remote_path
        ),
        format!(
            "list: {} -- {} ls -ld -- {}",
            ssh_transport, remote_target, remote_path
        ),
        format!(
            "delete: {} -- {} rm {} {}",
            ssh_transport, remote_target, delete_args, remote_path
        ),
    ]
    .join("\n")
}

fn remote_owner_arg(uid: &str, gid: &str) -> String {
    let uid = uid.trim();
    let gid = gid.trim();
    match (uid.is_empty(), gid.is_empty()) {
        (true, true) => "user:group".to_owned(),
        (false, true) => uid.to_owned(),
        (true, false) => format!(":{}", gid),
        (false, false) => format!("{}:{}", uid, gid),
    }
}

fn remote_touch_args(mtime: &str) -> String {
    let mtime = mtime.trim();
    if mtime.is_empty() {
        "-m".to_owned()
    } else if mtime.chars().all(|ch| ch.is_ascii_digit()) {
        format!("-m -d @{}", mtime)
    } else {
        format!("-m -d {}", shell_quote(mtime))
    }
}

fn non_empty<'a>(primary: &'a str, fallback: &'a str) -> &'a str {
    let primary = primary.trim();
    if primary.is_empty() {
        fallback
    } else {
        primary
    }
}

fn ssh_transport_command(profile: &SessionProfile) -> String {
    let mut args = vec!["ssh".to_owned()];
    if profile.port != 22 {
        args.push("-p".to_owned());
        args.push(profile.port.to_string());
    }
    if let AuthProfile::KeyFile { path } = &profile.auth {
        if !path.trim().is_empty() {
            args.push("-i".to_owned());
            args.push(shell_quote(path.trim()));
        }
    }
    args.join(" ")
}

fn scp_command_prefix(profile: &SessionProfile, recursive: bool) -> String {
    let mut args = vec!["scp".to_owned()];
    if recursive {
        args.push("-r".to_owned());
    }
    if profile.port != 22 {
        args.push("-P".to_owned());
        args.push(profile.port.to_string());
    }
    if let AuthProfile::KeyFile { path } = &profile.auth {
        if !path.trim().is_empty() {
            args.push("-i".to_owned());
            args.push(shell_quote(path.trim()));
        }
    }
    args.join(" ")
}

fn remote_command_target(profile: &SessionProfile) -> String {
    let host = if profile.host.contains(':') {
        format!("[{}]", profile.host)
    } else {
        profile.host.clone()
    };
    format!("{}@{}", profile.username, host)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn session_title(profile: &SessionProfile) -> String {
    match profile.protocol {
        SessionProtocol::LocalShell => profile.name.clone(),
        _ => format!("{}  {}", profile.name, profile.endpoint()),
    }
}

fn remote_selector_label(profile: &SessionProfile) -> String {
    format!("{} ({})", profile.name, short_id(profile))
}

fn is_remote_file_profile(profile: &SessionProfile) -> bool {
    matches!(
        profile.protocol,
        SessionProtocol::Ssh | SessionProtocol::SftpOnly
    )
}

fn short_id(profile: &SessionProfile) -> String {
    profile.id.to_string().chars().take(8).collect()
}

fn format_mode(value: Option<u32>) -> String {
    value
        .map(|mode| {
            let mode = mode & 0o7777;
            format!(
                "{:0width$o}",
                mode,
                width = if mode > 0o777 { 4 } else { 3 }
            )
        })
        .unwrap_or_else(|| "-".to_owned())
}

fn format_size(size: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let size = size as f64;
    if size < KB {
        format!("{} B", size as u64)
    } else if size < MB {
        format!("{:.1} KB", size / KB)
    } else if size < GB {
        format!("{:.1} MB", size / MB)
    } else {
        format!("{:.1} GB", size / GB)
    }
}
