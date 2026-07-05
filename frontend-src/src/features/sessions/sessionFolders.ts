import type { Profile } from "@/api";

const sessionFolderStorageKey = "rustshell.sessionFolders.v1";

export type SessionFolderNode = {
  name: string;
  path: string;
  children: SessionFolderNode[];
  profiles: Profile[];
};

export function buildSessionFolderTree(profiles: Profile[], customFolders: string[]): SessionFolderNode[] {
  const rootMap = new Map<string, SessionFolderNode>();
  const ensureFolder = (path: string): SessionFolderNode | null => {
    const parts = normalizeSessionGroupPath(path).split("/");
    let node: SessionFolderNode | null = null;
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!node) {
        node = rootMap.get(part) ?? { name: part, path: currentPath, children: [], profiles: [] };
        rootMap.set(part, node);
        continue;
      }

      let child: SessionFolderNode | undefined = node.children.find((item) => item.name === part);
      if (!child) {
        child = { name: part, path: currentPath, children: [], profiles: [] };
        node.children = [...node.children, child];
      }
      node = child;
    }
    return node;
  };

  for (const folder of customFolders) {
    ensureFolder(folder);
  }

  for (const profile of [...profiles].sort(compareProfilesByCreated)) {
    const folder = ensureFolder(profile.group || "我的会话");
    folder?.profiles.push(profile);
  }

  const sortNode = (node: SessionFolderNode): SessionFolderNode => ({
    ...node,
    children: node.children.map(sortNode).sort((left, right) => sessionGroupSort(left.path, right.path)),
    profiles: [...node.profiles].sort(compareProfilesByCreated)
  });

  return [...rootMap.values()].map(sortNode).sort((left, right) => sessionGroupSort(left.path, right.path));
}

export function normalizeSessionGroupPath(value: string) {
  return (
    value
      .split(/[\\/]+/)
      .map(normalizeSessionFolderPart)
      .filter(Boolean)
      .join("/") || "我的会话"
  );
}

export function normalizeSessionFolderPart(value: string) {
  return value.trim().replace(/[\\/]+/g, "");
}

export function sessionGroupParent(value: string) {
  const parts = normalizeSessionGroupPath(value).split("/");
  if (parts.length <= 1) return "我的会话";
  return parts.slice(0, -1).join("/");
}

export function isSessionGroupInsideFolder(group: string, folder: string) {
  const normalizedGroup = normalizeSessionGroupPath(group || "我的会话");
  const normalizedFolder = normalizeSessionGroupPath(folder);
  return normalizedGroup === normalizedFolder || normalizedGroup.startsWith(`${normalizedFolder}/`);
}

export function isProtectedSessionFolder(value: string) {
  const normalized = normalizeSessionGroupPath(value);
  return normalized === "我的会话" || normalized === "本地环境";
}

export function sessionGroupSort(left: string, right: string) {
  const score = (value: string) => {
    if (value === "我的会话") return 0;
    if (value.startsWith("我的会话/")) return 1;
    if (value === "本地环境") return 90;
    if (value.startsWith("本地环境/")) return 91;
    return 10;
  };
  const leftScore = score(left);
  const rightScore = score(right);
  if (leftScore !== rightScore) return leftScore - rightScore;
  return left.localeCompare(right, "zh-Hans-CN");
}

export function loadSessionFolders() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(sessionFolderStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .map((item) => (typeof item === "string" ? normalizeSessionGroupPath(item) : ""))
      .filter((item) => {
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return true;
      })
      .sort(sessionGroupSort);
  } catch {
    return [];
  }
}

export function saveSessionFolders(folders: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(sessionFolderStorageKey, JSON.stringify(folders));
  } catch {
    // Ignore localStorage failures; folders remain available until reload.
  }
}

function compareProfilesByCreated(left: Profile, right: Profile) {
  const leftTime = profileTimeValue(left.createdAt);
  const rightTime = profileTimeValue(right.createdAt);
  if (leftTime && rightTime && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== rightTime) return leftTime ? -1 : 1;
  return left.name.localeCompare(right.name, "zh-Hans-CN");
}

function profileTimeValue(value?: string | null) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}
