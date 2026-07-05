import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { Dispatch, SetStateAction } from "react";

import { api, hasTauriRuntime, type Profile } from "@/api";
import { downloadTextFile, pickTextFile } from "@/lib/browserFiles";
import type { AppConfirmOptions } from "@/features/dialogs/dialogTypes";
import { profileAuthKind, profileKeyPath } from "@/features/sessions/profileAuth";
import {
  createBlankProfile,
  isPublicKeyPath,
  normalizeProfile,
  normalizeProfiles
} from "@/features/sessions/profileModel";
import {
  isLocalProtocol,
  normalizeSavedProtocol
} from "@/features/sessions/profileProtocol";
import {
  isProtectedSessionFolder,
  isSessionGroupInsideFolder,
  normalizeSessionGroupPath,
  sessionGroupParent
} from "@/features/sessions/sessionFolders";

type ConfirmAction = (title: string, options?: AppConfirmOptions) => Promise<boolean>;
type PushToast = (tone: "success" | "info" | "error", text: string) => void;

type SessionActionParams = {
  profiles: Profile[];
  editingProfile: Profile | null;
  profileSecrets: Record<string, string>;
  profileSecretDrafts: Record<string, string>;
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  setEditingProfile: Dispatch<SetStateAction<Profile | null>>;
  setSelectedProfileId: Dispatch<SetStateAction<string | null>>;
  setDialog: (dialog: "profile" | null) => void;
  rememberProfileSecret: (profileId: string, password?: string | null) => void;
  forgetProfileSecret: (profileId: string) => void;
  confirmAction: ConfirmAction;
  pushToast: PushToast;
};

export function buildSessionActions({
  profiles,
  editingProfile,
  profileSecrets,
  profileSecretDrafts,
  setProfiles,
  setEditingProfile,
  setSelectedProfileId,
  setDialog,
  rememberProfileSecret,
  forgetProfileSecret,
  confirmAction,
  pushToast
}: SessionActionParams) {
  const openProfileEditor = (profile?: Profile, group?: string) => {
    if (!profile) {
      const blank = createBlankProfile();
      setEditingProfile(group ? { ...blank, group: normalizeSessionGroupPath(group) } : blank);
      setDialog("profile");
      return;
    }

    const normalized = normalizeProfile(profile);
    setEditingProfile({
      ...normalized,
      password: profileSecretDrafts[normalized.id] ?? profileSecrets[normalized.id] ?? normalized.password ?? ""
    });
    setDialog("profile");
  };

  const saveProfile = async () => {
    if (!editingProfile) return;
    try {
      const profileToSave = normalizeProfile(editingProfile);
      if (profileAuthKind(profileToSave.auth) === "KeyFile" && isPublicKeyPath(profileKeyPath(profileToSave.auth))) {
        pushToast("error", "请选择私钥文件，不要选择 .pub 公钥文件");
        return;
      }
      const next = await api.saveProfile({
        ...profileToSave,
        protocol: normalizeSavedProtocol(profileToSave.protocol, profileToSave)
      });
      if (profileToSave.password?.trim()) {
        rememberProfileSecret(profileToSave.id, profileToSave.password);
      } else if (isLocalProtocol(profileToSave.protocol) || !profileToSave.rememberPassword) {
        forgetProfileSecret(profileToSave.id);
      }
      setProfiles(normalizeProfiles(next));
      setSelectedProfileId(profileToSave.id);
      setDialog(null);
      pushToast("success", "会话已保存");
    } catch (error) {
      pushToast("error", `会话保存失败: ${String(error)}`);
    }
  };

  const pickProfileKeyFile = async () => {
    if (!editingProfile) return;
    if (!hasTauriRuntime()) {
      pushToast("info", "浏览器预览模式下请手动填写私钥路径");
      return;
    }
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "选择 SSH 私钥文件"
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      if (isPublicKeyPath(path)) {
        pushToast("error", "这是公钥文件，请选择没有 .pub 后缀的私钥");
        return;
      }
      setEditingProfile((current) => (current ? { ...current, auth: { KeyFile: { path } } } : current));
    } catch (error) {
      pushToast("error", `选择密钥文件失败: ${String(error)}`);
    }
  };

  const exportSessions = async () => {
    try {
      const payload = await api.exportProfiles();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadTextFile(`rustshell-sessions-${stamp}.json`, payload);
      await navigator.clipboard?.writeText(payload).catch(() => undefined);
      pushToast("success", "会话已导出");
    } catch (error) {
      pushToast("error", `会话导出失败: ${String(error)}`);
    }
  };

  const importSessions = async () => {
    try {
      const payload = await pickTextFile(".json,application/json");
      if (!payload) return;
      const replace = await confirmAction("导入会话", {
        message: "确定替换现有会话？取消则合并导入。密码不会从 JSON 导入。",
        confirmLabel: "替换导入",
        cancelLabel: "合并导入"
      });
      const next = await api.importProfiles(payload, replace);
      setProfiles(normalizeProfiles(next));
      pushToast("success", replace ? "会话已替换导入" : "会话已合并导入");
    } catch (error) {
      pushToast("error", `会话导入失败: ${String(error)}`);
    }
  };

  const duplicateSession = async (profile: Profile) => {
    try {
      const next = await api.duplicateProfile(profile.id);
      setProfiles(normalizeProfiles(next));
      pushToast("success", "会话已复制");
    } catch (error) {
      pushToast("error", `会话复制失败: ${String(error)}`);
    }
  };

  const deleteSession = async (profile: Profile) => {
    if (
      !(await confirmAction("删除会话", {
        message: `确定删除会话 "${profile.name}"？`,
        confirmLabel: "删除",
        danger: true
      }))
    ) {
      return;
    }
    try {
      const next = await api.deleteProfile(profile.id);
      setProfiles(normalizeProfiles(next));
      setSelectedProfileId((current) => (current === profile.id ? null : current));
      forgetProfileSecret(profile.id);
      pushToast("success", "会话已删除");
    } catch (error) {
      pushToast("error", `会话删除失败: ${String(error)}`);
    }
  };

  const deleteSessionFolder = async (path: string) => {
    const folder = normalizeSessionGroupPath(path);
    if (isProtectedSessionFolder(folder)) {
      pushToast("info", "内置目录不能删除");
      return false;
    }

    const targetGroup = sessionGroupParent(folder);
    const affectedProfiles = profiles.filter((profile) => isSessionGroupInsideFolder(profile.group, folder));
    const confirmed = await confirmAction("删除目录", {
      message:
        affectedProfiles.length > 0
          ? `确定删除目录 "${folder}"？\n目录内 ${affectedProfiles.length} 个会话会保留，并移动到 "${targetGroup}"。`
          : `确定删除空目录 "${folder}"？`,
      confirmLabel: "删除",
      danger: true
    });
    if (!confirmed) return false;

    if (affectedProfiles.length === 0) {
      pushToast("success", "目录已删除");
      return true;
    }

    try {
      let nextProfiles = profiles;
      for (const profile of affectedProfiles) {
        const next = await api.saveProfile({
          ...profile,
          group: targetGroup,
          protocol: normalizeSavedProtocol(profile.protocol, profile)
        });
        nextProfiles = normalizeProfiles(next);
      }
      setProfiles(nextProfiles);
      pushToast("success", `目录已删除，${affectedProfiles.length} 个会话已移动到 ${targetGroup}`);
      return true;
    } catch (error) {
      pushToast("error", `目录删除失败: ${String(error)}`);
      return false;
    }
  };

  return {
    openProfileEditor,
    saveProfile,
    pickProfileKeyFile,
    exportSessions,
    importSessions,
    duplicateSession,
    deleteSession,
    deleteSessionFolder
  };
}
