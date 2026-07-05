#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod services;

use crate::{
    core::{
        session::{AuthProfile, SessionProfile, SessionProtocol},
        settings::AppSettings,
        sftp::{
            list_local_dir as read_local_dir, local_chmod as chmod_local_path_impl,
            local_create_file as create_local_file_impl,
            local_create_symlink as create_local_symlink_impl,
            local_duplicate as duplicate_local_path_impl,
            local_file_sha256 as local_file_sha256_impl, local_home as read_local_home,
            local_mkdir as create_local_dir_impl, local_move as move_local_path_impl,
            local_parent as read_local_parent, local_path_stats as local_path_stats_impl,
            local_read_text_file as read_local_file_impl,
            local_read_text_file_tail as read_local_file_tail_impl,
            local_remove as remove_local_path_impl, local_rename as rename_local_path_impl,
            local_touch as touch_local_path_impl, local_write_text_file as write_local_file_impl,
            search_local as search_local_impl, FileEntry, LocalPathStats, LocalTextFile,
            TransferConflictStrategy, TransferDirection,
        },
        terminal::{HostKeyIssue, TerminalModel, TerminalSize, TerminalStatus},
    },
    services::{
        sftp_service, ssh,
        storage::{self, SessionStore, TransferHistoryRecord as TransferView},
        terminal_service::TerminalLauncher,
    },
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use uuid::Uuid;

struct AppRuntime {
    store: SessionStore,
    profiles: Mutex<Vec<SessionProfile>>,
    terminals: Mutex<HashMap<Uuid, TerminalModel>>,
    sftp_sessions: Mutex<HashMap<Uuid, CachedSftpConnection>>,
    password_cache: Mutex<HashMap<Uuid, String>>,
    settings: Mutex<AppSettings>,
    transfers: Mutex<HashMap<Uuid, TransferTask>>,
    allow_main_close: AtomicBool,
}

const TRANSFER_HISTORY_LIMIT: usize = 200;
const FINISHED_TRANSFER_QUEUE_LIMIT: usize = 50;
const SFTP_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const SFTP_MAX_SESSIONS: usize = 4;
const APP_ICON_RGBA: &[u8] = include_bytes!("../icons/rustshell-app-icon-64.rgba");
const APP_ICON_SIZE: u32 = 64;

fn rustshell_window_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::new(APP_ICON_RGBA, APP_ICON_SIZE, APP_ICON_SIZE)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuickConnectRequest {
    protocol: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    remember_password: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveProfileRequest {
    profile: SessionProfile,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportProfilesRequest {
    payload: String,
    replace: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIdRequest {
    profile_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeRequest {
    terminal_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendRequest {
    terminal_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SftpRequest {
    profile_id: String,
    path: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferRequest {
    profile_id: String,
    local_path: String,
    remote_path: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustHostKeyRequest {
    host: String,
    port: u16,
    key_type: String,
    key_b64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveKnownHostsRequest {
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMkdirRequest {
    profile_id: String,
    parent: String,
    name: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRemoveRequest {
    profile_id: String,
    path: String,
    is_dir: bool,
    recursive: bool,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteRenameRequest {
    profile_id: String,
    path: String,
    new_name: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDuplicateRequest {
    profile_id: String,
    path: String,
    is_dir: bool,
    new_name: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteMoveRequest {
    profile_id: String,
    path: String,
    target_path: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteChmodRequest {
    profile_id: String,
    path: String,
    mode: u32,
    recursive: bool,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteChownRequest {
    profile_id: String,
    path: String,
    uid: Option<u32>,
    gid: Option<u32>,
    recursive: bool,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTouchRequest {
    profile_id: String,
    path: String,
    mtime: u64,
    recursive: bool,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePathStatsRequest {
    profile_id: String,
    path: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCreateFileRequest {
    profile_id: String,
    parent: String,
    name: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSymlinkRequest {
    profile_id: String,
    parent: String,
    name: String,
    target: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteReadFileRequest {
    profile_id: String,
    path: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteWriteFileRequest {
    profile_id: String,
    path: String,
    content: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHomeRequest {
    profile_id: String,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSearchRequest {
    profile_id: String,
    root: String,
    query: String,
    max_results: Option<usize>,
    password: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalMkdirRequest {
    parent: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalCreateFileRequest {
    parent: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSymlinkRequest {
    parent: String,
    name: String,
    target: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRemoveRequest {
    path: String,
    is_dir: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalDuplicateRequest {
    path: String,
    new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalMoveRequest {
    path: String,
    target_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalTouchRequest {
    path: String,
    mtime: u64,
    recursive: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalChmodRequest {
    path: String,
    mode: u32,
    recursive: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalReadFileRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalWriteFileRequest {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSearchRequest {
    root: String,
    query: String,
    max_results: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPathStatsRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRenameRequest {
    path: String,
    new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalOpenRequest {
    path: String,
    reveal: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartTransferRequest {
    profile_id: String,
    direction: TransferDirection,
    local_path: String,
    remote_path: String,
    #[serde(default)]
    conflict_strategy: TransferConflictStrategy,
    password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalView {
    id: String,
    profile_id: String,
    title: String,
    status: String,
    status_label: &'static str,
    endpoint: String,
    text: String,
    cols: u16,
    rows: u16,
    last_error: Option<String>,
    host_key_issue: Option<HostKeyIssue>,
    current_directory: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDrain {
    id: String,
    status: String,
    status_label: &'static str,
    output: String,
    last_error: Option<String>,
    host_key_issue: Option<HostKeyIssue>,
    current_directory: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatusView {
    hostname: String,
    os: String,
    uptime: String,
    load_average: String,
    cpu: String,
    memory: String,
    disk: String,
}

#[derive(Debug)]
struct TransferTask {
    id: Uuid,
    profile_id: Uuid,
    direction: TransferDirection,
    conflict_strategy: TransferConflictStrategy,
    source: String,
    target: String,
    cancel: Arc<AtomicBool>,
    state: Arc<Mutex<TransferState>>,
}

#[derive(Debug)]
struct TransferState {
    status: String,
    transferred: u64,
    total: u64,
    speed_bps: u64,
    eta_seconds: Option<u64>,
    attempts: u32,
    started_at: Instant,
    finished_at: Option<DateTime<Utc>>,
    history_recorded: bool,
    message: Option<String>,
}

struct CachedSftpConnection {
    connection: sftp_service::SftpConnection,
    last_used: Instant,
}

#[tauri::command]
fn list_profiles(state: State<'_, AppRuntime>) -> Result<Vec<SessionProfile>, String> {
    Ok(lock(&state.profiles)?.clone())
}

#[tauri::command]
fn save_profile(
    request: SaveProfileRequest,
    state: State<'_, AppRuntime>,
) -> Result<Vec<SessionProfile>, String> {
    let SaveProfileRequest {
        mut profile,
        password,
    } = request;
    let submitted_password = password.as_deref().filter(|value| !value.is_empty());
    if submitted_password.is_some() {
        profile = profile_for_secret(profile, submitted_password);
    }
    let profile_id = profile.id;
    if let Some(password) = submitted_password {
        lock(&state.password_cache)?.insert(profile.id, password.to_owned());
        if profile.remember_password {
            storage::save_password(&profile, password).map_err(to_string)?;
        } else {
            storage::delete_password(&profile).map_err(to_string)?;
        }
    } else if !profile.remember_password {
        storage::delete_password(&profile).map_err(to_string)?;
    }

    let mut invalidate_sftp = submitted_password.is_some();
    let output = {
        let mut profiles = lock(&state.profiles)?;
        if let Some(existing) = profiles.iter_mut().find(|item| item.id == profile.id) {
            invalidate_sftp |= sftp_connection_profile_changed(existing, &profile);
            *existing = profile;
        } else {
            profiles.push(profile);
        }
        state.store.save(&profiles).map_err(to_string)?;
        profiles.clone()
    };

    if invalidate_sftp {
        lock(&state.sftp_sessions)?.remove(&profile_id);
    }

    Ok(output)
}

#[tauri::command]
fn export_profiles(state: State<'_, AppRuntime>) -> Result<String, String> {
    let profiles = lock(&state.profiles)?;
    serde_json::to_string_pretty(&*profiles).map_err(to_string)
}

#[tauri::command]
fn import_profiles(
    request: ImportProfilesRequest,
    state: State<'_, AppRuntime>,
) -> Result<Vec<SessionProfile>, String> {
    let imported: Vec<SessionProfile> = serde_json::from_str(&request.payload)
        .map_err(|error| format!("会话文件解析失败: {}", error))?;
    if imported.is_empty() {
        return Err("会话文件为空".to_owned());
    }

    let imported_ids: Vec<Uuid> = imported.iter().map(|profile| profile.id).collect();
    let mut profiles = lock(&state.profiles)?;
    if request.replace {
        *profiles = imported;
    } else {
        for profile in imported {
            if let Some(existing) = profiles.iter_mut().find(|item| item.id == profile.id) {
                *existing = profile;
            } else {
                profiles.push(profile);
            }
        }
    }

    state.store.save(&profiles).map_err(to_string)?;
    let active_ids: Vec<Uuid> = profiles.iter().map(|profile| profile.id).collect();
    let output = profiles.clone();
    drop(profiles);

    {
        let mut password_cache = lock(&state.password_cache)?;
        if request.replace {
            password_cache.retain(|id, _| active_ids.contains(id));
        }
        for id in imported_ids {
            password_cache.remove(&id);
        }
    }
    lock(&state.sftp_sessions)?.clear();

    Ok(output)
}

#[tauri::command]
fn duplicate_profile(
    request: ProfileIdRequest,
    state: State<'_, AppRuntime>,
) -> Result<Vec<SessionProfile>, String> {
    let id = parse_uuid(&request.profile_id)?;
    let mut profiles = lock(&state.profiles)?;
    let source = profiles
        .iter()
        .find(|profile| profile.id == id)
        .cloned()
        .ok_or_else(|| "未找到会话配置".to_owned())?;
    let mut copied = source;
    copied.id = Uuid::new_v4();
    copied.name = unique_profile_copy_name(&profiles, &copied.name);
    copied.created_at = Utc::now();
    copied.last_connected_at = None;
    copied.remember_password = false;
    profiles.push(copied);
    state.store.save(&profiles).map_err(to_string)?;
    Ok(profiles.clone())
}

#[tauri::command]
fn delete_profile(
    request: ProfileIdRequest,
    state: State<'_, AppRuntime>,
) -> Result<Vec<SessionProfile>, String> {
    let id = parse_uuid(&request.profile_id)?;
    let removed = {
        let mut profiles = lock(&state.profiles)?;
        let index = profiles
            .iter()
            .position(|profile| profile.id == id)
            .ok_or_else(|| "未找到会话配置".to_owned())?;
        let removed = profiles.remove(index);
        state.store.save(&profiles).map_err(to_string)?;
        (removed, profiles.clone())
    };

    storage::delete_password(&removed.0).map_err(to_string)?;
    lock(&state.password_cache)?.remove(&id);
    lock(&state.sftp_sessions)?.remove(&id);
    Ok(removed.1)
}

#[tauri::command]
fn connect_local_shell(state: State<'_, AppRuntime>) -> Result<TerminalView, String> {
    let profile = lock(&state.profiles)?
        .iter()
        .find(|profile| matches!(profile.protocol, SessionProtocol::LocalShell))
        .cloned()
        .unwrap_or_else(SessionProfile::new_local);
    launch_terminal(profile, None, &state)
}

#[tauri::command]
fn connect_profile(
    profile_id: String,
    password: Option<String>,
    state: State<'_, AppRuntime>,
) -> Result<TerminalView, String> {
    let id = parse_uuid(&profile_id)?;
    let profile = lock(&state.profiles)?
        .iter()
        .find(|profile| profile.id == id)
        .cloned()
        .ok_or_else(|| "未找到会话配置".to_owned())?;

    let password = resolve_password(&profile, password.as_deref(), &state)?;
    let terminal = launch_terminal(
        profile_for_secret(profile.clone(), password.as_deref()),
        password,
        &state,
    )?;
    mark_profile_connected(profile.id, &state)?;
    Ok(terminal)
}

#[tauri::command]
fn connect_quick(
    request: QuickConnectRequest,
    state: State<'_, AppRuntime>,
) -> Result<TerminalView, String> {
    let protocol = parse_protocol(&request.protocol)?;
    let mut profile = match protocol {
        SessionProtocol::LocalShell => SessionProfile::new_local(),
        _ => SessionProfile::new_ssh(
            non_empty(&request.name, &request.host),
            "我的会话",
            &request.host,
            &request.username,
        ),
    };
    profile.protocol = protocol;
    profile.port = request.port;
    profile.remember_password = request.remember_password;
    profile.auth = AuthProfile::Password;

    {
        let mut profiles = lock(&state.profiles)?;
        if let Some(existing) = profiles.iter_mut().find(|item| {
            item.host == profile.host
                && item.port == profile.port
                && item.username == profile.username
        }) {
            profile.id = existing.id;
            profile.created_at = existing.created_at;
            profile.last_connected_at = existing.last_connected_at;
            *existing = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        state.store.save(&profiles).map_err(to_string)?;
    }

    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    let terminal = launch_terminal(profile.clone(), password, &state)?;
    mark_profile_connected(profile.id, &state)?;
    Ok(terminal)
}

#[tauri::command]
fn list_terminals(state: State<'_, AppRuntime>) -> Result<Vec<TerminalView>, String> {
    let mut terminals = lock(&state.terminals)?;
    Ok(terminals.values_mut().map(snapshot_terminal).collect())
}

#[tauri::command]
fn terminal_snapshot(
    terminal_id: String,
    state: State<'_, AppRuntime>,
) -> Result<TerminalView, String> {
    let id = parse_uuid(&terminal_id)?;
    let mut terminals = lock(&state.terminals)?;
    let terminal = terminals
        .get_mut(&id)
        .ok_or_else(|| "终端不存在或已关闭".to_owned())?;
    Ok(snapshot_terminal(terminal))
}

#[tauri::command]
fn terminal_drain(
    terminal_id: String,
    state: State<'_, AppRuntime>,
) -> Result<TerminalDrain, String> {
    let id = parse_uuid(&terminal_id)?;
    let mut terminals = lock(&state.terminals)?;
    let terminal = terminals
        .get_mut(&id)
        .ok_or_else(|| "终端不存在或已关闭".to_owned())?;
    let output = terminal.drain_output();
    Ok(TerminalDrain {
        id: terminal.id.to_string(),
        status: status_name(terminal.status).to_owned(),
        status_label: terminal.status.label(),
        output,
        last_error: terminal.last_error.clone(),
        host_key_issue: terminal.host_key_issue.clone(),
        current_directory: terminal.current_directory.clone(),
    })
}

#[tauri::command]
fn duplicate_terminal(
    terminal_id: String,
    state: State<'_, AppRuntime>,
) -> Result<TerminalView, String> {
    let id = parse_uuid(&terminal_id)?;
    let profile = {
        let mut terminals = lock(&state.terminals)?;
        let terminal = terminals
            .get_mut(&id)
            .ok_or_else(|| "终端不存在或已关闭".to_owned())?;
        terminal.pump_events();
        terminal.profile.clone()
    };
    let password = resolve_password(&profile, None, &state)?;
    let terminal = launch_terminal(
        profile_for_secret(profile.clone(), password.as_deref()),
        password,
        &state,
    )?;
    if !matches!(profile.protocol, SessionProtocol::LocalShell) {
        mark_profile_connected(profile.id, &state)?;
    }
    Ok(terminal)
}

#[tauri::command]
fn load_settings(state: State<'_, AppRuntime>) -> Result<AppSettings, String> {
    Ok(lock(&state.settings)?.clone())
}

#[tauri::command]
fn save_settings(
    settings: AppSettings,
    state: State<'_, AppRuntime>,
) -> Result<AppSettings, String> {
    let saved = storage::save_settings(&settings).map_err(to_string)?;
    *lock(&state.settings)? = saved.clone();
    Ok(saved)
}

#[tauri::command]
fn trust_host_key(request: TrustHostKeyRequest) -> Result<(), String> {
    ssh::trust_host_key(
        &request.host,
        request.port,
        &request.key_type,
        &request.key_b64,
    )
    .map_err(to_string)
}

#[tauri::command]
fn load_known_hosts() -> Result<String, String> {
    let path = storage::known_hosts_path();
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(to_string)
}

#[tauri::command]
fn save_known_hosts(request: SaveKnownHostsRequest) -> Result<(), String> {
    let path = storage::known_hosts_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(to_string)?;
    }
    std::fs::write(&path, request.content).map_err(to_string)
}

#[tauri::command]
fn clear_known_hosts() -> Result<(), String> {
    let path = storage::known_hosts_path();
    if path.exists() {
        std::fs::remove_file(path).map_err(to_string)?;
    }
    Ok(())
}

#[tauri::command]
fn terminal_send(request: SendRequest, state: State<'_, AppRuntime>) -> Result<(), String> {
    let id = parse_uuid(&request.terminal_id)?;
    let mut terminals = lock(&state.terminals)?;
    let terminal = terminals
        .get_mut(&id)
        .ok_or_else(|| "终端不存在或已关闭".to_owned())?;
    let bytes = terminal.encode_input(&request.data);
    terminal.send(bytes);
    Ok(())
}

#[tauri::command]
fn terminal_resize(request: ResizeRequest, state: State<'_, AppRuntime>) -> Result<(), String> {
    let id = parse_uuid(&request.terminal_id)?;
    let mut terminals = lock(&state.terminals)?;
    let terminal = terminals
        .get_mut(&id)
        .ok_or_else(|| "终端不存在或已关闭".to_owned())?;
    terminal.resize(TerminalSize {
        cols: request.cols.clamp(40, 240),
        rows: request.rows.clamp(12, 80),
    });
    Ok(())
}

#[tauri::command]
fn close_terminal(terminal_id: String, state: State<'_, AppRuntime>) -> Result<(), String> {
    let id = parse_uuid(&terminal_id)?;
    if let Some(mut terminal) = lock(&state.terminals)?.remove(&id) {
        terminal.shutdown();
    }
    Ok(())
}

#[tauri::command]
fn list_local_dir(path: String) -> Result<Vec<FileEntry>, String> {
    read_local_dir(&path).map_err(to_string)
}

#[tauri::command]
fn search_local(request: LocalSearchRequest) -> Result<Vec<FileEntry>, String> {
    search_local_impl(
        &request.root,
        &request.query,
        request.max_results.unwrap_or(200),
    )
    .map_err(to_string)
}

#[tauri::command]
fn local_home() -> Result<String, String> {
    Ok(read_local_home())
}

#[tauri::command]
fn local_parent(path: String) -> Result<Option<String>, String> {
    Ok(read_local_parent(&path))
}

#[tauri::command]
fn open_local_path(request: LocalOpenRequest) -> Result<(), String> {
    open_local_path_impl(&request.path, request.reveal).map_err(to_string)
}

#[tauri::command]
fn create_local_dir(request: LocalMkdirRequest) -> Result<(), String> {
    create_local_dir_impl(&request.parent, &request.name).map_err(to_string)
}

#[tauri::command]
fn create_local_file(request: LocalCreateFileRequest) -> Result<String, String> {
    create_local_file_impl(&request.parent, &request.name).map_err(to_string)
}

#[tauri::command]
fn create_local_symlink(request: LocalSymlinkRequest) -> Result<String, String> {
    create_local_symlink_impl(&request.parent, &request.name, &request.target).map_err(to_string)
}

#[tauri::command]
fn remove_local_path(request: LocalRemoveRequest) -> Result<(), String> {
    remove_local_path_impl(&request.path, request.is_dir).map_err(to_string)
}

#[tauri::command]
fn duplicate_local_path(request: LocalDuplicateRequest) -> Result<String, String> {
    duplicate_local_path_impl(&request.path, &request.new_name).map_err(to_string)
}

#[tauri::command]
fn move_local_path(request: LocalMoveRequest) -> Result<String, String> {
    move_local_path_impl(&request.path, &request.target_path).map_err(to_string)
}

#[tauri::command]
fn touch_local_path(request: LocalTouchRequest) -> Result<(), String> {
    touch_local_path_impl(&request.path, request.mtime, request.recursive).map_err(to_string)
}

#[tauri::command]
fn chmod_local_path(request: LocalChmodRequest) -> Result<(), String> {
    chmod_local_path_impl(&request.path, request.mode, request.recursive).map_err(to_string)
}

#[tauri::command]
fn local_path_stats(request: LocalPathStatsRequest) -> Result<LocalPathStats, String> {
    local_path_stats_impl(&request.path).map_err(to_string)
}

#[tauri::command]
fn read_local_file(request: LocalReadFileRequest) -> Result<LocalTextFile, String> {
    read_local_file_impl(&request.path).map_err(to_string)
}

#[tauri::command]
fn read_local_file_tail(request: LocalReadFileRequest) -> Result<LocalTextFile, String> {
    read_local_file_tail_impl(&request.path).map_err(to_string)
}

#[tauri::command]
fn write_local_file(request: LocalWriteFileRequest) -> Result<(), String> {
    write_local_file_impl(&request.path, &request.content).map_err(to_string)
}

#[tauri::command]
fn local_file_sha256(request: LocalReadFileRequest) -> Result<String, String> {
    local_file_sha256_impl(&request.path).map_err(to_string)
}

#[tauri::command]
fn rename_local_path(request: LocalRenameRequest) -> Result<(), String> {
    rename_local_path_impl(&request.path, &request.new_name).map_err(to_string)
}

#[tauri::command]
fn list_remote_dir(
    request: SftpRequest,
    state: State<'_, AppRuntime>,
) -> Result<Vec<FileEntry>, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    let result = with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.list_dir(&request.path)
    });
    match result {
        Ok(entries) => Ok(entries),
        Err(error) if matches!(profile.auth, AuthProfile::KeyFile { .. }) => {
            system_ssh_list_dir(&profile, &request.path)
                .map_err(|fallback| format!("{}；OpenSSH fallback 失败: {}", error, fallback))
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
fn remote_home(request: RemoteHomeRequest, state: State<'_, AppRuntime>) -> Result<String, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    let result = with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.home_dir()
    });
    match result {
        Ok(home) => Ok(home),
        Err(error) if matches!(profile.auth, AuthProfile::KeyFile { .. }) => {
            system_ssh_remote_home(&profile)
                .map_err(|fallback| format!("{}；OpenSSH fallback 失败: {}", error, fallback))
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
fn server_status(
    request: RemoteHomeRequest,
    state: State<'_, AppRuntime>,
) -> Result<ServerStatusView, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    if matches!(profile.protocol, SessionProtocol::LocalShell) {
        return Ok(local_server_status());
    }

    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    let output = match ssh_exec_capture(&profile, password.as_deref(), SERVER_STATUS_COMMAND) {
        Ok(output) => output,
        Err(error) if matches!(profile.auth, AuthProfile::KeyFile { .. }) => {
            system_ssh_output(&profile, SERVER_STATUS_COMMAND)
                .map_err(|fallback| format!("{}；OpenSSH fallback 失败: {}", error, fallback))?
        }
        Err(error) => return Err(error),
    };
    Ok(parse_server_status(&output))
}

#[tauri::command]
fn disconnect_sftp_session(
    request: ProfileIdRequest,
    state: State<'_, AppRuntime>,
) -> Result<(), String> {
    let id = parse_uuid(&request.profile_id)?;
    lock(&state.sftp_sessions)?.remove(&id);
    Ok(())
}

#[tauri::command]
fn search_remote(
    request: RemoteSearchRequest,
    state: State<'_, AppRuntime>,
) -> Result<Vec<FileEntry>, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.search(
            &request.root,
            &request.query,
            request.max_results.unwrap_or(200),
        )
    })
}

#[tauri::command]
fn upload_file(request: TransferRequest, state: State<'_, AppRuntime>) -> Result<(), String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    sftp_service::upload_file(
        &profile,
        password.as_deref(),
        &request.local_path,
        &request.remote_path,
    )
    .map_err(to_string)
}

#[tauri::command]
fn download_file(request: TransferRequest, state: State<'_, AppRuntime>) -> Result<String, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    sftp_service::download_file(
        &profile,
        password.as_deref(),
        &request.remote_path,
        &request.local_path,
    )
    .map(|path| path.display().to_string())
    .map_err(to_string)
}

#[tauri::command]
fn create_remote_dir(
    request: RemoteMkdirRequest,
    state: State<'_, AppRuntime>,
) -> Result<(), String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.create_dir(&request.parent, &request.name)
    })
}

#[tauri::command]
fn remove_remote_path(
    request: RemoteRemoveRequest,
    state: State<'_, AppRuntime>,
) -> Result<(), String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.remove_path(&request.path, request.is_dir, request.recursive)
    })
}

#[tauri::command]
fn rename_remote_path(
    request: RemoteRenameRequest,
    state: State<'_, AppRuntime>,
) -> Result<String, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.rename_path(&request.path, &request.new_name)
    })
}

#[tauri::command]
fn duplicate_remote_path(
    request: RemoteDuplicateRequest,
    state: State<'_, AppRuntime>,
) -> Result<String, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.duplicate_path(&request.path, request.is_dir, &request.new_name)
    })
}

#[tauri::command]
fn move_remote_path(
    request: RemoteMoveRequest,
    state: State<'_, AppRuntime>,
) -> Result<String, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.move_path(&request.path, &request.target_path)
    })
}

#[tauri::command]
fn chmod_remote_path(
    request: RemoteChmodRequest,
    state: State<'_, AppRuntime>,
) -> Result<(), String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.chmod_path(&request.path, request.mode, request.recursive)
    })
}

#[tauri::command]
fn chown_remote_path(
    request: RemoteChownRequest,
    state: State<'_, AppRuntime>,
) -> Result<(), String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.chown_path(&request.path, request.uid, request.gid, request.recursive)
    })
}

#[tauri::command]
fn touch_remote_path(
    request: RemoteTouchRequest,
    state: State<'_, AppRuntime>,
) -> Result<(), String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.touch_path(&request.path, request.mtime, request.recursive)
    })
}

#[tauri::command]
fn remote_path_stats(
    request: RemotePathStatsRequest,
    state: State<'_, AppRuntime>,
) -> Result<sftp_service::RemotePathStats, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.path_stats(&request.path)
    })
}

#[tauri::command]
fn create_remote_file(
    request: RemoteCreateFileRequest,
    state: State<'_, AppRuntime>,
) -> Result<String, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.create_file(&request.parent, &request.name)
    })
}

#[tauri::command]
fn create_remote_symlink(
    request: RemoteSymlinkRequest,
    state: State<'_, AppRuntime>,
) -> Result<String, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.create_symlink(&request.parent, &request.name, &request.target)
    })
}

#[tauri::command]
fn read_remote_file(
    request: RemoteReadFileRequest,
    state: State<'_, AppRuntime>,
) -> Result<sftp_service::RemoteTextFile, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.read_text_file(&request.path)
    })
}

#[tauri::command]
fn read_remote_file_tail(
    request: RemoteReadFileRequest,
    state: State<'_, AppRuntime>,
) -> Result<sftp_service::RemoteTextFile, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.read_text_file_tail(&request.path)
    })
}

#[tauri::command]
fn write_remote_file(
    request: RemoteWriteFileRequest,
    state: State<'_, AppRuntime>,
) -> Result<(), String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.write_text_file(&request.path, &request.content)
    })
}

#[tauri::command]
fn remote_file_sha256(
    request: RemoteReadFileRequest,
    state: State<'_, AppRuntime>,
) -> Result<String, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    with_sftp(&profile, password.as_deref(), &state, |connection| {
        connection.file_sha256(&request.path)
    })
}

#[tauri::command]
fn start_transfer(
    request: StartTransferRequest,
    state: State<'_, AppRuntime>,
) -> Result<TransferView, String> {
    start_transfer_with_attempts(request, state, 1)
}

fn start_transfer_with_attempts(
    request: StartTransferRequest,
    state: State<'_, AppRuntime>,
    attempts: u32,
) -> Result<TransferView, String> {
    let profile = profile_for_transfer(&request.profile_id, request.password.as_deref(), &state)?;
    let password = resolve_password(&profile, request.password.as_deref(), &state)?;
    let id = Uuid::new_v4();
    let cancel = Arc::new(AtomicBool::new(false));
    let transfer_state = Arc::new(Mutex::new(TransferState {
        status: "running".to_owned(),
        transferred: 0,
        total: 0,
        speed_bps: 0,
        eta_seconds: None,
        attempts: attempts.max(1),
        started_at: Instant::now(),
        finished_at: None,
        history_recorded: false,
        message: None,
    }));
    let (source, target) = match request.direction {
        TransferDirection::Upload => (request.local_path.clone(), request.remote_path.clone()),
        TransferDirection::Download => (request.remote_path.clone(), request.local_path.clone()),
    };

    let task = TransferTask {
        id,
        profile_id: profile.id,
        direction: request.direction,
        conflict_strategy: request.conflict_strategy,
        source,
        target,
        cancel: cancel.clone(),
        state: transfer_state.clone(),
    };

    let worker_profile = profile.clone();
    let worker_local_path = request.local_path.clone();
    let worker_remote_path = request.remote_path.clone();
    let worker_direction = request.direction;
    let worker_conflict = request.conflict_strategy;
    let worker_profile_id = profile.id;
    let worker_source = task.source.clone();
    let worker_target = task.target.clone();
    let worker_attempts = attempts.max(1);
    thread::Builder::new()
        .name(format!("transfer-{}", id))
        .spawn(move || {
            let state_for_progress = transfer_state.clone();
            let result = match worker_direction {
                TransferDirection::Upload => sftp_service::upload_file_with_progress_with_strategy(
                    &worker_profile,
                    password.as_deref(),
                    &worker_local_path,
                    &worker_remote_path,
                    worker_conflict,
                    cancel.clone(),
                    move |transferred, total| {
                        update_transfer_progress(&state_for_progress, transferred, total);
                    },
                )
                .map(Some),
                TransferDirection::Download => {
                    sftp_service::download_file_with_progress_with_strategy(
                        &worker_profile,
                        password.as_deref(),
                        &worker_remote_path,
                        &worker_local_path,
                        worker_conflict,
                        cancel.clone(),
                        move |transferred, total| {
                            update_transfer_progress(&state_for_progress, transferred, total);
                        },
                    )
                    .map(|path| Some(path.display().to_string()))
                }
            };

            let mut guard = lock_poison_ok(&transfer_state);
            match result {
                Ok(path) => {
                    guard.status = "done".to_owned();
                    guard.finished_at = Some(Utc::now());
                    guard.message = path;
                }
                Err(error) if cancel.load(Ordering::Relaxed) => {
                    guard.status = "cancelled".to_owned();
                    guard.finished_at = Some(Utc::now());
                    guard.message = Some(error.to_string());
                }
                Err(error) => {
                    guard.status = "failed".to_owned();
                    guard.finished_at = Some(Utc::now());
                    guard.message = Some(error.to_string());
                }
            }

            let record = TransferView {
                id: id.to_string(),
                profile_id: worker_profile_id.to_string(),
                direction: worker_direction,
                conflict_strategy: worker_conflict,
                source: worker_source,
                target: worker_target,
                status: guard.status.clone(),
                transferred: guard.transferred,
                total: guard.total,
                speed_bps: guard.speed_bps,
                eta_seconds: guard.eta_seconds,
                attempts: worker_attempts,
                message: guard.message.clone(),
                finished_at: guard.finished_at.clone(),
            };
            if storage::append_transfer_history(record, TRANSFER_HISTORY_LIMIT).is_ok() {
                guard.history_recorded = true;
            }
        })
        .map_err(to_string)?;

    let view = snapshot_transfer(&task);
    lock(&state.transfers)?.insert(id, task);
    Ok(view)
}

#[tauri::command]
fn list_transfers(state: State<'_, AppRuntime>) -> Result<Vec<TransferView>, String> {
    let mut transfers = lock(&state.transfers)?;
    for task in transfers.values() {
        record_transfer_history(task);
    }
    prune_finished_transfer_tasks(&mut transfers);
    Ok(transfers.values().map(snapshot_transfer).collect())
}

#[tauri::command]
fn cancel_transfer(transfer_id: String, state: State<'_, AppRuntime>) -> Result<(), String> {
    let id = parse_uuid(&transfer_id)?;
    let transfers = lock(&state.transfers)?;
    let task = transfers
        .get(&id)
        .ok_or_else(|| "传输任务不存在".to_owned())?;
    task.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn retry_transfer(
    transfer_id: String,
    state: State<'_, AppRuntime>,
) -> Result<TransferView, String> {
    let id = parse_uuid(&transfer_id)?;
    let (profile_id, direction, conflict_strategy, local_path, remote_path, attempts) = {
        let transfers = lock(&state.transfers)?;
        let task = transfers
            .get(&id)
            .ok_or_else(|| "传输任务不存在".to_owned())?;
        let state = lock_poison_ok(&task.state);
        let status = state.status.clone();
        let attempts = state.attempts.saturating_add(1).max(2);
        drop(state);
        if status == "running" {
            return Err("运行中的任务不能重试".to_owned());
        }
        let (local_path, remote_path) = match task.direction {
            TransferDirection::Upload => (task.source.clone(), task.target.clone()),
            TransferDirection::Download => (task.target.clone(), task.source.clone()),
        };
        (
            task.profile_id.to_string(),
            task.direction,
            task.conflict_strategy,
            local_path,
            remote_path,
            attempts,
        )
    };

    start_transfer_with_attempts(
        StartTransferRequest {
            profile_id,
            direction,
            local_path,
            remote_path,
            conflict_strategy,
            password: None,
        },
        state,
        attempts,
    )
}

#[tauri::command]
fn clear_finished_transfers(state: State<'_, AppRuntime>) -> Result<Vec<TransferView>, String> {
    let mut transfers = lock(&state.transfers)?;
    transfers.retain(|_, task| {
        let status = lock_poison_ok(&task.state).status.clone();
        if status == "running" {
            true
        } else {
            record_transfer_history(task);
            false
        }
    });
    Ok(transfers
        .values()
        .map(snapshot_transfer_and_record)
        .collect())
}

#[tauri::command]
fn remove_transfer(
    transfer_id: String,
    state: State<'_, AppRuntime>,
) -> Result<Vec<TransferView>, String> {
    let id = parse_uuid(&transfer_id)?;
    let mut transfers = lock(&state.transfers)?;
    let task = transfers
        .get(&id)
        .ok_or_else(|| "传输任务不存在".to_owned())?;
    if lock_poison_ok(&task.state).status == "running" {
        return Err("运行中的任务不能移除".to_owned());
    }
    record_transfer_history(task);
    transfers.remove(&id);
    Ok(transfers
        .values()
        .map(snapshot_transfer_and_record)
        .collect())
}

#[tauri::command]
fn list_transfer_history() -> Result<Vec<TransferView>, String> {
    Ok(storage::load_transfer_history())
}

#[tauri::command]
fn clear_transfer_history() -> Result<Vec<TransferView>, String> {
    storage::clear_transfer_history().map_err(to_string)?;
    Ok(Vec::new())
}

#[tauri::command]
fn exit_main_window(app: AppHandle, state: State<'_, AppRuntime>) -> Result<(), String> {
    state.allow_main_close.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.destroy() {
            state.allow_main_close.store(false, Ordering::SeqCst);
            return Err(to_string(error));
        }
    } else {
        app.exit(0);
    }
    Ok(())
}

#[tauri::command]
async fn open_file_manager_window(
    profile_id: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    // 必须是 async 命令:同步命令在主线程执行,Windows 上在主线程里创建
    // WebviewWindow 会死锁(窗口外壳出现但 WebView 永远不初始化,表现为白屏)。
    let label = "file-manager";
    let url = match profile_id.as_deref() {
        Some(id) => format!("file-manager.html?profileId={id}"),
        None => "file-manager.html".to_string(),
    };
    eprintln!("open_file_manager_window called profile_id={profile_id:?} url={url}");

    if let Some(window) = app.get_webview_window(label) {
        eprintln!("open_file_manager_window closing previous file-manager window");
        window.close().map_err(to_string)?;
        std::thread::sleep(std::time::Duration::from_millis(120));
    }

    eprintln!("open_file_manager_window building file-manager window");
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        .title("RustShell 文件管理器")
        .inner_size(1180.0, 760.0)
        .min_inner_size(860.0, 560.0)
        .resizable(true)
        .decorations(false)
        .transparent(false)
        .on_page_load(|_, payload| {
            let event = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            eprintln!("file-manager page-load {} {}", event, payload.url());
            tracing::info!(target: "rustshell", "file-manager page-load {} {}", event, payload.url());
        })
        .build()
        .map_err(to_string)?;
    window
        .set_icon(rustshell_window_icon())
        .map_err(to_string)?;
    eprintln!("open_file_manager_window built file-manager window");
    window.show().map_err(to_string)?;
    window.set_focus().map_err(to_string)?;
    Ok(())
}

fn main() {
    let _log_guard = init_logging();

    let store = SessionStore::new();
    let profiles = store.load_or_seed();
    let settings = storage::load_settings();
    let runtime = AppRuntime {
        store,
        profiles: Mutex::new(profiles),
        terminals: Mutex::new(HashMap::new()),
        sftp_sessions: Mutex::new(HashMap::new()),
        password_cache: Mutex::new(HashMap::new()),
        settings: Mutex::new(settings),
        transfers: Mutex::new(HashMap::new()),
        allow_main_close: AtomicBool::new(false),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(rustshell_window_icon())?;
            }
            let tray_menu = MenuBuilder::new(app)
                .text("show-main", "显示 RustShell")
                .separator()
                .text("quit-app", "退出")
                .build()?;
            TrayIconBuilder::with_id("rustshell-tray")
                .icon(rustshell_window_icon())
                .tooltip("RustShell 正在后台运行")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show-main" => show_main_window(app),
                    "quit-app" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => show_main_window(tray.app_handle()),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppRuntime>();
                if state.allow_main_close.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let should_confirm = lock(&state.settings)
                    .map(|settings| settings.confirm_on_exit)
                    .unwrap_or(true);
                if should_confirm {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("rustshell://request-exit-confirm", ());
                } else {
                    let _ = window.hide();
                }
            }
        })
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            save_profile,
            export_profiles,
            import_profiles,
            duplicate_profile,
            delete_profile,
            connect_local_shell,
            connect_profile,
            connect_quick,
            list_terminals,
            terminal_snapshot,
            terminal_drain,
            duplicate_terminal,
            load_settings,
            save_settings,
            exit_main_window,
            trust_host_key,
            load_known_hosts,
            save_known_hosts,
            clear_known_hosts,
            terminal_send,
            terminal_resize,
            close_terminal,
            local_home,
            local_parent,
            open_local_path,
            list_local_dir,
            search_local,
            create_local_dir,
            create_local_file,
            create_local_symlink,
            remove_local_path,
            duplicate_local_path,
            move_local_path,
            touch_local_path,
            chmod_local_path,
            local_path_stats,
            read_local_file,
            read_local_file_tail,
            write_local_file,
            local_file_sha256,
            rename_local_path,
            list_remote_dir,
            remote_home,
            server_status,
            disconnect_sftp_session,
            search_remote,
            create_remote_dir,
            remove_remote_path,
            rename_remote_path,
            duplicate_remote_path,
            move_remote_path,
            chmod_remote_path,
            chown_remote_path,
            touch_remote_path,
            remote_path_stats,
            create_remote_file,
            create_remote_symlink,
            read_remote_file,
            read_remote_file_tail,
            write_remote_file,
            remote_file_sha256,
            upload_file,
            download_file,
            start_transfer,
            list_transfers,
            cancel_transfer,
            retry_transfer,
            clear_finished_transfers,
            remove_transfer,
            list_transfer_history,
            clear_transfer_history,
            open_file_manager_window
        ])
        .run(tauri::generate_context!())
        .expect("failed to run RustShell");
}

fn init_logging() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    std::fs::create_dir_all(storage::log_dir()).ok();
    let file_appender = tracing_appender::rolling::daily(storage::log_dir(), "rustshell.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);
    tracing_subscriber::fmt()
        .with_writer(writer)
        .with_env_filter("rustshell=info,warn")
        .try_init()
        .ok()?;
    Some(guard)
}

const SERVER_STATUS_COMMAND: &str = r#"printf 'hostname=%s\n' "$(hostname 2>/dev/null || uname -n 2>/dev/null)"
printf 'os=%s\n' "$(uname -srvmo 2>/dev/null || uname -a 2>/dev/null)"
printf 'uptime=%s\n' "$(uptime -p 2>/dev/null || uptime 2>/dev/null)"
printf 'load=%s\n' "$(awk '{print $1" "$2" "$3}' /proc/loadavg 2>/dev/null || uptime 2>/dev/null)"
printf 'cpu=%s cores\n' "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '-')"
printf 'memory=%s\n' "$(free -h 2>/dev/null | awk '/^Mem:/ {print $3 " / " $2 " used"}')"
printf 'disk=%s\n' "$(df -h / 2>/dev/null | awk 'NR==2 {print $3 " / " $2 " (" $5 ")"}')"
"#;

fn ssh_exec_capture(
    profile: &SessionProfile,
    password: Option<&str>,
    command: &str,
) -> Result<String, String> {
    let session = ssh::establish(profile, password).map_err(|error| error.to_string())?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建 SSH 命令通道: {}", error))?;
    channel
        .exec(command)
        .map_err(|error| format!("无法执行服务器状态命令: {}", error))?;
    let mut output = String::new();
    channel
        .read_to_string(&mut output)
        .map_err(|error| format!("读取服务器状态失败: {}", error))?;
    channel.wait_close().ok();
    Ok(output)
}

fn system_ssh_remote_home(profile: &SessionProfile) -> Result<String, String> {
    let output = system_ssh_output(profile, r#"printf '%s\n' "$HOME""#)?;
    Ok(output.trim().to_owned())
}

fn system_ssh_list_dir(profile: &SessionProfile, path: &str) -> Result<Vec<FileEntry>, String> {
    let command = format!(
        r#"
dir={}
if [ ! -d "$dir" ]; then
  exit 2
fi
find "$dir" -mindepth 1 -maxdepth 1 -exec sh -c '
for path do
  name=${{path##*/}}
  target=
  if [ -L "$path" ]; then
    kind=symlink
    target=$(readlink "$path" 2>/dev/null || true)
  elif [ -d "$path" ]; then
    kind=directory
  else
    kind=file
  fi
  size=$(stat -c %s "$path" 2>/dev/null || echo 0)
  mtime=$(stat -c %Y "$path" 2>/dev/null || echo 0)
  perm=$(stat -c %a "$path" 2>/dev/null || echo 0)
  uid=$(stat -c %u "$path" 2>/dev/null || echo 0)
  gid=$(stat -c %g "$path" 2>/dev/null || echo 0)
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$path" "$kind" "$size" "$mtime" "$perm" "$uid" "$gid" "$target"
done
' sh {{}} +
"#,
        shell_quote(path)
    );
    let output = system_ssh_output(profile, &command)?;
    let mut entries = output
        .lines()
        .filter_map(parse_system_ssh_entry)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(entries)
}

fn system_ssh_output(profile: &SessionProfile, remote_command: &str) -> Result<String, String> {
    let AuthProfile::KeyFile { path } = &profile.auth else {
        return Err("OpenSSH fallback 仅支持密钥文件会话".to_owned());
    };
    let key_path = path.trim();
    if key_path.is_empty() {
        return Err("密钥文件路径为空".to_owned());
    }
    if !Path::new(key_path).exists() {
        return Err(format!("密钥文件不存在: {}", key_path));
    }

    let output = Command::new("ssh")
        .arg("-i")
        .arg(key_path)
        .arg("-p")
        .arg(profile.port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("IdentitiesOnly=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=8")
        .arg(format!("{}@{}", profile.username, profile.host))
        .arg(remote_command)
        .output()
        .map_err(|error| format!("启动 ssh.exe 失败: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            format!("ssh.exe 退出码 {:?}", output.status.code())
        } else {
            stderr
        });
    }
    String::from_utf8(output.stdout).map_err(|error| format!("SSH 输出不是 UTF-8: {}", error))
}

fn parse_system_ssh_entry(line: &str) -> Option<FileEntry> {
    let fields = line.splitn(9, '\t').collect::<Vec<_>>();
    if fields.len() < 8 {
        return None;
    }
    let file_type = fields[2].to_owned();
    let is_dir = file_type == "directory";
    let size = fields[3].parse::<u64>().unwrap_or_default();
    let mtime = fields[4].parse::<i64>().unwrap_or_default().max(0);
    let modified_at = DateTime::<Utc>::from_timestamp(mtime, 0).unwrap_or_else(Utc::now);
    let perm_text = fields[5].trim_start_matches('0');
    let permissions =
        u32::from_str_radix(if perm_text.is_empty() { "0" } else { perm_text }, 8).ok();
    let uid = fields[6].parse::<u32>().ok();
    let gid = fields[7].parse::<u32>().ok();
    let link_target = fields
        .get(8)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    Some(FileEntry {
        name: fields[0].to_owned(),
        path: fields[1].to_owned(),
        size,
        modified_at,
        is_dir,
        file_type,
        link_target,
        permissions,
        uid,
        gid,
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn parse_server_status(output: &str) -> ServerStatusView {
    let get = |key: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{}=", key)).map(str::trim))
            .filter(|value| !value.is_empty())
            .unwrap_or("-")
            .to_owned()
    };
    ServerStatusView {
        hostname: get("hostname"),
        os: get("os"),
        uptime: get("uptime"),
        load_average: get("load"),
        cpu: get("cpu"),
        memory: get("memory"),
        disk: get("disk"),
    }
}

fn local_server_status() -> ServerStatusView {
    ServerStatusView {
        hostname: std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "localhost".to_owned()),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        uptime: "-".to_owned(),
        load_average: "-".to_owned(),
        cpu: std::thread::available_parallelism()
            .map(|count| format!("{} cores", count.get()))
            .unwrap_or_else(|_| "-".to_owned()),
        memory: "-".to_owned(),
        disk: "-".to_owned(),
    }
}

fn launch_terminal(
    profile: SessionProfile,
    password: Option<String>,
    state: &State<'_, AppRuntime>,
) -> Result<TerminalView, String> {
    let missing_password = password.as_deref().map(str::is_empty).unwrap_or(true);
    if matches!(profile.protocol, SessionProtocol::Ssh)
        && matches!(profile.auth, AuthProfile::Password)
        && missing_password
    {
        return Err("需要输入密码".to_owned());
    }

    let size = TerminalSize::default();
    let local_shell = if matches!(profile.protocol, SessionProtocol::LocalShell) {
        let configured = lock(&state.settings)?.local_shell.trim().to_owned();
        if configured.is_empty() {
            None
        } else {
            Some(configured)
        }
    } else {
        None
    };
    let running = TerminalLauncher::spawn(profile.clone(), password, size, local_shell);
    let mut terminal = TerminalModel::new(profile, size);
    terminal.attach(running);
    let view = snapshot_terminal(&mut terminal);
    lock(&state.terminals)?.insert(terminal.id, terminal);
    Ok(view)
}

fn mark_profile_connected(profile_id: Uuid, state: &State<'_, AppRuntime>) -> Result<(), String> {
    let mut profiles = lock(&state.profiles)?;
    if let Some(profile) = profiles.iter_mut().find(|profile| profile.id == profile_id) {
        profile.last_connected_at = Some(Utc::now());
        state.store.save(&profiles).map_err(to_string)?;
    }
    Ok(())
}

fn snapshot_terminal(terminal: &mut TerminalModel) -> TerminalView {
    terminal.pump_events();
    TerminalView {
        id: terminal.id.to_string(),
        profile_id: terminal.profile.id.to_string(),
        title: terminal.title.clone(),
        status: status_name(terminal.status).to_owned(),
        status_label: terminal.status.label(),
        endpoint: terminal.profile.endpoint(),
        text: terminal.screen_text(),
        cols: terminal.size.cols,
        rows: terminal.size.rows,
        last_error: terminal.last_error.clone(),
        host_key_issue: terminal.host_key_issue.clone(),
        current_directory: terminal.current_directory.clone(),
    }
}

fn profile_for_transfer(
    profile_id: &str,
    password: Option<&str>,
    state: &State<'_, AppRuntime>,
) -> Result<SessionProfile, String> {
    let id = parse_uuid(profile_id)?;
    let mut profile = lock(&state.profiles)?
        .iter()
        .find(|profile| profile.id == id)
        .cloned()
        .ok_or_else(|| "未找到会话配置".to_owned())?;
    if let Some(password) = password.filter(|value| !value.is_empty()) {
        lock(&state.password_cache)?.insert(profile.id, password.to_owned());
        profile = profile_for_secret(profile, Some(password));
    }
    Ok(profile)
}

fn profile_for_secret(mut profile: SessionProfile, _password: Option<&str>) -> SessionProfile {
    if matches!(profile.protocol, SessionProtocol::LocalShell) {
        return profile;
    }

    if matches!(&profile.auth, AuthProfile::KeyFile { path } if path.trim().is_empty()) {
        profile.auth = AuthProfile::Password;
    }

    profile
}

fn sftp_connection_profile_changed(left: &SessionProfile, right: &SessionProfile) -> bool {
    left.protocol != right.protocol
        || left.host != right.host
        || left.port != right.port
        || left.username != right.username
        || left.auth != right.auth
        || left.remember_password != right.remember_password
}

fn cached_password(
    profile_id: Uuid,
    state: &State<'_, AppRuntime>,
) -> Result<Option<String>, String> {
    let passwords = lock(&state.password_cache)?;
    Ok(passwords.get(&profile_id).cloned())
}

fn resolve_password(
    profile: &SessionProfile,
    submitted: Option<&str>,
    state: &State<'_, AppRuntime>,
) -> Result<Option<String>, String> {
    if let Some(password) = submitted.filter(|value| !value.is_empty()) {
        lock(&state.password_cache)?.insert(profile.id, password.to_owned());
        if profile.remember_password {
            storage::save_password(profile, password).map_err(to_string)?;
        } else {
            storage::delete_password(profile).map_err(to_string)?;
        }
        return Ok(Some(password.to_owned()));
    }

    if let Some(password) = cached_password(profile.id, state)? {
        return Ok(Some(password));
    }

    if profile.remember_password {
        if let Some(password) = storage::load_password(profile) {
            lock(&state.password_cache)?.insert(profile.id, password.clone());
            return Ok(Some(password));
        }
    }

    Ok(None)
}

fn with_sftp<T, F>(
    profile: &SessionProfile,
    password: Option<&str>,
    state: &State<'_, AppRuntime>,
    mut action: F,
) -> Result<T, String>
where
    F: FnMut(&mut sftp_service::SftpConnection) -> anyhow::Result<T>,
{
    let effective_profile = profile_for_secret(profile.clone(), password);
    let mut sessions = lock(&state.sftp_sessions)?;
    prune_sftp_sessions(&mut sessions, Some(profile.id));
    if !sessions.contains_key(&profile.id) {
        let connection = sftp_service::SftpConnection::connect(&effective_profile, password)
            .map_err(to_string)?;
        sessions.insert(
            profile.id,
            CachedSftpConnection {
                connection,
                last_used: Instant::now(),
            },
        );
        prune_sftp_sessions(&mut sessions, Some(profile.id));
    }

    let first = {
        let cached = sessions
            .get_mut(&profile.id)
            .ok_or_else(|| "SFTP 会话不存在".to_owned())?;
        cached.last_used = Instant::now();
        action(&mut cached.connection)
    };

    match first {
        Ok(value) => Ok(value),
        Err(_) => {
            sessions.remove(&profile.id);
            let connection = sftp_service::SftpConnection::connect(&effective_profile, password)
                .map_err(to_string)?;
            sessions.insert(
                profile.id,
                CachedSftpConnection {
                    connection,
                    last_used: Instant::now(),
                },
            );
            prune_sftp_sessions(&mut sessions, Some(profile.id));
            let cached = sessions
                .get_mut(&profile.id)
                .ok_or_else(|| "SFTP 会话不存在".to_owned())?;
            cached.last_used = Instant::now();
            action(&mut cached.connection).map_err(to_string)
        }
    }
}

fn prune_sftp_sessions(sessions: &mut HashMap<Uuid, CachedSftpConnection>, keep: Option<Uuid>) {
    let now = Instant::now();
    sessions.retain(|id, cached| {
        Some(*id) == keep || now.duration_since(cached.last_used) <= SFTP_IDLE_TIMEOUT
    });

    if sessions.len() <= SFTP_MAX_SESSIONS {
        return;
    }

    let mut candidates: Vec<_> = sessions
        .iter()
        .filter_map(|(id, cached)| {
            if Some(*id) == keep {
                None
            } else {
                Some((*id, cached.last_used))
            }
        })
        .collect();
    candidates.sort_by_key(|(_, last_used)| *last_used);

    let remove_count = sessions.len().saturating_sub(SFTP_MAX_SESSIONS);
    for (id, _) in candidates.into_iter().take(remove_count) {
        sessions.remove(&id);
    }
}

fn snapshot_transfer(task: &TransferTask) -> TransferView {
    let state = lock_poison_ok(&task.state);
    TransferView {
        id: task.id.to_string(),
        profile_id: task.profile_id.to_string(),
        direction: task.direction,
        conflict_strategy: task.conflict_strategy,
        source: task.source.clone(),
        target: task.target.clone(),
        status: state.status.clone(),
        transferred: state.transferred,
        total: state.total,
        speed_bps: state.speed_bps,
        eta_seconds: state.eta_seconds,
        attempts: state.attempts,
        message: state.message.clone(),
        finished_at: state.finished_at.clone(),
    }
}

fn snapshot_transfer_and_record(task: &TransferTask) -> TransferView {
    record_transfer_history(task);
    snapshot_transfer(task)
}

fn prune_finished_transfer_tasks(transfers: &mut HashMap<Uuid, TransferTask>) {
    let mut finished = Vec::new();
    for (id, task) in transfers.iter() {
        let state = lock_poison_ok(&task.state);
        if state.status != "running" {
            let finished_at = state
                .finished_at
                .as_ref()
                .map(DateTime::<Utc>::timestamp_millis)
                .unwrap_or_default();
            finished.push((*id, finished_at));
        }
    }

    if finished.len() <= FINISHED_TRANSFER_QUEUE_LIMIT {
        return;
    }

    finished.sort_by_key(|(_, finished_at)| *finished_at);
    let remove_count = finished.len() - FINISHED_TRANSFER_QUEUE_LIMIT;
    for (id, _) in finished.into_iter().take(remove_count) {
        if let Some(task) = transfers.get(&id) {
            record_transfer_history(task);
        }
        transfers.remove(&id);
    }
}

fn record_transfer_history(task: &TransferTask) {
    let mut state = lock_poison_ok(&task.state);
    if state.status == "running" || state.history_recorded {
        return;
    }

    let record = TransferView {
        id: task.id.to_string(),
        profile_id: task.profile_id.to_string(),
        direction: task.direction,
        conflict_strategy: task.conflict_strategy,
        source: task.source.clone(),
        target: task.target.clone(),
        status: state.status.clone(),
        transferred: state.transferred,
        total: state.total,
        speed_bps: state.speed_bps,
        eta_seconds: state.eta_seconds,
        attempts: state.attempts,
        message: state.message.clone(),
        finished_at: state.finished_at.clone().or_else(|| Some(Utc::now())),
    };

    if storage::append_transfer_history(record, TRANSFER_HISTORY_LIMIT).is_ok() {
        state.history_recorded = true;
    }
}

fn update_transfer_progress(state: &Arc<Mutex<TransferState>>, transferred: u64, total: u64) {
    let mut guard = lock_poison_ok(state);
    guard.transferred = transferred;
    guard.total = total;
    let elapsed = guard.started_at.elapsed().as_secs_f64();
    if elapsed > 0.0 {
        guard.speed_bps = (transferred as f64 / elapsed) as u64;
        guard.eta_seconds = if guard.speed_bps > 0 && total > transferred {
            Some((total - transferred).div_ceil(guard.speed_bps))
        } else {
            None
        };
    }
}

fn lock_poison_ok<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn open_local_path_impl(path: &str, reveal: bool) -> std::io::Result<()> {
    let target = Path::new(path);
    let containing_target = if reveal && target.is_file() {
        target.parent().unwrap_or(target)
    } else {
        target
    };

    #[cfg(windows)]
    {
        if reveal && target.is_file() {
            let mut command = Command::new("explorer.exe");
            command.arg(format!("/select,{}", target.display()));
            command.spawn()?.wait()?;
        } else {
            let mut command = if reveal {
                let mut command = Command::new("explorer.exe");
                command.arg(containing_target);
                command
            } else {
                let mut command = Command::new("rundll32.exe");
                command.arg("url.dll,FileProtocolHandler").arg(target);
                command
            };
            command.spawn()?.wait()?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if reveal && target.is_file() {
            command.arg("-R").arg(target);
        } else {
            command.arg(containing_target);
        }
        command.spawn()?.wait()?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(containing_target)
            .spawn()?
            .wait()?;
    }

    Ok(())
}

fn status_name(status: TerminalStatus) -> &'static str {
    match status {
        TerminalStatus::Disconnected => "disconnected",
        TerminalStatus::Connecting => "connecting",
        TerminalStatus::Connected => "connected",
        TerminalStatus::Failed => "failed",
    }
}

fn parse_protocol(value: &str) -> Result<SessionProtocol, String> {
    match value {
        "SSH" | "Ssh" | "ssh" => Ok(SessionProtocol::Ssh),
        "Local" | "LocalShell" | "local" => Ok(SessionProtocol::LocalShell),
        "SFTP" | "SftpOnly" | "sftp" => Ok(SessionProtocol::SftpOnly),
        "Serial" | "serial" => Ok(SessionProtocol::Serial),
        _ => Err(format!("不支持的协议: {}", value)),
    }
}

fn parse_uuid(value: &str) -> Result<Uuid, String> {
    Uuid::parse_str(value).map_err(|error| format!("无效 ID: {}", error))
}

fn unique_profile_copy_name(profiles: &[SessionProfile], name: &str) -> String {
    let base = format!("{} copy", name.trim());
    if !profiles.iter().any(|profile| profile.name == base) {
        return base;
    }

    let mut index = 2;
    loop {
        let candidate = format!("{} {}", base, index);
        if !profiles.iter().any(|profile| profile.name == candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn non_empty<'a>(primary: &'a str, fallback: &'a str) -> &'a str {
    if primary.trim().is_empty() {
        fallback
    } else {
        primary
    }
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|_| "内部状态锁定失败".to_owned())
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
