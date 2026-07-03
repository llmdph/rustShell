use crate::core::session::{SessionProfile, SessionProtocol};
use crate::services::storage::SessionStore;

use super::view_models::{SessionNodeVm, SessionPreviewVm};

#[derive(Clone, Debug)]
pub struct SessionViewState {
    profiles: Vec<SessionProfile>,
    selected_id: Option<String>,
}

impl SessionViewState {
    pub fn new() -> Self {
        let mut state = Self {
            profiles: Vec::new(),
            selected_id: None,
        };
        state.reload();
        state
    }

    pub fn reload(&mut self) {
        self.profiles = SessionStore::new().load_or_seed();
        if self.selected_id.is_none() {
            self.selected_id = self
                .profiles
                .iter()
                .find(|profile| matches!(profile.protocol, SessionProtocol::LocalShell))
                .or_else(|| self.profiles.first())
                .map(|profile| profile.id.to_string());
        }
    }

    pub fn profiles(&self) -> &[SessionProfile] {
        &self.profiles
    }

    pub fn selected_profile(&self) -> Option<&SessionProfile> {
        self.selected_id
            .as_deref()
            .and_then(|id| self.profile_by_selector(id))
    }

    pub fn selected_id(&self) -> Option<&str> {
        self.selected_id.as_deref()
    }

    pub fn select(&mut self, selector: &str) -> Option<SessionProfile> {
        let profile = self.profile_by_selector(selector)?.clone();
        self.selected_id = Some(profile.id.to_string());
        Some(profile)
    }

    pub fn profile_by_selector(&self, selector: &str) -> Option<&SessionProfile> {
        find_profile_by_selector(&self.profiles, selector)
    }

    pub fn default_local_profile(&self) -> SessionProfile {
        self.profiles
            .iter()
            .find(|profile| matches!(profile.protocol, SessionProtocol::LocalShell))
            .cloned()
            .unwrap_or_else(SessionProfile::new_local)
    }

    pub fn default_remote_selector(&self) -> String {
        self.profiles
            .iter()
            .find(|profile| is_remote_profile(profile))
            .map(profile_label)
            .unwrap_or_default()
    }

    pub fn rows(&self, statuses: &[(String, String)]) -> Vec<SessionNodeVm> {
        let mut groups: Vec<String> = self
            .profiles
            .iter()
            .map(|profile| group_name(profile).to_owned())
            .collect();
        groups.sort_by(|left, right| group_sort_key(left).cmp(&group_sort_key(right)));
        groups.dedup();

        let mut rows = Vec::new();
        for group in groups {
            rows.push(SessionNodeVm {
                id: format!("group:{}", group),
                name: group.clone(),
                protocol: String::new(),
                status: "folder".to_owned(),
                depth: 0,
                is_folder: true,
                selected: false,
            });

            let mut children: Vec<&SessionProfile> = self
                .profiles
                .iter()
                .filter(|profile| group_name(profile) == group)
                .collect();
            children.sort_by(|left, right| {
                left.name
                    .to_lowercase()
                    .cmp(&right.name.to_lowercase())
                    .then(left.host.cmp(&right.host))
            });

            for profile in children {
                let id = profile.id.to_string();
                let status = statuses
                    .iter()
                    .find(|(profile_id, _)| profile_id == &id)
                    .map(|(_, status)| status.clone())
                    .unwrap_or_else(|| "disconnected".to_owned());
                rows.push(SessionNodeVm {
                    id: id.clone(),
                    name: profile.name.clone(),
                    protocol: short_protocol(profile).to_owned(),
                    status,
                    depth: 1,
                    is_folder: false,
                    selected: self.selected_id.as_deref() == Some(id.as_str()),
                });
            }
        }
        rows
    }

    pub fn preview(&self) -> SessionPreviewVm {
        let Some(profile) = self.selected_profile() else {
            return SessionPreviewVm::default();
        };

        SessionPreviewVm {
            name: profile.name.clone(),
            host: profile.host.clone(),
            user: profile.username.clone(),
            protocol: profile.protocol.to_string(),
            port: if matches!(profile.protocol, SessionProtocol::LocalShell) {
                "0".to_owned()
            } else {
                profile.port.to_string()
            },
        }
    }
}

pub fn find_profile_by_selector<'a>(
    profiles: &'a [SessionProfile],
    selector: &str,
) -> Option<&'a SessionProfile> {
    let selector = selector.trim();
    if selector.is_empty() {
        return profiles.first();
    }

    profiles.iter().find(|profile| {
        let id = profile.id.to_string();
        id == selector
            || id.starts_with(selector)
            || profile.name.eq_ignore_ascii_case(selector)
            || profile.host.eq_ignore_ascii_case(selector)
            || profile_label(profile).eq_ignore_ascii_case(selector)
    })
}

pub fn find_remote_profile<'a>(
    profiles: &'a [SessionProfile],
    selector: &str,
) -> Option<&'a SessionProfile> {
    let selector = selector.trim();
    if selector.is_empty() {
        return profiles.iter().find(|profile| is_remote_profile(profile));
    }

    find_profile_by_selector(profiles, selector).filter(|profile| is_remote_profile(profile))
}

pub fn is_remote_profile(profile: &SessionProfile) -> bool {
    matches!(
        profile.protocol,
        SessionProtocol::Ssh | SessionProtocol::SftpOnly
    )
}

pub fn profile_label(profile: &SessionProfile) -> String {
    match profile.protocol {
        SessionProtocol::LocalShell => profile.name.clone(),
        _ => format!(
            "{} ({}@{}:{})",
            profile.name, profile.username, profile.host, profile.port
        ),
    }
}

fn group_name(profile: &SessionProfile) -> &str {
    if profile.group.trim().is_empty() {
        "我的会话"
    } else {
        profile.group.trim()
    }
}

fn group_sort_key(value: &str) -> (i32, String) {
    let priority = match value {
        "我的会话" => 0,
        "本地环境" => 10,
        _ => 5,
    };
    (priority, value.to_lowercase())
}

fn short_protocol(profile: &SessionProfile) -> &'static str {
    match profile.protocol {
        SessionProtocol::Ssh => "SSH",
        SessionProtocol::LocalShell => "Local",
        SessionProtocol::SftpOnly => "SFTP",
        SessionProtocol::Serial => "Serial",
    }
}
