import type { FileEntry } from "@/api";
import { downloadTextFile } from "@/lib/browserFiles";
import {
  directoryCompareCsv,
  directoryCompareCsvName,
  directoryCompareJson,
  directoryCompareJsonName
} from "@/features/files/fileReports";
import type { DirectoryCompare } from "@/features/files/filePaneTypes";

type CopyWithFallback = (options: {
  title: string;
  text: string;
  onCopied?: () => void;
}) => Promise<boolean>;

type PushToast = (tone: "success" | "info" | "error", text: string) => void;

type DirectoryCompareActionParams = {
  localPath: string;
  remotePath: string;
  baseVisibleLocalFiles: FileEntry[];
  baseVisibleRemoteFiles: FileEntry[];
  directoryCompare: DirectoryCompare;
  directoryCompareCount: number;
  directoryCompareDiffCount: number;
  copyWithFallback: CopyWithFallback;
  pushToast: PushToast;
};

export function buildDirectoryCompareActions({
  localPath,
  remotePath,
  baseVisibleLocalFiles,
  baseVisibleRemoteFiles,
  directoryCompare,
  directoryCompareCount,
  directoryCompareDiffCount,
  copyWithFallback,
  pushToast
}: DirectoryCompareActionParams) {
  const copyDirectoryCompareCsv = async () => {
    if (directoryCompareCount === 0) return;
    const text = directoryCompareCsv(baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare);
    await copyWithFallback({
      title: "复制目录对比 CSV",
      text,
      onCopied: () => pushToast("success", "目录对比 CSV 已复制")
    });
  };

  const downloadDirectoryCompareCsv = () => {
    if (directoryCompareCount === 0) return;
    downloadTextFile(
      directoryCompareCsvName(),
      directoryCompareCsv(baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare),
      "text/csv;charset=utf-8"
    );
    pushToast("success", "目录对比 CSV 已下载");
  };

  const copyDirectoryCompareJson = async () => {
    if (directoryCompareCount === 0) return;
    const text = directoryCompareJson(localPath, remotePath, baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare);
    await copyWithFallback({
      title: "复制目录对比 JSON",
      text,
      onCopied: () => pushToast("success", "目录对比 JSON 已复制")
    });
  };

  const downloadDirectoryCompareJson = () => {
    if (directoryCompareCount === 0) return;
    downloadTextFile(
      directoryCompareJsonName(),
      directoryCompareJson(localPath, remotePath, baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare)
    );
    pushToast("success", "目录对比 JSON 已下载");
  };

  const copyDirectoryCompareDiffCsv = async () => {
    if (directoryCompareDiffCount === 0) return;
    const text = directoryCompareCsv(baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare, { includeSame: false });
    await copyWithFallback({
      title: "复制目录差异 CSV",
      text,
      onCopied: () => pushToast("success", "目录差异 CSV 已复制")
    });
  };

  const downloadDirectoryCompareDiffCsv = () => {
    if (directoryCompareDiffCount === 0) return;
    downloadTextFile(
      directoryCompareCsvName("diff"),
      directoryCompareCsv(baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare, { includeSame: false }),
      "text/csv;charset=utf-8"
    );
    pushToast("success", "目录差异 CSV 已下载");
  };

  return {
    copyDirectoryCompareCsv,
    downloadDirectoryCompareCsv,
    copyDirectoryCompareJson,
    downloadDirectoryCompareJson,
    copyDirectoryCompareDiffCsv,
    downloadDirectoryCompareDiffCsv
  };
}
