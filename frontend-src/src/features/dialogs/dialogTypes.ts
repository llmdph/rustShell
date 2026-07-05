import type { FileEntry, HostKeyIssue } from "@/api";
import type { FileSide } from "@/features/files/filePaneTypes";

export type AppPromptOptions = {
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  readOnly?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};

export type AppConfirmOptions = {
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type BatchRenamePlanItem = { entry: FileEntry; newName: string };
export type DeleteConfirmState = { side: FileSide; entries: FileEntry[] };
export type HostKeyPromptState = { profileId: string; issue: HostKeyIssue };
export type TextPreviewPosition = "head" | "tail";
