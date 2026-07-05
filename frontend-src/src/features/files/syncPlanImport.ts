import type { FileEntry, TransferConflictStrategy } from "@/api";
import { pathBaseName } from "@/features/files/pathUtils";
import type { SyncPlanItem, SyncPlanState } from "@/features/files/syncPlanTypes";

export function parseSyncPlanJson(payload: string): SyncPlanState {
  const raw = JSON.parse(payload) as unknown;
  if (!isRecord(raw)) throw new Error("不是有效的同步计划 JSON");
  const direction = raw.direction === "upload" || raw.direction === "download" ? raw.direction : null;
  const mode = raw.mode === "transfer" || raw.mode === "metadata" ? raw.mode : null;
  const scope = raw.scope === "all" || raw.scope === "missing" || raw.scope === "metadata" ? raw.scope : mode === "metadata" ? "metadata" : "all";
  if (!direction || !mode) throw new Error("同步计划缺少方向或模式");
  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new Error("同步计划没有项目");
  const conflictStrategy = isTransferConflictStrategy(raw.conflictStrategy) ? raw.conflictStrategy : null;
  const items = raw.items.map((item, index) => parseSyncPlanJsonItem(item, mode, index));
  return {
    direction,
    mode,
    scope,
    conflictStrategy,
    title: typeof raw.title === "string" && raw.title.trim() ? `${raw.title}（导入）` : "导入同步计划",
    items
  };
}

export function parseOptionalOwnerId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4294967295) return undefined;
  return parsed;
}

export function parseDateTimeLocal(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const timestamp = new Date(trimmed).getTime();
  if (Number.isNaN(timestamp)) return undefined;
  return Math.floor(timestamp / 1000);
}

function parseSyncPlanJsonItem(raw: unknown, mode: SyncPlanState["mode"], index: number): SyncPlanItem {
  if (!isRecord(raw)) throw new Error(`同步计划第 ${index + 1} 项格式错误`);
  const source = typeof raw.source === "string" ? raw.source : "";
  const target = typeof raw.target === "string" ? raw.target : "";
  if (!source || !target) throw new Error(`同步计划第 ${index + 1} 项缺少源或目标路径`);
  const action =
    raw.action === "create" || raw.action === "overwrite" || raw.action === "metadata"
      ? raw.action
      : mode === "metadata"
        ? "metadata"
        : "overwrite";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : pathBaseName(source || target);
  const fileType = typeof raw.type === "string" && raw.type ? raw.type : "file";
  const size = typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : 0;
  const sourceEntry = syncPlanJsonEntry({
    name,
    path: source,
    fileType,
    size,
    mode: raw.sourceMode,
    owner: raw.sourceOwner,
    modifiedAt: raw.sourceModifiedAt,
    linkTarget: raw.sourceLinkTarget
  });
  const targetEntry = syncPlanJsonEntry({
    name,
    path: target,
    fileType,
    size,
    mode: raw.targetMode,
    owner: raw.targetOwner,
    modifiedAt: raw.targetModifiedAt,
    linkTarget: raw.targetLinkTarget
  });
  return {
    entry: mode === "metadata" ? targetEntry : sourceEntry,
    sourceEntry: mode === "metadata" ? sourceEntry : undefined,
    targetEntry: mode === "metadata" ? targetEntry : undefined,
    action,
    name,
    source,
    target,
    detail: typeof raw.detail === "string" ? raw.detail : action === "create" ? "新增" : action === "metadata" ? "元数据" : "覆盖",
    changes: Array.isArray(raw.changes) ? raw.changes.filter((change): change is string => typeof change === "string") : undefined
  };
}

function syncPlanJsonEntry({
  name,
  path,
  fileType,
  size,
  mode,
  owner,
  modifiedAt,
  linkTarget
}: {
  name: string;
  path: string;
  fileType: string;
  size: number;
  mode: unknown;
  owner: unknown;
  modifiedAt: unknown;
  linkTarget: unknown;
}): FileEntry {
  const parsedOwner = parseSyncPlanOwner(owner);
  const isDir = fileType === "directory";
  return {
    name: name || pathBaseName(path),
    path,
    size: isDir ? 0 : size,
    modifiedAt: typeof modifiedAt === "string" && modifiedAt ? modifiedAt : new Date(0).toISOString(),
    isDir,
    fileType,
    linkTarget: typeof linkTarget === "string" ? linkTarget : null,
    permissions: parseSyncPlanMode(mode),
    uid: parsedOwner.uid,
    gid: parsedOwner.gid
  };
}

function parseSyncPlanMode(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !/^[0-7]{3,4}$/.test(value)) return null;
  return Number.parseInt(value, 8);
}

function parseSyncPlanOwner(value: unknown): { uid: number | null; gid: number | null } {
  if (typeof value !== "string" || !value.includes(":")) return { uid: null, gid: null };
  const [uidText, gidText] = value.split(":");
  const uid = uidText ? Number.parseInt(uidText, 10) : Number.NaN;
  const gid = gidText ? Number.parseInt(gidText, 10) : Number.NaN;
  return {
    uid: Number.isFinite(uid) ? uid : null,
    gid: Number.isFinite(gid) ? gid : null
  };
}

function isTransferConflictStrategy(value: unknown): value is TransferConflictStrategy {
  return value === "overwrite" || value === "skip" || value === "rename" || value === "resume";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
