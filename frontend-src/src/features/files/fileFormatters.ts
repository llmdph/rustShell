import type { FileEntry } from "@/api";
import type { FileCompareKind, FileCompareMark } from "@/features/files/filePaneTypes";
import { formatSymbolicMode } from "@/features/files/permissions";

export function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fileTypeLabel(entry: FileEntry) {
  if (entry.fileType === "symlink") return "符号链接";
  if (entry.isDir || entry.fileType === "directory") return "目录";
  return "文件";
}

export function compareKindLabel(kind: FileCompareKind) {
  if (kind === "only-local") return "仅本地";
  if (kind === "only-remote") return "仅远程";
  if (kind === "different") return "不同";
  return "相同";
}

export function compareMarkLabel(mark: FileCompareMark) {
  if (mark.kind !== "different") return compareKindLabel(mark.kind);
  const detail = mark.detail.replace(/^差异:\s*/, "");
  return detail ? `${detail}不同` : "不同";
}

export function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

export function formatFileDateTime(value: string, withSeconds = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (part: number) => String(part).padStart(2, "0");
  const base = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

export function formatDateTimeLocal(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatOwner(file: FileEntry) {
  if (file.uid == null && file.gid == null) return "-";
  return `${file.uid ?? "-"}:${file.gid ?? "-"}`;
}

export function formatEntrySymbolicMode(file: FileEntry) {
  const mode = file.permissions ?? 0;
  const symbolic = formatSymbolicMode(mode, file.isDir);
  if (file.fileType === "symlink") return `l${symbolic.slice(1)}`;
  return symbolic;
}

