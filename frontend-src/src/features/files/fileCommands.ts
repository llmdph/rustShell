import type { FileEntry, Profile } from "@/api";

import { normalizeAuthProfile } from "../sessions/profileAuth";
import { normalizeSavedProtocol } from "../sessions/profileProtocol";
import { pathBaseName } from "./pathUtils";
import { formatMode } from "./permissions";

export function remoteSftpUri(profile: Profile, path: string) {
  const user = encodeURIComponent(profile.username || "user");
  const host = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
  const port = profile.port || 22;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const encodedPath = normalizedPath
    .split("/")
    .map((part, index) => (index === 0 ? "" : encodeURIComponent(part)))
    .join("/");
  return `sftp://${user}@${host}:${port}${encodedPath}`;
}

export function connectionCommand(profile: Profile) {
  const isSftp = normalizeSavedProtocol(profile.protocol) === "SftpOnly";
  const args = [isSftp ? "sftp" : "ssh"];
  const port = Number(profile.port || 22);
  if (port !== 22) args.push(isSftp ? "-P" : "-p", String(port));
  args.push(...keyFileArgs(profile));
  args.push(scpRemotePrefix(profile));
  return args.join(" ");
}

export function scpUploadCommand(profile: Profile, entry: FileEntry, remoteDir: string) {
  return scpCommand(profile, entry.isDir, shellQuote(entry.path), `${scpRemotePrefix(profile)}:${shellQuote(remoteDir || ".")}`);
}

export function scpDownloadCommand(profile: Profile, entry: FileEntry, localDir: string) {
  return scpCommand(profile, entry.isDir, `${scpRemotePrefix(profile)}:${shellQuote(entry.path)}`, shellQuote(localDir || "."));
}

export function rsyncUploadCommand(profile: Profile, entry: FileEntry, remoteDir: string, dryRun = false) {
  return rsyncCommand(profile, shellQuote(entry.path), shellQuote(`${scpRemotePrefix(profile)}:${remoteDir || "."}`), dryRun);
}

export function rsyncDownloadCommand(profile: Profile, entry: FileEntry, localDir: string, dryRun = false) {
  return rsyncCommand(profile, shellQuote(`${scpRemotePrefix(profile)}:${entry.path}`), shellQuote(localDir || "."), dryRun);
}

export function localChmodCommand(entry: FileEntry) {
  return `chmod ${formatMode(entry.permissions)} ${shellQuote(entry.path)}`;
}

export function remoteChmodCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `chmod ${formatMode(entry.permissions)} ${shellQuote(entry.path)}`);
}

export function remoteChownCommand(profile: Profile, entry: FileEntry) {
  const owner = `${entry.uid ?? ""}:${entry.gid ?? ""}`;
  return sshRemoteCommand(profile, `chown ${owner} ${shellQuote(entry.path)}`);
}

export function localTouchCommand(entry: FileEntry) {
  return `touch -m -t ${touchTimestamp(entry.modifiedAt)} ${shellQuote(entry.path)}`;
}

export function remoteTouchCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `touch -m -t ${touchTimestamp(entry.modifiedAt)} ${shellQuote(entry.path)}`);
}

export function remoteSymlinkCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `ln -s -- ${shellQuote(entry.linkTarget ?? "")} ${shellQuote(entry.path)}`);
}

export function remoteDeleteCommand(profile: Profile, entry: FileEntry) {
  const recursive = entry.isDir && entry.fileType !== "symlink";
  return sshRemoteCommand(profile, `rm ${recursive ? "-r " : ""}-- ${shellQuote(entry.path)}`);
}

export function remoteStatCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `stat -- ${shellQuote(entry.path)}`);
}

export function remoteSha256Command(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `sha256sum -- ${shellQuote(entry.path)}`);
}

export function remoteDuCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `du -sh -- ${shellQuote(entry.path)}`);
}

export function remoteListCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `ls -ld -- ${shellQuote(entry.path)}`);
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function localCdCommand(path: string, shellCommand = "") {
  if (isPowerShellCommand(shellCommand)) {
    return `Set-Location -LiteralPath ${powershellQuote(path)}\r`;
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    return `cd /d ${cmdQuote(path)}\r`;
  }
  return `cd -- ${shellQuote(path)}\r`;
}

function rsyncCommand(profile: Profile, source: string, target: string, dryRun = false) {
  const args = ["rsync", "-a", "--partial", "--progress", "-e", shellQuote(sshTransportCommand(profile)), source, target];
  if (dryRun) args.splice(1, 0, "--dry-run", "--itemize-changes");
  return args.join(" ");
}

function sshRemoteCommand(profile: Profile, command: string) {
  return `${sshTransportCommand(profile)} -- ${scpRemotePrefix(profile)} ${command}`;
}

function sshTransportCommand(profile: Profile) {
  const args = ["ssh"];
  if ((profile.port || 22) !== 22) args.push("-p", String(profile.port || 22));
  args.push(...keyFileArgs(profile));
  return args.join(" ");
}

function scpCommand(profile: Profile, recursive: boolean, source: string, target: string) {
  const args = ["scp"];
  if ((profile.port || 22) !== 22) args.push("-P", String(profile.port || 22));
  args.push(...keyFileArgs(profile));
  if (recursive) args.push("-r");
  args.push(source, target);
  return args.join(" ");
}

function keyFileArgs(profile: Profile) {
  const auth = normalizeAuthProfile(profile.auth);
  if (typeof auth === "object" && "KeyFile" in auth && auth.KeyFile.path.trim()) {
    return ["-i", shellQuote(auth.KeyFile.path.trim())];
  }
  return [];
}

function scpRemotePrefix(profile: Profile) {
  const user = profile.username || "user";
  const host = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
  return `${user}@${host}`;
}

function isPowerShellCommand(shellCommand: string) {
  const command = pathBaseName(firstCommandPart(shellCommand)).toLowerCase();
  return command === "powershell.exe" || command === "powershell" || command === "pwsh.exe" || command === "pwsh";
}

function firstCommandPart(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const quote = trimmed[0] === '"' || trimmed[0] === "'" ? trimmed[0] : "";
  if (quote) {
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

function powershellQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function cmdQuote(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function touchTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}.${pad(
    date.getSeconds()
  )}`;
}
