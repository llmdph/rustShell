import { api, type FileEntry, type Profile } from "@/api";
import type { AppConfirmOptions, AppPromptOptions } from "@/features/dialogs/dialogTypes";
import { uniqueDuplicateName } from "@/features/files/filePaneModel";
import { isLocalProtocol } from "@/features/sessions/profileProtocol";

type PromptText = (title: string, options?: AppPromptOptions) => Promise<string | null>;
type ConfirmAction = (title: string, options?: AppConfirmOptions) => Promise<boolean>;
type PushToast = (tone: "success" | "info" | "error", text: string) => void;

type FileMutationActionParams = {
  activeProfile: Profile | null;
  passwordForActive: string | null;
  localPath: string;
  remotePath: string;
  localFiles: FileEntry[];
  remoteFiles: FileEntry[];
  visibleSelectedLocalEntries: FileEntry[];
  visibleSelectedRemoteEntries: FileEntry[];
  promptText: PromptText;
  confirmAction: ConfirmAction;
  refreshLocalFiles: (preferPath?: string) => Promise<void>;
  refreshRemoteFiles: (preferPath?: string) => Promise<void>;
  requestActiveProfileSecretIfNeeded: (error: unknown) => boolean;
  setStatus: (status: string) => void;
  pushToast: PushToast;
};

export function buildFileMutationActions({
  activeProfile,
  passwordForActive,
  localPath,
  remotePath,
  localFiles,
  remoteFiles,
  visibleSelectedLocalEntries,
  visibleSelectedRemoteEntries,
  promptText,
  confirmAction,
  refreshLocalFiles,
  refreshRemoteFiles,
  requestActiveProfileSecretIfNeeded,
  setStatus,
  pushToast
}: FileMutationActionParams) {
  const duplicateRemoteSelected = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const occupiedNames = new Set(remoteFiles.map((file) => file.name));
    const targets = entries.map((entry) => {
      const name = uniqueDuplicateName(entry.name, occupiedNames);
      occupiedNames.add(name);
      return { entry, name };
    });

    if (targets.length === 1) {
      const name = await promptText("复制为", { defaultValue: targets[0].name });
      if (!name || name === targets[0].entry.name) return;
      targets[0].name = name;
    } else if (
      !(await confirmAction("复制远程项目", {
        message: `确认复制 ${targets.length} 个远程项目到当前目录？`,
        confirmLabel: "复制"
      }))
    ) {
      return;
    }

    if (targets.length === 1) {
      try {
        const lastPath = await api.duplicateRemotePath(
          activeProfile.id,
          targets[0].entry.path,
          targets[0].entry.isDir,
          targets[0].name,
          passwordForActive
        );
        await refreshRemoteFiles(lastPath);
        pushToast("success", "远程副本已创建");
      } catch (error) {
        if (requestActiveProfileSecretIfNeeded(error)) return;
        pushToast("error", `复制失败: ${String(error)}`);
      }
      return;
    }

    const failures: string[] = [];
    let copied = 0;
    for (const { entry, name } of targets) {
      try {
        await api.duplicateRemotePath(activeProfile.id, entry.path, entry.isDir, name, passwordForActive);
        copied += 1;
      } catch (error) {
        failures.push(`${entry.name}: ${String(error)}`);
      }
    }
    await refreshRemoteFiles();
    if (copied > 0) pushToast("success", `已创建 ${copied} 个远程副本`);
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`复制失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `复制失败 ${failures.length} 个项目`);
      if (requestActiveProfileSecretIfNeeded(failures[0])) return;
    }
  };

  const duplicateLocalSelected = async () => {
    const entries = visibleSelectedLocalEntries;
    if (entries.length === 0) return;
    const occupiedNames = new Set(localFiles.map((file) => file.name));
    const targets = entries.map((entry) => {
      const name = uniqueDuplicateName(entry.name, occupiedNames);
      occupiedNames.add(name);
      return { entry, name };
    });

    if (targets.length === 1) {
      const name = await promptText("复制为", { defaultValue: targets[0].name });
      if (!name || name === targets[0].entry.name) return;
      targets[0].name = name;
    } else if (
      !(await confirmAction("复制本地项目", {
        message: `确认复制 ${targets.length} 个本地项目到当前目录？`,
        confirmLabel: "复制"
      }))
    ) {
      return;
    }

    if (targets.length === 1) {
      try {
        const lastPath = await api.duplicateLocalPath(targets[0].entry.path, targets[0].name);
        await refreshLocalFiles(lastPath);
        pushToast("success", "本地副本已创建");
      } catch (error) {
        pushToast("error", `复制失败: ${String(error)}`);
      }
      return;
    }

    const failures: string[] = [];
    let copied = 0;
    for (const { entry, name } of targets) {
      try {
        await api.duplicateLocalPath(entry.path, name);
        copied += 1;
      } catch (error) {
        failures.push(`${entry.name}: ${String(error)}`);
      }
    }
    await refreshLocalFiles();
    if (copied > 0) pushToast("success", `已创建 ${copied} 个本地副本`);
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`复制失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `复制失败 ${failures.length} 个项目`);
    }
  };

  const moveLocalSelected = async () => {
    const entries = visibleSelectedLocalEntries;
    if (entries.length === 0) return;
    const multiple = entries.length > 1;
    const target = await promptText(multiple ? "批量移动到本地目录" : "移动到本地目录或完整路径", { defaultValue: localPath });
    if (!target?.trim()) return;
    const targetPath = target.trim();
    try {
      if (multiple) {
        await api.listLocalDir(targetPath);
        const failures: string[] = [];
        let moved = 0;
        for (const entry of entries) {
          try {
            await api.moveLocalPath(entry.path, targetPath);
            moved += 1;
          } catch (error) {
            failures.push(`${entry.name}: ${String(error)}`);
          }
        }
        await refreshLocalFiles();
        if (moved > 0) pushToast("success", `已移动 ${moved} 个本地项目`);
        if (failures.length > 0) {
          const summary = failures.slice(0, 3).join("；");
          setStatus(`移动失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
          pushToast("error", `移动失败 ${failures.length} 个项目`);
        }
      } else {
        const path = await api.moveLocalPath(entries[0].path, targetPath);
        await refreshLocalFiles(path);
        pushToast("success", "本地项目已移动");
      }
    } catch (error) {
      pushToast("error", `移动失败: ${String(error)}`);
    }
  };

  const moveRemoteSelected = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const multiple = entries.length > 1;
    const target = await promptText(multiple ? "批量移动到远程目录" : "移动到远程目录或完整路径", { defaultValue: remotePath });
    if (!target?.trim()) return;
    const targetPath = target.trim();
    try {
      if (multiple) {
        await api.listRemoteDir(activeProfile.id, targetPath, passwordForActive);
        const failures: string[] = [];
        let moved = 0;
        for (const entry of entries) {
          try {
            await api.moveRemotePath(activeProfile.id, entry.path, targetPath, passwordForActive);
            moved += 1;
          } catch (error) {
            failures.push(`${entry.name}: ${String(error)}`);
          }
        }
        await refreshRemoteFiles();
        if (moved > 0) pushToast("success", `已移动 ${moved} 个项目`);
        if (failures.length > 0) {
          const summary = failures.slice(0, 3).join("；");
          setStatus(`移动失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
          pushToast("error", `移动失败 ${failures.length} 个项目`);
          if (requestActiveProfileSecretIfNeeded(failures[0])) return;
        }
      } else {
        const path = await api.moveRemotePath(activeProfile.id, entries[0].path, targetPath, passwordForActive);
        await refreshRemoteFiles(path);
        pushToast("success", "远程项目已移动");
      }
    } catch (error) {
      if (requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `移动失败: ${String(error)}`);
    }
  };

  return {
    duplicateRemoteSelected,
    duplicateLocalSelected,
    moveLocalSelected,
    moveRemoteSelected
  };
}
