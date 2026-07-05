import type { FileEntry } from "@/api";

export type FileSide = "local" | "remote";
export type CompareView = "all" | "diff" | "same" | "only-local" | "only-remote" | "different";
export type FileSortKey = "name" | "permissions" | "owner" | "size" | "modifiedAt";
export type FileSort = { key: FileSortKey; direction: "asc" | "desc" };
export type FileCompareKind = "same" | "different" | "only-local" | "only-remote";
export type FileCompareMark = { kind: FileCompareKind; detail: string };
export type PathBookmark = { label: string; path: string };
export type FileDragPayload = { side: FileSide; entries: FileEntry[] };
export type FileSearchState = { root: string; query: string; count: number };
export type DirectoryCompare = {
  local: Map<string, FileCompareMark>;
  remote: Map<string, FileCompareMark>;
  summary: { same: number; different: number; onlyLocal: number; onlyRemote: number };
};
