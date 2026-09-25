use crate::{
    core::{
        session::{AuthProfile, SessionProfile},
        terminal::HostKeyIssue,
    },
    services::storage,
};
use anyhow::{anyhow, Context, Result};
use base64::Engine;
use sha2::{Digest, Sha256};
use ssh2::{
    CheckResult, HostKeyType, KeyboardInteractivePrompt, KnownHostFileKind, KnownHostKeyFormat,
    Prompt, Session,
};
use std::{
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    time::Duration,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const HANDSHAKE_TIMEOUT_MS: u32 = 8_000;

/// Failure modes the UI reacts to individually.
#[derive(Debug)]
pub enum ConnectFailure {
    /// Host key unknown or changed; carries everything the trust dialog needs.
    HostKey(HostKeyIssue),
    /// A password / passphrase is required but none was supplied.
    PasswordRequired,
    /// Authentication was attempted and rejected.
    AuthRejected(String),
    Other(anyhow::Error),
}

impl std::fmt::Display for ConnectFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HostKey(issue) if issue.changed => {
                write!(f, "主机密钥已变更,连接被阻止: {}", issue.fingerprint)
            }
            Self::HostKey(issue) => write!(f, "主机密钥未信任: {}", issue.fingerprint),
            Self::PasswordRequired => write!(f, "需要输入密钥口令或密码"),
            Self::AuthRejected(message) => write!(f, "认证失败: {}", message),
            Self::Other(error) => write!(f, "{:#}", error),
        }
    }
}

impl From<anyhow::Error> for ConnectFailure {
    fn from(error: anyhow::Error) -> Self {
        Self::Other(error)
    }
}

/// Establish an authenticated SSH session with host-key verification
/// against the app-managed known_hosts file and keepalive enabled.
pub fn establish(
    profile: &SessionProfile,
    password: Option<&str>,
) -> Result<Session, ConnectFailure> {
    // Ask for a password or key passphrase before opening a socket. The
    // handshake is wasted work when we already know auth cannot succeed.
    if secret_required_before_connect(profile, password) {
        return Err(ConnectFailure::PasswordRequired);
    }

    let tcp = connect_tcp(&profile.host, profile.port)?;

    let mut session = Session::new().context("无法创建 SSH 会话")?;
    session.set_timeout(HANDSHAKE_TIMEOUT_MS);
    session.set_tcp_stream(tcp);
    session.handshake().context("SSH 握手失败")?;

    verify_host_key(&session, &profile.host, profile.port)?;
    authenticate(&session, profile, password)?;

    session.set_keepalive(true, 30);
    Ok(session)
}

fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, ConnectFailure> {
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .with_context(|| format!("无法解析主机 {}", host))?
        .collect();
    if addrs.is_empty() {
        return Err(ConnectFailure::Other(anyhow!("无法解析主机 {}", host)));
    }

    let mut last_error = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(stream) => {
                stream.set_nodelay(true).ok();
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(ConnectFailure::Other(anyhow!(
        "无法连接 {}:{} — {}",
        host,
        port,
        last_error.map(|e| e.to_string()).unwrap_or_default()
    )))
}

fn verify_host_key(session: &Session, host: &str, port: u16) -> Result<(), ConnectFailure> {
    let (key, key_type) = session
        .host_key()
        .ok_or_else(|| ConnectFailure::Other(anyhow!("服务器未提供主机密钥")))?;

    let mut known_hosts = session.known_hosts().context("无法初始化 known_hosts")?;
    let path = storage::known_hosts_path();
    if path.exists() {
        known_hosts
            .read_file(&path, KnownHostFileKind::OpenSSH)
            .context("known_hosts 文件解析失败")?;
    }

    match known_hosts.check_port(host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::Mismatch => Err(ConnectFailure::HostKey(build_issue(
            host, port, key, key_type, true,
        ))),
        CheckResult::NotFound | CheckResult::Failure => Err(ConnectFailure::HostKey(build_issue(
            host, port, key, key_type, false,
        ))),
    }
}

fn build_issue(
    host: &str,
    port: u16,
    key: &[u8],
    key_type: HostKeyType,
    changed: bool,
) -> HostKeyIssue {
    HostKeyIssue {
        host: host.to_owned(),
        port,
        key_type: key_type_name(key_type).to_owned(),
        fingerprint: fingerprint_sha256(key),
        key_b64: base64::engine::general_purpose::STANDARD.encode(key),
        changed,
    }
}

pub fn fingerprint_sha256(key: &[u8]) -> String {
    let digest = Sha256::digest(key);
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
    )
}

fn key_type_name(key_type: HostKeyType) -> &'static str {
    match key_type {
        HostKeyType::Rsa => "ssh-rsa",
        HostKeyType::Dss => "ssh-dss",
        HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        HostKeyType::Ed25519 => "ssh-ed25519",
        HostKeyType::Unknown => "unknown",
    }
}

fn key_format_for(name: &str) -> KnownHostKeyFormat {
    match name {
        "ssh-rsa" => KnownHostKeyFormat::SshRsa,
        "ssh-dss" => KnownHostKeyFormat::SshDss,
        "ecdsa-sha2-nistp256" => KnownHostKeyFormat::Ecdsa256,
        "ecdsa-sha2-nistp384" => KnownHostKeyFormat::Ecdsa384,
        "ecdsa-sha2-nistp521" => KnownHostKeyFormat::Ecdsa521,
        "ssh-ed25519" => KnownHostKeyFormat::Ed25519,
        _ => KnownHostKeyFormat::Unknown,
    }
}

/// Known-hosts entry name; libssh2 uses `[host]:port` for non-default ports.
fn known_hosts_name(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{}]:{}", host, port)
    }
}

/// Persist a host key the user explicitly accepted. Replaces any previous
/// entry recorded for the same host.
pub fn trust_host_key(host: &str, port: u16, key_type: &str, key_b64: &str) -> Result<()> {
    let key = base64::engine::general_purpose::STANDARD
        .decode(key_b64)
        .context("主机密钥解码失败")?;

    let session = Session::new().context("无法创建 SSH 会话")?;
    let mut known_hosts = session.known_hosts().context("无法初始化 known_hosts")?;
    let path = storage::known_hosts_path();
    if path.exists() {
        known_hosts
            .read_file(&path, KnownHostFileKind::OpenSSH)
            .context("known_hosts 文件解析失败")?;
    }

    let name = known_hosts_name(host, port);
    let stale: Vec<_> = known_hosts
        .hosts()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| entry.name() == Some(name.as_str()))
        .collect();
    for entry in stale {
        known_hosts.remove(&entry).ok();
    }

    known_hosts
        .add(&name, &key, "rustshell", key_format_for(key_type))
        .context("写入主机密钥失败")?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    known_hosts
        .write_file(&path, KnownHostFileKind::OpenSSH)
        .context("保存 known_hosts 失败")?;
    Ok(())
}

struct PasswordResponder<'a> {
    password: &'a str,
}

impl KeyboardInteractivePrompt for PasswordResponder<'_> {
    fn prompt<'a>(
        &mut self,
        _username: &str,
        _instructions: &str,
        prompts: &[Prompt<'a>],
    ) -> Vec<String> {
        prompts.iter().map(|_| self.password.to_owned()).collect()
    }
}

fn authenticate(
    session: &Session,
    profile: &SessionProfile,
    password: Option<&str>,
) -> Result<(), ConnectFailure> {
    let password = password.filter(|value| !value.is_empty());

    match &profile.auth {
        AuthProfile::Password => {
            let password = password.ok_or(ConnectFailure::PasswordRequired)?;
            authenticate_password(session, &profile.username, password)?;
        }
        AuthProfile::KeyFile { path } => {
            let key_path = Path::new(path);
            if !key_path.exists() {
                return Err(ConnectFailure::Other(anyhow!("密钥文件不存在: {}", path)));
            }
            if password.is_none() && private_key_appears_encrypted(key_path) {
                return Err(ConnectFailure::PasswordRequired);
            }
            let public_key_path = public_key_path_for(key_path);
            let result = session.userauth_pubkey_file(
                &profile.username,
                public_key_path.as_deref(),
                key_path,
                password,
            );
            if let Err(error) = result {
                let detail = error.to_string();
                if password.is_none() && looks_like_passphrase_required(&detail) {
                    return Err(ConnectFailure::PasswordRequired);
                }
                if password.is_some() && looks_like_passphrase_required(&detail) {
                    return Err(ConnectFailure::AuthRejected(format!(
                        "密钥口令不正确，需要重新输入密码: {}",
                        detail
                    )));
                }
                return Err(ConnectFailure::AuthRejected(format!(
                    "密钥认证失败，请确认密钥文件与服务器 authorized_keys: {}",
                    detail
                )));
            }
        }
        AuthProfile::Agent => {
            let agent_result = session.userauth_agent(&profile.username);
            if agent_result.is_err() || !session.authenticated() {
                match password {
                    Some(password) => authenticate_password(session, &profile.username, password)?,
                    None => return Err(ConnectFailure::PasswordRequired),
                }
            }
        }
    }

    if !session.authenticated() {
        return Err(ConnectFailure::AuthRejected("服务器拒绝认证".to_owned()));
    }
    Ok(())
}

fn secret_required_before_connect(profile: &SessionProfile, password: Option<&str>) -> bool {
    if password.is_some_and(|value| !value.is_empty()) {
        return false;
    }
    match &profile.auth {
        AuthProfile::Password => true,
        AuthProfile::KeyFile { path } => private_key_appears_encrypted(Path::new(path)),
        // Agent can succeed with no typed secret; only fall back after it fails.
        AuthProfile::Agent => false,
    }
}

fn private_key_appears_encrypted(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    private_key_bytes_encrypted(&bytes)
}

/// OpenSSH new-format keys keep the cipher name inside the base64 payload, so a
/// text search for "aes256-ctr" or "encrypted" misses them and also
/// false-positives on comments. Parse the header instead.
fn private_key_bytes_encrypted(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let lower = text.to_ascii_lowercase();
    if lower.contains("-----begin encrypted private key-----")
        || lower.contains("proc-type: 4,encrypted")
    {
        return true;
    }
    if lower.contains("putty-user-key-file") {
        return putty_key_encrypted(text);
    }
    if lower.contains("-----begin openssh private key-----") {
        return openssh_private_key_encrypted(text);
    }
    false
}

fn putty_key_encrypted(text: &str) -> bool {
    for line in text.lines() {
        let lower = line.trim().to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("encryption:") {
            return value.trim() != "none";
        }
    }
    false
}

fn openssh_private_key_encrypted(text: &str) -> bool {
    let Some(body) = openssh_armored_body(text) else {
        return false;
    };
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(body.as_bytes()) else {
        return false;
    };
    const MAGIC: &[u8] = b"openssh-key-v1\0";
    if !decoded.starts_with(MAGIC) {
        return false;
    }
    let mut rest = &decoded[MAGIC.len()..];
    match read_ssh_string(&mut rest) {
        Some(cipher) => cipher != b"none",
        None => false,
    }
}

fn openssh_armored_body(text: &str) -> Option<String> {
    let mut collecting = false;
    let mut body = String::new();
    for line in text.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if lower.contains("-----begin openssh private key-----") {
            collecting = true;
            continue;
        }
        if lower.starts_with("-----end ") {
            break;
        }
        if collecting && !line.is_empty() {
            body.push_str(line);
        }
    }
    if body.is_empty() {
        None
    } else {
        Some(body)
    }
}

fn read_ssh_string<'a>(data: &mut &'a [u8]) -> Option<&'a [u8]> {
    if data.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes(data[..4].try_into().ok()?) as usize;
    *data = &data[4..];
    if data.len() < len {
        return None;
    }
    let (head, tail) = data.split_at(len);
    *data = tail;
    Some(head)
}


fn looks_like_passphrase_required(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "passphrase",
        "password protected",
        "bad decrypt",
        "wrong passphrase",
        "incorrect passphrase",
        "key is encrypted",
        "encrypted key",
        "unable to decrypt",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn public_key_path_for(private_key_path: &Path) -> Option<std::path::PathBuf> {
    let mut public_key = private_key_path.as_os_str().to_os_string();
    public_key.push(".pub");
    let public_key_path = std::path::PathBuf::from(public_key);
    public_key_path.exists().then_some(public_key_path)
}

fn authenticate_password(
    session: &Session,
    username: &str,
    password: &str,
) -> Result<(), ConnectFailure> {
    let methods = session
        .auth_methods(username)
        .unwrap_or_default()
        .to_owned();
    let direct = session.userauth_password(username, password);
    if direct.is_err() || !session.authenticated() {
        // Some servers advertise methods inconsistently but still accept
        // keyboard-interactive with the same secret.
        let mut responder = PasswordResponder { password };
        let interactive = session.userauth_keyboard_interactive(username, &mut responder);
        if interactive.is_err() || !session.authenticated() {
            let direct_error = direct
                .err()
                .map(|e| e.to_string())
                .or_else(|| interactive.err().map(|e| e.to_string()))
                .unwrap_or_else(|| "服务器未完成密码认证".to_owned());
            let detail = if methods.is_empty() {
                direct_error
            } else {
                format!("{} (server methods: {})", direct_error, methods)
            };
            return Err(ConnectFailure::AuthRejected(detail));
        }
    }
    Ok(())
}

#[cfg(test)]
mod private_key_detection {
    use super::private_key_bytes_encrypted;
    use base64::Engine;

    fn openssh_key(cipher: &str) -> Vec<u8> {
        fn push_string(buf: &mut Vec<u8>, value: &[u8]) {
            buf.extend_from_slice(&(value.len() as u32).to_be_bytes());
            buf.extend_from_slice(value);
        }
        let mut raw = b"openssh-key-v1\0".to_vec();
        push_string(&mut raw, cipher.as_bytes());
        push_string(&mut raw, b"none");
        push_string(&mut raw, b"");
        raw.extend_from_slice(&0u32.to_be_bytes());
        let body = base64::engine::general_purpose::STANDARD.encode(raw);
        format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{body}\n-----END OPENSSH PRIVATE KEY-----\n"
        )
        .into_bytes()
    }

    #[test]
    fn detects_encrypted_openssh_and_pem_keys() {
        assert!(private_key_bytes_encrypted(&openssh_key("aes256-ctr")));
        assert!(!private_key_bytes_encrypted(&openssh_key("none")));
        assert!(private_key_bytes_encrypted(
            b"-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n-----END RSA PRIVATE KEY-----\n"
        ));
        assert!(private_key_bytes_encrypted(
            b"-----BEGIN ENCRYPTED PRIVATE KEY-----\n-----END ENCRYPTED PRIVATE KEY-----\n"
        ));
        assert!(!private_key_bytes_encrypted(
            b"-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"
        ));
        assert!(private_key_bytes_encrypted(
            b"PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\n"
        ));
        assert!(!private_key_bytes_encrypted(
            b"PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n"
        ));
    }
}
