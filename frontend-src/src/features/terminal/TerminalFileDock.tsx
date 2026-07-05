import { ArrowUp, ChevronDown, ChevronRight, Copy, Download, Folder, FolderOpen, ListChecks, ListX, RefreshCcw, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { FileEntry } from "@/api";
import { IconButton } from "@/components/app/IconButton";
import type { FileAction } from "@/components/app/ActionContextMenu";
import { Input } from "@/components/ui/input";
import { FileList } from "@/features/files/FileList";
import {
  compareMarkLabel,
  formatEntrySymbolicMode,
  formatFileDateTime,
  formatOwner,
  formatSize
} from "@/features/files/fileFormatters";
import { defaultFileSort, emptyCompareMarks, nextFileSort, sortFiles } from "@/features/files/filePaneModel";
import type { FileSort } from "@/features/files/filePaneTypes";
import { cn } from "@/lib/utils";

type DockSide = "local" | "remote";
type TreeDropOperation = "move" | "copy";
type DockTransferEntry = Pick<FileEntry, "path" | "name" | "isDir">;
type DockDragPayload = {
  source: "terminal-file-dock";
  side: DockSide;
  profileId: string | null;
  entries: DockTransferEntry[];
};

type DockNode = {
  path: string;
  name: string;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  children: DockNode[] | null;
};

type TerminalFileDockProps = {
  side: DockSide;
  profileId?: string | null;
  dropTargetId?: string;
  sessionLabel: string;
  followPath: string | null;
  height: number;
  dropActive?: boolean;
  transferRecordCount?: number;
  runningTransferCount?: number;
  onHeightChange: (height: number) => void;
  listDir: (path: string) => Promise<FileEntry[]>;
  resolveHome: () => Promise<string>;
  onOpenFile: (entry: FileEntry) => void;
  onDownloadEntries?: (entries: FileEntry[], remotePath: string) => void | Promise<void>;
  onUploadEntries?: (entries: FileEntry[], remotePath: string) => void | Promise<void>;
  onRemoveEntries?: (entries: FileEntry[], currentPath: string) => void | Promise<void>;
  onTransferEntriesToDirectory?: (entries: DockTransferEntry[], targetPath: string, operation: TreeDropOperation) => void | Promise<void>;
  onCopyText?: (options: { title: string; text: string; onCopied?: () => void }) => Promise<boolean>;
  onOpenTransferQueue?: () => void;
  onClose: () => void;
};

const DOCK_DRAG_TYPE = "application/x-rustshell-terminal-file-drag";

function isRemoteSide(side: DockSide) {
  return side === "remote";
}

function parentPath(side: DockSide, path: string): string | null {
  if (isRemoteSide(side)) {
    if (!path || path === "/") return null;
    const trimmed = path.replace(/\/+$/, "");
    const index = trimmed.lastIndexOf("/");
    if (index <= 0) return "/";
    return trimmed.slice(0, index);
  }
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) return null;
  const parent = trimmed.slice(0, index);
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`;
  return parent || null;
}

function rootOf(side: DockSide, path: string): string {
  if (isRemoteSide(side)) return "/";
  const match = /^([a-zA-Z]:)/.exec(path);
  return match ? `${match[1]}\\` : path;
}

function nameOf(side: DockSide, path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = isRemoteSide(side) ? trimmed.lastIndexOf("/") : Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  const name = index >= 0 ? trimmed.slice(index + 1) : trimmed;
  return name || path;
}

function normalizeDockPath(side: DockSide, path: string): string {
  const value = path.trim();
  if (!value) return "";
  if (isRemoteSide(side)) {
    const normalized = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (normalized === "/") return "/";
    return normalized.replace(/\/+$/, "") || "/";
  }
  const normalized = value.replace(/\//g, "\\");
  const driveMatch = /^([a-zA-Z]:)(?:\\+)?/.exec(normalized);
  if (!driveMatch) return normalized.replace(/\\+$/, "");
  const root = `${driveMatch[1]}\\`;
  const rest = normalized.slice(driveMatch[0].length).replace(/\\{2,}/g, "\\").replace(/\\+$/, "");
  return rest ? `${root}${rest}` : root;
}

function sameDockPath(side: DockSide, left: string, right: string): boolean {
  const normalizedLeft = normalizeDockPath(side, left);
  const normalizedRight = normalizeDockPath(side, right);
  return isRemoteSide(side)
    ? normalizedLeft === normalizedRight
    : normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function isSameOrChildDockPath(side: DockSide, parent: string, child: string): boolean {
  const normalizedParent = normalizeDockPath(side, parent);
  const normalizedChild = normalizeDockPath(side, child);
  if (!normalizedParent || !normalizedChild) return false;
  if (sameDockPath(side, normalizedParent, normalizedChild)) return true;
  if (isRemoteSide(side)) {
    if (normalizedParent === "/") return normalizedChild.startsWith("/");
    return normalizedChild.startsWith(`${normalizedParent}/`);
  }
  const parentKey = normalizedParent.toLowerCase();
  const childKey = normalizedChild.toLowerCase();
  return childKey.startsWith(parentKey.endsWith("\\") ? parentKey : `${parentKey}\\`);
}

function canDropEntriesOnDirectory(side: DockSide, entries: DockTransferEntry[], targetPath: string): boolean {
  return !entries.some((entry) => {
    const sourceParent = parentPath(side, entry.path);
    if (sourceParent && sameDockPath(side, sourceParent, targetPath)) return true;
    if (sameDockPath(side, entry.path, targetPath)) return true;
    return entry.isDir && isSameOrChildDockPath(side, entry.path, targetPath);
  });
}

function readDockDragPayload(dataTransfer: DataTransfer): DockDragPayload | null {
  const raw = dataTransfer.getData(DOCK_DRAG_TYPE);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DockDragPayload;
    if (value.source !== "terminal-file-dock") return null;
    if (value.side !== "local" && value.side !== "remote") return null;
    if (!Array.isArray(value.entries) || value.entries.length === 0) return null;
    const entries = value.entries.filter(
      (entry): entry is DockTransferEntry =>
        typeof entry?.path === "string" &&
        typeof entry.name === "string" &&
        typeof entry.isDir === "boolean"
    );
    if (entries.length === 0) return null;
    return { source: "terminal-file-dock", side: value.side, profileId: value.profileId ?? null, entries };
  } catch {
    return null;
  }
}

function pathChain(side: DockSide, targetPath: string): Array<Pick<DockNode, "path" | "name">> {
  const normalized = normalizeDockPath(side, targetPath);
  if (!normalized) return [];
  if (isRemoteSide(side)) {
    const chain: Array<Pick<DockNode, "path" | "name">> = [{ path: "/", name: "/" }];
    const segments = normalized.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : `/${segment}`;
      chain.push({ path: current, name: segment });
    }
    return chain;
  }

  const driveMatch = /^([a-zA-Z]:)\\?/.exec(normalized);
  if (!driveMatch) return [{ path: normalized, name: nameOf(side, normalized) }];
  const root = `${driveMatch[1]}\\`;
  const chain: Array<Pick<DockNode, "path" | "name">> = [{ path: root, name: root }];
  const rest = normalized.slice(driveMatch[0].length).split("\\").filter(Boolean);
  let current = root;
  for (const segment of rest) {
    current = current.endsWith("\\") ? `${current}${segment}` : `${current}\\${segment}`;
    chain.push({ path: current, name: segment });
  }
  return chain;
}

function emptyNode(path: string, name: string): DockNode {
  return { path, name, expanded: false, loading: false, loaded: false, children: null };
}

function ensureTreePath(current: DockNode | null, side: DockSide, targetPath: string): DockNode | null {
  const chain = pathChain(side, targetPath);
  if (chain.length === 0) return current;
  const [rootDescriptor] = chain;
  const root =
    current && sameDockPath(side, current.path, rootDescriptor.path)
      ? current
      : emptyNode(rootDescriptor.path, rootDescriptor.name);

  const mergeAt = (node: DockNode, index: number): DockNode => {
    const descriptor = chain[index];
    const isAncestor = index < chain.length - 1;
    const next: DockNode = {
      ...node,
      path: descriptor.path,
      name: descriptor.name,
      expanded: isAncestor ? true : node.expanded,
      loading: false
    };
    if (!isAncestor) return next;

    const childDescriptor = chain[index + 1];
    const children = next.children ? [...next.children] : [];
    let childIndex = children.findIndex((child) => sameDockPath(side, child.path, childDescriptor.path));
    if (childIndex < 0) {
      childIndex = children.length;
      children.push(emptyNode(childDescriptor.path, childDescriptor.name));
    }
    children[childIndex] = mergeAt(children[childIndex], index + 1);
    return { ...next, children };
  };

  return mergeAt(root, 0);
}

function directoryNodeChildren(side: DockSide, entries: FileEntry[], existingChildren: DockNode[] | null | undefined) {
  const existing = existingChildren ?? [];
  return entries
    .filter((entry) => entry.isDir)
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .map((entry) => {
      const found = existing.find((child) => sameDockPath(side, child.path, entry.path));
      return found ? { ...found, path: entry.path, name: entry.name, loading: false } : emptyNode(entry.path, entry.name);
    });
}

function updateTreeNode(
  current: DockNode | null,
  side: DockSide,
  targetPath: string,
  updater: (node: DockNode) => DockNode
): DockNode | null {
  if (!current) return current;
  const visit = (node: DockNode): DockNode => {
    if (sameDockPath(side, node.path, targetPath)) return updater(node);
    if (!node.children) return node;
    return { ...node, children: node.children.map(visit) };
  };
  return visit(current);
}

function mergeLoadedChildren(
  current: DockNode | null,
  side: DockSide,
  parent: string,
  entries: FileEntry[],
  expandParent: boolean
): DockNode | null {
  return updateTreeNode(current, side, parent, (node) => ({
    ...node,
    expanded: expandParent ? true : node.expanded,
    loading: false,
    loaded: true,
    children: directoryNodeChildren(side, entries, node.children)
  }));
}

export function TerminalFileDock({
  side,
  profileId,
  dropTargetId,
  sessionLabel,
  followPath,
  height,
  dropActive = false,
  transferRecordCount = 0,
  runningTransferCount = 0,
  onHeightChange,
  listDir,
  resolveHome,
  onOpenFile,
  onDownloadEntries,
  onUploadEntries,
  onRemoveEntries,
  onTransferEntriesToDirectory,
  onCopyText,
  onOpenTransferQueue,
  onClose
}: TerminalFileDockProps) {
  const [path, setPath] = useState<string>("");
  const [pathDraft, setPathDraft] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [sort, setSort] = useState<FileSort>(defaultFileSort);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tree, setTree] = useState<DockNode | null>(null);
  const [treeDropPath, setTreeDropPath] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const followedRef = useRef<string | null>(null);
  const dockDragRef = useRef<DockDragPayload | null>(null);

  const hydrateTreeAroundPath = useCallback(
    async (target: string, targetEntries: FileEntry[], seq: number) => {
      const chain = pathChain(side, target);
      const ancestorPaths = chain.slice(0, -1).map((item) => item.path);
      const ancestorLists = await Promise.all(
        ancestorPaths.map(async (ancestor) => {
          try {
            return { path: ancestor, entries: await listDir(ancestor) };
          } catch {
            return null;
          }
        })
      );
      if (requestSeq.current !== seq) return;
      setTree((current) => {
        let next = ensureTreePath(current, side, target);
        for (const loaded of ancestorLists) {
          if (loaded) next = mergeLoadedChildren(next, side, loaded.path, loaded.entries, true);
        }
        next = mergeLoadedChildren(next, side, target, targetEntries, false);
        return next;
      });
    },
    [listDir, side]
  );

  const navigate = useCallback(
    async (nextPath: string) => {
      const target = normalizeDockPath(side, nextPath);
      if (!target) return;
      const seq = ++requestSeq.current;
      setLoading(true);
      setError("");
      try {
        const list = await listDir(target);
        if (requestSeq.current !== seq) return;
        setEntries(list);
        setSelected(null);
        setSelectedPaths([]);
        setPath(target);
        setPathDraft(target);
        setTree((current) => ensureTreePath(current, side, target));
        void hydrateTreeAroundPath(target, list, seq);
      } catch (err) {
        if (requestSeq.current !== seq) return;
        setError(String(err));
      } finally {
        if (requestSeq.current === seq) setLoading(false);
      }
    },
    [hydrateTreeAroundPath, listDir, side]
  );

  useEffect(() => {
    let cancelled = false;
    void resolveHome()
      .then((home) => {
        if (cancelled) return;
        const normalizedHome = normalizeDockPath(side, home);
        const root = rootOf(side, normalizedHome);
        setTree(ensureTreePath({ path: root, name: root, expanded: true, loading: false, loaded: false, children: null }, side, normalizedHome));
        void navigate(normalizedHome);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, sessionLabel]);

  useEffect(() => {
    if (!followPath) return;
    const normalizedFollowPath = normalizeDockPath(side, followPath);
    if (!normalizedFollowPath || followedRef.current === normalizedFollowPath) return;
    followedRef.current = normalizedFollowPath;
    if (!sameDockPath(side, normalizedFollowPath, path)) void navigate(normalizedFollowPath);
  }, [followPath, navigate, path, side]);

  const sortedEntries = useMemo(() => sortFiles(entries, sort), [entries, sort]);
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedEntries = useMemo(() => sortedEntries.filter((entry) => selectedPathSet.has(entry.path)), [selectedPathSet, sortedEntries]);

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.isDir) void navigate(entry.path);
      else onOpenFile(entry);
    },
    [navigate, onOpenFile]
  );

  const copyDockText = useCallback(
    async (title: string, text: string) => {
      if (!text) return;
      if (onCopyText) {
        await onCopyText({ title, text });
        return;
      }
      await navigator.clipboard?.writeText(text).catch(() => undefined);
    },
    [onCopyText]
  );

  const removeSelectedEntries = useCallback(async () => {
    if (!onRemoveEntries || selectedEntries.length === 0) return;
    await onRemoveEntries(selectedEntries, path);
    if (path) void navigate(path);
  }, [navigate, onRemoveEntries, path, selectedEntries]);

  const dragPayloadFromEvent = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const payload = dockDragRef.current ?? readDockDragPayload(event.dataTransfer);
      if (!payload || payload.side !== side) return null;
      if (side === "remote" && payload.profileId !== (profileId ?? null)) return null;
      return payload;
    },
    [profileId, side]
  );

  const contextActions = useMemo<FileAction[]>(
    () => {
      const hasSelection = selectedEntries.length > 0;
      return [
        {
          label: "打开",
          icon: <FolderOpen size={14} />,
          disabled: !selected,
          onClick: () => {
            if (selected) openEntry(selected);
          }
        },
        side === "remote"
          ? {
              label: "下载到本地",
              icon: <Download size={14} />,
              disabled: !onDownloadEntries || !hasSelection,
              onClick: () => {
                if (onDownloadEntries) void onDownloadEntries(selectedEntries, path);
              }
            }
          : {
              label: "上传到远程",
              icon: <Upload size={14} />,
              disabled: !onUploadEntries || !hasSelection,
              onClick: () => {
                if (onUploadEntries) void onUploadEntries(selectedEntries, path);
              }
            },
        { type: "separator" },
        {
          label: "删除",
          icon: <Trash2 size={14} />,
          disabled: !onRemoveEntries || !hasSelection,
          danger: true,
          onClick: () => {
            void removeSelectedEntries();
          }
        },
        { type: "separator" },
        {
          label: "复制路径",
          icon: <Copy size={14} />,
          disabled: !hasSelection,
          onClick: () => {
            void copyDockText("复制路径", selectedEntries.map((entry) => entry.path).join("\n"));
          }
        },
        {
          label: "复制名称",
          icon: <Copy size={14} />,
          disabled: !hasSelection,
          onClick: () => {
            void copyDockText("复制名称", selectedEntries.map((entry) => entry.name).join("\n"));
          }
        },
        { type: "separator" },
        {
          label: "全选",
          icon: <ListChecks size={14} />,
          disabled: sortedEntries.length === 0,
          onClick: () => {
            setSelected(sortedEntries[0] ?? null);
            setSelectedPaths(sortedEntries.map((entry) => entry.path));
          }
        },
        {
          label: "清空选择",
          icon: <ListX size={14} />,
          disabled: !hasSelection,
          onClick: () => {
            setSelected(null);
            setSelectedPaths([]);
          }
        },
        { type: "separator" },
        {
          label: "刷新",
          icon: <RefreshCcw size={14} />,
          onClick: () => {
            if (path) void navigate(path);
          }
        }
      ];
    },
    [copyDockText, navigate, onDownloadEntries, onRemoveEntries, onUploadEntries, openEntry, path, removeSelectedEntries, selected, selectedEntries, side, sortedEntries]
  );

  const loadNodeChildren = useCallback(
    async (target: DockNode) => {
      setTree((current) => updateTreeNode(current, side, target.path, (node) => ({ ...node, loading: true })));
      try {
        const list = await listDir(target.path);
        setTree((current) => mergeLoadedChildren(current, side, target.path, list, true));
      } catch {
        setTree((current) => updateTreeNode(current, side, target.path, (node) => ({ ...node, loading: false })));
      }
    },
    [listDir, side]
  );

  const toggleNode = useCallback(
    (node: DockNode) => {
      if (!node.loaded) {
        void loadNodeChildren(node);
        return;
      }
      setTree((current) =>
        updateTreeNode(current, side, node.path, (item) => ({
          ...item,
          expanded: !item.expanded
        }))
      );
    },
    [loadNodeChildren, side]
  );

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const delta = startY - moveEvent.clientY;
      onHeightChange(Math.min(520, Math.max(160, Math.round(startHeight + delta))));
    };
    const handleUp = () => {
      document.body.classList.remove("is-resizing-terminal-layout");
      window.dispatchEvent(new CustomEvent("rustshell:terminal-layout-resize-end"));
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    document.body.classList.add("is-resizing-terminal-layout");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  const handleSelect = (entry: FileEntry, event: MouseEvent<HTMLButtonElement>) => {
    setSelected(entry);
    if (event.ctrlKey || event.metaKey) {
      setSelectedPaths((current) => {
        const exists = current.includes(entry.path);
        const next = exists ? current.filter((item) => item !== entry.path) : [...current, entry.path];
        return next.length > 0 ? next : [entry.path];
      });
      return;
    }
    if (event.shiftKey && selectedPaths.length > 0) {
      const anchorIndex = sortedEntries.findIndex((item) => item.path === selectedPaths[selectedPaths.length - 1]);
      const targetIndex = sortedEntries.findIndex((item) => item.path === entry.path);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        setSelectedPaths(sortedEntries.slice(start, end + 1).map((item) => item.path));
        return;
      }
    }
    setSelectedPaths([entry.path]);
  };

  const handleFileDragStart = (entry: FileEntry, event: DragEvent<HTMLButtonElement>) => {
    const entries = selectedPathSet.has(entry.path) && selectedEntries.length > 0 ? selectedEntries : [entry];
    if (!selectedPathSet.has(entry.path)) {
      setSelected(entry);
      setSelectedPaths([entry.path]);
    }
    const payload: DockDragPayload = {
      source: "terminal-file-dock",
      side,
      profileId: profileId ?? null,
      entries: entries.map((item) => ({ path: item.path, name: item.name, isDir: item.isDir }))
    };
    dockDragRef.current = payload;
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", entries.map((item) => item.path).join("\n"));
    event.dataTransfer.setData(DOCK_DRAG_TYPE, JSON.stringify(payload));
  };

  const prepareContextMenu = (_event: MouseEvent, entry?: FileEntry, alreadySelected = false) => {
    if (entry && !alreadySelected) {
      setSelected(entry);
      setSelectedPaths([entry.path]);
    }
  };

  const handleTreeNodeDragOver = (node: DockNode, event: DragEvent<HTMLButtonElement>) => {
    const payload = dragPayloadFromEvent(event);
    if (!payload || !onTransferEntriesToDirectory || !canDropEntriesOnDirectory(side, payload.entries, node.path)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.ctrlKey ? "copy" : "move";
    setTreeDropPath(node.path);
  };

  const handleTreeNodeDragLeave = (node: DockNode, event: DragEvent<HTMLButtonElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    setTreeDropPath((current) => (current && sameDockPath(side, current, node.path) ? null : current));
  };

  const handleTreeNodeDrop = async (node: DockNode, event: DragEvent<HTMLButtonElement>) => {
    const payload = dragPayloadFromEvent(event);
    setTreeDropPath(null);
    if (!payload || !onTransferEntriesToDirectory || !canDropEntriesOnDirectory(side, payload.entries, node.path)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    await onTransferEntriesToDirectory(payload.entries, node.path, event.ctrlKey ? "copy" : "move");
    if (path) void navigate(path);
    void loadNodeChildren(node);
  };

  const renderNode = (node: DockNode, depth: number) => (
    <div key={node.path}>
      <button
        type="button"
        data-file-pane-side={side}
        data-file-drop-target-id={dropTargetId}
        data-file-drop-profile-id={side === "remote" ? profileId || undefined : undefined}
        data-file-drop-target-path={side === "remote" ? node.path : undefined}
        className={cn(
          "flex h-6 w-full min-w-0 items-center gap-1 rounded-sm px-1 text-left text-xs hover:bg-accent",
          sameDockPath(side, path, node.path) && "bg-accent text-foreground",
          treeDropPath && sameDockPath(side, treeDropPath, node.path) && "bg-primary/10 text-primary ring-1 ring-primary/40"
        )}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
        title={node.path}
        onClick={() => void navigate(node.path)}
        onDragOver={(event) => handleTreeNodeDragOver(node, event)}
        onDragLeave={(event) => handleTreeNodeDragLeave(node, event)}
        onDrop={(event) => {
          void handleTreeNodeDrop(node, event);
        }}
      >
        <span
          className="grid size-4 flex-none place-items-center rounded-sm hover:bg-border"
          onClick={(event) => {
            event.stopPropagation();
            toggleNode(node);
          }}
        >
          {node.loading ? (
            <RefreshCcw size={11} className="animate-spin" />
          ) : node.expanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )}
        </span>
        <Folder size={12} className="flex-none text-muted-foreground" />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
      {node.expanded && node.children && node.children.map((child) => renderNode(child, depth + 1))}
    </div>
  );

  return (
    <section
      data-terminal-file-dock
      data-file-pane-side={side}
      data-file-drop-target-id={dropTargetId}
      data-file-drop-profile-id={side === "remote" ? profileId || undefined : undefined}
      data-file-drop-target-path={side === "remote" ? path || undefined : undefined}
      className={cn(
        "relative flex min-h-0 flex-col overflow-hidden border-t bg-background",
        dropActive && side === "remote" && "outline-dashed outline-1 outline-offset-[-2px] outline-primary/60"
      )}
      style={{ height }}
    >
      <div
        className="absolute inset-x-0 -top-px z-20 flex h-2 cursor-row-resize items-center justify-center hover:bg-ring/20"
        title="拖拽调整文件区高度"
        onPointerDown={beginResize}
      >
        <span className="h-px w-16 rounded-full bg-border" />
      </div>
      <div className="flex h-8 flex-none items-center gap-1.5 border-b px-2">
        <Input
          className="h-6 min-w-0 flex-1 px-2 font-mono text-[11px]"
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void navigate(pathDraft);
          }}
        />
        <IconButton
          className="h-6 w-6 min-w-6 p-0"
          title="上级目录"
          icon={<ArrowUp size={13} />}
          onClick={() => {
            const parent = parentPath(side, pathDraft.trim() || path);
            if (parent) void navigate(parent);
          }}
        />
        <IconButton className="h-6 w-6 min-w-6 p-0" title="刷新" icon={<RefreshCcw size={13} />} onClick={() => path && void navigate(path)} />
        <IconButton
          className={cn(
            "h-6 min-w-6 p-0",
            transferRecordCount > 0 && "w-auto px-1.5",
            runningTransferCount > 0 && "border-primary/50 text-primary"
          )}
          title={
            runningTransferCount > 0
              ? `传输记录：${runningTransferCount} 个运行中 / ${transferRecordCount} 条记录`
              : `传输记录：${transferRecordCount} 条`
          }
          label={transferRecordCount > 0 ? String(transferRecordCount) : undefined}
          icon={<ListChecks size={13} />}
          onClick={() => {
            onOpenTransferQueue?.();
          }}
          disabled={!onOpenTransferQueue}
        />
        <IconButton className="h-6 w-6 min-w-6 p-0" title="关闭文件区" icon={<X size={13} />} onClick={onClose} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)] overflow-hidden">
        <div data-scroll-container className="min-h-0 overflow-auto border-r bg-muted/20 p-1">
          {tree ? renderNode(tree, 0) : <div className="p-2 text-xs text-muted-foreground">目录树加载中...</div>}
        </div>
        <div className="relative min-h-0 overflow-hidden">
          {error ? (
            <div className="p-3 text-xs text-destructive">{error}</div>
          ) : (
            <>
              <FileList
                files={sortedEntries}
                compareMarks={emptyCompareMarks}
                selected={selected}
                selectedPaths={selectedPaths}
                sort={sort}
                onSelect={handleSelect}
                onSort={(key) => setSort((current) => nextFileSort(current, key))}
                onOpen={openEntry}
                onDragStart={handleFileDragStart}
                onDragEnd={() => {
                  dockDragRef.current = null;
                  setTreeDropPath(null);
                }}
                onSelectAll={() => setSelectedPaths(sortedEntries.map((entry) => entry.path))}
                onClearSelection={() => {
                  setSelected(null);
                  setSelectedPaths([]);
                }}
                onRemove={() => {
                  void removeSelectedEntries();
                }}
                onRename={() => undefined}
                onContextMenu={prepareContextMenu}
                contextActions={contextActions}
                compareMarkLabel={compareMarkLabel}
                formatOwner={formatOwner}
                formatSize={formatSize}
                formatFileDateTime={formatFileDateTime}
                formatEntrySymbolicMode={formatEntrySymbolicMode}
                variant="flat"
              />
              {loading && (
                <div className="pointer-events-none absolute right-3 top-3 rounded-sm border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
                  加载中...
                </div>
              )}
              {!loading && sortedEntries.length === 0 && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted-foreground">
                  空目录
                </div>
              )}
              {dropActive && side === "remote" && (
                <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border border-dashed border-primary/60 bg-background/85 text-[13px] text-foreground shadow-sm">
                  拖放到此远程目录上传
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
