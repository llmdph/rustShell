use crate::core::{
    session::{AuthProfile, SessionProfile, SessionProtocol},
    terminal::{PumpSignal, RunningTerminal, TerminalCommand, TerminalEvent, TerminalSize},
};
use crate::services::ssh::{self, ConnectFailure};
use anyhow::{Context, Result};
use crossbeam_channel::{unbounded, Receiver, RecvTimeoutError, Sender};
use portable_pty::{CommandBuilder, PtySize};
use ssh2::{ErrorCode, PtyModeOpcode, PtyModes};
use std::{
    io::{ErrorKind, Read, Write},
    sync::Arc,
    thread,
    time::Duration,
};

/// Forwards worker events to the pump and wakes it so echo is not stuck
/// behind the idle backoff that `terminal_send` often races ahead of.
#[derive(Clone)]
struct EventSink {
    tx: Sender<TerminalEvent>,
    pump: Arc<PumpSignal>,
}

impl EventSink {
    fn send(
        &self,
        event: TerminalEvent,
    ) -> Result<(), crossbeam_channel::SendError<TerminalEvent>> {
        self.tx.send(event)?;
        self.pump.notify();
        Ok(())
    }
}

pub struct TerminalLauncher;

impl TerminalLauncher {
    pub fn spawn(
        profile: SessionProfile,
        password: Option<String>,
        size: TerminalSize,
        local_shell: Option<String>,
        pump: Arc<PumpSignal>,
    ) -> RunningTerminal {
        let (command_tx, command_rx) = unbounded();
        // Unbounded: a 64-slot bound blocked the PTY/SSH reader on key-repeat
        // echo, the socket window froze, and the next write marked the session
        // failed. The pump drains up to 1024 events per tick.
        let (raw_tx, event_rx) = unbounded();
        let event_tx = EventSink { tx: raw_tx, pump };

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
                        // Prefer the in-process SSH stack for every auth mode so
                        // key-file sessions stay inside the app instead of
                        // popping OpenSSH/OpenSSL passphrase consoles.
                        run_ssh_shell(profile, password, size, command_rx, worker_event_tx.clone())
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
    event_tx: EventSink,
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

fn run_local_shell(
    _profile: SessionProfile,
    local_shell: Option<String>,
    size: TerminalSize,
    command_rx: Receiver<TerminalCommand>,
    event_tx: EventSink,
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

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone PTY reader")?;
    let mut writer = pair
        .master
        .take_writer()
        .context("failed to open PTY writer")?;

    event_tx.send(TerminalEvent::Connected).ok();

    let reader_tx = event_tx.clone();
    thread::Builder::new()
        .name("local-pty-reader".to_owned())
        .spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if reader_tx
                            .send(TerminalEvent::Output(buffer[..n].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) => {
                        reader_tx.send(TerminalEvent::Error(error.to_string())).ok();
                        break;
                    }
                }
            }
        })
        .context("failed to spawn PTY reader")?;

    let master = pair.master;
    let mut pending = None;
    'local_cmd: loop {
        let command = match pending.take() {
            Some(command) => command,
            None => match command_rx.recv() {
                Ok(command) => command,
                Err(_) => break,
            },
        };
        match command {
            TerminalCommand::Write(bytes) => {
                let (outgoing, leftover) = coalesce_writes(bytes, &command_rx);
                writer.write_all(&outgoing).context("failed to write PTY")?;
                writer.flush().ok();
                pending = leftover;
            }
            TerminalCommand::Resize(next_size) => {
                master
                    .resize(PtySize {
                        rows: next_size.rows,
                        cols: next_size.cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .context("failed to resize PTY")?;
            }
            TerminalCommand::Shutdown => break 'local_cmd,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    event_tx
        .send(TerminalEvent::Disconnected { exit_code: None })
        .ok();
    Ok(())
}

/// All SSH terminals use the in-process libssh2 stack. System OpenSSH is not
/// used here, so encrypted keys never open an external passphrase console.
fn run_ssh_shell(
    profile: SessionProfile,
    password: Option<String>,
    size: TerminalSize,
    command_rx: Receiver<TerminalCommand>,
    event_tx: EventSink,
) -> Result<()> {
    match establish_ssh_session(&profile, password.as_deref(), &event_tx)? {
        Some(session) => run_ssh_channel(session, size, command_rx, event_tx),
        None => Ok(()),
    }
}

fn establish_ssh_session(
    profile: &SessionProfile,
    password: Option<&str>,
    event_tx: &EventSink,
) -> Result<Option<ssh2::Session>> {
    match ssh::establish(profile, password) {
        Ok(session) => Ok(Some(session)),
        Err(ConnectFailure::HostKey(issue)) => {
            event_tx.send(TerminalEvent::HostKey(issue)).ok();
            Ok(None)
        }
        Err(ConnectFailure::PasswordRequired) => {
            let message = if matches!(profile.auth, AuthProfile::KeyFile { .. }) {
                "需要输入密钥口令".to_owned()
            } else {
                "需要输入密码".to_owned()
            };
            event_tx.send(TerminalEvent::AuthFailed(message)).ok();
            Ok(None)
        }
        Err(ConnectFailure::AuthRejected(message)) => {
            event_tx.send(TerminalEvent::AuthFailed(message)).ok();
            Ok(None)
        }
        Err(ConnectFailure::Other(error)) => Err(error),
    }
}

/// Interactive tty flags so remote bash/dircolors treat the session as a
/// real xterm (color_prompt, ls --color=auto) instead of a dumb pipe.
fn ssh_pty_modes() -> PtyModes {
    let mut modes = PtyModes::new();
    modes.set_boolean(PtyModeOpcode::ECHO, true);
    modes.set_boolean(PtyModeOpcode::ECHOE, true);
    modes.set_boolean(PtyModeOpcode::ECHOK, true);
    modes.set_boolean(PtyModeOpcode::ECHOCTL, true);
    modes.set_boolean(PtyModeOpcode::ECHOKE, true);
    modes.set_boolean(PtyModeOpcode::ICANON, true);
    modes.set_boolean(PtyModeOpcode::ISIG, true);
    modes.set_boolean(PtyModeOpcode::IEXTEN, true);
    modes.set_boolean(PtyModeOpcode::OPOST, true);
    modes.set_boolean(PtyModeOpcode::ONLCR, true);
    modes.set_boolean(PtyModeOpcode::ICRNL, true);
    modes.set_boolean(PtyModeOpcode::IXON, true);
    modes.set_boolean(PtyModeOpcode::IXANY, true);
    modes.set_boolean(PtyModeOpcode::IMAXBEL, true);
    modes.set_boolean(PtyModeOpcode::CS8, true);
    modes.set_boolean(PtyModeOpcode::ISTRIP, false);
    modes.set_boolean(PtyModeOpcode::INLCR, false);
    modes.set_boolean(PtyModeOpcode::IGNCR, false);
    modes.set_character(PtyModeOpcode::VINTR, Some('\u{0003}'));
    modes.set_character(PtyModeOpcode::VQUIT, Some('\u{001c}'));
    modes.set_character(PtyModeOpcode::VERASE, Some('\u{007f}'));
    modes.set_character(PtyModeOpcode::VKILL, Some('\u{0015}'));
    modes.set_character(PtyModeOpcode::VEOF, Some('\u{0004}'));
    modes.set_character(PtyModeOpcode::VSTART, Some('\u{0011}'));
    modes.set_character(PtyModeOpcode::VSTOP, Some('\u{0013}'));
    modes.set_character(PtyModeOpcode::VSUSP, Some('\u{001a}'));
    modes.set_u32(PtyModeOpcode::TTY_OP_ISPEED, 38_400);
    modes.set_u32(PtyModeOpcode::TTY_OP_OSPEED, 38_400);
    modes
}

/// Start a login shell with TERM already in the environment so Ubuntu
/// `.bashrc` can turn on `color_prompt`. `ls --color` can work while the
/// prompt stays monochrome: older skel only matches `xterm-color`, not
/// `*-256color`. Exporting `force_color_prompt` hits the `tput` branch.
/// Fall back to a plain `shell` request if the server rejects `exec`.
fn start_remote_shell(channel: &mut ssh2::Channel) -> Result<()> {
    const START: &str = "export TERM=xterm-256color COLORTERM=truecolor force_color_prompt=yes; exec \"${SHELL:-/bin/bash}\" -l";
    if channel.exec(START).is_ok() {
        return Ok(());
    }
    channel.shell().context("failed to start remote shell")
}

fn run_ssh_channel(
    session: ssh2::Session,
    size: TerminalSize,
    command_rx: Receiver<TerminalCommand>,
    event_tx: EventSink,
) -> Result<()> {
    let mut channel = session
        .channel_session()
        .context("failed to create SSH channel")?;
    channel
        .request_pty(
            "xterm-256color",
            Some(ssh_pty_modes()),
            Some((size.cols as u32, size.rows as u32, 0, 0)),
        )
        .context("failed to request SSH PTY")?;
    // Best-effort; OpenSSH AcceptEnv usually ignores these. TERM itself
    // comes from the pty-req term type above.
    let _ = channel.setenv("COLORTERM", "truecolor");
    let _ = channel.setenv("TERM", "xterm-256color");
    let _ = channel.setenv("FORCE_COLOR", "1");
    let _ = channel.setenv("CLICOLOR_FORCE", "1");
    start_remote_shell(&mut channel)?;
    session.set_blocking(false);

    event_tx.send(TerminalEvent::Connected).ok();

    let mut buffer = [0_u8; 16 * 1024];
    let mut idle_rounds: u32 = 0;
    let mut outgoing = Vec::new();
    loop {
        while let Ok(command) = command_rx.try_recv() {
            if apply_ssh_command(&mut channel, command, &mut outgoing, &event_tx)? {
                return Ok(());
            }
            idle_rounds = 0;
        }
        if !outgoing.is_empty() {
            write_ssh_all(&mut channel, &outgoing, &event_tx)?;
            outgoing.clear();
            idle_rounds = 0;
        }

        let idle = match channel.read(&mut buffer) {
            Ok(0) if channel.eof() => break,
            Ok(0) => true,
            Ok(read) => {
                idle_rounds = 0;
                event_tx
                    .send(TerminalEvent::Output(buffer[..read].to_vec()))
                    .ok();
                false
            }
            Err(error) if is_would_block(&error) => true,
            Err(error) => return Err(error).context("failed to read SSH channel"),
        };

        // Nothing to read: park instead of spinning. Waiting on the command
        // channel means a keystroke wakes us immediately, so the backoff only
        // ever delays *unsolicited* server output.
        if idle {
            idle_rounds = idle_rounds.saturating_add(1);
            match command_rx.recv_timeout(ssh_poll_interval(idle_rounds)) {
                Ok(command) => {
                    if apply_ssh_command(&mut channel, command, &mut outgoing, &event_tx)? {
                        return Ok(());
                    }
                    idle_rounds = 0;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    channel.close().ok();
                    return Ok(());
                }
            }
        }
    }

    let code = channel.exit_status().ok();
    event_tx
        .send(TerminalEvent::Disconnected { exit_code: code })
        .ok();
    Ok(())
}

/// Applies one command to the channel. Writes are staged into `outgoing` so a
/// key-repeat burst becomes one flush. Returns `true` when the terminal should
/// shut down.
fn apply_ssh_command(
    channel: &mut ssh2::Channel,
    command: TerminalCommand,
    outgoing: &mut Vec<u8>,
    event_tx: &EventSink,
) -> Result<bool> {
    match command {
        TerminalCommand::Write(bytes) => {
            outgoing.extend(bytes);
            Ok(false)
        }
        TerminalCommand::Resize(size) => {
            if !outgoing.is_empty() {
                write_ssh_all(channel, outgoing, event_tx)?;
                outgoing.clear();
            }
            channel
                .request_pty_size(size.cols as u32, size.rows as u32, None, None)
                .context("failed to resize SSH PTY")?;
            Ok(false)
        }
        TerminalCommand::Shutdown => {
            channel.close().ok();
            Ok(true)
        }
    }
}

fn coalesce_writes(
    first: Vec<u8>,
    command_rx: &Receiver<TerminalCommand>,
) -> (Vec<u8>, Option<TerminalCommand>) {
    let mut outgoing = first;
    loop {
        match command_rx.try_recv() {
            Ok(TerminalCommand::Write(bytes)) => outgoing.extend(bytes),
            Ok(other) => return (outgoing, Some(other)),
            Err(_) => return (outgoing, None),
        }
    }
}

/// How long to wait for socket data before checking again. Stays tight while a
/// session is streaming and relaxes once it goes quiet, which takes an idle
/// terminal from ~1000 wakeups per second down to ~25.
fn ssh_poll_interval(idle_rounds: u32) -> Duration {
    let millis = match idle_rounds {
        0..=32 => 2,
        33..=160 => 8,
        161..=600 => 20,
        _ => 40,
    };
    Duration::from_millis(millis)
}

fn write_ssh_all(
    channel: &mut ssh2::Channel,
    mut bytes: &[u8],
    event_tx: &EventSink,
) -> Result<()> {
    let mut incoming = [0_u8; 16 * 1024];
    while !bytes.is_empty() {
        // libssh2 only applies inbound window updates when we read. A
        // write-only burst (key repeat) otherwise dies with WINDOW_EXCEEDED.
        match channel.read(&mut incoming) {
            Ok(0) => {}
            Ok(n) => {
                event_tx
                    .send(TerminalEvent::Output(incoming[..n].to_vec()))
                    .ok();
            }
            Err(error) if is_would_block(&error) => {}
            Err(error) => return Err(error).context("failed to read SSH channel"),
        }

        match channel.write(bytes) {
            Ok(0) => thread::sleep(Duration::from_millis(1)),
            Ok(n) => bytes = &bytes[n..],
            Err(error) if is_would_block(&error) => thread::sleep(Duration::from_millis(1)),
            Err(error) => return Err(error).context("failed to write SSH channel"),
        }
    }

    channel.flush().ok();
    Ok(())
}

fn is_would_block(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::TimedOut
    ) || error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<ssh2::Error>())
        .is_some_and(|error| {
            matches!(
                error.code(),
                ErrorCode::Session(-37) // EAGAIN
                    | ErrorCode::Session(-19) // CHANNEL_WINDOW_EXCEEDED
                    | ErrorCode::Session(-14) // TIMEOUT
            )
        })
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
}
