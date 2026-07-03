use crate::core::{
    session::SessionProfile,
    settings::AppSettings,
    sftp::{TransferConflictStrategy, TransferDirection},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

const KEYRING_SERVICE: &str = "RustShell";
static TRANSFER_HISTORY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferHistoryRecord {
    pub id: String,
    pub profile_id: String,
    pub direction: TransferDirection,
    pub conflict_strategy: TransferConflictStrategy,
    pub source: String,
    pub target: String,
    pub status: String,
    pub transferred: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub eta_seconds: Option<u64>,
    pub attempts: u32,
    pub message: Option<String>,
    pub finished_at: Option<DateTime<Utc>>,
}

pub struct SessionStore {
    file: PathBuf,
}

impl SessionStore {
    pub fn new() -> Self {
        let base = config_dir();

        Self {
            file: base.join("sessions.json"),
        }
    }

    pub fn load_or_seed(&self) -> Vec<SessionProfile> {
        match self.load() {
            Ok(profiles) => {
                let profiles: Vec<_> = profiles
                    .into_iter()
                    .filter(|profile| !is_builtin_demo_profile(profile))
                    .collect();
                if profiles.is_empty() {
                    default_profiles()
                } else {
                    profiles
                }
            }
            Err(_) => default_profiles(),
        }
    }

    pub fn load(&self) -> Result<Vec<SessionProfile>> {
        let bytes = fs::read(&self.file)
            .with_context(|| format!("failed to read {}", self.file.display()))?;
        serde_json::from_slice(&bytes).context("failed to parse sessions.json")
    }

    pub fn save(&self, profiles: &[SessionProfile]) -> Result<()> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        let payload = serde_json::to_vec_pretty(profiles).context("failed to encode sessions")?;
        fs::write(&self.file, payload)
            .with_context(|| format!("failed to write {}", self.file.display()))
    }
}

pub fn config_dir() -> PathBuf {
    ProjectDirs::from("com", "RustShell", "RustShell")
        .map(|dirs| dirs.config_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".rustshell"))
}

pub fn data_dir() -> PathBuf {
    ProjectDirs::from("com", "RustShell", "RustShell")
        .map(|dirs| dirs.data_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".rustshell"))
}

pub fn known_hosts_path() -> PathBuf {
    config_dir().join("known_hosts")
}

pub fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

pub fn transfer_history_path() -> PathBuf {
    data_dir().join("transfer-history.json")
}

pub fn load_transfer_history() -> Vec<TransferHistoryRecord> {
    let _guard = transfer_history_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    load_transfer_history_unlocked()
}

fn load_transfer_history_unlocked() -> Vec<TransferHistoryRecord> {
    let path = transfer_history_path();
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<TransferHistoryRecord>>(&bytes).ok())
        .unwrap_or_default()
}

pub fn save_transfer_history(history: &[TransferHistoryRecord]) -> Result<()> {
    let _guard = transfer_history_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    save_transfer_history_unlocked(history)
}

fn save_transfer_history_unlocked(history: &[TransferHistoryRecord]) -> Result<()> {
    let path = transfer_history_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let payload =
        serde_json::to_vec_pretty(history).context("failed to encode transfer history")?;
    fs::write(&path, payload).with_context(|| format!("failed to write {}", path.display()))
}

pub fn append_transfer_history(
    record: TransferHistoryRecord,
    limit: usize,
) -> Result<Vec<TransferHistoryRecord>> {
    let _guard = transfer_history_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut history = load_transfer_history_unlocked();
    history.retain(|item| item.id != record.id);
    history.insert(0, record);
    history.truncate(limit.max(1));
    save_transfer_history_unlocked(&history)?;
    Ok(history)
}

pub fn clear_transfer_history() -> Result<()> {
    let _guard = transfer_history_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    save_transfer_history_unlocked(&[])
}

fn transfer_history_lock() -> &'static Mutex<()> {
    TRANSFER_HISTORY_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn load_settings() -> AppSettings {
    let path = settings_path();
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AppSettings>(&bytes).ok())
        .map(AppSettings::sanitized)
        .unwrap_or_default()
}

pub fn save_settings(settings: &AppSettings) -> Result<AppSettings> {
    let settings = settings.clone().sanitized();
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let payload = serde_json::to_vec_pretty(&settings).context("failed to encode settings")?;
    fs::write(&path, payload).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(settings)
}

pub fn load_password(profile: &SessionProfile) -> Option<String> {
    keyring_entry(profile)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

pub fn save_password(profile: &SessionProfile, password: &str) -> Result<()> {
    if password.is_empty() {
        return Ok(());
    }
    keyring_entry(profile)
        .context("failed to open system keyring")?
        .set_password(password)
        .context("failed to save password")
}

pub fn delete_password(profile: &SessionProfile) -> Result<()> {
    if let Ok(entry) = keyring_entry(profile) {
        entry.delete_credential().ok();
    }
    Ok(())
}

fn keyring_entry(profile: &SessionProfile) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("profile:{}", profile.id))
}

fn default_profiles() -> Vec<SessionProfile> {
    vec![SessionProfile::new_local()]
}

fn is_builtin_demo_profile(profile: &SessionProfile) -> bool {
    matches!(
        (profile.name.as_str(), profile.host.as_str()),
        ("阿里云-杭州", "47.100.100.100")
            | ("腾讯云-上海", "43.138.88.21")
            | ("华为云-北京", "124.70.18.9")
            | ("开发机-1", "10.10.20.11")
            | ("开发机-2", "10.10.20.12")
            | ("MySQL-主库", "10.20.30.10")
            | ("Redis-集群", "10.20.30.20")
    )
}
