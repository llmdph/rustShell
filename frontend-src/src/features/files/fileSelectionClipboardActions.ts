import type { FileEntry } from "@/api";
import { downloadTextFile } from "@/lib/browserFiles";
import {
  directoryListingCsvName,
  fileInfoCsv,
  fileInfoCsvName,
  fileInfoTable
} from "@/features/files/fileReports";
import type { FileSide } from "@/features/files/filePaneTypes";
import { parentPathForSide, relativePathForSide } from "@/features/files/pathUtils";

type CopyWithFallback = (options: {
  title: string;
  text: string;
  onCopied?: () => void;
}) => Promise<boolean>;

type PushToast = (tone: "success" | "info" | "error", text: string) => void;

type FileSelectionClipboardActionParams = {
  localPath: string;
  remotePath: string;
  visibleSelectedLocalEntries: FileEntry[];
  visibleSelectedRemoteEntries: FileEntry[];
  localFiles: FileEntry[];
  remoteFiles: FileEntry[];
  copyWithFallback: CopyWithFallback;
  pushToast: PushToast;
};

export function buildFileSelectionClipboardActions({
  localPath,
  remotePath,
  visibleSelectedLocalEntries,
  visibleSelectedRemoteEntries,
  localFiles,
  remoteFiles,
  copyWithFallback,
  pushToast
}: FileSelectionClipboardActionParams) {
  const selectedEntriesFor = (side: FileSide) =>
    side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
  const directoryEntriesFor = (side: FileSide) => (side === "local" ? localFiles : remoteFiles);

  const copySelectedPaths = async (side: FileSide) => {
    const entries = selectedEntriesFor(side);
    if (entries.length === 0) return;
    const text = entries.map((entry) => entry.path).join("\n");
    await copyWithFallback({
      title: "复制路径",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "路径已复制" : `${entries.length} 个路径已复制`)
    });
  };

  const copySelectedNames = async (side: FileSide) => {
    const entries = selectedEntriesFor(side);
    if (entries.length === 0) return;
    const text = entries.map((entry) => entry.name).join("\n");
    await copyWithFallback({
      title: "复制名称",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "名称已复制" : `${entries.length} 个名称已复制`)
    });
  };

  const copySelectedParentPaths = async (side: FileSide) => {
    const entries = selectedEntriesFor(side);
    if (entries.length === 0) return;
    const text = entries.map((entry) => parentPathForSide(side, entry.path)).join("\n");
    await copyWithFallback({
      title: "复制父目录路径",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "父目录路径已复制" : `${entries.length} 个父目录路径已复制`)
    });
  };

  const copySelectedRelativePaths = async (side: FileSide) => {
    const entries = selectedEntriesFor(side);
    if (entries.length === 0) return;
    const base = side === "local" ? localPath : remotePath;
    const text = entries.map((entry) => relativePathForSide(side, base, entry.path)).join("\n");
    await copyWithFallback({
      title: "复制相对路径",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "相对路径已复制" : `${entries.length} 个相对路径已复制`)
    });
  };

  const copySelectedFileInfo = async (side: FileSide) => {
    const entries = selectedEntriesFor(side);
    if (entries.length === 0) return;
    const text = fileInfoTable(entries);
    await copyWithFallback({
      title: "复制文件信息",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "文件信息已复制" : `${entries.length} 个文件信息已复制`)
    });
  };

  const copySelectedFileInfoCsv = async (side: FileSide) => {
    const entries = selectedEntriesFor(side);
    if (entries.length === 0) return;
    const text = fileInfoCsv(entries);
    await copyWithFallback({
      title: "复制 CSV 文件信息",
      text,
      onCopied: () => pushToast("success", entries.length === 1 ? "CSV 文件信息已复制" : `${entries.length} 个 CSV 文件信息已复制`)
    });
  };

  const downloadSelectedFileInfoCsv = (side: FileSide) => {
    const entries = selectedEntriesFor(side);
    if (entries.length === 0) return;
    downloadTextFile(fileInfoCsvName(side), fileInfoCsv(entries), "text/csv;charset=utf-8");
    pushToast("success", entries.length === 1 ? "CSV 清单已下载" : `${entries.length} 个项目的 CSV 清单已下载`);
  };

  const copyCurrentDirectoryFileInfoCsv = async (side: FileSide) => {
    const entries = directoryEntriesFor(side);
    if (entries.length === 0) return;
    const text = fileInfoCsv(entries);
    await copyWithFallback({
      title: "复制当前目录 CSV 清单",
      text,
      onCopied: () => pushToast("success", `${side === "local" ? "本地" : "远程"}当前目录 CSV 已复制 ${entries.length} 条`)
    });
  };

  const downloadCurrentDirectoryFileInfoCsv = (side: FileSide) => {
    const entries = directoryEntriesFor(side);
    if (entries.length === 0) return;
    downloadTextFile(directoryListingCsvName(side), fileInfoCsv(entries), "text/csv;charset=utf-8");
    pushToast("success", `${side === "local" ? "本地" : "远程"}当前目录 CSV 已下载 ${entries.length} 条`);
  };

  const copySelectedLinkTargets = async (side: FileSide) => {
    const entries = selectedEntriesFor(side);
    const targets = entries.map((entry) => entry.linkTarget?.trim()).filter(Boolean) as string[];
    if (targets.length === 0) {
      pushToast("info", "所选项目没有链接目标");
      return;
    }
    const text = targets.join("\n");
    await copyWithFallback({
      title: "复制链接目标",
      text,
      onCopied: () => pushToast("success", targets.length === 1 ? "链接目标已复制" : `${targets.length} 个链接目标已复制`)
    });
  };

  return {
    copySelectedPaths,
    copySelectedNames,
    copySelectedParentPaths,
    copySelectedRelativePaths,
    copySelectedFileInfo,
    copySelectedFileInfoCsv,
    downloadSelectedFileInfoCsv,
    copyCurrentDirectoryFileInfoCsv,
    downloadCurrentDirectoryFileInfoCsv,
    copySelectedLinkTargets
  };
}
