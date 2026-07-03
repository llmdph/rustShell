use crate::core::{
    session::{SessionProfile, SessionProtocol},
    settings::AppSettings,
    terminal::{TerminalModel, TerminalSize},
};
use crate::services::terminal_service::TerminalLauncher;

use super::view_models::{TerminalLineVm, TerminalTabVm};

const DEFAULT_COLS: u16 = 132;
const DEFAULT_ROWS: u16 = 40;
const MAX_SCROLLBACK_ROWS: usize = 4000;

pub struct TerminalManager {
    tabs: Vec<TerminalTabState>,
    active: Option<usize>,
    size: TerminalSize,
}

pub struct TerminalAction {
    pub message: Option<String>,
    pub copied_text: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct TerminalSnapshot {
    pub tabs: Vec<TerminalTabVm>,
    pub lines: Vec<TerminalLineVm>,
    pub profile_statuses: Vec<(String, String)>,
}

struct TerminalTabState {
    profile: SessionProfile,
    password: Option<String>,
    model: TerminalModel,
    parser: vt100::Parser,
    last_rendered_error: Option<String>,
}

impl TerminalManager {
    pub fn new(settings: &AppSettings) -> Self {
        Self {
            tabs: Vec::new(),
            active: None,
            size: TerminalSize {
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
            },
        }
        .with_scrollback(settings)
    }

    fn with_scrollback(mut self, settings: &AppSettings) -> Self {
        for tab in &mut self.tabs {
            tab.parser
                .set_scrollback(settings.scrollback.min(MAX_SCROLLBACK_ROWS as u32) as usize);
        }
        self
    }

    pub fn open_local(&mut self, profile: SessionProfile, settings: &AppSettings) {
        self.open_profile(profile, None, settings);
    }

    pub fn open_profile(
        &mut self,
        profile: SessionProfile,
        password: Option<String>,
        settings: &AppSettings,
    ) {
        let local_shell = matches!(profile.protocol, SessionProtocol::LocalShell)
            .then(|| settings.local_shell.clone())
            .filter(|value| !value.trim().is_empty());
        let running =
            TerminalLauncher::spawn(profile.clone(), password.clone(), self.size, local_shell);
        let mut model = TerminalModel::new(profile.clone(), self.size);
        model.attach(running);

        let mut parser = vt100::Parser::new(
            self.size.rows,
            self.size.cols,
            settings.scrollback.min(MAX_SCROLLBACK_ROWS as u32) as usize,
        );
        parser.process(b"\x1b[?25h");

        let tab = TerminalTabState {
            profile,
            password,
            model,
            parser,
            last_rendered_error: None,
        };
        self.tabs.push(tab);
        self.active = Some(self.tabs.len() - 1);
    }

    pub fn send_command(&mut self, command: &str) -> Option<String> {
        let command = command.trim();
        if command.is_empty() {
            return None;
        }

        let Some(tab) = self.active_tab_mut() else {
            return Some("没有可用终端".to_owned());
        };

        let mut text = command.to_owned();
        if !text.ends_with('\n') && !text.ends_with('\r') {
            text.push('\r');
        }
        tab.model.send(tab.model.encode_input(&text));
        None
    }

    pub fn control(&mut self, action: &str, settings: &AppSettings) -> TerminalAction {
        match action {
            "copy" => TerminalAction {
                message: Some("当前屏幕文本已准备复制".to_owned()),
                copied_text: self.active_tab().map(|tab| tab.parser.screen().contents()),
            },
            "paste" => TerminalAction {
                message: Some("粘贴入口已保留，后续接系统剪贴板".to_owned()),
                copied_text: None,
            },
            "clear" => {
                let size = self.size;
                if let Some(tab) = self.active_tab_mut() {
                    tab.parser = vt100::Parser::new(
                        size.rows,
                        size.cols,
                        settings.scrollback.min(MAX_SCROLLBACK_ROWS as u32) as usize,
                    );
                }
                TerminalAction {
                    message: Some("终端视图已清屏".to_owned()),
                    copied_text: None,
                }
            }
            "reconnect" => {
                if let Some(index) = self.active {
                    let profile = self.tabs[index].profile.clone();
                    let password = self.tabs[index].password.clone();
                    self.tabs[index].model.shutdown();
                    self.tabs.remove(index);
                    self.active = None;
                    self.open_profile(profile, password, settings);
                    TerminalAction {
                        message: Some("终端已重新连接".to_owned()),
                        copied_text: None,
                    }
                } else {
                    TerminalAction {
                        message: Some("没有可重连的终端".to_owned()),
                        copied_text: None,
                    }
                }
            }
            "close" => {
                if let Some(index) = self.active {
                    self.tabs[index].model.shutdown();
                    self.tabs.remove(index);
                    self.active = if self.tabs.is_empty() {
                        None
                    } else {
                        Some(index.saturating_sub(1).min(self.tabs.len() - 1))
                    };
                }
                TerminalAction {
                    message: Some("终端已关闭".to_owned()),
                    copied_text: None,
                }
            }
            _ => TerminalAction {
                message: Some(format!("未知终端操作: {}", action)),
                copied_text: None,
            },
        }
    }

    pub fn poll(&mut self) -> TerminalSnapshot {
        for tab in &mut self.tabs {
            let output = tab.model.drain_output();
            if !output.is_empty() {
                tab.parser.process(output.as_bytes());
            }
            if tab.model.status.name() == "failed" {
                if let Some(error) = tab.model.last_error.clone() {
                    if tab.last_rendered_error.as_deref() == Some(error.as_str()) {
                        continue;
                    }
                    let line = format!("\r\n[{}]\r\n", error);
                    tab.parser.process(line.as_bytes());
                    tab.last_rendered_error = Some(error);
                }
            }
        }
        self.snapshot()
    }

    pub fn snapshot(&self) -> TerminalSnapshot {
        let tabs = self
            .tabs
            .iter()
            .enumerate()
            .map(|(index, tab)| TerminalTabVm {
                id: tab.model.id.to_string(),
                title: tab.model.title.clone(),
                status: tab.model.status.name().to_owned(),
                active: self.active == Some(index),
            })
            .collect();

        let lines = self.active_tab().map(lines_from_tab).unwrap_or_else(|| {
            vec![TerminalLineVm {
                text: "未打开终端".to_owned(),
                runs: Vec::new(),
            }]
        });

        let profile_statuses = self
            .tabs
            .iter()
            .map(|tab| {
                (
                    tab.profile.id.to_string(),
                    tab.model.status.name().to_owned(),
                )
            })
            .collect();

        TerminalSnapshot {
            tabs,
            lines,
            profile_statuses,
        }
    }

    fn active_tab(&self) -> Option<&TerminalTabState> {
        self.active.and_then(|index| self.tabs.get(index))
    }

    fn active_tab_mut(&mut self) -> Option<&mut TerminalTabState> {
        self.active.and_then(|index| self.tabs.get_mut(index))
    }
}

fn lines_from_tab(tab: &TerminalTabState) -> Vec<TerminalLineVm> {
    let (_, cols) = tab.parser.screen().size();
    let mut lines: Vec<TerminalLineVm> = tab
        .parser
        .screen()
        .rows(0, cols)
        .map(|text| TerminalLineVm {
            text,
            runs: Vec::new(),
        })
        .collect();
    if lines.is_empty() {
        lines.push(TerminalLineVm {
            text: tab.model.screen_text(),
            runs: Vec::new(),
        });
    }
    lines
}
