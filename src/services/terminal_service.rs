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
    io::{ErrorKind, Read, Write},
    thread,
    time::Duration,
};

const TERMINAL_EVENT_CHANNEL_CAP: usize = 64;

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
    while let Ok(command) = command_rx.recv() {
        match command {
            TerminalCommand::Write(bytes) => {
                writer.write_all(&bytes).context("failed to write PTY")?;
                writer.flush().ok();
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
            TerminalCommand::Shutdown => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    event_tx
        .send(TerminalEvent::Disconnected { exit_code: None })
        .ok();
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

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone SSH PTY reader")?;
    let mut writer = pair
        .master
        .take_writer()
        .context("failed to open SSH PTY writer")?;

    event_tx.send(TerminalEvent::Connected).ok();

    let reader_tx = event_tx.clone();
    thread::Builder::new()
        .name("system-ssh-reader".to_owned())
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
        .context("failed to spawn SSH PTY reader")?;

    let master = pair.master;
    while let Ok(command) = command_rx.recv() {
        match command {
            TerminalCommand::Write(bytes) => {
                writer
                    .write_all(&bytes)
                    .context("failed to write SSH PTY")?;
                writer.flush().ok();
            }
            TerminalCommand::Resize(next_size) => {
                master
                    .resize(PtySize {
                        rows: next_size.rows,
                        cols: next_size.cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .context("failed to resize SSH PTY")?;
            }
            TerminalCommand::Shutdown => break,
        }
    }

    let _ = child.kill();
    let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
    event_tx
        .send(TerminalEvent::Disconnected { exit_code })
        .ok();
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
                .send(TerminalEvent::AuthFailed("需要输入密码".to_owned()))
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
    loop {
        while let Ok(command) = command_rx.try_recv() {
            match command {
                TerminalCommand::Write(bytes) => {
                    write_ssh_all(&mut channel, &bytes)?;
                }
                TerminalCommand::Resize(next_size) => {
                    channel
                        .request_pty_size(next_size.cols as u32, next_size.rows as u32, None, None)
                        .context("failed to resize SSH PTY")?;
                }
                TerminalCommand::Shutdown => {
                    channel.close().ok();
                    return Ok(());
                }
            }
        }

        match channel.read(&mut buffer) {
            Ok(0) if channel.eof() => break,
            Ok(0) => thread::sleep(Duration::from_millis(1)),
            Ok(n) => {
                event_tx
                    .send(TerminalEvent::Output(buffer[..n].to_vec()))
                    .ok();
            }
            Err(error) if is_would_block(&error) => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(error).context("failed to read SSH channel"),
        }
    }

    let code = channel.exit_status().ok();
    event_tx
        .send(TerminalEvent::Disconnected { exit_code: code })
        .ok();
    Ok(())
}

fn write_ssh_all(channel: &mut ssh2::Channel, mut bytes: &[u8]) -> Result<()> {
    while !bytes.is_empty() {
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
}
