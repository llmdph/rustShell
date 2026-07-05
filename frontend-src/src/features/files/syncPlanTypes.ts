import type { FileEntry, TransferConflictStrategy } from "@/api";

export type SyncPlanItem = {
  entry: FileEntry;
  sourceEntry?: FileEntry;
  targetEntry?: FileEntry;
  action: "create" | "overwrite" | "metadata";
  name: string;
  source: string;
  target: string;
  detail: string;
  changes?: string[];
};

export type SyncPlanState = {
  direction: "upload" | "download";
  mode: "transfer" | "metadata";
  scope: "all" | "missing" | "metadata";
  conflictStrategy?: TransferConflictStrategy | null;
  title: string;
  items: SyncPlanItem[];
};
