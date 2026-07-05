import type { Profile, TransferView } from "@/api";
import { downloadTextFile } from "@/lib/browserFiles";
import {
  transferAuditCsv,
  transferAuditCsvName,
  transferAuditJson,
  transferAuditJsonName,
  transferAuditRecords
} from "@/features/transfers/transferUtils";

type ToastTone = "success" | "info" | "error";
type CopyWithFallback = (options: { title: string; text: string; onCopied?: () => void }) => Promise<boolean>;

type BuildTransferAuditActionsOptions = {
  transfers: TransferView[];
  history: TransferView[];
  profiles: Profile[];
  copyWithFallback: CopyWithFallback;
  pushToast: (tone: ToastTone, text: string) => void;
};

export function buildTransferAuditActions({
  transfers,
  history,
  profiles,
  copyWithFallback,
  pushToast
}: BuildTransferAuditActionsOptions) {
  const auditRecords = () => transferAuditRecords(transfers, history);

  const copyTransferAuditCsv = async () => {
    const records = auditRecords();
    if (records.length === 0) return;
    const text = transferAuditCsv(records, profiles);
    await copyWithFallback({
      title: "复制传输审计 CSV",
      text,
      onCopied: () => pushToast("success", `传输审计 CSV 已复制 ${records.length} 条`)
    });
  };

  const downloadTransferAuditCsv = () => {
    const records = auditRecords();
    if (records.length === 0) return;
    downloadTextFile(transferAuditCsvName(), transferAuditCsv(records, profiles), "text/csv;charset=utf-8");
    pushToast("success", `传输审计 CSV 已下载 ${records.length} 条`);
  };

  const copyTransferAuditJson = async () => {
    const records = auditRecords();
    if (records.length === 0) return;
    const text = transferAuditJson(records, profiles);
    await copyWithFallback({
      title: "复制传输审计 JSON",
      text,
      onCopied: () => pushToast("success", `传输审计 JSON 已复制 ${records.length} 条`)
    });
  };

  const downloadTransferAuditJson = () => {
    const records = auditRecords();
    if (records.length === 0) return;
    downloadTextFile(transferAuditJsonName(), transferAuditJson(records, profiles));
    pushToast("success", `传输审计 JSON 已下载 ${records.length} 条`);
  };

  return {
    copyTransferAuditCsv,
    downloadTransferAuditCsv,
    copyTransferAuditJson,
    downloadTransferAuditJson
  };
}
