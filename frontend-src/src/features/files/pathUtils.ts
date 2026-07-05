import type { FileEntry } from "@/api";

import type { FileSide } from "./filePaneTypes";

export function pathBaseName(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) return "";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function joinRemotePath(parent: string, child: string) {
  if (!parent || parent === ".") return child;
  if (parent === "/") return `/${child.replace(/^\/+/g, "")}`;
  return `${parent.replace(/\/+$/g, "")}/${child.replace(/^\/+/g, "")}`;
}

export function joinLocalPath(parent: string, child: string) {
  if (!parent || parent === ".") return child;
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/g, "")}${separator}${child.replace(/^[\\/]+/g, "")}`;
}

export function remoteParentPath(path: string) {
  const trimmed = path.trim().replace(/\/+$/g, "");
  if (!trimmed || trimmed === ".") return ".";
  if (trimmed === "/") return "/";
  const index = trimmed.lastIndexOf("/");
  if (index === 0) return "/";
  if (index > 0) return trimmed.slice(0, index);
  return ".";
}

export function localParentPath(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) return ".";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slash < 0) return ".";
  if (slash === 0) return trimmed[0];
  if (slash === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, slash);
}

export function parentPathForSide(side: FileSide, path: string) {
  return side === "remote" ? remoteParentPath(path) : localParentPath(path);
}

export function relativePathForSide(side: FileSide, basePath: string, path: string) {
  return side === "remote" ? remoteRelativePath(basePath, path) : localRelativePath(basePath, path);
}

export function remoteRelativePath(basePath: string, path: string) {
  const base = normalizeRemotePath(basePath);
  const target = normalizeRemotePath(path);
  if (!base || base === ".") return target;
  if (target === base) return ".";
  const prefix = base === "/" ? "/" : `${base}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : path;
}

export function localRelativePath(basePath: string, path: string) {
  const base = normalizeLocalComparablePath(basePath);
  const target = normalizeLocalComparablePath(path);
  if (!base || base === ".") return path;
  if (target === base) return ".";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return target.startsWith(prefix) ? path.replace(/\\/g, "/").slice(prefix.length) : path;
}

export function normalizeRemotePath(path: string) {
  const collapsed = path.trim().replace(/\/+/g, "/");
  if (!collapsed) return ".";
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/g, "");
}

export function normalizeLocalComparablePath(path: string) {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return trimmed.toLowerCase();
}

export function resolveSymlinkTargetPath(side: FileSide, entry: FileEntry) {
  const target = entry.linkTarget?.trim() ?? "";
  if (!target) return "";
  if (side === "remote") {
    return target.startsWith("/") ? target : joinRemotePath(remoteParentPath(entry.path), target);
  }
  return isLocalAbsolutePath(target) ? target : joinLocalPath(localParentPath(entry.path), target);
}

export function isLocalAbsolutePath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}
