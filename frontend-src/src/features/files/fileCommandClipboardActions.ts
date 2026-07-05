import type { FileEntry, Profile } from "@/api";
import {
  connectionCommand,
  localChmodCommand,
  localTouchCommand,
  remoteChmodCommand,
  remoteChownCommand,
  remoteDeleteCommand,
  remoteDuCommand,
  remoteListCommand,
  remoteSha256Command,
  remoteSftpUri,
  remoteStatCommand,
  remoteSymlinkCommand,
  remoteTouchCommand,
  rsyncDownloadCommand,
  rsyncUploadCommand,
  scpDownloadCommand,
  scpUploadCommand,
  touchTimestamp
} from "@/features/files/fileCommands";
import type { FileSide } from "@/features/files/filePaneTypes";
import { isLocalProtocol } from "@/features/sessions/profileProtocol";

type CopyWithFallback = (options: {
  title: string;
  text: string;
  onCopied?: () => void;
}) => Promise<boolean>;

type PushToast = (tone: "success" | "info" | "error", text: string) => void;

type FileCommandClipboardActionParams = {
  activeProfile: Profile | null;
  localPath: string;
  remotePath: string;
  visibleSelectedLocalEntries: FileEntry[];
  visibleSelectedRemoteEntries: FileEntry[];
  copyWithFallback: CopyWithFallback;
  pushToast: PushToast;
};

export function buildFileCommandClipboardActions({
  activeProfile,
  localPath,
  remotePath,
  visibleSelectedLocalEntries,
  visibleSelectedRemoteEntries,
  copyWithFallback,
  pushToast
}: FileCommandClipboardActionParams) {
  const copyRemoteSymlinkCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = visibleSelectedRemoteEntries.filter((entry) => entry.fileType === "symlink" && entry.linkTarget?.trim());
    if (entries.length === 0) {
      pushToast("info", "所选远程项目没有可复制的符号链接命令");
      return;
    }
    const text = entries.map((entry) => remoteSymlinkCommand(activeProfile, entry)).join("\n");
    await copyWithFallback({
      title: "复制 ln -s 命令",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "ln -s 命令已复制" : `${entries.length} 条 ln -s 命令已复制`)
    });
  };

  const copyRemoteUris = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteSftpUri(activeProfile, entry.path)).join("\n");
    await copyWithFallback({
      title: "复制 SFTP 地址",
      text,
      onCopied: () =>
        pushToast(
          "success",
          visibleSelectedRemoteEntries.length === 1 ? "SFTP 地址已复制" : `${visibleSelectedRemoteEntries.length} 个 SFTP 地址已复制`
        )
    });
  };

  const copyScpCommands = async (direction: "upload" | "download") => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = direction === "upload" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = entries
      .map((entry) =>
        direction === "upload"
          ? scpUploadCommand(activeProfile, entry, remotePath)
          : scpDownloadCommand(activeProfile, entry, localPath || ".")
      )
      .join("\n");
    await copyWithFallback({
      title: "复制 scp 命令",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "scp 命令已复制" : `${entries.length} 条 scp 命令已复制`)
    });
  };

  const copyRsyncCommands = async (direction: "upload" | "download", dryRun = false) => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = direction === "upload" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = entries
      .map((entry) =>
        direction === "upload"
          ? rsyncUploadCommand(activeProfile, entry, remotePath, dryRun)
          : rsyncDownloadCommand(activeProfile, entry, localPath || ".", dryRun)
      )
      .join("\n");
    await copyWithFallback({
      title: dryRun ? "复制 rsync 预演命令" : "复制 rsync 命令",
      text,
      onCopied: () =>
        pushToast(
          "success",
          entries.length === 1
            ? `rsync${dryRun ? " 预演" : ""}命令已复制`
            : `${entries.length} 条 rsync${dryRun ? " 预演" : ""}命令已复制`
        )
    });
  };

  const copyChmodCommands = async (side: FileSide) => {
    const entries = (side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries).filter(
      (entry) => entry.permissions != null && entry.fileType !== "symlink"
    );
    if (entries.length === 0) {
      pushToast("info", "所选项目没有可复制的权限命令");
      return;
    }
    if (side === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return;
    const text = entries
      .map((entry) => (side === "remote" ? remoteChmodCommand(activeProfile!, entry) : localChmodCommand(entry)))
      .join("\n");
    await copyWithFallback({
      title: "复制 chmod 命令",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "chmod 命令已复制" : `${entries.length} 条 chmod 命令已复制`)
    });
  };

  const copyChownCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = visibleSelectedRemoteEntries.filter(
      (entry) => entry.fileType !== "symlink" && (entry.uid != null || entry.gid != null)
    );
    if (entries.length === 0) {
      pushToast("info", "所选远程项目没有可复制的属主命令");
      return;
    }
    const text = entries.map((entry) => remoteChownCommand(activeProfile, entry)).join("\n");
    await copyWithFallback({
      title: "复制 chown 命令",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "chown 命令已复制" : `${entries.length} 条 chown 命令已复制`)
    });
  };

  const copyTouchCommands = async (side: FileSide) => {
    const entries = (side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries).filter(
      (entry) => entry.fileType !== "symlink" && touchTimestamp(entry.modifiedAt)
    );
    if (entries.length === 0) {
      pushToast("info", "所选项目没有可复制的时间命令");
      return;
    }
    if (side === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return;
    const text = entries
      .map((entry) => (side === "remote" ? remoteTouchCommand(activeProfile!, entry) : localTouchCommand(entry)))
      .join("\n");
    await copyWithFallback({
      title: "复制 touch 命令",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "touch 命令已复制" : `${entries.length} 条 touch 命令已复制`)
    });
  };

  const copyRemoteDeleteCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteDeleteCommand(activeProfile, entry)).join("\n");
    await copyWithFallback({
      title: "复制删除命令",
      text,
      onCopied: () =>
        pushToast(
          "success",
          visibleSelectedRemoteEntries.length === 1 ? "删除命令已复制" : `${visibleSelectedRemoteEntries.length} 条删除命令已复制`
        )
    });
  };

  const copyRemoteStatCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteStatCommand(activeProfile, entry)).join("\n");
    await copyWithFallback({
      title: "复制 stat 命令",
      text,
      onCopied: () =>
        pushToast(
          "success",
          visibleSelectedRemoteEntries.length === 1 ? "stat 命令已复制" : `${visibleSelectedRemoteEntries.length} 条 stat 命令已复制`
        )
    });
  };

  const copyRemoteSha256Commands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = visibleSelectedRemoteEntries.filter((entry) => !entry.isDir && entry.fileType !== "symlink");
    if (entries.length === 0) return;
    const text = entries.map((entry) => remoteSha256Command(activeProfile, entry)).join("\n");
    await copyWithFallback({
      title: "复制 sha256sum 命令",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "sha256sum 命令已复制" : `${entries.length} 条 sha256sum 命令已复制`)
    });
  };

  const copyRemoteDuCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteDuCommand(activeProfile, entry)).join("\n");
    await copyWithFallback({
      title: "复制 du 命令",
      text,
      onCopied: () =>
        pushToast(
          "success",
          visibleSelectedRemoteEntries.length === 1 ? "du 命令已复制" : `${visibleSelectedRemoteEntries.length} 条 du 命令已复制`
        )
    });
  };

  const copyRemoteListCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteListCommand(activeProfile, entry)).join("\n");
    await copyWithFallback({
      title: "复制 ls -ld 命令",
      text,
      onCopied: () =>
        pushToast(
          "success",
          visibleSelectedRemoteEntries.length === 1 ? "ls -ld 命令已复制" : `${visibleSelectedRemoteEntries.length} 条 ls -ld 命令已复制`
        )
    });
  };

  const copyConnectionCommand = async (profile: Profile | null) => {
    if (!profile || isLocalProtocol(profile.protocol)) return;
    const text = connectionCommand(profile);
    await copyWithFallback({ title: "复制连接命令", text, onCopied: () => pushToast("success", "连接命令已复制") });
  };

  return {
    copyRemoteSymlinkCommands,
    copyRemoteUris,
    copyScpCommands,
    copyRsyncCommands,
    copyChmodCommands,
    copyChownCommands,
    copyTouchCommands,
    copyRemoteDeleteCommands,
    copyRemoteStatCommands,
    copyRemoteSha256Commands,
    copyRemoteDuCommands,
    copyRemoteListCommands,
    copyConnectionCommand
  };
}
