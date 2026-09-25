use crate::core::{
    session::{AuthProfile, SessionProfile, SessionProtocol},
    terminal::{RunningTerminal, TerminalCommand, TerminalEvent, TerminalSize},
};
use crate::services::ssh::{self, ConnectFailure};
use anyhow::{Context, Result};
use crossbeam_channel::{bounded, unbounded, Receiver, Sender};
use portable_pty::{CommandBuilder, PtySize};
use ssh2::ErrorCode;
use std::{
    collections::VecDeque,
    io::{ErrorKind, Read, Write},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};

const TERMINAL_EVENT_CHANNEL_CAP: usize = 64;
/// Unread terminal output kept while the window is behind. Past this, the
/// oldest unread bytes are dropped so a fast command can still be stopped.
const PTY_OUTPUT_BACKLOG: usize = 1024 * 1024;

pub struct TerminalLauncher;

impl TerminalLauncher {
    pub fn spawn(
        profile: SessionProfile,
        password: Option<String>,
        size: TerminalSize,
        local_shell: Option<String>,
    ) -> RunningTerminal {
        let (command_tx, command_rx) = unbounded();
        let (event_tx, event_rx) = bounded(TERMINAL_EVENT_CHANNEL_CAP);

        let worker_event_tx = event_tx.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("terminal-{}", profile.name))
            .spawn(move || {
                let result = match profile.protocol.clone() {
                    SessionProtocol::LocalShell => run_local_shell(
                        profile,
                        local_shell,
                        size,
                        command_rx,
                        worker_event_tx.clone(),
                    ),
                    SessionProtocol::Ssh => {
                        if matches!(profile.auth, AuthProfile::KeyFile { .. }) {
                            run_system_ssh_shell(profile, size, command_rx, worker_event_tx.clone())
                        } else {
                            run_ssh_shell(
                                profile,
                                password,
                                size,
                                command_rx,
                                worker_event_tx.clone(),
                            )
                        }
                    }
                    SessionProtocol::SftpOnly | SessionProtocol::Serial => {
                        run_placeholder(profile, command_rx, worker_event_tx.clone())
                    }
                };

                if let Err(error) = result {
                    let _ = worker_event_tx.send(TerminalEvent::Error(format!("{:#}", error)));
                }
            })
        {
            let _ = event_tx.send(TerminalEvent::Error(format!(
                "failed to spawn terminal worker: {}",
                error
            )));
        }

        RunningTerminal {
            command_tx,
            event_rx,
        }
    }
}

fn run_placeholder(
    profile: SessionProfile,
    command_rx: Receiver<TerminalCommand>,
    event_tx: Sender<TerminalEvent>,
) -> Result<()> {
    event_tx.send(TerminalEvent::Connected).ok();
    let message = match profile.protocol {
        SessionProtocol::SftpOnly => {
            "\r\nSFTP-only session is ready. Use the SFTP window to browse, upload, and download files.\r\n".to_owned()
        }
        SessionProtocol::Serial => {
            "\r\nSerial sessions are not implemented in this build.\r\n".to_owned()
        }
        _ => String::new(),
    };
    event_tx
        .send(TerminalEvent::Output(message.into_bytes()))
        .ok();

    while let Ok(command) = command_rx.recv() {
        match command {
            TerminalCommand::Write(bytes) => event_tx.send(TerminalEvent::Output(bytes)).ok(),
            TerminalCommand::Resize(_) => None,
            TerminalCommand::Shutdown => break,
        };
    }

    event_tx
        .send(TerminalEvent::Disconnected { exit_code: None })
        .ok();
    Ok(())
}


struct PtyOutputQueue {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    finished: bool,
}

fn lock_pty_output(queue: &Mutex<PtyOutputQueue>) -> std::sync::MutexGuard<'_, PtyOutputQueue> {
    queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct PtyExitSignal {
    code: Mutex<Option<Option<i32>>>,
    ready: Condvar,
}

impl PtyExitSignal {
    fn new() -> Self {
        Self {
            code: Mutex::new(None),
            ready: Condvar::new(),
        }
    }
}

fn lock_exit_code(signal: &PtyExitSignal) -> std::sync::MutexGuard<'_, Option<Option<i32>>> {
    signal.code.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn signal_pty_exit(signal: &PtyExitSignal, code: Option<i32>) {
    let mut guard = lock_exit_code(signal);
    if guard.is_some() {
        return;
    }
    *guard = Some(code);
    signal.ready.notify_one();
}

fn pty_exit_is_signaled(signal: &PtyExitSignal) -> bool {
    lock_exit_code(signal).is_some()
}

/// Queue the closed state only after the caller has recorded the exit code.
/// Output already sent on this channel stays ahead of it.
fn finish_pty_session(signal: &PtyExitSignal, event_tx: &Sender<TerminalEvent>) {
    let code = {
        let mut guard = lock_exit_code(signal);
        loop {
            if let Some(code) = *guard {
                break code;
            }
            guard = signal
                .ready
                .wait(guard)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    };
    event_tx
        .send(TerminalEvent::Disconnected { exit_code: code })
        .ok();
}

struct ExitOnDrop(Arc<PtyExitSignal>);

impl Drop for ExitOnDrop {
    fn drop(&mut self) {
        signal_pty_exit(&self.0, None);
    }
}

fn spawn_pty_output_reader(
    reader: Box<dyn Read + Send>,
    event_tx: Sender<TerminalEvent>,
) -> std::io::Result<Arc<PtyExitSignal>> {
    let signal = Arc::new(PtyExitSignal::new());
    let queue = Arc::new(Mutex::new(PtyOutputQueue {
        chunks: VecDeque::new(),
        bytes: 0,
        finished: false,
    }));
    let ready = Arc::new(Condvar::new());

    let sender_queue = Arc::clone(&queue);
    let sender_ready = Arc::clone(&ready);
    let sender_tx = event_tx.clone();
    let sender_signal = Arc::clone(&signal);
    thread::Builder::new()
        .name("pty-output".to_owned())
        .spawn(move || send_pty_output(sender_queue, sender_ready, sender_tx, sender_signal))?;

    let reader_queue = Arc::clone(&queue);
    let reader_ready = Arc::clone(&ready);
    let reader_signal = Arc::clone(&signal);
    if let Err(error) = thread::Builder::new()
        .name("pty-reader".to_owned())
        .spawn(move || read_pty_output(reader, reader_queue, reader_ready, event_tx, reader_signal))
    {
        let mut guard = lock_pty_output(&queue);
        guard.finished = true;
        ready.notify_one();
        signal_pty_exit(&signal, None);
        return Err(error);
    }
    Ok(signal)
}

fn read_pty_output(
    mut reader: Box<dyn Read + Send>,
    queue: Arc<Mutex<PtyOutputQueue>>,
    ready: Arc<Condvar>,
    event_tx: Sender<TerminalEvent>,
    exit_signal: Arc<PtyExitSignal>,
) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        if lock_pty_output(&queue).finished {
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = buffer[..n].to_vec();
                let mut guard = lock_pty_output(&queue);
                if guard.finished {
                    break;
                }
                guard.bytes += chunk.len();
                guard.chunks.push_back(chunk);
                while guard.bytes > PTY_OUTPUT_BACKLOG {
                    let Some(old) = guard.chunks.pop_front() else {
                        break;
                    };
                    guard.bytes = guard.bytes.saturating_sub(old.len());
                }
                ready.notify_one();
            }
            Err(error) => {
                // Closing the shell drops the console. That is not a failure
                // if the session is already finished.
                if !pty_exit_is_signaled(&exit_signal) {
                    let _ = event_tx.try_send(TerminalEvent::Error(error.to_string()));
                }
                break;
            }
        }
    }
    let mut guard = lock_pty_output(&queue);
    guard.finished = true;
    ready.notify_one();
}

fn send_pty_output(
    queue: Arc<Mutex<PtyOutputQueue>>,
    ready: Arc<Condvar>,
    event_tx: Sender<TerminalEvent>,
    exit_signal: Arc<PtyExitSignal>,
) {
    loop {
        let chunk = {
            let mut guard = lock_pty_output(&queue);
            loop {
                if let Some(chunk) = guard.chunks.pop_front() {
                    guard.bytes = guard.bytes.saturating_sub(chunk.len());
                    break Some(chunk);
                }
                if guard.finished {
                    break None;
                }
                guard = ready.wait(guard).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        if event_tx.send(TerminalEvent::Output(chunk)).is_err() {
            let mut guard = lock_pty_output(&queue);
            guard.finished = true;
            guard.chunks.clear();
            guard.bytes = 0;
            ready.notify_one();
            break;
        }
    }
    // Everything still queued has been sent. The closed state comes after it.
    finish_pty_session(&exit_signal, &event_tx);
}


enum PtyCommandWait {
    Command(TerminalCommand),
    Exited(i32),
    Closed,
}

/// Block for the next keystroke, but notice when the shell has already exited.
/// Waiting only on the command channel left a finished shell looking connected.
fn wait_pty_command(
    command_rx: &Receiver<TerminalCommand>,
    child: &mut dyn portable_pty::Child,
) -> PtyCommandWait {
    loop {
        match command_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(command) => return PtyCommandWait::Command(command),
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                return PtyCommandWait::Closed;
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                if let Some(code) = pty_exit_code(child) {
                    return PtyCommandWait::Exited(code);
                }
            }
        }
    }
}

fn pty_exit_code(child: &mut dyn portable_pty::Child) -> Option<i32> {
    match portable_pty::Child::try_wait(child) {
        Ok(Some(status)) => Some(status.exit_code() as i32),
        _ => None,
    }
}

fn run_local_shell(
    _profile: SessionProfile,
    local_shell: Option<String>,
    size: TerminalSize,
    command_rx: Receiver<TerminalCommand>,
    event_tx: Sender<TerminalEvent>,
) -> Result<()> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to open local PTY")?;

    let (shell, args) = shell_command_parts(local_shell.as_deref());
    let mut command = CommandBuilder::new(shell);
    for arg in args {
        command.arg(arg);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(command)
        .context("failed to spawn local shell")?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone PTY reader")?;
    let mut writer = pair
        .master
        .take_writer()
        .context("failed to open PTY writer")?;

    event_tx.send(TerminalEvent::Connected).ok();

    // Reading stays ahead of the window. Otherwise a command that prints
    // faster than the screen can fill the console and stop accepting input.
    let exit_signal = spawn_pty_output_reader(reader, event_tx.clone()).context("failed to spawn PTY reader")?;
    let _exit_on_drop = ExitOnDrop(Arc::clone(&exit_signal));

    let master = pair.master;
    let mut exit_code = None;
    loop {
        match wait_pty_command(&command_rx, child.as_mut()) {
            PtyCommandWait::Command(TerminalCommand::Write(bytes)) => {
                if let Err(error) = writer.write_all(&bytes) {
                    if let Some(code) = pty_exit_code(child.as_mut()) {
                        exit_code = Some(code);
                        break;
                    }
                    return Err(error).context("failed to write PTY");
                }
                writer.flush().ok();
            }
            PtyCommandWait::Command(TerminalCommand::Resize(next_size)) => {
                if let Err(error) = master.resize(PtySize {
                    rows: next_size.rows,
                    cols: next_size.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    if let Some(code) = pty_exit_code(child.as_mut()) {
                        exit_code = Some(code);
                        break;
                    }
                    return Err(error).context("failed to resize PTY");
                }
            }
            PtyCommandWait::Command(TerminalCommand::Shutdown) | PtyCommandWait::Closed => break,
            PtyCommandWait::Exited(code) => {
                exit_code = Some(code);
                break;
            }
        }
    }

    if exit_code.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    // The output sender closes the session after the last queued text.
    signal_pty_exit(&exit_signal, exit_code);
    Ok(())
}

fn run_system_ssh_shell(
    profile: SessionProfile,
    size: TerminalSize,
    command_rx: Receiver<TerminalCommand>,
    event_tx: Sender<TerminalEvent>,
) -> Result<()> {
    let AuthProfile::KeyFile { path } = &profile.auth else {
        return run_ssh_shell(profile, None, size, command_rx, event_tx);
    };
    let key_path = path.trim();
    if key_path.is_empty() {
        event_tx
            .send(TerminalEvent::AuthFailed("密钥文件路径为空".to_owned()))
            .ok();
        return Ok(());
    }

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to open SSH PTY")?;

    let mut command = CommandBuilder::new("ssh");
    command.arg("-tt");
    command.arg("-i");
    command.arg(key_path);
    command.arg("-p");
    command.arg(profile.port.to_string());
    command.arg("-o");
    command.arg("IdentitiesOnly=yes");
    command.arg("-o");
    command.arg("StrictHostKeyChecking=accept-new");
    command.arg("-o");
    command.arg("ServerAliveInterval=30");
    command.arg("-o");
    command.arg("ConnectTimeout=8");
    command.arg(format!("{}@{}", profile.username, profile.host));
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(command)
        .context("failed to spawn system ssh")?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone SSH PTY reader")?;
    let mut writer = pair
        .master
        .take_writer()
        .context("failed to open SSH PTY writer")?;

    event_tx.send(TerminalEvent::Connected).ok();

    let exit_signal = spawn_pty_output_reader(reader, event_tx.clone()).context("failed to spawn SSH PTY reader")?;
    let _exit_on_drop = ExitOnDrop(Arc::clone(&exit_signal));

    let master = pair.master;
    let mut exit_code = None;
    let mut child_exited = false;
    loop {
        match wait_pty_command(&command_rx, child.as_mut()) {
            PtyCommandWait::Command(TerminalCommand::Write(bytes)) => {
                if let Err(error) = writer.write_all(&bytes) {
                    if let Some(code) = pty_exit_code(child.as_mut()) {
                        exit_code = Some(code);
                        child_exited = true;
                        break;
                    }
                    return Err(error).context("failed to write SSH PTY");
                }
                writer.flush().ok();
            }
            PtyCommandWait::Command(TerminalCommand::Resize(next_size)) => {
                if let Err(error) = master.resize(PtySize {
                    rows: next_size.rows,
                    cols: next_size.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    if let Some(code) = pty_exit_code(child.as_mut()) {
                        exit_code = Some(code);
                        child_exited = true;
                        break;
                    }
                    return Err(error).context("failed to resize SSH PTY");
                }
            }
            PtyCommandWait::Command(TerminalCommand::Shutdown) | PtyCommandWait::Closed => break,
            PtyCommandWait::Exited(code) => {
                exit_code = Some(code);
                child_exited = true;
                break;
            }
        }
    }

    if !child_exited {
        let _ = child.kill();
        exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
    }
    // The output sender closes the session after the last queued text.
    signal_pty_exit(&exit_signal, exit_code);
    Ok(())
}

fn run_ssh_shell(
    profile: SessionProfile,
    password: Option<String>,
    size: TerminalSize,
    command_rx: Receiver<TerminalCommand>,
    event_tx: Sender<TerminalEvent>,
) -> Result<()> {
    let session = match ssh::establish(&profile, password.as_deref()) {
        Ok(session) => session,
        Err(ConnectFailure::HostKey(issue)) => {
            event_tx.send(TerminalEvent::HostKey(issue)).ok();
            return Ok(());
        }
        Err(ConnectFailure::PasswordRequired) => {
            event_tx
                .send(TerminalEvent::AuthFailed(ConnectFailure::PasswordRequired.to_string()))
                .ok();
            return Ok(());
        }
        Err(ConnectFailure::AuthRejected(message)) => {
            event_tx.send(TerminalEvent::AuthFailed(message)).ok();
            return Ok(());
        }
        Err(ConnectFailure::Other(error)) => return Err(error),
    };

    let mut channel = session
        .channel_session()
        .context("failed to create SSH channel")?;
    channel
        .request_pty(
            "xterm-256color",
            None,
            Some((size.cols as u32, size.rows as u32, 0, 0)),
        )
        .context("failed to request SSH PTY")?;
    channel.shell().context("failed to start remote shell")?;
    session.set_blocking(false);

    event_tx.send(TerminalEvent::Connected).ok();

    let mut buffer = [0_u8; 16 * 1024];
    let mut pending_input = PendingSshInput::default();
    // One chunk the window has not taken yet. Waiting inside send would leave
    // keystrokes sitting here until the screen catches up.
    let mut waiting_output: Option<Vec<u8>> = None;
    loop {
        if take_ssh_commands(&command_rx, &mut channel, &mut pending_input)? {
            return Ok(());
        }

        let wrote = flush_ssh_input(&mut channel, &mut pending_input)?;
        if waiting_output.is_none() {
            match channel.read(&mut buffer) {
                Ok(0) if channel.eof() => break,
                Ok(n) if n > 0 => waiting_output = Some(buffer[..n].to_vec()),
                Ok(_) => {}
                Err(error) if is_would_block(&error) => {}
                Err(error) => return Err(error).context("failed to read SSH channel"),
            }
        }

        let mut sent_output = false;
        if let Some(bytes) = waiting_output.take() {
            match event_tx.try_send(TerminalEvent::Output(bytes)) {
                Ok(()) => sent_output = true,
                Err(crossbeam_channel::TrySendError::Full(TerminalEvent::Output(bytes))) => {
                    waiting_output = Some(bytes);
                }
                Err(crossbeam_channel::TrySendError::Full(_))
                | Err(crossbeam_channel::TrySendError::Disconnected(_)) => return Ok(()),
            }
        }

        let output_is_waiting = waiting_output.is_some();
        if (output_is_waiting || (!wrote && !sent_output))
            && wait_ssh_command(&command_rx, &mut channel, &mut pending_input)?
        {
            return Ok(());
        }
    }

    let code = channel.exit_status().ok();
    event_tx
        .send(TerminalEvent::Disconnected { exit_code: code })
        .ok();
    Ok(())
}


#[derive(Default)]
struct PendingSshInput {
    bytes: Vec<u8>,
    offset: usize,
}

impl PendingSshInput {
    fn is_empty(&self) -> bool {
        self.offset >= self.bytes.len()
    }

    fn remaining(&self) -> &[u8] {
        &self.bytes[self.offset..]
    }

    fn push(&mut self, bytes: &[u8]) {
        if self.is_empty() {
            self.bytes.clear();
            self.offset = 0;
        }
        self.bytes.extend_from_slice(bytes);
    }

    fn consume(&mut self, count: usize) {
        self.offset += count;
        if self.offset > 64 * 1024 && self.offset * 2 >= self.bytes.len() {
            self.bytes.drain(..self.offset);
            self.offset = 0;
        }
    }
}

fn take_ssh_commands(
    command_rx: &Receiver<TerminalCommand>,
    channel: &mut ssh2::Channel,
    pending: &mut PendingSshInput,
) -> Result<bool> {
    while let Ok(command) = command_rx.try_recv() {
        if queue_ssh_command(channel, command, pending)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Block until the user types or a short idle slice elapses.
///
/// The SSH session is non-blocking, so polling the socket every millisecond
/// keeps a core awake for every open connection. Waiting on the command
/// channel instead still wakes immediately for keystrokes.
fn wait_ssh_command(
    command_rx: &Receiver<TerminalCommand>,
    channel: &mut ssh2::Channel,
    pending: &mut PendingSshInput,
) -> Result<bool> {
    match command_rx.recv_timeout(Duration::from_millis(20)) {
        Ok(command) => queue_ssh_command(channel, command, pending),
        Err(crossbeam_channel::RecvTimeoutError::Timeout) => Ok(false),
        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => Ok(true),
    }
}

fn queue_ssh_command(
    channel: &mut ssh2::Channel,
    command: TerminalCommand,
    pending: &mut PendingSshInput,
) -> Result<bool> {
    match command {
        TerminalCommand::Write(bytes) => {
            pending.push(&bytes);
            Ok(false)
        }
        TerminalCommand::Resize(next_size) => {
            channel
                .request_pty_size(next_size.cols as u32, next_size.rows as u32, None, None)
                .context("failed to resize SSH PTY")?;
            Ok(false)
        }
        TerminalCommand::Shutdown => {
            channel.close().ok();
            Ok(true)
        }
    }
}

/// Write whatever the server can take, then return. Staying here until a large
/// paste finishes would stop reading output and stall the session.
fn flush_ssh_input(channel: &mut ssh2::Channel, pending: &mut PendingSshInput) -> Result<bool> {
    if pending.is_empty() {
        return Ok(false);
    }
    match channel.write(pending.remaining()) {
        Ok(0) => Ok(false),
        Ok(count) => {
            pending.consume(count);
            if pending.is_empty() {
                channel.flush().ok();
            }
            Ok(true)
        }
        Err(error) if is_would_block(&error) => Ok(false),
        Err(error) => Err(error).context("failed to write SSH channel"),
    }
}

fn is_would_block(error: &std::io::Error) -> bool {
    error.kind() == ErrorKind::WouldBlock
        || error
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<ssh2::Error>())
            .is_some_and(|error| matches!(error.code(), ErrorCode::Session(-37)))
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_owned())
    }

    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_owned())
    }
}

fn shell_command_parts(configured_shell: Option<&str>) -> (String, Vec<String>) {
    let configured_shell = configured_shell
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(configured_shell) = configured_shell else {
        return (default_shell(), Vec::new());
    };

    let mut parts = split_command_line(configured_shell);
    if parts.is_empty() {
        return (default_shell(), Vec::new());
    }
    let program = parts.remove(0);
    (program, parts)
}

fn split_command_line(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote = None;

    for ch in value.chars() {
        match quote {
            Some(active) if ch == active => quote = None,
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_command_line_keeps_quoted_windows_path() {
        let parts = split_command_line(r#""C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo"#);

        assert_eq!(parts[0], r#"C:\Program Files\PowerShell\7\pwsh.exe"#);
        assert_eq!(parts[1], "-NoLogo");
    }

    #[test]
    fn split_command_line_handles_cmd_with_arguments() {
        let parts = split_command_line("cmd.exe /k chcp 65001");

        assert_eq!(parts, ["cmd.exe", "/k", "chcp", "65001"]);
    }

    #[test]
    fn shell_output_is_sent_before_the_session_closes() {
        use crate::core::terminal::TerminalEvent;
        use crossbeam_channel::bounded;
        use std::sync::Arc;
        use std::thread;
        use std::time::Duration;

        let (event_tx, event_rx) = bounded::<TerminalEvent>(8);
        let signal = Arc::new(PtyExitSignal::new());
        let (entered_tx, entered_rx) = bounded(1);
        let tx = event_tx.clone();
        let sig = Arc::clone(&signal);
        let worker = thread::spawn(move || {
            tx.send(TerminalEvent::Output(b"last".to_vec())).unwrap();
            let _ = entered_tx.send(());
            finish_pty_session(&sig, &tx);
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        signal_pty_exit(&signal, Some(7));
        worker.join().unwrap();
        match event_rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            TerminalEvent::Output(bytes) => assert_eq!(bytes, b"last"),
            other => panic!("expected output before close, got {other:?}"),
        }
        match event_rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            TerminalEvent::Disconnected { exit_code } => assert_eq!(exit_code, Some(7)),
            other => panic!("expected the session to close after output, got {other:?}"),
        }
        assert!(event_rx.try_recv().is_err());
    }
}
