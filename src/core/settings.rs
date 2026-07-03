use serde::{Deserialize, Serialize};

/// UI / behavior preferences persisted to `settings.json` in the config dir.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: String,
    pub font_size: u16,
    pub copy_on_select: bool,
    pub scrollback: u32,
    /// Empty string means auto-detect the platform default shell.
    pub local_shell: String,
    pub confirm_on_exit: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "deep".to_owned(),
            font_size: 14,
            copy_on_select: false,
            scrollback: 10_000,
            local_shell: String::new(),
            confirm_on_exit: true,
        }
    }
}

impl AppSettings {
    pub fn sanitized(mut self) -> Self {
        if !matches!(self.theme.as_str(), "deep" | "graphite" | "light") {
            self.theme = "deep".to_owned();
        }
        self.font_size = self.font_size.clamp(10, 28);
        self.scrollback = self.scrollback.clamp(1_000, 200_000);
        self
    }
}
