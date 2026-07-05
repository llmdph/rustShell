import { api, type Profile, type TransferConflictStrategy, type TransferView } from "@/api";
import type { TransferQueueProps } from "@/features/transfers/TransferQueue";
import {
  transferDetailText,
  transferDownloadResultPath,
  transferUploadResultPath
} from "@/features/transfers/transferUtils";
import { localParentPath, remoteParentPath } from "@/features/files/pathUtils";

type ToastTone = "success" | "error" | "info";
type CopyWithFallback = (options: { title: string; text: string; onCopied?: () => void }) => Promise<boolean>;

type BuildTransferQueuePropsOptions = {
  transfers: TransferView[];
  history: TransferView[];
  conflict: TransferConflictStrategy;
  profiles: Profile[];
  formatSize: (size: number) => string;
  onConflict: (value: TransferConflictStrategy) => void;
  onTransfers: (transfers: TransferView[]) => void;
  onHistory: (history: TransferView[]) => void;
  onSelectedProfile: (profileId: string) => void;
  refreshTransfers: () => Promise<void>;
  pushToast: (tone: ToastTone, text: string) => void;
  copyWithFallback: CopyWithFallback;
  onCopyCsv: () => void;
  onDownloadCsv: () => void;
  navigateLocalPath: (nextPath: string, preferPath?: string) => void;
  navigateRemotePath: (nextPath: string, preferPath?: string) => void;
};

export function buildTransferQueueProps({
  transfers,
  history,
  conflict,
  profiles,
  formatSize,
  onConflict,
  onTransfers,
  onHistory,
  onSelectedProfile,
  refreshTransfers,
  pushToast,
  copyWithFallback,
  onCopyCsv,
  onDownloadCsv,
  navigateLocalPath,
  navigateRemotePath
}: BuildTransferQueuePropsOptions): TransferQueueProps {
  return {
    transfers,
    history,
    conflict,
    formatSize,
    onConflict,
    onCancel: async (id) => {
      await api.cancelTransfer(id).catch(() => undefined);
      await refreshTransfers();
    },
    onRetry: async (id) => {
      await api.retryTransfer(id).catch((error) => pushToast("error", `重试失败: ${String(error)}`));
      await refreshTransfers();
    },
    onRemove: async (id) => {
      await api
        .removeTransfer(id)
        .then(async (next) => {
          onTransfers(next);
          onHistory(await api.listTransferHistory());
        })
        .catch((error) => pushToast("error", `移除失败: ${String(error)}`));
    },
    onClear: async () => {
      const nextTransfers = await api.clearFinishedTransfers();
      const nextHistory = await api.clearTransferHistory();
      onTransfers(nextTransfers);
      onHistory(nextHistory);
      pushToast("success", "已清理完成和历史传输");
    },
    onCancelRunning: async (ids) => {
      if (ids.length === 0) return;
      await Promise.all(ids.map((id) => api.cancelTransfer(id).catch(() => undefined)));
      await refreshTransfers();
      pushToast("success", `已取消 ${ids.length} 个传输`);
    },
    onRetryFailed: async (ids) => {
      if (ids.length === 0) return;
      await Promise.all(ids.map((id) => api.retryTransfer(id).catch((error) => pushToast("error", `重试失败: ${String(error)}`))));
      await refreshTransfers();
    },
    onCopyCsv,
    onDownloadCsv,
    onOpenLocalPath: async (path, reveal) => {
      try {
        await api.openLocalPath(path, reveal);
      } catch (error) {
        pushToast("error", `${reveal ? "打开所在文件夹" : "打开文件"}失败: ${String(error)}`);
      }
    },
    onCopyDetail: async (transfer) => {
      const text = transferDetailText(transfer, profiles);
      await copyWithFallback({ title: "复制传输详情", text, onCopied: () => pushToast("success", "传输详情已复制") });
    },
    onLocate: async (transfer) => {
      try {
        if (transfer.direction === "download") {
          const targetPath = transferDownloadResultPath(transfer);
          navigateLocalPath(localParentPath(targetPath), targetPath);
          return;
        }
        onSelectedProfile(transfer.profileId);
        const targetPath = transferUploadResultPath(transfer);
        navigateRemotePath(remoteParentPath(targetPath), targetPath);
      } catch (error) {
        pushToast("error", `定位失败: ${String(error)}`);
      }
    }
  };
}
