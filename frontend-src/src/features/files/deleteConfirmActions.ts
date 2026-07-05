import { downloadTextFile } from "@/lib/browserFiles";
import type { DeleteConfirmState } from "@/features/dialogs/dialogTypes";
import {
  deleteConfirmCsv,
  deleteConfirmCsvName,
  deleteConfirmJson,
  deleteConfirmJsonName
} from "@/features/files/fileReports";

type CopyWithFallback = (options: {
  title: string;
  text: string;
  onCopied?: () => void;
}) => Promise<boolean>;

type PushToast = (tone: "success" | "info" | "error", text: string) => void;

type DeleteConfirmActionParams = {
  deleteConfirm: DeleteConfirmState | null;
  copyWithFallback: CopyWithFallback;
  pushToast: PushToast;
};

export function buildDeleteConfirmActions({
  deleteConfirm,
  copyWithFallback,
  pushToast
}: DeleteConfirmActionParams) {
  const copyDeleteConfirmCsv = async () => {
    if (!deleteConfirm) return;
    const text = deleteConfirmCsv(deleteConfirm.side, deleteConfirm.entries);
    await copyWithFallback({
      title: "复制删除清单 CSV",
      text,
      onCopied: () => pushToast("success", "删除清单 CSV 已复制")
    });
  };

  const downloadDeleteConfirmCsv = () => {
    if (!deleteConfirm) return;
    downloadTextFile(
      deleteConfirmCsvName(deleteConfirm.side),
      deleteConfirmCsv(deleteConfirm.side, deleteConfirm.entries),
      "text/csv;charset=utf-8"
    );
    pushToast("success", "删除清单 CSV 已下载");
  };

  const copyDeleteConfirmJson = async () => {
    if (!deleteConfirm) return;
    const text = deleteConfirmJson(deleteConfirm.side, deleteConfirm.entries);
    await copyWithFallback({
      title: "复制删除清单 JSON",
      text,
      onCopied: () => pushToast("success", "删除清单 JSON 已复制")
    });
  };

  const downloadDeleteConfirmJson = () => {
    if (!deleteConfirm) return;
    downloadTextFile(deleteConfirmJsonName(deleteConfirm.side), deleteConfirmJson(deleteConfirm.side, deleteConfirm.entries));
    pushToast("success", "删除清单 JSON 已下载");
  };

  return {
    copyDeleteConfirmCsv,
    downloadDeleteConfirmCsv,
    copyDeleteConfirmJson,
    downloadDeleteConfirmJson
  };
}
