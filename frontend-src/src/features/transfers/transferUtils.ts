import type { Profile, TransferConflictStrategy, TransferView } from "@/api";
import { joinLocalPath, joinRemotePath, pathBaseName } from "@/features/files/pathUtils";

export function conflictLabel(value: TransferConflictStrategy) {
  if (value === "skip") return "跳过";
  if (value === "rename") return "重命名";
  if (value === "resume") return "续传";
  return "覆盖";
}

export function transferStatusLabel(value: TransferView["status"]) {
  if (value === "running") return "传输中";
  if (value === "done") return "完成";
  if (value === "failed") return "失败";
  return "已取消";
}

export function formatEta(value?: number | null) {
  if (!value) return "ETA -";
  if (value < 60) return `ETA ${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes < 60) return `ETA ${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `ETA ${hours}h ${minutes % 60}m`;
}

export function formatTransferTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function transferAuditCsvName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-transfer-audit-${stamp}.csv`;
}

export function transferAuditJsonName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-transfer-audit-${stamp}.json`;
}

export function transferUploadResultPath(transfer: TransferView) {
  if (transfer.status === "done" && transfer.message) return transfer.message;
  return joinRemotePath(transfer.target || ".", pathBaseName(transfer.source));
}

export function transferDownloadResultPath(transfer: TransferView) {
  if (transfer.status === "done" && transfer.message) return transfer.message;
  return joinLocalPath(transfer.target || ".", pathBaseName(transfer.source));
}

export function transferDetailText(transfer: TransferView, profiles: Profile[]) {
  const profile = profiles.find((item) => item.id === transfer.profileId);
  const resultPath = transfer.direction === "upload" ? transferUploadResultPath(transfer) : transferDownloadResultPath(transfer);
  return [
    "RustShell Transfer",
    `ID: ${transfer.id}`,
    `Session: ${profile?.name ?? "-"} (${transfer.profileId})`,
    `Direction: ${transfer.direction === "upload" ? "上传" : "下载"}`,
    `Status: ${transferStatusLabel(transfer.status)} (${transfer.status})`,
    `Conflict: ${conflictLabel(transfer.conflictStrategy)} (${transfer.conflictStrategy})`,
    `Source: ${transfer.source}`,
    `Target: ${transfer.target}`,
    `Result: ${resultPath}`,
    `Progress: ${transferAuditPercent(transfer)}% (${transfer.transferred}/${transfer.total || "-"} bytes)`,
    `Speed: ${transfer.speedBps} B/s`,
    `ETA: ${transfer.etaSeconds == null ? "-" : `${transfer.etaSeconds}s`}`,
    `Attempts: ${transfer.attempts}`,
    `Finished At: ${transfer.finishedAt ? formatTransferTime(transfer.finishedAt) : "-"}`,
    `Message: ${transfer.message ?? "-"}`
  ].join("\n");
}

export function transferAuditCsv(transfers: TransferView[], profiles: Profile[]) {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const rows = [
    [
      "id",
      "profile_id",
      "profile_name",
      "direction",
      "direction_label",
      "status",
      "status_label",
      "conflict_strategy",
      "conflict_label",
      "source",
      "target",
      "result_path",
      "transferred_bytes",
      "total_bytes",
      "progress_percent",
      "speed_bps",
      "eta_seconds",
      "attempts",
      "finished_at",
      "message"
    ],
    ...transfers.map((transfer) => {
      const profile = profileById.get(transfer.profileId);
      return [
        transfer.id,
        transfer.profileId,
        profile?.name ?? "",
        transfer.direction,
        transfer.direction === "upload" ? "上传" : "下载",
        transfer.status,
        transferStatusLabel(transfer.status),
        transfer.conflictStrategy,
        conflictLabel(transfer.conflictStrategy),
        transfer.source,
        transfer.target,
        transfer.direction === "upload" ? transferUploadResultPath(transfer) : transferDownloadResultPath(transfer),
        String(transfer.transferred),
        String(transfer.total),
        String(transferAuditPercent(transfer)),
        String(transfer.speedBps),
        transfer.etaSeconds == null ? "" : String(transfer.etaSeconds),
        String(transfer.attempts),
        transfer.finishedAt ?? "",
        transfer.message ?? ""
      ];
    })
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function transferAuditJson(transfers: TransferView[], profiles: Profile[]) {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: {
        total: transfers.length,
        running: transfers.filter((transfer) => transfer.status === "running").length,
        done: transfers.filter((transfer) => transfer.status === "done").length,
        failed: transfers.filter((transfer) => transfer.status === "failed").length,
        cancelled: transfers.filter((transfer) => transfer.status === "cancelled").length,
        uploaded: transfers.filter((transfer) => transfer.direction === "upload").length,
        downloaded: transfers.filter((transfer) => transfer.direction === "download").length
      },
      transfers: transfers.map((transfer) => {
        const profile = profileById.get(transfer.profileId);
        return {
          id: transfer.id,
          profileId: transfer.profileId,
          profileName: profile?.name ?? null,
          endpoint: profile ? `${profile.username}@${profile.host}:${profile.port}` : null,
          direction: transfer.direction,
          directionLabel: transfer.direction === "upload" ? "上传" : "下载",
          status: transfer.status,
          statusLabel: transferStatusLabel(transfer.status),
          conflictStrategy: transfer.conflictStrategy,
          conflictLabel: conflictLabel(transfer.conflictStrategy),
          source: transfer.source,
          target: transfer.target,
          resultPath: transfer.direction === "upload" ? transferUploadResultPath(transfer) : transferDownloadResultPath(transfer),
          transferredBytes: transfer.transferred,
          totalBytes: transfer.total,
          progressPercent: transferAuditPercent(transfer),
          speedBps: transfer.speedBps,
          etaSeconds: transfer.etaSeconds ?? null,
          attempts: transfer.attempts,
          finishedAt: transfer.finishedAt ?? null,
          message: transfer.message ?? null
        };
      })
    },
    null,
    2
  );
}

export function transferAuditRecords(transfers: TransferView[], history: TransferView[]) {
  const seen = new Set<string>();
  return [...transfers, ...history].filter((transfer) => {
    if (seen.has(transfer.id)) return false;
    seen.add(transfer.id);
    return true;
  });
}

export function sameTransferList(left: TransferView[], right: TransferView[]) {
  return left.length === right.length && transferListSignature(left) === transferListSignature(right);
}

export function transferPercent(transfer: TransferView) {
  if (!transfer.total) return transfer.status === "done" ? 100 : 8;
  return Math.min(100, Math.max(4, Math.round((transfer.transferred / transfer.total) * 100)));
}

export function transferAuditPercent(transfer: TransferView) {
  if (!transfer.total) return transfer.status === "done" ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((transfer.transferred / transfer.total) * 100)));
}

function escapeCsvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function transferListSignature(transfers: TransferView[]) {
  return transfers
    .map((transfer) =>
      [
        transfer.id,
        transfer.status,
        transfer.transferred,
        transfer.total,
        transfer.speedBps,
        transfer.etaSeconds ?? "",
        transfer.attempts,
        transfer.message ?? "",
        transfer.finishedAt ?? ""
      ].join(":")
    )
    .join("|");
}
