import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export type Protocol =
  | "SSH"
  | "Ssh"
  | "ssh"
  | "Local"
  | "local"
  | "LocalShell"
  | "localshell"
  | "localShell"
  | "SFTP"
  | "SftpOnly"
  | "sftp"
  | "sftpOnly"
  | "Serial"
  | "serial"
  | (string & {});
export type TerminalStatus = "disconnected" | "connecting" | "connected" | "failed";
export type TransferDirection = "upload" | "download";
export type TransferConflictStrategy = "overwrite" | "skip" | "rename" | "resume";

export type AuthProfile = "Password" | "Agent" | { KeyFile: { path: string } };

export type Profile = {
  id: string;
  name: string;
  group: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  charset: string;
  auth: AuthProfile;
  color: [number, number, number];
  tags: string[];
  lastConnectedAt?: string | null;
  createdAt: string;
  rememberPassword: boolean;
  password?: string | null;
};

export type HostKeyIssue = {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  keyB64: string;
  changed: boolean;
};

export type TerminalView = {
  id: string;
  profileId: string;
  title: string;
  status: TerminalStatus;
  statusLabel: string;
  endpoint: string;
  text: string;
  cols: number;
  rows: number;
  lastError?: string | null;
  hostKeyIssue?: HostKeyIssue | null;
  currentDirectory?: string | null;
};

export type TerminalDrain = {
  id: string;
  status: TerminalStatus;
  statusLabel: string;
  output: string;
  lastError?: string | null;
  hostKeyIssue?: HostKeyIssue | null;
  currentDirectory?: string | null;
};

export type ServerStatus = {
  hostname: string;
  os: string;
  uptime: string;
  loadAverage: string;
  cpu: string;
  memory: string;
  disk: string;
};

export type FileEntry = {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  isDir: boolean;
  fileType: "file" | "directory" | "symlink" | string;
  linkTarget?: string | null;
  permissions?: number | null;
  uid?: number | null;
  gid?: number | null;
};

export type AppSettings = {
  theme: "deep" | "graphite" | "light";
  fontSize: number;
  copyOnSelect: boolean;
  scrollback: number;
  localShell: string;
  confirmOnExit: boolean;
};

export type QuickConnectRequest = {
  protocol: Protocol;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string | null;
  rememberPassword: boolean;
};

export type TransferView = {
  id: string;
  profileId: string;
  direction: TransferDirection;
  conflictStrategy: TransferConflictStrategy;
  source: string;
  target: string;
  status: "running" | "done" | "failed" | "cancelled";
  transferred: number;
  total: number;
  speedBps: number;
  etaSeconds?: number | null;
  attempts: number;
  message?: string | null;
  finishedAt?: string | null;
};

export type TextFile = {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  isBinary: boolean;
};

export type RemotePathStats = {
  totalSize: number;
  fileCount: number;
  dirCount: number;
};

export function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export const api = {
  openFileManagerWindow: async (profileId?: string | null) => {
    const label = "file-manager";
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.close().catch(() => undefined);
      await wait(160);
    }

    // 使用 file-manager.html(自带启动诊断面板),渲染报错会显示在窗口里而不是白屏
    const url = profileId ? `file-manager.html?profileId=${encodeURIComponent(profileId)}` : "file-manager.html";
    const fileWindow = new WebviewWindow(label, {
      url,
      title: "RustShell 文件管理器",
      width: 1180,
      height: 760,
      minWidth: 860,
      minHeight: 560,
      center: true,
      focus: true,
      visible: true,
      resizable: true,
      decorations: false,
      transparent: false
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (handler: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        handler();
      };
      const timeout = window.setTimeout(() => settle(resolve), 3000);

      void fileWindow.once("tauri://created", () => {
        settle(() => {
          void fileWindow.show();
          void fileWindow.setFocus();
          resolve();
        });
      });
      void fileWindow.once("tauri://error", (event) => {
        settle(() => reject(event.payload || "文件管理器窗口创建失败"));
      });
    });
  },
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  saveProfile: (profile: Profile) => {
    const { password, ...savedProfile } = profile;
    return invoke<Profile[]>("save_profile", { request: { profile: savedProfile, password: password || null } });
  },
  exportProfiles: () => invoke<string>("export_profiles"),
  importProfiles: (payload: string, replace = false) =>
    invoke<Profile[]>("import_profiles", { request: { payload, replace } }),
  duplicateProfile: (profileId: string) =>
    invoke<Profile[]>("duplicate_profile", { request: { profileId } }),
  deleteProfile: (profileId: string) =>
    invoke<Profile[]>("delete_profile", { request: { profileId } }),
  connectLocalShell: () => invoke<TerminalView>("connect_local_shell"),
  connectProfile: (profileId: string, password?: string | null) =>
    invoke<TerminalView>("connect_profile", { profileId, password: password || null }),
  connectQuick: (request: QuickConnectRequest) => invoke<TerminalView>("connect_quick", { request }),
  listTerminals: () => invoke<TerminalView[]>("list_terminals"),
  terminalSnapshot: (terminalId: string) => invoke<TerminalView>("terminal_snapshot", { terminalId }),
  terminalDrain: (terminalId: string) => invoke<TerminalDrain>("terminal_drain", { terminalId }),
  duplicateTerminal: (terminalId: string) => invoke<TerminalView>("duplicate_terminal", { terminalId }),
  terminalSend: (terminalId: string, data: string) =>
    invoke<void>("terminal_send", { request: { terminalId, data } }),
  terminalResize: (terminalId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { request: { terminalId, cols, rows } }),
  closeTerminal: (terminalId: string) => invoke<void>("close_terminal", { terminalId }),
  loadSettings: () => invoke<AppSettings>("load_settings"),
  saveSettings: (settings: AppSettings) => invoke<AppSettings>("save_settings", { settings }),
  trustHostKey: (issue: HostKeyIssue) =>
    invoke<void>("trust_host_key", {
      request: {
        host: issue.host,
        port: issue.port,
        keyType: issue.keyType,
        keyB64: issue.keyB64
      }
    }),
  loadKnownHosts: () => invoke<string>("load_known_hosts"),
  saveKnownHosts: (content: string) => invoke<void>("save_known_hosts", { request: { content } }),
  clearKnownHosts: () => invoke<void>("clear_known_hosts"),
  localHome: () => invoke<string>("local_home"),
  localParent: (path: string) => invoke<string | null>("local_parent", { path }),
  openLocalPath: (path: string, reveal = true) =>
    invoke<void>("open_local_path", { request: { path, reveal } }),
  listLocalDir: (path: string) => invoke<FileEntry[]>("list_local_dir", { path }),
  searchLocal: (root: string, query: string, maxResults = 300) =>
    invoke<FileEntry[]>("search_local", { request: { root, query, maxResults } }),
  createLocalDir: (parent: string, name: string) =>
    invoke<void>("create_local_dir", { request: { parent, name } }),
  createLocalFile: (parent: string, name: string) =>
    invoke<string>("create_local_file", { request: { parent, name } }),
  createLocalSymlink: (parent: string, name: string, target: string) =>
    invoke<string>("create_local_symlink", { request: { parent, name, target } }),
  removeLocalPath: (path: string, isDir: boolean) =>
    invoke<void>("remove_local_path", { request: { path, isDir } }),
  duplicateLocalPath: (path: string, newName: string) =>
    invoke<string>("duplicate_local_path", { request: { path, newName } }),
  moveLocalPath: (path: string, targetPath: string) =>
    invoke<string>("move_local_path", { request: { path, targetPath } }),
  touchLocalPath: (path: string, mtime: number, recursive: boolean) =>
    invoke<void>("touch_local_path", { request: { path, mtime, recursive } }),
  chmodLocalPath: (path: string, mode: number, recursive: boolean) =>
    invoke<void>("chmod_local_path", { request: { path, mode, recursive } }),
  localPathStats: (path: string) =>
    invoke<RemotePathStats>("local_path_stats", { request: { path } }),
  readLocalFile: (path: string) =>
    invoke<TextFile>("read_local_file", { request: { path } }),
  readLocalFileTail: (path: string) =>
    invoke<TextFile>("read_local_file_tail", { request: { path } }),
  writeLocalFile: (path: string, content: string) =>
    invoke<void>("write_local_file", { request: { path, content } }),
  localFileSha256: (path: string) =>
    invoke<string>("local_file_sha256", { request: { path } }),
  renameLocalPath: (path: string, newName: string) =>
    invoke<void>("rename_local_path", { request: { path, newName } }),
  listRemoteDir: (profileId: string, path: string, password?: string | null) =>
    invoke<FileEntry[]>("list_remote_dir", { request: { profileId, path, password: password || null } }),
  remoteHome: (profileId: string, password?: string | null) =>
    invoke<string>("remote_home", { request: { profileId, password: password || null } }),
  serverStatus: (profileId: string, password?: string | null) =>
    invoke<ServerStatus>("server_status", { request: { profileId, password: password || null } }),
  disconnectSftpSession: (profileId: string) =>
    invoke<void>("disconnect_sftp_session", { request: { profileId } }),
  searchRemote: (profileId: string, root: string, query: string, maxResults = 200, password?: string | null) =>
    invoke<FileEntry[]>("search_remote", {
      request: { profileId, root, query, maxResults, password: password || null }
    }),
  createRemoteDir: (profileId: string, parent: string, name: string, password?: string | null) =>
    invoke<void>("create_remote_dir", { request: { profileId, parent, name, password: password || null } }),
  removeRemotePath: (
    profileId: string,
    path: string,
    isDir: boolean,
    recursive: boolean,
    password?: string | null
  ) =>
    invoke<void>("remove_remote_path", {
      request: { profileId, path, isDir, recursive, password: password || null }
    }),
  renameRemotePath: (profileId: string, path: string, newName: string, password?: string | null) =>
    invoke<string>("rename_remote_path", { request: { profileId, path, newName, password: password || null } }),
  duplicateRemotePath: (
    profileId: string,
    path: string,
    isDir: boolean,
    newName: string,
    password?: string | null
  ) =>
    invoke<string>("duplicate_remote_path", {
      request: { profileId, path, isDir, newName, password: password || null }
    }),
  moveRemotePath: (profileId: string, path: string, targetPath: string, password?: string | null) =>
    invoke<string>("move_remote_path", {
      request: { profileId, path, targetPath, password: password || null }
    }),
  chmodRemotePath: (
    profileId: string,
    path: string,
    mode: number,
    recursive: boolean,
    password?: string | null
  ) =>
    invoke<void>("chmod_remote_path", {
      request: { profileId, path, mode, recursive, password: password || null }
    }),
  chownRemotePath: (
    profileId: string,
    path: string,
    uid: number | null,
    gid: number | null,
    recursive: boolean,
    password?: string | null
  ) =>
    invoke<void>("chown_remote_path", {
      request: { profileId, path, uid, gid, recursive, password: password || null }
    }),
  touchRemotePath: (
    profileId: string,
    path: string,
    mtime: number,
    recursive: boolean,
    password?: string | null
  ) =>
    invoke<void>("touch_remote_path", {
      request: { profileId, path, mtime, recursive, password: password || null }
    }),
  remotePathStats: (profileId: string, path: string, password?: string | null) =>
    invoke<RemotePathStats>("remote_path_stats", {
      request: { profileId, path, password: password || null }
    }),
  createRemoteFile: (profileId: string, parent: string, name: string, password?: string | null) =>
    invoke<string>("create_remote_file", { request: { profileId, parent, name, password: password || null } }),
  createRemoteSymlink: (
    profileId: string,
    parent: string,
    name: string,
    target: string,
    password?: string | null
  ) =>
    invoke<string>("create_remote_symlink", {
      request: { profileId, parent, name, target, password: password || null }
    }),
  readRemoteFile: (profileId: string, path: string, password?: string | null) =>
    invoke<TextFile>("read_remote_file", { request: { profileId, path, password: password || null } }),
  readRemoteFileTail: (profileId: string, path: string, password?: string | null) =>
    invoke<TextFile>("read_remote_file_tail", { request: { profileId, path, password: password || null } }),
  writeRemoteFile: (profileId: string, path: string, content: string, password?: string | null) =>
    invoke<void>("write_remote_file", { request: { profileId, path, content, password: password || null } }),
  remoteFileSha256: (profileId: string, path: string, password?: string | null) =>
    invoke<string>("remote_file_sha256", { request: { profileId, path, password: password || null } }),
  startTransfer: (
    profileId: string,
    direction: TransferDirection,
    localPath: string,
    remotePath: string,
    conflictStrategy: TransferConflictStrategy,
    password?: string | null
  ) =>
    invoke<TransferView>("start_transfer", {
      request: { profileId, direction, localPath, remotePath, conflictStrategy, password: password || null }
    }),
  listTransfers: () => invoke<TransferView[]>("list_transfers"),
  listTransferHistory: () => invoke<TransferView[]>("list_transfer_history"),
  cancelTransfer: (transferId: string) => invoke<void>("cancel_transfer", { transferId }),
  retryTransfer: (transferId: string) => invoke<TransferView>("retry_transfer", { transferId }),
  clearFinishedTransfers: () => invoke<TransferView[]>("clear_finished_transfers"),
  clearTransferHistory: () => invoke<TransferView[]>("clear_transfer_history"),
  removeTransfer: (transferId: string) => invoke<TransferView[]>("remove_transfer", { transferId })
};
