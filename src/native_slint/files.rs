use crate::core::session::SessionProfile;
use crate::core::sftp::{list_local_dir, local_home, local_parent, remote_parent_path, FileEntry};
use crate::services::sftp_service::{download_file, upload_file, SftpConnection};
use crate::services::storage;
use crossbeam_channel::{unbounded, Receiver, Sender};

use super::sessions::{find_remote_profile, profile_label};
use super::view_models::{DialogVm, FileEntryVm, TransferVm};

#[derive(Clone, Debug, Default)]
pub struct FileSnapshot {
    pub local_path: String,
    pub remote_path: String,
    pub remote_selector: String,
    pub local_entries: Vec<FileEntryVm>,
    pub remote_entries: Vec<FileEntryVm>,
    pub modal: Option<DialogVm>,
    pub transfers: Vec<TransferVm>,
}

pub struct FileManagerState {
    local_path: String,
    remote_path: String,
    remote_selector: String,
    local_entries: Vec<FileEntry>,
    remote_entries: Vec<FileEntry>,
    selected_local: Option<String>,
    selected_remote: Option<String>,
    modal: Option<DialogVm>,
    transfers: Vec<TransferVm>,
    worker_tx: Sender<FileWorkerEvent>,
    worker_rx: Receiver<FileWorkerEvent>,
}

enum FileWorkerEvent {
    RemoteList {
        selector: String,
        path: String,
        result: Result<Vec<FileEntry>, String>,
    },
    TransferDone {
        transfer: TransferVm,
        result: Result<String, String>,
    },
}

impl FileManagerState {
    pub fn new(remote_selector: String) -> Self {
        let (worker_tx, worker_rx) = unbounded();
        let local_path = local_home();
        let mut state = Self {
            local_path,
            remote_path: "/root".to_owned(),
            remote_selector,
            local_entries: Vec::new(),
            remote_entries: Vec::new(),
            selected_local: None,
            selected_remote: None,
            modal: None,
            transfers: Vec::new(),
            worker_tx,
            worker_rx,
        };
        state.refresh_local("");
        state
    }

    pub fn snapshot(&self) -> FileSnapshot {
        FileSnapshot {
            local_path: self.local_path.clone(),
            remote_path: self.remote_path.clone(),
            remote_selector: self.remote_selector.clone(),
            local_entries: map_entries(&self.local_entries, self.selected_local.as_deref()),
            remote_entries: map_entries(&self.remote_entries, self.selected_remote.as_deref()),
            modal: self.modal.clone(),
            transfers: self.transfers.clone(),
        }
    }

    pub fn poll(&mut self) {
        while let Ok(event) = self.worker_rx.try_recv() {
            match event {
                FileWorkerEvent::RemoteList {
                    selector,
                    path,
                    result,
                } => match result {
                    Ok(entries) => {
                        self.remote_selector = selector;
                        self.remote_path = path;
                        self.remote_entries = entries;
                        self.selected_remote = None;
                        self.modal = None;
                    }
                    Err(error) => {
                        self.remote_selector = selector;
                        self.remote_path = path;
                        self.remote_entries.clear();
                        self.modal = Some(DialogVm::info("远程目录加载失败", error));
                    }
                },
                FileWorkerEvent::TransferDone {
                    mut transfer,
                    result,
                } => match result {
                    Ok(message) => {
                        transfer.status = "done".to_owned();
                        transfer.progress = 100;
                        self.transfers.insert(0, transfer);
                        self.transfers.truncate(20);
                        self.modal = Some(DialogVm::info("传输完成", message));
                    }
                    Err(error) => {
                        transfer.status = "failed".to_owned();
                        self.transfers.insert(0, transfer);
                        self.transfers.truncate(20);
                        self.modal = Some(DialogVm::info("传输失败", error));
                    }
                },
            }
        }
    }

    pub fn clear_modal(&mut self) {
        self.modal = None;
    }

    pub fn refresh_local(&mut self, path: &str) {
        let next_path = if path.trim().is_empty() {
            self.local_path.clone()
        } else {
            path.trim().to_owned()
        };
        match list_local_dir(&next_path) {
            Ok(entries) => {
                self.local_path = next_path;
                self.local_entries = entries;
                self.selected_local = None;
                self.modal = None;
            }
            Err(error) => {
                self.modal = Some(DialogVm::info(
                    "本地目录加载失败",
                    format!("{}: {}", next_path, error),
                ));
            }
        }
    }

    pub fn local_home(&mut self) {
        self.refresh_local(&local_home());
    }

    pub fn local_parent(&mut self, path: &str) {
        let path = if path.trim().is_empty() {
            self.local_path.as_str()
        } else {
            path.trim()
        };
        match local_parent(path) {
            Some(parent) => self.refresh_local(&parent),
            None => {
                self.modal = Some(DialogVm::info("本地目录", "没有可打开的上级目录"));
            }
        }
    }

    pub fn select_local(&mut self, path: &str) {
        self.selected_local = Some(path.to_owned());
    }

    pub fn refresh_remote(&mut self, selector: &str, path: &str, profiles: &[SessionProfile]) {
        let Some(profile) = find_remote_profile(profiles, selector).cloned() else {
            self.modal = Some(DialogVm::info(
                "远程会话未找到",
                "请输入远程会话名称、完整 UUID 或短 UUID 前缀",
            ));
            return;
        };

        let selector = profile_label(&profile);
        let requested_path = if path.trim().is_empty() {
            self.remote_path.clone()
        } else {
            path.trim().to_owned()
        };
        self.remote_selector = selector.clone();
        self.remote_path = requested_path.clone();
        self.modal = Some(DialogVm::info("远程目录", "正在加载远程目录..."));

        let tx = self.worker_tx.clone();
        std::thread::Builder::new()
            .name("slint-sftp-list".to_owned())
            .spawn(move || {
                let secret = if profile.remember_password {
                    storage::load_password(&profile)
                } else {
                    None
                };
                let result = list_remote_entries(&profile, secret.as_deref(), &requested_path);
                let _ = tx.send(FileWorkerEvent::RemoteList {
                    selector,
                    path: result
                        .as_ref()
                        .map(|(_, path)| path.clone())
                        .unwrap_or_else(|_| requested_path.clone()),
                    result: result.map(|(entries, _)| entries),
                });
            })
            .ok();
    }

    pub fn remote_home(&mut self, selector: &str, profiles: &[SessionProfile]) {
        self.refresh_remote(selector, ".", profiles);
    }

    pub fn remote_parent(&mut self, selector: &str, path: &str, profiles: &[SessionProfile]) {
        let path = if path.trim().is_empty() {
            self.remote_path.as_str()
        } else {
            path.trim()
        };
        self.refresh_remote(selector, &remote_parent_path(path), profiles);
    }

    pub fn select_remote(&mut self, path: &str) {
        self.selected_remote = Some(path.to_owned());
    }

    pub fn transfer(&mut self, action: &str, profiles: &[SessionProfile]) {
        match action {
            "upload" => self.upload_selected(profiles),
            "download" => self.download_selected(profiles),
            _ => {
                self.modal = Some(DialogVm::info("传输", format!("未知传输动作: {}", action)));
            }
        }
    }

    fn upload_selected(&mut self, profiles: &[SessionProfile]) {
        let Some(local_path) = self.selected_local.clone() else {
            self.modal = Some(DialogVm::info("上传", "请先选择一个本地文件或目录"));
            return;
        };
        let Some(profile) = find_remote_profile(profiles, &self.remote_selector).cloned() else {
            self.modal = Some(DialogVm::info("上传", "远程会话未找到"));
            return;
        };
        let remote_dir = self.remote_path.clone();
        let selector = profile_label(&profile);
        let transfer = TransferVm {
            id: format!("upload:{}", local_path),
            direction: "upload".to_owned(),
            source: local_path.clone(),
            target: remote_dir.clone(),
            status: "running".to_owned(),
            progress: 0,
        };
        self.modal = Some(DialogVm::info("上传", "上传任务已开始"));
        spawn_transfer(self.worker_tx.clone(), transfer, move || {
            let secret = if profile.remember_password {
                storage::load_password(&profile)
            } else {
                None
            };
            upload_file(&profile, secret.as_deref(), &local_path, &remote_dir)
                .map(|_| format!("{} 上传到 {}", selector, remote_dir))
                .map_err(|error| format!("{:#}", error))
        });
    }

    fn download_selected(&mut self, profiles: &[SessionProfile]) {
        let Some(remote_path) = self.selected_remote.clone() else {
            self.modal = Some(DialogVm::info("下载", "请先选择一个远程文件或目录"));
            return;
        };
        let Some(profile) = find_remote_profile(profiles, &self.remote_selector).cloned() else {
            self.modal = Some(DialogVm::info("下载", "远程会话未找到"));
            return;
        };
        let local_dir = self.local_path.clone();
        let selector = profile_label(&profile);
        let transfer = TransferVm {
            id: format!("download:{}", remote_path),
            direction: "download".to_owned(),
            source: remote_path.clone(),
            target: local_dir.clone(),
            status: "running".to_owned(),
            progress: 0,
        };
        self.modal = Some(DialogVm::info("下载", "下载任务已开始"));
        spawn_transfer(self.worker_tx.clone(), transfer, move || {
            let secret = if profile.remember_password {
                storage::load_password(&profile)
            } else {
                None
            };
            download_file(&profile, secret.as_deref(), &remote_path, &local_dir)
                .map(|path| format!("{} 下载到 {}", selector, path.display()))
                .map_err(|error| format!("{:#}", error))
        });
    }
}

fn list_remote_entries(
    profile: &SessionProfile,
    password: Option<&str>,
    requested_path: &str,
) -> Result<(Vec<FileEntry>, String), String> {
    let connection =
        SftpConnection::connect(profile, password).map_err(|error| format!("{:#}", error))?;
    let path = if requested_path == "." || requested_path.trim().is_empty() {
        connection
            .home_dir()
            .map_err(|error| format!("{:#}", error))?
    } else {
        requested_path.to_owned()
    };
    connection
        .list_dir(&path)
        .map(|entries| (entries, path))
        .map_err(|error| format!("{:#}", error))
}

fn spawn_transfer<F>(tx: Sender<FileWorkerEvent>, transfer: TransferVm, job: F)
where
    F: FnOnce() -> Result<String, String> + Send + 'static,
{
    std::thread::Builder::new()
        .name("slint-sftp-transfer".to_owned())
        .spawn(move || {
            let result = job();
            let _ = tx.send(FileWorkerEvent::TransferDone { transfer, result });
        })
        .ok();
}

fn map_entries(entries: &[FileEntry], selected: Option<&str>) -> Vec<FileEntryVm> {
    entries
        .iter()
        .map(|entry| FileEntryVm {
            name: entry.name.clone(),
            path: entry.path.clone(),
            kind: entry.file_type.clone(),
            permissions: format_mode(entry.permissions),
            owner: format_owner(entry.uid, entry.gid),
            size: if entry.is_dir {
                "-".to_owned()
            } else {
                format_size(entry.size)
            },
            modified: entry
                .modified_at
                .with_timezone(&chrono::Local)
                .format("%Y/%m/%d %H:%M")
                .to_string(),
            is_dir: entry.is_dir,
            selected: selected == Some(entry.path.as_str()),
        })
        .collect()
}

fn format_mode(value: Option<u32>) -> String {
    value
        .map(|mode| format!("{:03o}", mode & 0o7777))
        .unwrap_or_else(|| "-".to_owned())
}

fn format_owner(uid: Option<u32>, gid: Option<u32>) -> String {
    match (uid, gid) {
        (Some(uid), Some(gid)) => format!("{}:{}", uid, gid),
        (Some(uid), None) => uid.to_string(),
        (None, Some(gid)) => format!(":{}", gid),
        (None, None) => "-".to_owned(),
    }
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
