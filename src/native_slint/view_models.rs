#[derive(Clone, Debug, Default)]
pub struct SessionNodeVm {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub status: String,
    pub depth: i32,
    pub is_folder: bool,
    pub selected: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SessionPreviewVm {
    pub name: String,
    pub host: String,
    pub user: String,
    pub protocol: String,
    pub port: String,
}

#[derive(Clone, Debug, Default)]
pub struct TerminalTabVm {
    pub id: String,
    pub title: String,
    pub status: String,
    pub active: bool,
}

#[derive(Clone, Debug, Default)]
pub struct TerminalRunVm {
    pub text: String,
    pub fg: String,
    pub bold: bool,
}

#[derive(Clone, Debug, Default)]
pub struct TerminalLineVm {
    pub text: String,
    pub runs: Vec<TerminalRunVm>,
}

#[derive(Clone, Debug, Default)]
pub struct FileEntryVm {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub permissions: String,
    pub owner: String,
    pub size: String,
    pub modified: String,
    pub is_dir: bool,
    pub selected: bool,
}

#[derive(Clone, Debug, Default)]
pub struct TransferVm {
    pub id: String,
    pub direction: String,
    pub source: String,
    pub target: String,
    pub status: String,
    pub progress: i32,
}

#[derive(Clone, Debug, Default)]
pub struct DialogVm {
    pub title: String,
    pub body: String,
}

impl DialogVm {
    pub fn info(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            body: body.into(),
        }
    }
}
