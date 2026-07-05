import { useCallback, useMemo, useState } from "react";

import type { Profile } from "@/api";
import {
  buildSessionFolderTree,
  loadSessionFolders,
  normalizeSessionFolderPart,
  normalizeSessionGroupPath,
  saveSessionFolders,
  sessionGroupSort,
  type SessionFolderNode
} from "@/features/sessions/sessionFolders";

export type SessionTreeItem =
  | { kind: "folder"; id: string; node: SessionFolderNode; depth: number; collapsed: boolean }
  | { kind: "profile"; id: string; profile: Profile; depth: number };

type UseSessionFoldersOptions = {
  profiles: Profile[];
  onPromptText: (title: string) => Promise<string | null>;
  onDeleteFolder: (group: string) => Promise<boolean>;
};

export function useSessionFolders({ profiles, onPromptText, onDeleteFolder }: UseSessionFoldersOptions) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [customFolders, setCustomFolders] = useState<string[]>(loadSessionFolders);
  const tree = useMemo(() => buildSessionFolderTree(profiles, customFolders), [customFolders, profiles]);
  const visibleItems = useMemo(() => {
    const items: SessionTreeItem[] = [];
    const visit = (node: SessionFolderNode, depth = 0) => {
      const collapsed = collapsedGroups.has(node.path);
      items.push({ kind: "folder", id: `folder-${node.path}`, node, depth, collapsed });
      if (collapsed) return;
      node.profiles.forEach((profile) => items.push({ kind: "profile", id: `profile-${profile.id}`, profile, depth: depth + 1 }));
      node.children.forEach((child) => visit(child, depth + 1));
    };
    tree.forEach((node) => visit(node));
    return items;
  }, [collapsedGroups, tree]);

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }, []);

  const addFolder = useCallback(
    async (parentPath: string) => {
      const name = await onPromptText("新建目录");
      const normalizedName = normalizeSessionFolderPart(name ?? "");
      if (!normalizedName) return;
      const nextPath = normalizeSessionGroupPath(`${parentPath}/${normalizedName}`);
      setCustomFolders((current) => {
        if (current.includes(nextPath)) return current;
        const next = [...current, nextPath].sort((left, right) => sessionGroupSort(left, right));
        saveSessionFolders(next);
        return next;
      });
      setCollapsedGroups((current) => {
        const next = new Set(current);
        next.delete(parentPath);
        return next;
      });
    },
    [onPromptText]
  );

  const deleteFolder = useCallback(
    async (path: string) => {
      const normalizedPath = normalizeSessionGroupPath(path);
      const deleted = await onDeleteFolder(normalizedPath);
      if (!deleted) return;
      setCustomFolders((current) => {
        const next = current.filter((item) => item !== normalizedPath && !item.startsWith(`${normalizedPath}/`));
        saveSessionFolders(next);
        return next;
      });
      setCollapsedGroups((current) => {
        const next = new Set<string>();
        for (const group of current) {
          if (group !== normalizedPath && !group.startsWith(`${normalizedPath}/`)) {
            next.add(group);
          }
        }
        return next;
      });
    },
    [onDeleteFolder]
  );

  return { visibleItems, toggleGroup, addFolder, deleteFolder };
}
