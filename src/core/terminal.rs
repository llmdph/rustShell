use crate::core::session::{SessionProfile, SessionProtocol};
use crossbeam_channel::{Receiver, Sender};
use encoding_rs::{CoderResult, Decoder, Encoding, UTF_8};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const TERMINAL_REPLAY_CAP: usize = 1024 * 1024;
const TERMINAL_PENDING_CAP: usize = 1024 * 1024;
const TERMINAL_OSC_SCAN_CAP: usize = 8 * 1024;
const MAX_EVENTS_PER_PUMP: usize = 256;

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

    pub fn push(&mut self, bytes: &[u8], charset: &str) {
        self.data.extend_from_slice(bytes);
        if let Some(drop_n) = trim_bounded_prefix(&mut self.data, self.cap, charset) {
            self.start_offset += drop_n as u64;
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
                    self.history.push(&bytes, &self.profile.charset);
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
        if trim_bounded_prefix(&mut self.pending_output, TERMINAL_PENDING_CAP, &self.profile.charset).is_some() {
            // Unread bytes were discarded, including any continuation the
            // decoder was waiting on. Start clean at the aligned boundary.
            self.output_decoder = terminal_encoding(&self.profile.charset).new_decoder();
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

    /// The replay string already contains this output. Drop it so the next
    /// drain does not write the same bytes into the terminal again.
    pub fn discard_replayed_output(&mut self) {
        self.pending_output.clear();
        self.output_decoder = terminal_encoding(&self.profile.charset).new_decoder();
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

/// Drop enough leading bytes to get back under `cap`, plus a margin so the
/// next chunks do not slide the whole buffer forward again.
fn trim_bounded_prefix(buf: &mut Vec<u8>, cap: usize, charset: &str) -> Option<usize> {
    if buf.len() <= cap || cap == 0 {
        return None;
    }
    let slack = (cap / 16).clamp(32 * 1024, 256 * 1024).min(cap);
    let drop_at = (buf.len() - cap + slack).min(buf.len());
    let drop_n = align_terminal_cut(buf, drop_at, charset).min(buf.len());
    if drop_n == 0 {
        return None;
    }
    buf.drain(..drop_n);
    if buf.capacity() > cap.saturating_mul(4) {
        buf.shrink_to(cap.saturating_add(slack));
    }
    Some(drop_n)
}

/// Move a trim point forward so the kept bytes start on a character boundary.
fn align_terminal_cut(data: &[u8], drop_at: usize, charset: &str) -> usize {
    if drop_at >= data.len() {
        return data.len();
    }
    if is_utf8_charset(charset) {
        return skip_utf8_continuation(data, drop_at);
    }
    if is_gbk_charset(charset) {
        let four_byte = is_gb18030_charset(charset);
        let mut index = 0;
        while index < drop_at && index < data.len() {
            let step = cjk_char_len(&data[index..], four_byte);
            if step == 0 {
                break;
            }
            index += step;
        }
        return index.min(data.len());
    }
    drop_at
}

fn is_utf8_charset(charset: &str) -> bool {
    terminal_encoding(charset) == UTF_8
}

fn is_gbk_charset(charset: &str) -> bool {
    let name = terminal_encoding(charset).name();
    name.eq_ignore_ascii_case("gbk") || name.eq_ignore_ascii_case("gb18030")
}

fn is_gb18030_charset(charset: &str) -> bool {
    terminal_encoding(charset)
        .name()
        .eq_ignore_ascii_case("gb18030")
}

fn skip_utf8_continuation(data: &[u8], drop_at: usize) -> usize {
    let mut index = drop_at;
    let limit = data.len().min(drop_at.saturating_add(3));
    while index < limit && data[index] & 0b1100_0000 == 0b1000_0000 {
        index += 1;
    }
    index
}

fn cjk_char_len(bytes: &[u8], four_byte: bool) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let first = bytes[0];
    if first <= 0x7F || !(0x81..=0xFE).contains(&first) {
        return 1;
    }
    if bytes.len() == 1 {
        return 1;
    }
    let second = bytes[1];
    if (0x40..=0x7E).contains(&second) || (0x80..=0xFE).contains(&second) {
        return 2;
    }
    if four_byte && (0x30..=0x39).contains(&second) {
        return 4.min(bytes.len());
    }
    1
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

        buffer.push(b"hello", "UTF-8");
        assert_eq!(buffer.end_offset(), 5);
        assert_eq!(buffer.bytes(), b"hello");

        // Push past capacity to force trimming.
        let chunk = vec![b'x'; 32 * 1024];
        for _ in 0..8 {
            buffer.push(&chunk, "UTF-8");
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

    fn model_with_charset(
        charset: &str,
    ) -> (TerminalModel, crossbeam_channel::Sender<TerminalEvent>) {
        let mut profile = crate::core::session::SessionProfile::new_ssh("t", "g", "h", "u");
        profile.charset = charset.to_owned();
        let mut model = TerminalModel::new(profile, TerminalSize::default());
        let (event_tx, event_rx) = crossbeam_channel::unbounded();
        let (command_tx, _command_rx) = crossbeam_channel::unbounded();
        model.attach(RunningTerminal {
            command_tx,
            event_rx,
        });
        (model, event_tx)
    }

    #[test]
    fn history_trim_keeps_utf8_and_gbk_character_boundaries() {
        let mut utf8 = HistoryBuffer::new(64 * 1024);
        let mut bytes = vec![b'a'];
        bytes.extend_from_slice("\u{4e2d}".as_bytes());
        bytes.resize(64 * 1024 + 2, b'b');
        utf8.push(&bytes, "UTF-8");
        let kept = utf8.bytes();
        assert!(kept.len() <= 64 * 1024);
        assert!(std::str::from_utf8(kept).is_ok());
        assert!(kept.iter().all(|byte| *byte == b'b'));

        let mut gbk = HistoryBuffer::new(64 * 1024);
        let encoded = encode_terminal_text("GBK", "\u{4e2d}");
        assert_eq!(encoded.len(), 2);
        let mut bytes = vec![b'a'];
        bytes.extend_from_slice(&encoded);
        bytes.resize(64 * 1024 + 2, b'b');
        gbk.push(&bytes, "GBK");
        let text = decode_terminal_bytes("GBK", gbk.bytes());
        assert!(!text.contains('\u{FFFD}'));
        assert!(text.chars().all(|ch| ch == 'b'));

        let mut gb18030 = HistoryBuffer::new(64 * 1024);
        let encoded = encode_terminal_text("gb18030", "\u{1F600}");
        assert!(encoded.len() > 1);
        let mut bytes = vec![b'a'];
        bytes.extend_from_slice(&encoded);
        bytes.resize(64 * 1024 + 2, b'b');
        gb18030.push(&bytes, "GB18030");
        let text = decode_terminal_bytes("GB18030", gb18030.bytes());
        assert!(!text.contains('\u{FFFD}'));
        assert!(text.chars().all(|ch| ch == 'b'));
    }

    #[test]
    fn pending_trim_does_not_resume_mid_character() {
        let (mut model, event_tx) = model_with_charset("UTF-8");
        event_tx
            .send(TerminalEvent::Output(vec![0xE4]))
            .unwrap();
        assert_eq!(model.drain_output(), "");

        let mut bytes = vec![b'a'];
        bytes.extend_from_slice("\u{4e2d}".as_bytes());
        bytes.resize(TERMINAL_PENDING_CAP + 2, b'b');
        event_tx.send(TerminalEvent::Output(bytes)).unwrap();
        let trimmed = model.drain_output();
        assert!(
            trimmed.chars().all(|ch| ch == 'b'),
            "trimmed output was {trimmed:?}"
        );

        event_tx
            .send(TerminalEvent::Output("\u{4e2d}".as_bytes().to_vec()))
            .unwrap();
        assert_eq!(model.drain_output(), "\u{4e2d}");
    }

    #[test]
    fn replay_does_not_emit_the_same_output_again() {
        let (mut model, event_tx) = model_with_charset("UTF-8");
        event_tx
            .send(TerminalEvent::Output(b"ready".to_vec()))
            .unwrap();
        model.pump_events();
        assert_eq!(model.screen_text(), "ready");
        model.discard_replayed_output();
        assert_eq!(model.drain_output(), "");

        event_tx
            .send(TerminalEvent::Output(" \u{4e2d}".as_bytes().to_vec()))
            .unwrap();
        assert_eq!(model.drain_output(), " \u{4e2d}");
        assert_eq!(model.screen_text(), "ready \u{4e2d}");
    }
}
