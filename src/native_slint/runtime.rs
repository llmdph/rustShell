use crate::core::session::{SessionProfile, SessionProtocol};
use crate::services::storage;

use super::files::{FileManagerState, FileSnapshot};
use super::sessions::SessionViewState;
use super::terminal::{TerminalAction, TerminalManager, TerminalSnapshot};
use super::view_models::{DialogVm, SessionNodeVm, SessionPreviewVm};

#[derive(Clone, Debug)]
pub struct RuntimeSnapshot {
    pub theme_mode: i32,
    pub session_rows: Vec<SessionNodeVm>,
    pub session_preview: SessionPreviewVm,
    pub terminal: TerminalSnapshot,
    pub files: FileSnapshot,
    pub modal: Option<DialogVm>,
}

pub struct NativeRuntime {
    sessions: SessionViewState,
    terminals: TerminalManager,
    files: FileManagerState,
    settings: crate::core::settings::AppSettings,
    modal: Option<DialogVm>,
}

impl NativeRuntime {
    pub fn new() -> Self {
        let settings = storage::load_settings();
        let sessions = SessionViewState::new();
        let files = FileManagerState::new(sessions.default_remote_selector());
        let terminals = TerminalManager::new(&settings);
        Self {
            sessions,
            terminals,
            files,
            settings,
            modal: None,
        }
    }

    pub fn start_default_terminal(&mut self) {
        let profile = self.sessions.default_local_profile();
        self.sessions.select(&profile.id.to_string());
        self.terminals.open_local(profile, &self.settings);
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        let terminal = self.terminals.snapshot();
        RuntimeSnapshot {
            theme_mode: theme_mode_from_name(&self.settings.theme),
            session_rows: self.sessions.rows(&terminal.profile_statuses),
            session_preview: self.sessions.preview(),
            terminal,
            files: self.files.snapshot(),
            modal: self.modal.clone(),
        }
    }

    pub fn poll(&mut self) -> RuntimeSnapshot {
        let terminal = self.terminals.poll();
        self.files.poll();
        RuntimeSnapshot {
            theme_mode: theme_mode_from_name(&self.settings.theme),
            session_rows: self.sessions.rows(&terminal.profile_statuses),
            session_preview: self.sessions.preview(),
            terminal,
            files: self.files.snapshot(),
            modal: self.modal.clone(),
        }
    }

    pub fn reload_sessions(&mut self) {
        self.sessions.reload();
    }

    pub fn select_session(&mut self, id: &str) {
        self.sessions.select(id);
    }

    pub fn connect_session(&mut self, id: &str) {
        let Some(profile) = self.sessions.select(id) else {
            self.modal = Some(DialogVm::info("连接失败", "会话未找到"));
            return;
        };
        self.open_profile(profile);
    }

    pub fn connect_quick(&mut self, selector: &str) {
        let selector = selector.trim();
        if selector.is_empty() {
            self.open_local_terminal();
            return;
        }

        if let Some(profile) = self.sessions.profile_by_selector(selector).cloned() {
            self.sessions.select(&profile.id.to_string());
            self.open_profile(profile);
            return;
        }

        let username = std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_else(|_| "root".to_owned());
        let profile = SessionProfile::new_ssh(selector, "临时连接", selector, &username);
        self.open_profile(profile);
    }

    pub fn open_local_terminal(&mut self) {
        let profile = self.sessions.default_local_profile();
        self.sessions.select(&profile.id.to_string());
        self.terminals.open_local(profile, &self.settings);
    }

    pub fn send_terminal_command(&mut self, command: &str) {
        if let Some(message) = self.terminals.send_command(command) {
            self.modal = Some(DialogVm::info("终端", message));
        }
    }

    pub fn terminal_control(&mut self, action: &str) -> TerminalAction {
        let result = self.terminals.control(action, &self.settings);
        if let Some(message) = &result.message {
            if action != "copy" {
                self.modal = Some(DialogVm::info("终端", message.clone()));
            }
        }
        result
    }

    pub fn open_file_manager(&mut self) {
        if self.files.snapshot().local_entries.is_empty() {
            self.files.refresh_local("");
        }
    }

    pub fn open_settings(&mut self) {
        self.modal = Some(DialogVm::info(
            "设置",
            "Slint 原生设置窗口已接入主题与终端配置；完整表单将在该原生入口继续扩展。",
        ));
    }

    pub fn clear_modal(&mut self) {
        self.modal = None;
    }

    pub fn refresh_local(&mut self, path: &str) {
        self.files.refresh_local(path);
    }

    pub fn local_home(&mut self) {
        self.files.local_home();
    }

    pub fn local_parent(&mut self, path: &str) {
        self.files.local_parent(path);
    }

    pub fn select_local(&mut self, path: &str) {
        self.files.select_local(path);
    }

    pub fn refresh_remote(&mut self, selector: &str, path: &str) {
        self.files
            .refresh_remote(selector, path, self.sessions.profiles());
    }

    pub fn remote_home(&mut self, selector: &str) {
        self.files.remote_home(selector, self.sessions.profiles());
    }

    pub fn remote_parent(&mut self, selector: &str, path: &str) {
        self.files
            .remote_parent(selector, path, self.sessions.profiles());
    }

    pub fn select_remote(&mut self, path: &str) {
        self.files.select_remote(path);
    }

    pub fn transfer(&mut self, action: &str) {
        self.files.transfer(action, self.sessions.profiles());
    }

    pub fn clear_file_modal(&mut self) {
        self.files.clear_modal();
    }

    fn open_profile(&mut self, profile: SessionProfile) {
        let password = if profile.remember_password {
            storage::load_password(&profile)
        } else {
            None
        };
        if profile.wants_secret() && password.is_none() {
            self.modal = Some(DialogVm::info(
                "需要认证",
                "当前原生 Slint 入口会优先读取已保存密码；未保存密码的 SSH 会话会进入认证失败状态，密码输入弹窗后续接入。",
            ));
        }
        if matches!(profile.protocol, SessionProtocol::LocalShell) {
            self.terminals.open_local(profile, &self.settings);
        } else {
            self.terminals
                .open_profile(profile, password, &self.settings);
        }
    }
}

fn theme_mode_from_name(theme: &str) -> i32 {
    match theme {
        "graphite" => 1,
        "light" => 2,
        _ => 0,
    }
}
