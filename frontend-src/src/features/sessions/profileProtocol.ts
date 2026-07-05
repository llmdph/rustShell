import type { Profile, Protocol } from "@/api";
import { normalizeAuthProfile } from "@/features/sessions/profileAuth";

export function profileWithProtocol(profile: Profile, nextProtocol: Protocol): Profile {
  const protocol = normalizeSavedProtocol(nextProtocol);
  if (isLocalProtocol(protocol)) {
    return {
      ...profile,
      protocol,
      port: 0,
      auth: "Agent",
      password: "",
      rememberPassword: false
    };
  }

  return {
    ...profile,
    protocol,
    port: Number(profile.port || 22),
    username: profile.username || "root",
    auth: isLocalProtocol(profile.protocol) ? "Password" : normalizeAuthProfile(profile.auth),
    password: profile.password ?? ""
  };
}

export function normalizeSavedProtocol(protocol?: Protocol | string | null, profile?: Partial<Profile> | null): Protocol {
  const value = String(protocol ?? "").trim().toLowerCase().replace(/[-_\s]/g, "");
  if (value === "ssh") return "Ssh";
  if (value === "sftp" || value === "sftponly") return "SftpOnly";
  if (value === "local" || value === "localshell" || value === "shell") return "LocalShell";
  if (value === "serial") return "Serial";

  if (profile && (profile.host || profile.username || Number(profile.port || 0) > 0)) {
    return "Ssh";
  }

  return "Ssh";
}

export function isLocalProtocol(protocol?: Protocol | string | null) {
  const normalized = normalizeSavedProtocol(protocol);
  return normalized === "LocalShell";
}

export function isSshProtocol(protocol?: Protocol | string | null) {
  const normalized = normalizeSavedProtocol(protocol);
  return normalized === "Ssh";
}

export function isRemoteProtocol(protocol?: Protocol | string | null) {
  const normalized = normalizeSavedProtocol(protocol);
  return normalized === "Ssh" || normalized === "SftpOnly";
}

export function normalizeProtocolLabel(protocol?: Protocol | string | null) {
  if (!protocol) return "-";
  const normalized = normalizeSavedProtocol(protocol);
  if (normalized === "Ssh") return "SSH";
  if (normalized === "SftpOnly") return "SFTP";
  if (normalized === "LocalShell") return "Local";
  return normalized;
}
