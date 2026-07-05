import type { FileEntry } from "@/api";
import { formatOwner } from "@/features/files/fileFormatters";
import type {
  CompareView,
  DirectoryCompare,
  FileCompareMark,
  FileSort,
  FileSortKey
} from "@/features/files/filePaneTypes";

export const defaultFileSort: FileSort = { key: "name", direction: "asc" };
export const emptyCompareMarks = new Map<string, FileCompareMark>();

export function canEditTextFile(entry?: FileEntry | null) {
  return Boolean(entry && !entry.isDir && entry.fileType !== "symlink");
}

export function pickSelection(files: FileEntry[], preferPath?: string, previous?: FileEntry | null) {
  const targetPath = preferPath || previous?.path;
  if (!targetPath) return null;
  return files.find((file) => file.path === targetPath) ?? null;
}

export function pushHistory(history: string[], path: string, front = false) {
  const value = path.trim();
  if (!value) return history;
  if (front) {
    if (history[0] === value) return history;
    return [value, ...history].slice(0, 80);
  }
  if (history[history.length - 1] === value) return history;
  return [...history, value].slice(-80);
}

export function visibleFiles(files: FileEntry[], showHidden: boolean, filter: string) {
  const needle = filter.trim().toLowerCase();
  return files.filter((file) => {
    if (!showHidden && isHiddenFile(file)) return false;
    if (!needle) return true;
    return fileSearchText(file).includes(needle);
  });
}

export function visibleSelection(selected: FileEntry | null, showHidden: boolean, filter: string) {
  if (!selected) return null;
  if (!showHidden && isHiddenFile(selected)) return null;
  const needle = filter.trim().toLowerCase();
  if (needle && !fileSearchText(selected).includes(needle)) return null;
  return selected;
}

export function selectionVisibleInFiles(selected: FileEntry | null, files: FileEntry[]) {
  if (!selected) return null;
  return files.some((file) => file.path === selected.path) ? selected : null;
}

export function selectedEntries(files: FileEntry[], selectedPaths: string[], selected: FileEntry | null) {
  const selectedPathSet = new Set(selectedPaths);
  const entries = files.filter((file) => selectedPathSet.has(file.path));
  if (entries.length > 0) return entries;
  return selected ? [selected] : [];
}

export function filterCompareView(files: FileEntry[], marks: Map<string, FileCompareMark>, view: CompareView) {
  if (view === "all") return files;
  return files.filter((file) => {
    const kind = marks.get(file.path)?.kind;
    if (view === "same") return kind === "same";
    if (view === "diff") return kind === "only-local" || kind === "only-remote" || kind === "different";
    return kind === view;
  });
}

export function buildDirectoryCompare(localFiles: FileEntry[], remoteFiles: FileEntry[]): DirectoryCompare {
  const local = new Map<string, FileCompareMark>();
  const remote = new Map<string, FileCompareMark>();
  const summary = { same: 0, different: 0, onlyLocal: 0, onlyRemote: 0 };
  const localByName = new Map(localFiles.map((file) => [file.name, file]));
  const remoteByName = new Map(remoteFiles.map((file) => [file.name, file]));
  const names = new Set([...localByName.keys(), ...remoteByName.keys()]);

  for (const name of names) {
    const left = localByName.get(name);
    const right = remoteByName.get(name);
    if (left && !right) {
      local.set(left.path, { kind: "only-local", detail: "远程不存在" });
      summary.onlyLocal += 1;
      continue;
    }
    if (!left && right) {
      remote.set(right.path, { kind: "only-remote", detail: "本地不存在" });
      summary.onlyRemote += 1;
      continue;
    }
    if (!left || !right) continue;

    const mark = compareFilePair(left, right);
    local.set(left.path, mark);
    remote.set(right.path, mark);
    if (mark.kind === "same") {
      summary.same += 1;
    } else {
      summary.different += 1;
    }
  }

  return { local, remote, summary };
}

export function compareFilePair(left: FileEntry, right: FileEntry): FileCompareMark {
  const reasons: string[] = [];
  if (left.isDir !== right.isDir) reasons.push("类型");
  if (left.fileType !== right.fileType) reasons.push("文件类型");
  if ((left.linkTarget ?? "") !== (right.linkTarget ?? "")) reasons.push("链接目标");
  if ((left.permissions ?? null) !== (right.permissions ?? null)) reasons.push("权限");
  if ((left.uid ?? null) !== (right.uid ?? null) || (left.gid ?? null) !== (right.gid ?? null)) reasons.push("属主");
  if (!left.isDir && !right.isDir && left.size !== right.size) reasons.push("大小");

  const leftTime = new Date(left.modifiedAt).getTime();
  const rightTime = new Date(right.modifiedAt).getTime();
  const comparableTime = !Number.isNaN(leftTime) && !Number.isNaN(rightTime);
  if (comparableTime && Math.abs(leftTime - rightTime) > 2000) reasons.push("时间");

  if (reasons.length === 0) return { kind: "same", detail: "内容、时间、权限、属主一致" };
  return { kind: "different", detail: `差异: ${reasons.join("、")}` };
}

export function togglePath(paths: string[], path: string) {
  if (paths.includes(path)) {
    const next = paths.filter((item) => item !== path);
    return next.length > 0 ? next : [path];
  }
  return [...paths, path];
}

export function commonEntryValue(entries: FileEntry[], getValue: (entry: FileEntry) => string) {
  if (entries.length === 0) return "";
  const first = getValue(entries[0]);
  return entries.every((entry) => getValue(entry) === first) ? first : "";
}

export function nextFileSort(current: FileSort, key: FileSortKey): FileSort {
  if (current.key !== key) return { key, direction: key === "name" ? "asc" : "desc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

export function sortFiles(files: FileEntry[], sort: FileSort) {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...files].sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    const primary = compareFileValue(left, right, sort.key);
    if (primary !== 0) return primary * direction;
    return compareText(left.name, right.name);
  });
}

export function duplicateName(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${name.slice(0, dot)} copy${name.slice(dot)}`;
  return `${name} copy`;
}

export function uniqueDuplicateName(name: string, occupiedNames: Set<string>) {
  let candidate = duplicateName(name);
  if (!occupiedNames.has(candidate)) return candidate;

  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let index = 2;
  do {
    candidate = `${base} copy ${index}${ext}`;
    index += 1;
  } while (occupiedNames.has(candidate));
  return candidate;
}

export function metadataSyncChanges(source: FileEntry, target: FileEntry, direction: "upload" | "download") {
  const changes: string[] = [];
  if (source.permissions != null && source.permissions !== target.permissions) changes.push("权限");
  const sourceMtime = Math.floor(new Date(source.modifiedAt).getTime() / 1000);
  const targetMtime = Math.floor(new Date(target.modifiedAt).getTime() / 1000);
  if (Number.isFinite(sourceMtime) && Number.isFinite(targetMtime) && Math.abs(sourceMtime - targetMtime) > 2) {
    changes.push("时间");
  }
  if (
    direction === "upload" &&
    (source.uid != null || source.gid != null) &&
    (source.uid !== target.uid || source.gid !== target.gid)
  ) {
    changes.push("属主");
  }
  return changes;
}

function isHiddenFile(file: FileEntry) {
  return file.name.startsWith(".") && file.name !== "." && file.name !== "..";
}

function fileSearchText(file: FileEntry) {
  return `${file.name}\n${file.path}\n${file.linkTarget ?? ""}`.toLowerCase();
}

function compareFileValue(left: FileEntry, right: FileEntry, key: FileSortKey) {
  if (key === "name") return compareText(left.name, right.name);
  if (key === "permissions") return (left.permissions ?? -1) - (right.permissions ?? -1);
  if (key === "owner") return compareText(formatOwner(left), formatOwner(right));
  if (key === "size") return left.size - right.size;
  return new Date(left.modifiedAt).getTime() - new Date(right.modifiedAt).getTime();
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}
