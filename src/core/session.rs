use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SessionProtocol {
    #[serde(alias = "SSH", alias = "ssh")]
    Ssh,
    #[serde(
        alias = "Local",
        alias = "local",
        alias = "localShell",
        alias = "localshell",
        alias = "shell"
    )]
    LocalShell,
    #[serde(alias = "SFTP", alias = "sftp", alias = "sftpOnly", alias = "sftponly")]
    SftpOnly,
    #[serde(alias = "serial")]
    Serial,
}

impl fmt::Display for SessionProtocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ssh => write!(f, "SSH"),
            Self::LocalShell => write!(f, "Local"),
            Self::SftpOnly => write!(f, "SFTP"),
            Self::Serial => write!(f, "Serial"),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum AuthProfile {
    #[serde(alias = "password")]
    Password,
    #[serde(
        alias = "keyFile",
        alias = "key_file",
        alias = "keyfile",
        alias = "privateKey",
        alias = "publicKey"
    )]
    KeyFile { path: String },
    #[serde(alias = "agent")]
    Agent,
}

impl Default for AuthProfile {
    fn default() -> Self {
        Self::Password
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfile {
    pub id: Uuid,
    pub name: String,
    pub group: String,
    pub protocol: SessionProtocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub charset: String,
    #[serde(default)]
    pub auth: AuthProfile,
    pub color: [u8; 3],
    pub tags: Vec<String>,
    #[serde(alias = "last_connected_at")]
    pub last_connected_at: Option<DateTime<Utc>>,
    #[serde(alias = "created_at")]
    pub created_at: DateTime<Utc>,
    #[serde(default, alias = "remember_password")]
    pub remember_password: bool,
}

impl SessionProfile {
    pub fn new_ssh(name: &str, group: &str, host: &str, username: &str) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.to_owned(),
            group: group.to_owned(),
            protocol: SessionProtocol::Ssh,
            host: host.to_owned(),
            port: 22,
            username: username.to_owned(),
            charset: "UTF-8".to_owned(),
            auth: AuthProfile::Password,
            color: [47, 211, 166],
            tags: Vec::new(),
            last_connected_at: None,
            created_at: Utc::now(),
            remember_password: false,
        }
    }

    pub fn new_local() -> Self {
        Self {
            id: Uuid::new_v4(),
            name: local_profile_name(),
            group: "本地环境".to_owned(),
            protocol: SessionProtocol::LocalShell,
            host: "localhost".to_owned(),
            port: 0,
            username: whoami_fallback(),
            charset: "UTF-8".to_owned(),
            auth: AuthProfile::Agent,
            color: [78, 156, 255],
            tags: vec!["local".to_owned()],
            last_connected_at: None,
            created_at: Utc::now(),
            remember_password: false,
        }
    }

    pub fn endpoint(&self) -> String {
        match &self.protocol {
            SessionProtocol::LocalShell => "local://shell".to_owned(),
            _ => format!("{}@{}:{}", self.username, self.host, self.port),
        }
    }

    /// Whether this profile can require a secret (password or key passphrase).
    pub fn wants_secret(&self) -> bool {
        !matches!(self.protocol, SessionProtocol::LocalShell)
            && !matches!(self.auth, AuthProfile::Agent)
    }
}

fn local_profile_name() -> String {
    #[cfg(windows)]
    {
        "Windows 本机".to_owned()
    }
    #[cfg(not(windows))]
    {
        "本机终端".to_owned()
    }
}

fn whoami_fallback() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_owned())
}
