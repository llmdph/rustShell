import type { Profile, Protocol } from "@/api";
import { normalizeAuthProfile, profileAuthKind } from "@/features/sessions/profileAuth";
import { isLocalProtocol, normalizeSavedProtocol } from "@/features/sessions/profileProtocol";

export function createBlankProfile(): Profile {
  return {
    id: crypto.randomUUID(),
    name: "新建 SSH 会话",
    group: "我的会话",
    protocol: "Ssh",
    host: "",
    port: 22,
    username: "root",
    charset: "UTF-8",
    auth: "Password",
    color: [47, 211, 166],
    tags: [],
    lastConnectedAt: null,
    createdAt: new Date().toISOString(),
    rememberPassword: false,
    password: ""
  };
}

export function normalizeProfiles(profiles: Profile[]) {
  return profiles.map(normalizeProfile);
}

export function normalizeProfile(profile: Profile): Profile {
  const protocol = normalizeSavedProtocol(profile.protocol, profile);
  const isLocal = isLocalProtocol(protocol);
  return {
    ...profile,
    protocol,
    group: profile.group || "我的会话",
    port: Number(profile.port || (isLocal ? 0 : 22)),
    username: profile.username || (isLocal ? "" : "root"),
    charset: profile.charset || "UTF-8",
    auth: isLocal ? "Agent" : normalizeAuthProfile(profile.auth),
    color: profile.color ?? [47, 211, 166],
    tags: profile.tags ?? [],
    lastConnectedAt: profile.lastConnectedAt ?? null,
    rememberPassword: Boolean(profile.rememberPassword),
    password: profile.password ?? ""
  };
}

export function normalizeQuickProtocol(protocol: Protocol): Protocol {
  protocol = normalizeSavedProtocol(protocol);
  if (protocol === "Ssh") return "SSH";
  if (protocol === "SftpOnly") return "SFTP";
  return protocol;
}

export function shouldPromptForPassword(profile: Profile, message: string) {
  if (isLocalProtocol(profile.protocol)) return false;
  const normalized = message.toLowerCase();
  const authKind = profileAuthKind(profile.auth);

  // Key-file sessions only prompt when the backend explicitly needs a passphrase.
  // Generic publickey rejects must not reopen the secret dialog.
  if (authKind === "KeyFile") {
    return (
      message.includes("需要输入密钥口令") ||
      message.includes("需要输入密码") ||
      message.includes("密钥口令不正确") ||
      normalized.includes("passphrase") ||
      (normalized.includes("encrypted") && normalized.includes("key"))
    );
  }

  return (
    message.includes("需要输入密码") ||
    message.includes("认证失败") ||
    message.includes("拒绝认证") ||
    message.includes("密码") ||
    normalized.includes("authentication") ||
    normalized.includes("auth") ||
    normalized.includes("permission denied") ||
    normalized.includes("password")
  );
}

export function isPublicKeyPath(path: string) {
  return path.trim().toLowerCase().endsWith(".pub");
}
