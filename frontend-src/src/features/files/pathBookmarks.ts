import type { FileSide, PathBookmark } from "@/features/files/filePaneTypes";

const pathBookmarkStorageKey = "rustshell.pathBookmarks.v1";

export function loadPathBookmarks(side: FileSide): PathBookmark[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(pathBookmarkStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<Record<FileSide, unknown>>;
    return normalizeBookmarks(parsed[side]);
  } catch {
    return [];
  }
}

export function savePathBookmarks(side: FileSide, bookmarks: PathBookmark[]) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(pathBookmarkStorageKey);
    const parsed = raw ? (JSON.parse(raw) as Partial<Record<FileSide, unknown>>) : {};
    const next = { ...parsed, [side]: normalizeBookmarks(bookmarks) };
    window.localStorage.setItem(pathBookmarkStorageKey, JSON.stringify(next));
  } catch {
    // Ignore localStorage failures; bookmarks are a convenience layer.
  }
}

export function upsertBookmark(bookmarks: PathBookmark[], next: PathBookmark) {
  return [next, ...bookmarks.filter((bookmark) => bookmark.path !== next.path)].slice(0, 80);
}

export function bookmarkLabel(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  if (!normalized) return path.trim() || "路径";
  const segments = normalized.split(/[\\/]+/);
  return segments[segments.length - 1] || normalized;
}

function normalizeBookmarks(value: unknown): PathBookmark[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const bookmarks: PathBookmark[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const bookmark = item as Partial<PathBookmark>;
    const path = String(bookmark.path ?? "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    bookmarks.push({
      path,
      label: String(bookmark.label ?? bookmarkLabel(path)).trim() || bookmarkLabel(path)
    });
    if (bookmarks.length >= 80) break;
  }
  return bookmarks;
}
