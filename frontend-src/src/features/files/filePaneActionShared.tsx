import type { FileEntry } from "@/api";
import type { TextPreviewPosition } from "@/features/dialogs/dialogTypes";
import { touchTimestamp } from "@/features/files/fileCommands";
import { Edit3, Folder, Link2 } from "lucide-react";

export type ActionHandler = () => void;
export type EditorHandler = (position?: TextPreviewPosition) => void;

export type CommonFilePaneActionParams = {
  selected: FileEntry | null;
  selectedEntries: FileEntry[];
  visibleFiles: FileEntry[];
  directoryEntryCount: number;
};

export function openSelectedLabel(entry: FileEntry | null) {
  if (entry?.fileType === "symlink") return "定位链接目标";
  if (entry?.isDir) return "打开目录";
  return "打开/编辑";
}

export function openSelectedIcon(entry: FileEntry | null) {
  if (entry?.fileType === "symlink") return <Link2 size={14} />;
  if (entry?.isDir) return <Folder size={14} />;
  return <Edit3 size={14} />;
}

export function isHashableFile(entry: FileEntry) {
  return !entry.isDir && entry.fileType !== "symlink";
}

export function isPermissionCommandTarget(entry: FileEntry) {
  return entry.permissions != null && entry.fileType !== "symlink";
}

export function isTouchCommandTarget(entry: FileEntry) {
  return entry.fileType !== "symlink" && Boolean(touchTimestamp(entry.modifiedAt));
}
