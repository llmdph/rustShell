use crate::core::session::{SessionProfile, SessionProtocol};
use crossbeam_channel::{Receiver, Sender};
use encoding_rs::{CoderResult, Decoder, Encoding, UTF_8};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const TERMINAL_REPLAY_CAP: usize = 1024 * 1024;
const TERMINAL_PENDING_CAP: usize = 1024 * 1024;
const TERMINAL_OSC_SCAN_CAP: usize = 8 * 1024;
const MAX_EVENTS_PER_PUMP: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            cols: 120,
            rows: 30,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalStatus {
    Disconnected,
    Connecting,
    Connected,
    Failed,
}

impl TerminalStatus {
    pub fn name(self) -> &'static str {
        match self {
            Self::Disconnected => "disconnected",
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Failed => "failed",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Disconnected => "未连接",
            Self::Connecting => "连接中",
            Self::Connected => "已连接",
            Self::Failed => "连接失败",
        }
    }
}

#[derive(Debug)]
pub enum TerminalCommand {
    Write(Vec<u8>),
    Resize(TerminalSize),
    Shutdown,
}

/// Raised by SSH workers when the server host key is not yet trusted.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyIssue {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub key_b64: String,
    /// true when a different key was previously recorded for this host.
    pub changed: bool,
}

#[derive(Debug)]
pub enum TerminalEvent {
    Connected,
    Output(Vec<u8>),
    Disconnected {
        exit_code: Option<i32>,
    },
    Error(String),
    /// Authentication was rejected; cached credentials should be dropped.
    AuthFailed(String),
    HostKey(HostKeyIssue),
}

/// Bounded raw output history so terminals can be replayed after the
/// webview reloads or a pane remounts. Offsets are monotonically
/// increasing byte counters used to de-duplicate replay vs live events.
pub struct HistoryBuffer {
    data: Vec<u8>,
    start_offset: u64,
    cap: usize,
}

impl HistoryBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            data: Vec::new(),
            start_offset: 0,
            cap: cap.max(64 * 1024),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.data.extend_from_slice(bytes);
        if self.data.len() > self.cap {
            let drop = self.data.len() - self.cap;
            self.data.drain(..drop);
            self.start_offset += drop as u64;
            if self.data.capacity() > self.cap * 2 {
                self.data.shrink_to(self.cap);
            }
        }
    }

    /// Total bytes ever produced (offset just past the newest byte).
    pub fn end_offset(&self) -> u64 {
        self.start_offset + self.data.len() as u64
    }

    pub fn bytes(&self) -> &[u8] {
        &self.data
    }
}

pub struct TerminalShared {
    pub status: TerminalStatus,
    pub last_error: Option<String>,
    pub history: HistoryBuffer,
    pub size: TerminalSize,
    pub exit_code: Option<i32>,
}

impl TerminalShared {
    pub fn new(size: TerminalSize) -> Self {
        Self {
            status: TerminalStatus::Connecting,
            last_error: None,
            history: HistoryBuffer::new(TERMINAL_REPLAY_CAP),
            size,
            exit_code: None,
        }
    }
}

pub struct TerminalHandle {
    pub id: Uuid,
    pub profile_id: Uuid,
    pub title: String,
    pub endpoint: String,
    pub protocol: SessionProtocol,
    pub command_tx: Sender<TerminalCommand>,
    pub shared: Arc<Mutex<TerminalShared>>,
}

pub struct RunningTerminal {
    pub command_tx: Sender<TerminalCommand>,
    pub event_rx: Receiver<TerminalEvent>,
}

/// In-memory backend-side terminal model used by Tauri commands. It keeps a
/// bounded replay history and a small live-output drain so the React webview can
/// recover after remounts while still receiving incremental output efficiently.
pub struct TerminalModel {
    pub id: Uuid,
    pub profile: SessionProfile,
    pub title: String,
    pub status: TerminalStatus,
    pub size: TerminalSize,
    pub last_error: Option<String>,
    pub host_key_issue: Option<HostKeyIssue>,
    pub current_directory: Option<String>,
    pub exit_code: Option<i32>,
    command_tx: Option<Sender<TerminalCommand>>,
    event_rx: Option<Receiver<TerminalEvent>>,
    history: HistoryBuffer,
    pending_output: Vec<u8>,
    osc_scan_buffer: Vec<u8>,
    output_decoder: Decoder,
}

impl TerminalModel {
    pub fn new(profile: SessionProfile, size: TerminalSize) -> Self {
        let output_decoder = terminal_encoding(&profile.charset).new_decoder();
        Self {
            id: Uuid::new_v4(),
            title: profile.name.clone(),
            profile,
            status: TerminalStatus::Connecting,
            size,
            last_error: None,
            host_key_issue: None,
            current_directory: None,
            exit_code: None,
            command_tx: None,
            event_rx: None,
            history: HistoryBuffer::new(TERMINAL_REPLAY_CAP),
            pending_output: Vec::new(),
            osc_scan_buffer: Vec::new(),
            output_decoder,
        }
    }

    pub fn attach(&mut self, running: RunningTerminal) {
        self.command_tx = Some(running.command_tx);
        self.event_rx = Some(running.event_rx);
    }

    pub fn pump_events(&mut self) {
        for _ in 0..MAX_EVENTS_PER_PUMP {
            let next_event = self
                .event_rx
                .as_ref()
                .and_then(|event_rx| event_rx.try_recv().ok());
            let Some(event) = next_event else {
                break;
            };

            match event {
                TerminalEvent::Connected => {
                    self.status = TerminalStatus::Connected;
                    self.last_error = None;
                    self.host_key_issue = None;
                }
                TerminalEvent::Output(bytes) => {
                    self.history.push(&bytes);
                    if let Some(path) = self.detect_current_directory(&bytes) {
                        self.current_directory = Some(path);
                    }
                    self.push_pending_output(&bytes);
                }
                TerminalEvent::Disconnected { exit_code } => {
                    self.status = TerminalStatus::Disconnected;
                    self.exit_code = exit_code;
                }
                TerminalEvent::Error(message) => {
                    self.status = TerminalStatus::Failed;
                    self.last_error = Some(message);
                }
                TerminalEvent::AuthFailed(message) => {
                    self.status = TerminalStatus::Failed;
                    self.last_error = Some(message);
                }
                TerminalEvent::HostKey(issue) => {
                    self.status = TerminalStatus::Failed;
                    self.last_error = Some(format!(
                        "主机密钥{}: {}",
                        if issue.changed {
                            "已变更"
                        } else {
                            "未信任"
                        },
                        issue.fingerprint
                    ));
                    self.host_key_issue = Some(issue);
                }
            }
        }
    }

    fn push_pending_output(&mut self, bytes: &[u8]) {
        self.pending_output.extend_from_slice(bytes);
        if self.pending_output.len() > TERMINAL_PENDING_CAP {
            let drop = self.pending_output.len() - TERMINAL_PENDING_CAP;
            self.pending_output.drain(..drop);
            if self.pending_output.capacity() > TERMINAL_PENDING_CAP * 2 {
                self.pending_output.shrink_to(TERMINAL_PENDING_CAP);
            }
        }
    }

    fn detect_current_directory(&mut self, bytes: &[u8]) -> Option<String> {
        self.osc_scan_buffer.extend_from_slice(bytes);
        if self.osc_scan_buffer.len() > TERMINAL_OSC_SCAN_CAP {
            let drop = self.osc_scan_buffer.len() - TERMINAL_OSC_SCAN_CAP;
            self.osc_scan_buffer.drain(..drop);
            if self.osc_scan_buffer.capacity() > TERMINAL_OSC_SCAN_CAP * 2 {
                self.osc_scan_buffer.shrink_to(TERMINAL_OSC_SCAN_CAP);
            }
        }
        detect_current_directory(&self.osc_scan_buffer)
    }

    pub fn screen_text(&self) -> String {
        decode_terminal_bytes(&self.profile.charset, self.history.bytes())
    }

    pub fn drain_output(&mut self) -> String {
        self.pump_events();
        let output = std::mem::take(&mut self.pending_output);
        decode_terminal_stream(&mut self.output_decoder, &output)
    }

    pub fn encode_input(&self, text: &str) -> Vec<u8> {
        encode_terminal_text(&self.profile.charset, text)
    }

    pub fn send(&self, bytes: Vec<u8>) {
        if let Some(command_tx) = &self.command_tx {
            command_tx.send(TerminalCommand::Write(bytes)).ok();
        }
    }

    pub fn resize(&mut self, size: TerminalSize) {
        if self.size == size {
            return;
        }

        self.size = size;
        if let Some(command_tx) = &self.command_tx {
            command_tx.send(TerminalCommand::Resize(size)).ok();
        }
    }

    pub fn shutdown(&mut self) {
        if let Some(command_tx) = &self.command_tx {
            command_tx.send(TerminalCommand::Shutdown).ok();
        }
    }
}

fn detect_current_directory(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    parse_osc_current_directory(&text)
}

fn parse_osc_current_directory(text: &str) -> Option<String> {
    let mut index = 0;
    let bytes = text.as_bytes();
    let mut current_directory = None;
    while index < bytes.len() {
        let Some(offset) = text[index..].find("\x1b]") else {
            break;
        };
        let start = index + offset + 2;
        let rest = &text[start..];
        let bel_end = rest.find('\x07');
        let st_end = rest.find("\x1b\\");
        let end = match (bel_end, st_end) {
            (Some(left), Some(right)) => left.min(right),
            (Some(left), None) => left,
            (None, Some(right)) => right,
            (None, None) => break,
        };
        let payload = &rest[..end];
        if let Some(path) = parse_current_directory_payload(payload) {
            current_directory = Some(path);
        }
        index = start + end + 1;
    }
    current_directory
}

fn parse_current_directory_payload(payload: &str) -> Option<String> {
    if let Some(value) = payload.strip_prefix("7;file://") {
        return parse_file_uri_path(value);
    }
    payload
        .strip_prefix("9;9;")
        .map(percent_decode)
        .filter(|value| !value.trim().is_empty())
}

fn parse_file_uri_path(value: &str) -> Option<String> {
    let path_start = value.find('/').unwrap_or(0);
    let path = percent_decode(&value[path_start..]);
    if path.len() >= 3 && path.as_bytes()[0] == b'/' && path.as_bytes()[2] == b':' {
        return Some(path[1..].replace('/', "\\"));
    }
    (!path.trim().is_empty()).then_some(path)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = (bytes[index + 1] as char).to_digit(16);
            let lo = (bytes[index + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                output.push(((hi << 4) | lo) as u8);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn terminal_encoding(charset: &str) -> &'static Encoding {
    Encoding::for_label(charset.trim().as_bytes()).unwrap_or(UTF_8)
}

fn decode_terminal_bytes(charset: &str, bytes: &[u8]) -> String {
    let (text, _, _) = terminal_encoding(charset).decode(bytes);
    text.into_owned()
}

fn decode_terminal_stream(decoder: &mut Decoder, bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    let mut output = String::new();
    let mut remaining = bytes;
    loop {
        let capacity = decoder
            .max_utf8_buffer_length(remaining.len())
            .unwrap_or_else(|| remaining.len().saturating_mul(3).saturating_add(8));
        output.reserve(capacity);
        let (result, read, _) = decoder.decode_to_string(remaining, &mut output, false);
        remaining = &remaining[read..];
        match result {
            CoderResult::InputEmpty => break,
            CoderResult::OutputFull => {
                if remaining.is_empty() {
                    output.reserve(8);
                }
            }
        }
    }
    output
}

fn encode_terminal_text(charset: &str, text: &str) -> Vec<u8> {
    let (bytes, _, _) = terminal_encoding(charset).encode(text);
    bytes.into_owned()
}

impl TerminalHandle {
    pub fn new(
        profile: &SessionProfile,
        command_tx: Sender<TerminalCommand>,
        shared: Arc<Mutex<TerminalShared>>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            profile_id: profile.id,
            title: profile.name.clone(),
            endpoint: profile.endpoint(),
            protocol: profile.protocol,
            command_tx,
            shared,
        }
    }

    pub fn send(&self, bytes: Vec<u8>) {
        let _ = self.command_tx.send(TerminalCommand::Write(bytes));
    }

    pub fn resize(&self, size: TerminalSize) {
        {
            let mut shared = match self.shared.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            if shared.size == size {
                return;
            }
            shared.size = size;
        }
        let _ = self.command_tx.send(TerminalCommand::Resize(size));
    }

    pub fn shutdown(&self) {
        let _ = self.command_tx.send(TerminalCommand::Shutdown);
    }
}

impl Drop for TerminalHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_buffer_tracks_offsets_and_trims() {
        let mut buffer = HistoryBuffer::new(64 * 1024);
        assert_eq!(buffer.end_offset(), 0);

        buffer.push(b"hello");
        assert_eq!(buffer.end_offset(), 5);
        assert_eq!(buffer.bytes(), b"hello");

        // Push past capacity to force trimming.
        let chunk = vec![b'x'; 32 * 1024];
        for _ in 0..8 {
            buffer.push(&chunk);
        }
        let total = 5 + 8 * chunk.len() as u64;
        assert_eq!(buffer.end_offset(), total);
        assert!(buffer.bytes().len() <= 64 * 1024);
        // Offset math stays consistent after trim.
        assert_eq!(
            buffer.end_offset() - buffer.bytes().len() as u64,
            total - buffer.bytes().len() as u64
        );
    }

    #[test]
    fn stream_decoder_keeps_split_utf8_character() {
        let mut decoder = terminal_encoding("UTF-8").new_decoder();
        let bytes = "中".as_bytes();

        assert_eq!(decode_terminal_stream(&mut decoder, &bytes[..1]), "");
        assert_eq!(decode_terminal_stream(&mut decoder, &bytes[1..]), "中");
    }

    #[test]
    fn stream_decoder_keeps_split_gbk_character() {
        let mut decoder = terminal_encoding("GBK").new_decoder();
        let bytes = encode_terminal_text("GBK", "中");

        assert_eq!(decode_terminal_stream(&mut decoder, &bytes[..1]), "");
        assert_eq!(decode_terminal_stream(&mut decoder, &bytes[1..]), "中");
    }
}
