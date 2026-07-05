import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit as emitTauriEvent, listen as listenTauriEvent } from "@tauri-apps/api/event";
import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type CSSProperties
} from "react";
import {
  api,
  hasTauriRuntime,
  type AppSettings,
  type FileEntry,
  type Profile,
  type QuickConnectRequest,
  type RemotePathStats,
  type ServerStatus,
  type TextFile,
  type TerminalDrain,
  type TerminalView,
  type TransferConflictStrategy,
  type TransferView
} from "./api";
import { EventBus } from "./events";
import { AppDialogs, type AppDialog } from "./features/dialogs/AppDialogs";
import type {
  BatchRenamePlanItem,
  DeleteConfirmState,
  HostKeyPromptState,
  TextPreviewPosition
} from "./features/dialogs/dialogTypes";
import { editorFileMetadata } from "./features/dialogs/textEditorModel";
import { useAppModal } from "./features/dialogs/useAppModal";
import { useClipboardFallback } from "./features/dialogs/useClipboardFallback";
import {
  localCdCommand,
  shellQuote,
} from "./features/files/fileCommands";
import { buildFileCommandClipboardActions } from "./features/files/fileCommandClipboardActions";
import {
  buildLocalFilePaneActions,
  buildLocalFilePaneExtraActions,
  buildRemoteFilePaneActions,
  buildRemoteFilePaneExtraActions
} from "./features/files/filePaneActions";
import { FileManagerShell } from "./features/files/FileManagerShell";
import { FilePane } from "./features/files/FilePane";
import { SearchNotice } from "./features/files/FilePaneChrome";
import { buildDeleteConfirmActions } from "./features/files/deleteConfirmActions";
import { buildDirectoryCompareActions } from "./features/files/directoryCompareActions";
import { buildPropertiesReportActions, buildSelectedSha256Actions } from "./features/files/fileAuditActions";
import {
  compareKindLabel,
  compareMarkLabel,
  fileTypeLabel,
  formatDate,
  formatDateTimeLocal,
  formatEntrySymbolicMode,
  formatFileDateTime,
  formatOwner,
  formatSize
} from "./features/files/fileFormatters";
import { fileManagerProfileStorageKey, readFileManagerWindowParams } from "./features/files/fileManagerWindow";
import {
  commonEntryValue,
  emptyCompareMarks,
  metadataSyncChanges,
} from "./features/files/filePaneModel";
import { buildFileSelectionClipboardActions } from "./features/files/fileSelectionClipboardActions";
import { buildFileMutationActions } from "./features/files/fileMutationActions";
import { useFilePaneState } from "./features/files/useFilePaneState";
import type {
  FileDragPayload,
  FileSide,
} from "./features/files/filePaneTypes";
import {
  joinLocalPath,
  joinRemotePath,
  localParentPath,
  normalizeLocalComparablePath,
  normalizeRemotePath,
  parentPathForSide,
  pathBaseName,
  remoteParentPath,
  resolveSymlinkTargetPath
} from "./features/files/pathUtils";
import { parseDateTimeLocal, parseOptionalOwnerId, parseSyncPlanJson } from "./features/files/syncPlanImport";
import type { SyncPlanItem, SyncPlanState } from "./features/files/syncPlanTypes";
import { profileAuthKind } from "./features/sessions/profileAuth";
import { buildSessionActions } from "./features/sessions/sessionActions";
import {
  isLocalProtocol,
  isRemoteProtocol,
  isSshProtocol,
} from "./features/sessions/profileProtocol";
import {
  normalizeProfile,
  normalizeProfiles,
  normalizeQuickProtocol,
  shouldPromptForPassword
} from "./features/sessions/profileModel";
import { SessionSidebar } from "./features/sessions/SessionSidebar";
import { buildAppMenus } from "./features/shell/appMenus";
import { defaultQuick, defaultSettings } from "./features/shell/appDefaults";
import type { AppEvents } from "./features/shell/appEvents";
import { AppTopbar } from "./features/shell/AppTopbar";
import { useAppBootstrap, useAppTheme, useCommandPaletteShortcut, useSettingsSync } from "./features/shell/useAppShellEffects";
import { APP_BACKGROUND_EVENT, backgroundImageValue, loadAppBackground, type AppBackgroundConfig } from "./features/shell/appBackground";
import { TerminalFileDock } from "./features/terminal/TerminalFileDock";
import { loadFileDockAuto } from "./features/terminal/fileDockPrefs";
import { useTransientScrollbars } from "./features/shell/useTransientScrollbars";
import { useWorkspacePanels } from "./features/shell/useWorkspacePanels";
import { startWindowDrag } from "./features/shell/windowDrag";
import { WorkspaceLayout } from "./features/shell/WorkspaceLayout";
import { TerminalArea, type TerminalSplitDropTarget } from "./features/terminal/TerminalArea";
import { terminalSnippets } from "./features/terminal/terminalSnippets";
import { buildTransferAuditActions } from "./features/transfers/transferAuditActions";
import { buildTransferQueueProps } from "./features/transfers/transferQueueProps";
import { useTransferState } from "./features/transfers/useTransferState";
import type { SelectOption } from "@/components/app/AppSelect";
import { CommandPalette } from "@/components/app/CommandPalette";
import { toast as sonnerToast } from "sonner";

import type { Toast } from "@/components/app/toast";
import { Toaster } from "@/components/ui/sonner";
import type { WindowAction } from "@/components/app/WindowControls";
import { pickTextFile } from "@/lib/browserFiles";
import { cn } from "@/lib/utils";
import { formatMode, resolvePermissionMode } from "./features/files/permissions";

export default function App() {
  const fileWindowParams = useMemo(readFileManagerWindowParams, []);
  const isFileManagerWindow = fileWindowParams.isFileManagerWindow;
  const busRef = useRef(new EventBus<AppEvents>());
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tabs, setTabs] = useState<TerminalView[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(fileWindowParams.profileId);
  const [dialog, setDialog] = useState<AppDialog>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const { appModal, resolveAppModal, promptText, confirmAction, showTextDialog } = useAppModal();
  const copyWithFallback = useClipboardFallback(showTextDialog);
  const [quick, setQuick] = useState<QuickConnectRequest>(defaultQuick);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [secretProfileId, setSecretProfileId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [knownHostsText, setKnownHostsText] = useState("");
  const [status, setStatus] = useState("就绪");
  const [hostSearch, setHostSearch] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const {
    leftPanelCollapsed,
    rightPanelCollapsed,
    setLeftPanelCollapsed,
    setRightPanelCollapsed,
    startPanelResize,
    resetPanelWidth,
    workspaceStyle
  } = useWorkspacePanels(isFileManagerWindow);
  const [chmodTarget, setChmodTarget] = useState<FileEntry | null>(null);
  const [chmodTargets, setChmodTargets] = useState<FileEntry[]>([]);
  const [chmodSide, setChmodSide] = useState<FileSide>("remote");
  const [chmodMode, setChmodMode] = useState("755");
  const [chmodRecursive, setChmodRecursive] = useState(false);
  const [batchRenameSide, setBatchRenameSide] = useState<FileSide>("local");
  const [batchRenameTargets, setBatchRenameTargets] = useState<FileEntry[]>([]);
  const [batchRenameFind, setBatchRenameFind] = useState("");
  const [batchRenameReplace, setBatchRenameReplace] = useState("");
  const [batchRenamePrefix, setBatchRenamePrefix] = useState("");
  const [batchRenameSuffix, setBatchRenameSuffix] = useState("");
  const [batchRenameNumberStart, setBatchRenameNumberStart] = useState("1");
  const [batchRenameNumberPadding, setBatchRenameNumberPadding] = useState("2");
  const [batchRenamePreserveExtension, setBatchRenamePreserveExtension] = useState(true);
  const [batchRenameCaseSensitive, setBatchRenameCaseSensitive] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [syncPlan, setSyncPlan] = useState<SyncPlanState | null>(null);
  const [propertiesTarget, setPropertiesTarget] = useState<FileEntry | null>(null);
  const [propertiesTargets, setPropertiesTargets] = useState<FileEntry[]>([]);
  const [propertiesSide, setPropertiesSide] = useState<FileSide>("remote");
  const [propertiesUid, setPropertiesUid] = useState("");
  const [propertiesGid, setPropertiesGid] = useState("");
  const [propertiesMode, setPropertiesMode] = useState("");
  const [propertiesMtime, setPropertiesMtime] = useState("");
  const [propertiesStats, setPropertiesStats] = useState<RemotePathStats | null>(null);
  const [propertiesStatsLoading, setPropertiesStatsLoading] = useState(false);
  const [propertiesChecksum, setPropertiesChecksum] = useState("");
  const [propertiesChecksumLoading, setPropertiesChecksumLoading] = useState(false);
  const [propertiesRecursive, setPropertiesRecursive] = useState(false);
  const [editorFile, setEditorFile] = useState<TextFile | null>(null);
  const [editorSide, setEditorSide] = useState<FileSide>("remote");
  const [editorPreviewPosition, setEditorPreviewPosition] = useState<TextPreviewPosition>("head");
  const [editorContent, setEditorContent] = useState("");
  const {
    transfers,
    setTransfers,
    transferHistory,
    setTransferHistory,
    transfersRef,
    refreshTransfers
  } = useTransferState();
  const [transferConflict, setTransferConflict] = useState<TransferConflictStrategy>("overwrite");
  const [terminalCommands, setTerminalCommands] = useState<Record<string, string>>({});
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [serverStatusLoading, setServerStatusLoading] = useState(false);
  const [serverStatusError, setServerStatusError] = useState("");
  const serverStatusProfileIdRef = useRef<string | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPromptState | null>(null);
  const [dragOverSide, setDragOverSide] = useState<FileSide | null>(null);
  const [profileSecrets, setProfileSecrets] = useState<Record<string, string>>({});
  const [profileSecretDrafts, setProfileSecretDrafts] = useState<Record<string, string>>({});
  const authPromptedTabsRef = useRef(new Set<string>());
  const fileDragRef = useRef<FileDragPayload | null>(null);
  const transferStatusRef = useRef(new Map<string, TransferView["status"]>());
  const remoteFilePaneRef = useRef<HTMLDivElement | null>(null);

  const pushToast = useCallback((tone: Toast["tone"], text: string) => {
    if (tone === "success") sonnerToast.success(text);
    else if (tone === "error") sonnerToast.error(text);
    else sonnerToast.info(text);
  }, []);

  const {
    localPath,
    setLocalPath,
    remotePath,
    setRemotePath,
    remoteHomeReady,
    setRemoteHomeReady,
    remoteBrowserProfileId,
    localBackHistory,
    localForwardHistory,
    remoteBackHistory,
    setRemoteBackHistory,
    remoteForwardHistory,
    setRemoteForwardHistory,
    localPathBookmarks,
    remotePathBookmarks,
    localFiles,
    remoteFiles,
    showLocalHidden,
    setShowLocalHidden,
    showRemoteHidden,
    setShowRemoteHidden,
    localFilter,
    setLocalFilter,
    remoteFilter,
    setRemoteFilter,
    localSearch,
    remoteSearch,
    compareDirectories,
    setCompareDirectories,
    compareView,
    setCompareView,
    localSort,
    remoteSort,
    selectedRemote,
    selectedLocalPaths,
    selectedRemotePaths,
    localSelectionStats,
    remoteSelectionStats,
    selectionStatsLoading,
    setLocalSelectionStats,
    setRemoteSelectionStats,
    setSelectionStatsLoading,
    baseVisibleLocalFiles,
    baseVisibleRemoteFiles,
    directoryCompare,
    visibleLocalFiles,
    visibleRemoteFiles,
    directoryCompareCount,
    directoryCompareDiffCount,
    visibleSelectedLocal,
    visibleSelectedRemote,
    visibleSelectedLocalEntries,
    visibleSelectedRemoteEntries,
    clearLocalSelection,
    clearRemoteSelection,
    selectFile,
    selectAllFiles,
    invertFileSelection,
    selectComparedEntries,
    selectComparedPairs,
    navigateLocalPath,
    navigateRemotePath,
    goLocalHistory,
    goRemoteHistory,
    addPathBookmark,
    removePathBookmark,
    openPathBookmark,
    consumeLocalPreferPath,
    consumeRemotePreferPath,
    replaceLocalFiles,
    replaceRemoteFiles,
    applyLocalSearch,
    applyRemoteSearch,
    resetRemoteBrowserProfile,
    sortLocalBy,
    sortRemoteBy
  } = useFilePaneState({
    initialRemoteBrowserProfileId: isFileManagerWindow ? fileWindowParams.profileId : null,
    promptText,
    pushToast,
    setStatus
  });

  useTransientScrollbars();

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const selectedProfile = useMemo(
    () => (selectedProfileId ? profiles.find((profile) => profile.id === selectedProfileId) ?? null : null),
    [profiles, selectedProfileId]
  );
  const activeTerminalProfile = useMemo(
    () => (activeTab ? profiles.find((profile) => profile.id === activeTab.profileId) ?? null : null),
    [activeTab, profiles]
  );
  const activeProfile = useMemo(() => {
    if (activeTerminalProfile) return activeTerminalProfile;
    if (selectedProfile) return selectedProfile;
    return profiles.find((profile) => !isLocalProtocol(profile.protocol)) ?? profiles[0] ?? null;
  }, [activeTerminalProfile, profiles, selectedProfile]);
  const secretProfile = useMemo(
    () => (secretProfileId ? profiles.find((profile) => profile.id === secretProfileId) ?? null : null),
    [profiles, secretProfileId]
  );

  const activeProfileSecret = activeProfile ? profileSecrets[activeProfile.id] ?? "" : "";
  const activeProfileSecretDraft = activeProfile ? profileSecretDrafts[activeProfile.id] ?? activeProfileSecret : "";
  const passwordForActive = activeProfileSecretDraft || activeProfileSecret || null;
  const activeRemoteConnected = Boolean(
    activeProfile &&
      isRemoteProtocol(activeProfile.protocol) &&
      tabs.some((tab) => tab.profileId === activeProfile.id && tab.status === "connected")
  );
  const remoteBrowserReady = Boolean(
    activeProfile &&
      isRemoteProtocol(activeProfile.protocol) &&
      isFileManagerWindow &&
      remoteBrowserProfileId === activeProfile.id
  );

  useEffect(() => {
    if (!isFileManagerWindow || profiles.length === 0) return;
    const selected = selectedProfileId ? profiles.find((profile) => profile.id === selectedProfileId) ?? null : null;
    const profile =
      selected && isRemoteProtocol(selected.protocol)
        ? selected
        : profiles.find((item) => isRemoteProtocol(item.protocol)) ?? null;
    if (!profile) return;
    setSelectedProfileId((current) => {
      const currentProfile = current ? profiles.find((item) => item.id === current) ?? null : null;
      return currentProfile && isRemoteProtocol(currentProfile.protocol) ? current : profile.id;
    });
    if (remoteBrowserProfileId !== profile.id) {
      resetRemoteBrowserProfile(profile.id);
    }
  }, [isFileManagerWindow, profiles, remoteBrowserProfileId, resetRemoteBrowserProfile, selectedProfileId]);

  const profileSecretValue = (profile: Profile) =>
    profile.password || profileSecretDrafts[profile.id] || profileSecrets[profile.id] || "";
  const deferredSessionSearch = useDeferredValue(sessionSearch);
  const {
    copyDirectoryCompareCsv,
    downloadDirectoryCompareCsv,
    copyDirectoryCompareJson,
    downloadDirectoryCompareJson,
    copyDirectoryCompareDiffCsv,
    downloadDirectoryCompareDiffCsv
  } = buildDirectoryCompareActions({
    localPath,
    remotePath,
    baseVisibleLocalFiles,
    baseVisibleRemoteFiles,
    directoryCompare,
    directoryCompareCount,
    directoryCompareDiffCount,
    copyWithFallback,
    pushToast
  });

  const {
    copyTransferAuditCsv,
    downloadTransferAuditCsv,
    copyTransferAuditJson,
    downloadTransferAuditJson
  } = buildTransferAuditActions({
    transfers,
    history: transferHistory,
    profiles,
    copyWithFallback,
    pushToast
  });

  const revealCreatedPath = async (side: FileSide, path: string) => {
    const parent = parentPathForSide(side, path);
    if (side === "local") {
      if (normalizeLocalComparablePath(parent) === normalizeLocalComparablePath(localPath)) {
        await refreshLocalFiles(path);
      } else {
        navigateLocalPath(parent, path);
      }
      return;
    }
    if (normalizeRemotePath(parent) === normalizeRemotePath(remotePath)) {
      await refreshRemoteFiles(path);
    } else {
      navigateRemotePath(parent, path);
    }
  };

  const createdRelativePath = (side: FileSide, basePath: string, relativePath: string) => {
    const segments = relativePath.trim().split(/[\\/]+/).filter(Boolean);
    return segments.reduce(
      (path, segment) => (side === "remote" ? joinRemotePath(path, segment) : joinLocalPath(path, segment)),
      basePath
    );
  };

  useEffect(() => {
    const offToast = busRef.current.on("toast", (toast) => pushToast(toast.tone, toast.text));
    const offTransfers = busRef.current.on("refreshTransfers", () => refreshTransfers());
    return () => {
      offToast();
      offTransfers();
    };
  }, [pushToast]);

  const reloadProfiles = useCallback(async () => {
    if (!hasTauriRuntime()) {
      setStatus("请在 Tauri 窗口中使用");
      return;
    }
    try {
      const next = await api.listProfiles();
      setProfiles(normalizeProfiles(next));
    } catch (error) {
      setStatus(`会话加载失败: ${String(error)}`);
      pushToast("error", "会话加载失败");
    }
  }, [pushToast]);

  const refreshServerStatus = useCallback(async (force = false) => {
    if (!hasTauriRuntime() || !activeProfile) {
      serverStatusProfileIdRef.current = null;
      setServerStatus(null);
      setServerStatusError("");
      return;
    }
    const profile = activeProfile;
    const profileId = profile.id;
    serverStatusProfileIdRef.current = profileId;
    if (isRemoteProtocol(profile.protocol) && !activeRemoteConnected && !remoteBrowserReady && !force) {
      setServerStatus(null);
      setServerStatusError("");
      return;
    }
    setServerStatusLoading(true);
    try {
      const next = await api.serverStatus(profile.id, passwordForActive);
      if (serverStatusProfileIdRef.current !== profileId) return;
      setServerStatus(next);
      setServerStatusError("");
    } catch (error) {
      if (serverStatusProfileIdRef.current !== profileId) return;
      const message = String(error);
      if (shouldPromptForPassword(profile, message)) {
        requestProfileSecret(profile, message);
      }
      setServerStatus(null);
      setServerStatusError(message);
    } finally {
      if (serverStatusProfileIdRef.current === profileId) {
        setServerStatusLoading(false);
      }
    }
  }, [activeProfile, activeRemoteConnected, passwordForActive, remoteBrowserReady]);

  const refreshLocalFiles = useCallback(async (preferPath?: string) => {
    if (!localPath) return;
    const preferredPath = consumeLocalPreferPath(preferPath);
    try {
      const files = await api.listLocalDir(localPath);
      replaceLocalFiles(files, preferredPath);
      setStatus(`本地 ${localPath}`);
    } catch (error) {
      setStatus(`本地目录读取失败: ${String(error)}`);
      pushToast("error", "本地目录读取失败");
    }
  }, [consumeLocalPreferPath, localPath, pushToast, replaceLocalFiles]);

  const loadRemoteFilesFor = useCallback(async (profile: Profile, path: string, password: string | null, preferPath?: string) => {
    const files = await api.listRemoteDir(profile.id, path, password);
    replaceRemoteFiles(files, preferPath);
    setStatus(`远程 ${profile.host}:${path}`);
  }, [replaceRemoteFiles]);

  const refreshRemoteFiles = useCallback(async (preferPath?: string) => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) {
      replaceRemoteFiles([], undefined, { preserveSelection: false });
      return;
    }
    const preferredPath = consumeRemotePreferPath(preferPath);
    try {
      await loadRemoteFilesFor(activeProfile, remotePath, passwordForActive, typeof preferredPath === "string" ? preferredPath : undefined);
    } catch (error) {
      const message = String(error);
      if (shouldPromptForPassword(activeProfile, message)) {
        requestProfileSecret(activeProfile, message);
        pushToast("info", "请输入连接密码/口令");
        return;
      }
      setStatus(`远程目录读取失败: ${message}`);
      pushToast("error", "远程目录读取失败");
    }
  }, [activeProfile, consumeRemotePreferPath, loadRemoteFilesFor, passwordForActive, pushToast, remotePath, replaceRemoteFiles]);

  const reconnectRemoteSftp = useCallback(async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    try {
      await api.disconnectSftpSession(activeProfile.id);
      setStatus(`正在重连 SFTP ${activeProfile.host}`);
      await refreshRemoteFiles();
      pushToast("success", "SFTP 已重连");
    } catch (error) {
      setStatus(`SFTP 重连失败: ${String(error)}`);
      pushToast("error", "SFTP 重连失败");
    }
  }, [activeProfile, pushToast, refreshRemoteFiles]);

  const openSftpManager = async () => {
    const profile =
      activeProfile && isRemoteProtocol(activeProfile.protocol)
        ? activeProfile
        : profiles.find((item) => isRemoteProtocol(item.protocol)) ?? null;

    if (!profile) {
      setStatus("没有可用的 SSH/SFTP 会话");
      pushToast("info", "请先新建或选择一个 SSH/SFTP 会话");
      return;
    }
    if (!hasTauriRuntime()) {
      setStatus("请在 Tauri 窗口中打开文件管理器");
      pushToast("info", "独立文件管理器需要桌面窗口运行时");
      return;
    }

    try {
      window.localStorage.setItem(fileManagerProfileStorageKey, profile.id);
      await api.openFileManagerWindow(profile.id);
      setStatus(`文件管理器: ${profile.name}`);
      pushToast("success", "文件管理器窗口已打开");
    } catch (error) {
      setStatus(`文件管理器窗口打开失败: ${String(error)}`);
      pushToast("error", "文件管理器窗口打开失败");
    }
  };

  useAppTheme(settings.theme);
  useSettingsSync(setSettings);

  const [appBackground, setAppBackground] = useState<AppBackgroundConfig>(() => loadAppBackground());
  useEffect(() => {
    const refresh = () => setAppBackground(loadAppBackground());
    window.addEventListener(APP_BACKGROUND_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(APP_BACKGROUND_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  const appBackgroundActive = appBackground.kind !== "none";

  const [splitPaneTabIds, setSplitPaneTabIds] = useState<string[]>([]);
  const [primaryPaneActiveTabId, setPrimaryPaneActiveTabId] = useState<string | null>(null);
  const [splitPaneActiveTabId, setSplitPaneActiveTabId] = useState<string | null>(null);
  const [splitDirection, setSplitDirection] = useState<"row" | "column">("row");
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitPaneTabIdSet = useMemo(() => new Set(splitPaneTabIds), [splitPaneTabIds]);
  const primaryPaneTabs = useMemo(() => tabs.filter((tab) => !splitPaneTabIdSet.has(tab.id)), [tabs, splitPaneTabIdSet]);
  const splitPaneTabs = useMemo(
    () => splitPaneTabIds.map((id) => tabs.find((tab) => tab.id === id)).filter((tab): tab is TerminalView => Boolean(tab)),
    [splitPaneTabIds, tabs]
  );

  useEffect(() => {
    setSplitPaneTabIds((current) => {
      if (tabs.length <= 1) return current.length > 0 ? [] : current;
      const valid = current.filter((id, index) => current.indexOf(id) === index && tabs.some((tab) => tab.id === id));
      while (valid.length >= tabs.length) valid.pop();
      if (valid.length === current.length && valid.every((id, index) => id === current[index])) return current;
      return valid;
    });
  }, [tabs]);

  useEffect(() => {
    const fallback = primaryPaneTabs[0]?.id ?? null;
    setPrimaryPaneActiveTabId((current) => (current && primaryPaneTabs.some((tab) => tab.id === current) ? current : fallback));
  }, [primaryPaneTabs]);

  useEffect(() => {
    const fallback = splitPaneTabs[0]?.id ?? null;
    setSplitPaneActiveTabId((current) => (current && splitPaneTabs.some((tab) => tab.id === current) ? current : fallback));
  }, [splitPaneTabs]);

  const primaryCandidateForSplit = (draggedTabId: string) => {
    const preferredIds = [primaryPaneActiveTabId, activeTabId, splitPaneActiveTabId].filter((id): id is string => Boolean(id && id !== draggedTabId));
    for (const id of preferredIds) {
      const tab = tabs.find((item) => item.id === id);
      if (tab) return tab;
    }
    return tabs.find((tab) => tab.id !== draggedTabId) ?? null;
  };

  const insertTabIntoPrimaryOrder = (tabId: string, insertIndex: number | undefined, targetSplitPaneTabIds: string[]) => {
    if (insertIndex == null) return;
    setTabs((current) => {
      const dragged = current.find((tab) => tab.id === tabId);
      if (!dragged) return current;
      const splitSet = new Set(targetSplitPaneTabIds);
      const withoutDragged = current.filter((tab) => tab.id !== tabId);
      const primaryWithoutDragged = withoutDragged.filter((tab) => !splitSet.has(tab.id));
      const targetIndex = Math.min(Math.max(insertIndex, 0), primaryWithoutDragged.length);
      const beforeId = primaryWithoutDragged[targetIndex]?.id ?? null;
      const next = [...withoutDragged];
      const insertAt = beforeId ? next.findIndex((tab) => tab.id === beforeId) : next.length;
      next.splice(insertAt >= 0 ? insertAt : next.length, 0, dragged);
      return next.every((tab, index) => tab.id === current[index]?.id) ? current : next;
    });
  };

  const splitTabByDrop = (tabId: string, target: TerminalSplitDropTarget) => {
    const dragged = tabs.find((tab) => tab.id === tabId);
    if (!dragged) return;
    const paired = primaryCandidateForSplit(tabId);
    if (!paired) return;

    setSplitDirection(target === "left" || target === "right" ? "row" : "column");
    setSplitRatio(0.5);
    if (target === "left" || target === "top") {
      setSplitPaneTabIds((current) => {
        const valid = current.filter((id) => id !== dragged.id && tabs.some((tab) => tab.id === id));
        return valid.length > 0 ? valid : [paired.id];
      });
      setPrimaryPaneActiveTabId(dragged.id);
      setSplitPaneActiveTabId((current) => (current && current !== dragged.id ? current : paired.id));
      setActiveTabId(dragged.id);
      setSelectedProfileId(dragged.profileId);
      return;
    }

    setSplitPaneTabIds((current) => {
      const valid = current.filter((id) => tabs.some((tab) => tab.id === id));
      let next = valid.includes(dragged.id) ? valid : [...valid, dragged.id];
      if (next.length >= tabs.length) next = next.filter((id) => id !== paired.id);
      return next;
    });
    setPrimaryPaneActiveTabId((current) => (current && current !== dragged.id ? current : paired.id));
    setSplitPaneActiveTabId(dragged.id);
    setActiveTabId(dragged.id);
    setSelectedProfileId(dragged.profileId);
  };

  const moveTabToPrimaryPane = (tabId: string, insertIndex?: number) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const nextSplitPaneTabIds = splitPaneTabIds.filter((id) => id !== tab.id);
    setSplitPaneTabIds((current) => current.filter((id) => id !== tab.id));
    insertTabIntoPrimaryOrder(tab.id, insertIndex, nextSplitPaneTabIds);
    setPrimaryPaneActiveTabId(tab.id);
    setActiveTabId(tab.id);
    setSelectedProfileId(tab.profileId);
  };

  const moveTabToSplitPane = (tabId: string, insertIndex?: number) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const paired = primaryCandidateForSplit(tab.id);
    if (!paired) return;
    setSplitPaneTabIds((current) => {
      let valid = current.filter((id) => id !== tab.id && tabs.some((item) => item.id === id));
      if (valid.length + 1 >= tabs.length) valid = valid.filter((id) => id !== paired.id);
      const targetIndex = Math.min(Math.max(insertIndex ?? valid.length, 0), valid.length);
      const next = [...valid];
      next.splice(targetIndex, 0, tab.id);
      return next;
    });
    setPrimaryPaneActiveTabId((current) => (current && current !== tab.id ? current : paired.id));
    setSplitPaneActiveTabId(tab.id);
    setActiveTabId(tab.id);
    setSelectedProfileId(tab.profileId);
  };

  const unsplitTerminalPanes = () => {
    setSplitPaneTabIds([]);
    setSplitPaneActiveTabId(null);
    setPrimaryPaneActiveTabId(activeTabId);
  };

  const [fileDockOpenByTabId, setFileDockOpenByTabId] = useState<Record<string, boolean>>({});
  const [fileDockHeightByTabId, setFileDockHeightByTabId] = useState<Record<string, number>>({});
  const dockTabStatusRef = useRef(new Map<string, TerminalView["status"]>());
  useEffect(() => {
    if (isFileManagerWindow) return;
    const prev = dockTabStatusRef.current;
    for (const tab of tabs) {
      const before = prev.get(tab.id);
      if (tab.status === "connected" && before !== "connected" && tab.id === activeTabId && loadFileDockAuto()) {
        setFileDockOpenByTabId((current) => ({ ...current, [tab.id]: true }));
      }
      prev.set(tab.id, tab.status);
    }
  }, [tabs, activeTabId, isFileManagerWindow]);

  const fileDockOpenForTab = useCallback((tabId: string) => Boolean(fileDockOpenByTabId[tabId]), [fileDockOpenByTabId]);
  const toggleFileDockForTab = useCallback((tabId: string) => {
    setFileDockOpenByTabId((current) => ({ ...current, [tabId]: !current[tabId] }));
  }, []);
  const commandForTab = useCallback((tabId: string) => terminalCommands[tabId] ?? "", [terminalCommands]);
  const setCommandForTab = useCallback((tabId: string, command: string) => {
    setTerminalCommands((current) => ({ ...current, [tabId]: command }));
  }, []);
  const canReconnectTab = useCallback((tab: TerminalView) => profiles.some((profile) => profile.id === tab.profileId), [profiles]);
  const renderTerminalFileDock = useCallback(
    (tab: TerminalView) => {
      const profile = profiles.find((item) => item.id === tab.profileId) ?? null;
      const side: "local" | "remote" = profile && !isLocalProtocol(profile.protocol) ? "remote" : "local";
      const secret = profile ? profileSecrets[profile.id] || profile.password || "" : "";
      const height = fileDockHeightByTabId[tab.id] ?? 240;

      return (
        <TerminalFileDock
          key={`${tab.id}-${side}-${profile?.id ?? "local"}`}
          side={side}
          sessionLabel={profile?.name ?? tab.title}
          followPath={tab.currentDirectory ?? null}
          height={height}
          onHeightChange={(nextHeight) => {
            setFileDockHeightByTabId((current) => ({ ...current, [tab.id]: nextHeight }));
          }}
          listDir={(path) => {
            if (side === "remote" && profile) return api.listRemoteDir(profile.id, path, secret || undefined);
            return api.listLocalDir(path);
          }}
          resolveHome={() => {
            if (side === "remote" && profile) return api.remoteHome(profile.id, secret || undefined);
            return api.localHome();
          }}
          onOpenFile={(entry) => {
            setActiveTabId(tab.id);
            setSelectedProfileId(tab.profileId);
            if (side === "remote" && profile) void openRemoteEditorForProfile(profile, secret, entry);
            else void openLocalEditor(entry);
          }}
          onClose={() => {
            setFileDockOpenByTabId((current) => ({ ...current, [tab.id]: false }));
          }}
        />
      );
    },
    [fileDockHeightByTabId, profileSecrets, profiles]
  );

  const confirmActionRef = useRef(confirmAction);
  useEffect(() => {
    confirmActionRef.current = confirmAction;
  }, [confirmAction]);
  const exitConfirmOpenRef = useRef(false);

  useEffect(() => {
    if (!hasTauriRuntime() || isFileManagerWindow) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenTauriEvent("rustshell://request-exit-confirm", async () => {
      if (exitConfirmOpenRef.current) return;
      exitConfirmOpenRef.current = true;
      try {
        const confirmed = await confirmActionRef.current("退出确认", {
          message: "确定要关闭 RustShell 吗？未断开的会话将被关闭。",
          confirmLabel: "退出",
          cancelLabel: "取消",
          danger: true
        });
        if (confirmed) {
          await api.exitMainWindow().catch((error) => {
            const message = `退出失败: ${String(error)}`;
            setStatus(message);
            pushToast("error", message);
          });
        }
      } finally {
        exitConfirmOpenRef.current = false;
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isFileManagerWindow, pushToast]);
  useCommandPaletteShortcut(setCommandOpen);

  useEffect(() => {
    refreshLocalFiles();
  }, [refreshLocalFiles]);

  useEffect(() => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || !remoteBrowserReady) {
      setRemoteHomeReady(false);
      replaceRemoteFiles([], undefined, { preserveSelection: false });
      return;
    }
    let disposed = false;
    setRemoteHomeReady(false);
    api
      .remoteHome(activeProfile.id, passwordForActive)
      .then((home) => {
        if (disposed) return;
        setRemoteBackHistory([]);
        setRemoteForwardHistory([]);
        setRemotePath(home || ".");
        setRemoteHomeReady(true);
      })
      .catch((error) => {
        if (disposed) return;
        const message = String(error);
        if (activeProfile && shouldPromptForPassword(activeProfile, message)) {
          requestProfileSecret(activeProfile, message);
          pushToast("info", "请输入连接密码/口令");
        }
        setRemoteBackHistory([]);
        setRemoteForwardHistory([]);
        setRemotePath(".");
        replaceRemoteFiles([], undefined, { preserveSelection: false });
        setRemoteHomeReady(false);
        setStatus(`远程主目录读取失败: ${message}`);
        if (!shouldPromptForPassword(activeProfile, message)) {
          pushToast("error", "远程主目录读取失败");
        }
      });
    return () => {
      disposed = true;
    };
  }, [
    activeProfile?.id,
    activeProfile?.protocol,
    passwordForActive,
    remoteBrowserReady,
    replaceRemoteFiles,
    setRemoteBackHistory,
    setRemoteForwardHistory,
    setRemoteHomeReady,
    setRemotePath
  ]);

  useEffect(() => {
    if (remoteBrowserReady && remoteHomeReady) {
      refreshRemoteFiles();
    }
  }, [refreshRemoteFiles, remoteBrowserReady, remoteHomeReady]);

  useEffect(() => {
    if (isFileManagerWindow) {
      serverStatusProfileIdRef.current = null;
      setServerStatus(null);
      setServerStatusError("");
      setServerStatusLoading(false);
      return;
    }
    if (!activeProfile) {
      serverStatusProfileIdRef.current = null;
      setServerStatus(null);
      setServerStatusError("");
      setServerStatusLoading(false);
      return;
    }
    serverStatusProfileIdRef.current = activeProfile.id;
    setServerStatus(null);
    setServerStatusError("");
    setServerStatusLoading(false);
  }, [activeProfile?.id, isFileManagerWindow]);

  useEffect(() => {
    const previous = transferStatusRef.current;
    const completed = transfers.filter((transfer) => previous.get(transfer.id) === "running" && transfer.status === "done");
    transferStatusRef.current = new Map(transfers.map((transfer) => [transfer.id, transfer.status]));
    if (completed.length === 0) return;

    refreshLocalFiles();
    if (remoteBrowserReady && remoteHomeReady) {
      refreshRemoteFiles();
    }
    pushToast("success", completed.length === 1 ? "传输已完成" : `${completed.length} 个传输已完成`);
  }, [pushToast, refreshLocalFiles, refreshRemoteFiles, remoteBrowserReady, remoteHomeReady, transfers]);

  const openLocalShell = useCallback(async () => {
    if (!hasTauriRuntime()) return;
    try {
      const terminal = await api.connectLocalShell();
      appendTab(terminal);
      setStatus(`正在连接 ${terminal.endpoint}`);
    } catch (error) {
      setStatus(`本地终端启动失败: ${String(error)}`);
      pushToast("error", "本地终端启动失败");
    }
  }, [pushToast]);

  const openLocalShellHere = async () => {
    if (!hasTauriRuntime() || !localPath.trim()) return;
    const entry = visibleSelectedLocal;
    const targetPath = entry ? (entry.isDir ? entry.path : localParentPath(entry.path)) : localPath;
    try {
      const terminal = await api.connectLocalShell();
      appendTab(terminal);
      setStatus(`正在连接 ${terminal.endpoint}`);
      try {
        await api.terminalSend(terminal.id, localCdCommand(targetPath, settings.localShell));
        pushToast("success", "本地终端已进入目录");
      } catch (error) {
        setStatus(`本地终端目录切换失败: ${String(error)}`);
        pushToast("error", `本地终端目录切换失败: ${String(error)}`);
      }
    } catch (error) {
      setStatus(`本地终端启动失败: ${String(error)}`);
      pushToast("error", `本地终端启动失败: ${String(error)}`);
    }
  };

  useAppBootstrap({
    isFileManagerWindow,
    openLocalShell,
    setActiveTabId,
    setLocalPath,
    setProfiles,
    setSelectedProfileId,
    setSettings,
    setStatus,
    setTabs
  });

  const appendTab = (terminal: TerminalView) => {
    setTabs((current) => [...current.filter((tab) => tab.id !== terminal.id), terminal]);
    setPrimaryPaneActiveTabId(terminal.id);
    setActiveTabId(terminal.id);
    setSelectedProfileId(terminal.profileId);
  };

  const markTerminalReplayConsumed = useCallback((terminalId: string) => {
    setTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.id !== terminalId || !tab.text) return tab;
        changed = true;
        return { ...tab, text: "" };
      });
      return changed ? next : current;
    });
  }, []);

  const rememberProfileSecret = (profileId: string, password?: string | null) => {
    if (!password) return;
    setProfileSecrets((current) => ({ ...current, [profileId]: password }));
    setProfileSecretDrafts((current) => ({ ...current, [profileId]: password }));
  };

  const commitProfileSecret = (profileId: string, password: string) => {
    setProfileSecretDrafts((current) => ({ ...current, [profileId]: password }));
    setProfileSecrets((current) => {
      if (password) return { ...current, [profileId]: password };
      const next = { ...current };
      delete next[profileId];
      return next;
    });
  };

  const forgetProfileSecret = (profileId: string) => {
    setProfileSecretDrafts((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
    setProfileSecrets((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
  };

  const requestProfileSecret = (profile: Profile, message?: string) => {
    setSelectedProfileId(profile.id);
    setSecretProfileId(profile.id);
    setProfileSecretDrafts((current) => ({
      ...current,
      [profile.id]: current[profile.id] ?? profileSecrets[profile.id] ?? profile.password ?? ""
    }));
    setDialog("secret");
    setStatus(message ? `${profile.name}: ${message}` : `${profile.name}: 请输入连接密码`);
  };

  const requestActiveProfileSecretIfNeeded = (error: unknown) => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return false;
    const message = String(error);
    if (!shouldPromptForPassword(activeProfile, message)) return false;
    requestProfileSecret(activeProfile, message);
    pushToast("info", "请输入连接密码/口令");
    return true;
  };

  const connectQuick = async () => {
    try {
      const terminal = await api.connectQuick({ ...quick, password: quick.password || null });
      rememberProfileSecret(terminal.profileId, quick.password);
      appendTab(terminal);
      setQuick((current) => ({ ...current, password: "" }));
      setDialog(null);
      setStatus(`正在连接 ${terminal.endpoint}`);
      await reloadProfiles();
    } catch (error) {
      setStatus(`连接失败: ${String(error)}`);
      pushToast("error", "连接失败");
    }
  };

  const connectProfile = async (profile: Profile) => {
    setSelectedProfileId(profile.id);
    const normalized = normalizeProfile(profile);
    const knownSecret = profileSecretValue(normalized);
    if (
      !isLocalProtocol(normalized.protocol) &&
      profileAuthKind(normalized.auth) === "Password" &&
      !knownSecret.trim() &&
      !normalized.rememberPassword
    ) {
      requestProfileSecret(normalized);
      pushToast("info", "请输入连接密码/口令");
      return;
    }

    const openWithPassword = async (password?: string | null) => {
      const terminal = await api.connectProfile(normalized.id, password || null);
      rememberProfileSecret(normalized.id, password);
      appendTab(terminal);
      setQuick((current) => ({
        ...current,
        protocol: normalizeQuickProtocol(normalized.protocol),
        name: normalized.name,
        host: normalized.host,
        port: normalized.port || 22,
        username: normalized.username,
        password: ""
      }));
      setStatus(`正在连接 ${terminal.endpoint}`);
      await reloadProfiles().catch(() => undefined);
    };

    try {
      await openWithPassword(knownSecret || null);
    } catch (error) {
      const message = String(error);
      if (shouldPromptForPassword(normalized, message)) {
        requestProfileSecret(normalized, message);
        pushToast("info", "请输入连接密码/口令");
        return;
      }
      setStatus(`连接失败: ${message}`);
      pushToast("error", "连接失败");
    }
  };

  const connectSecretProfile = async () => {
    if (!secretProfile) return;
    const password = profileSecretDrafts[secretProfile.id] ?? "";
    const authKind = profileAuthKind(secretProfile.auth);
    if (authKind !== "KeyFile" && !password.trim()) {
      setStatus(`${secretProfile.name}: 请输入连接密码`);
      pushToast("info", "请输入连接密码/口令");
      return;
    }
    if (password.trim()) {
      commitProfileSecret(secretProfile.id, password);
    }
    setDialog(null);
    setSecretProfileId(null);
    if (isFileManagerWindow) {
      setSelectedProfileId(secretProfile.id);
      resetRemoteBrowserProfile(secretProfile.id);
      setStatus(`正在打开 SFTP ${secretProfile.host || secretProfile.name}`);
      return;
    }
    await connectProfile({ ...secretProfile, password });
  };

  const reconnectActive = async () => {
    if (!activeProfile) return;
    await connectProfile(activeProfile);
  };

  const reconnectTab = async (tab: TerminalView) => {
    const profile = profiles.find((item) => item.id === tab.profileId);
    if (!profile) return;
    await connectProfile(profile);
  };

  const copyTerminal = async (tab: TerminalView) => {
    let text = tab.text || "";
    if (hasTauriRuntime()) {
      try {
        text = (await api.terminalSnapshot(tab.id)).text || text;
      } catch {
        // Fall back to any replay text still held by React.
      }
    }
    if (!text) {
      pushToast("info", "终端暂无可复制内容");
      return;
    }
    await copyWithFallback({ title: "复制终端内容", text, onCopied: () => pushToast("success", "终端内容已复制") });
  };

  const copyActiveTerminal = async () => {
    if (!activeTab) return;
    await copyTerminal(activeTab);
  };

  const pasteToTerminal = async (tab: TerminalView) => {
    if (tab.status !== "connected") return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      await api.terminalSend(tab.id, text);
    } catch (error) {
      pushToast("error", `粘贴失败: ${String(error)}`);
    }
  };

  const pasteToActiveTerminal = async () => {
    if (!activeTab) return;
    await pasteToTerminal(activeTab);
  };

  const clearTerminal = async (tab: TerminalView) => {
    if (tab.status !== "connected") return;
    await api.terminalSend(tab.id, "\f").catch((error) => pushToast("error", `清屏失败: ${String(error)}`));
  };

  const clearActiveTerminal = async () => {
    if (!activeTab) return;
    await clearTerminal(activeTab);
  };

  const sendTerminalCommand = async (tab: TerminalView, command: string) => {
    if (tab.status !== "connected") return;
    const value = command.trim();
    if (!value) return;
    try {
      await api.terminalSend(tab.id, `${value}\r`);
      setTerminalCommands((current) => ({ ...current, [tab.id]: "" }));
    } catch (error) {
      pushToast("error", `命令发送失败: ${String(error)}`);
    }
  };

  const closeTab = async (tabId: string) => {
    await api.closeTerminal(tabId).catch(() => undefined);
    setTabs((current) => current.filter((tab) => tab.id !== tabId));
    setSplitPaneTabIds((current) => current.filter((id) => id !== tabId));
    setPrimaryPaneActiveTabId((current) => (current === tabId ? null : current));
    setSplitPaneActiveTabId((current) => (current === tabId ? null : current));
    setActiveTabId((current) => (current === tabId ? null : current));
    setTerminalCommands((current) => {
      const { [tabId]: _removed, ...next } = current;
      return next;
    });
    setFileDockOpenByTabId((current) => {
      const { [tabId]: _removed, ...next } = current;
      return next;
    });
    setFileDockHeightByTabId((current) => {
      const { [tabId]: _removed, ...next } = current;
      return next;
    });
    authPromptedTabsRef.current.delete(tabId);
  };

  const closeTabWithConfirm = async (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    if (settings.confirmOnExit) {
      const confirmed = await confirmAction("关闭会话确认", {
        message: `确定要关闭会话「${tab.title}」吗？\n未保存的终端输出不会继续保留在当前窗口。`,
        confirmLabel: "关闭会话",
        cancelLabel: "取消",
        danger: true
      });
      if (!confirmed) return;
    }
    await closeTab(tabId);
  };

  const duplicateTab = async (source: TerminalView) => {
    try {
      const terminal = await api.duplicateTerminal(source.id);
      appendTab(terminal);
      const profile = profiles.find((item) => item.id === source.profileId);
      const directory = source.currentDirectory?.trim();
      if (directory && terminal.status !== "failed") {
        const command =
          profile && isLocalProtocol(profile.protocol)
            ? localCdCommand(directory, settings.localShell)
            : `cd -- ${shellQuote(directory)}\r`;
        await api.terminalSend(terminal.id, command);
        setStatus(`已复制窗口并进入 ${directory}`);
        pushToast("success", "窗口已复制到相同目录");
      } else {
        setStatus(`已复制窗口 ${source.title}`);
        pushToast("info", "窗口已复制，当前目录未上报");
      }
    } catch (error) {
      const profile = profiles.find((item) => item.id === source.profileId);
      const message = String(error);
      if (profile && shouldPromptForPassword(profile, message)) {
        requestProfileSecret(profile, message);
        pushToast("info", "请输入连接密码/口令");
        return;
      }
      setStatus(`窗口复制失败: ${message}`);
      pushToast("error", "窗口复制失败");
    }
  };

  const activateTerminalTab = useCallback((tab: TerminalView) => {
    if (splitPaneTabIds.includes(tab.id)) setSplitPaneActiveTabId(tab.id);
    else setPrimaryPaneActiveTabId(tab.id);
    setActiveTabId(tab.id);
    startTransition(() => setSelectedProfileId(tab.profileId));
  }, [splitPaneTabIds]);

  const retryAuthFailure = async (next: TerminalDrain, profileId: string) => {
    if (next.status !== "failed" || !next.lastError || authPromptedTabsRef.current.has(next.id)) return;
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile || !shouldPromptForPassword(profile, next.lastError)) return;

    authPromptedTabsRef.current.add(next.id);
    await closeTab(next.id);
    requestProfileSecret(profile, next.lastError);
    pushToast("info", "请输入连接密码/口令");
  };

  const connectFromSearch = () => {
    const needle = hostSearch.trim().toLowerCase();
    const profile = profiles.find(
      (item) => item.name.toLowerCase().includes(needle) || item.host.toLowerCase().includes(needle)
    );
    if (!profile) {
      setQuick((current) => ({ ...current, host: hostSearch, name: hostSearch || current.name }));
      setDialog("quick");
      return;
    }
    connectProfile(profile);
  };

  const {
    openProfileEditor,
    saveProfile,
    pickProfileKeyFile,
    exportSessions,
    importSessions,
    duplicateSession,
    deleteSession,
    deleteSessionFolder
  } = buildSessionActions({
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
  });

  const importSyncPlanJson = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) {
      pushToast("info", "请选择一个 SSH/SFTP 会话后再导入同步计划");
      return;
    }
    try {
      const payload = await pickTextFile(".json,application/json");
      if (!payload) return;
      const plan = parseSyncPlanJson(payload);
      setSyncPlan(plan);
      if (plan.conflictStrategy) {
        setTransferConflict(plan.conflictStrategy);
      }
      setDialog("syncPlan");
      pushToast("success", `同步计划已导入 ${plan.items.length} 项`);
    } catch (error) {
      pushToast("error", `同步计划导入失败: ${String(error)}`);
    }
  };

  const persistSettings = async (next: AppSettings) => {
    try {
      const saved = await api.saveSettings(next);
      setSettings(saved);
      if (hasTauriRuntime()) {
        void emitTauriEvent("rustshell://settings", saved).catch(() => undefined);
      }
      return saved;
    } catch (error) {
      pushToast("error", `设置保存失败: ${String(error)}`);
      return null;
    }
  };

  const saveSettings = async () => {
    const saved = await persistSettings(settings);
    if (saved) {
      setDialog(null);
      pushToast("success", "设置已保存");
    }
  };

  const openKnownHostsManager = async () => {
    try {
      setKnownHostsText(await api.loadKnownHosts());
      setDialog("hostkeys");
    } catch (error) {
      pushToast("error", `主机密钥读取失败: ${String(error)}`);
    }
  };

  const saveKnownHosts = async () => {
    try {
      await api.saveKnownHosts(knownHostsText);
      setDialog(null);
      pushToast("success", "主机密钥已保存");
    } catch (error) {
      pushToast("error", `主机密钥保存失败: ${String(error)}`);
    }
  };

  const clearKnownHosts = async () => {
    if (
      !(await confirmAction("清空主机密钥", {
        message: "确定清空已信任的主机密钥？下次连接会重新要求确认。",
        confirmLabel: "清空",
        danger: true
      }))
    ) {
      return;
    }
    try {
      await api.clearKnownHosts();
      setKnownHostsText("");
      pushToast("success", "主机密钥已清空");
    } catch (error) {
      pushToast("error", `主机密钥清空失败: ${String(error)}`);
    }
  };

  const acceptHostKey = async () => {
    if (!hostKeyPrompt) return;
    try {
      await api.trustHostKey(hostKeyPrompt.issue);
      const profile = profiles.find((item) => item.id === hostKeyPrompt.profileId);
      setHostKeyPrompt(null);
      pushToast("success", "主机密钥已信任");
      if (profile) await connectProfile(profile);
    } catch (error) {
      pushToast("error", `主机密钥保存失败: ${String(error)}`);
    }
  };

  const makeDir = async (side: FileSide) => {
    const name = await promptText("目录名称或相对路径");
    if (!name) return;
    try {
      if (side === "local") {
        await api.createLocalDir(localPath, name);
        await revealCreatedPath("local", createdRelativePath("local", localPath, name));
      } else if (activeProfile) {
        await api.createRemoteDir(activeProfile.id, remotePath, name, passwordForActive);
        await revealCreatedPath("remote", createdRelativePath("remote", remotePath, name));
      }
      pushToast("success", "目录已创建");
    } catch (error) {
      if (side === "remote" && requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `创建失败: ${String(error)}`);
    }
  };

  const createLocalFile = async () => {
    if (!localPath.trim()) return;
    const name = await promptText("文件名称或相对路径");
    if (!name) return;
    try {
      const path = await api.createLocalFile(localPath, name);
      await revealCreatedPath("local", path);
      const file = await api.readLocalFile(path);
      setEditorSide("local");
      setEditorFile(editorFileMetadata(file));
      setEditorPreviewPosition("head");
      setEditorContent(file.content);
      setDialog("editor");
      pushToast("success", "本地文件已创建");
    } catch (error) {
      pushToast("error", `文件创建失败: ${String(error)}`);
    }
  };

  const createLocalSymlink = async () => {
    if (!localPath.trim()) return;
    const target = await promptText("链接目标路径", { defaultValue: visibleSelectedLocal?.path ?? "" });
    if (!target?.trim()) return;
    const name = await promptText("链接名称或相对路径", { defaultValue: visibleSelectedLocal ? `${visibleSelectedLocal.name}.link` : "" });
    if (!name?.trim()) return;
    try {
      const path = await api.createLocalSymlink(localPath, name.trim(), target.trim());
      await revealCreatedPath("local", path);
      pushToast("success", "本地软链接已创建");
    } catch (error) {
      pushToast("error", `本地软链接创建失败: ${String(error)}`);
    }
  };

  const {
    copyRemoteSymlinkCommands,
    copyRemoteUris,
    copyScpCommands,
    copyRsyncCommands,
    copyChmodCommands,
    copyChownCommands,
    copyTouchCommands,
    copyRemoteDeleteCommands,
    copyRemoteStatCommands,
    copyRemoteSha256Commands,
    copyRemoteDuCommands,
    copyRemoteListCommands,
    copyConnectionCommand
  } = buildFileCommandClipboardActions({
    activeProfile,
    localPath,
    remotePath,
    visibleSelectedLocalEntries,
    visibleSelectedRemoteEntries,
    copyWithFallback,
    pushToast
  });

  const revealLocalSelected = async () => {
    if (!visibleSelectedLocal || visibleSelectedLocalEntries.length > 1) return;
    try {
      await api.openLocalPath(visibleSelectedLocal.path, true);
      pushToast("success", "已打开系统文件管理器");
    } catch (error) {
      pushToast("error", `打开失败: ${String(error)}`);
    }
  };

  const openParentDir = async (side: FileSide) => {
    try {
      if (side === "local") {
        const parent = await api.localParent(localPath);
        if (parent) navigateLocalPath(parent);
      } else {
        navigateRemotePath(remoteParentPath(remotePath));
      }
    } catch (error) {
      pushToast("error", `上级目录打开失败: ${String(error)}`);
    }
  };

  const removeSelected = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    setDeleteConfirm({ side, entries });
    setDialog("deleteConfirm");
  };

  const confirmDeleteSelected = async () => {
    if (!deleteConfirm) return;
    const { side, entries } = deleteConfirm;
    const failures: string[] = [];
    let deleted = 0;
    if (side === "remote" && !activeProfile) return;
    setDialog(null);
    setDeleteConfirm(null);
    for (const entry of entries) {
      try {
        if (side === "local") {
          await api.removeLocalPath(entry.path, entry.isDir);
        } else {
          await api.removeRemotePath(activeProfile!.id, entry.path, entry.isDir, entry.isDir, passwordForActive);
        }
        deleted += 1;
      } catch (error) {
        failures.push(`${entry.name}: ${String(error)}`);
      }
    }
    if (side === "local") {
      await refreshLocalFiles();
    } else {
      await refreshRemoteFiles();
    }
    if (deleted > 0) {
      pushToast("success", deleted === 1 ? "已删除" : `已删除 ${deleted} 个项目`);
    }
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`删除失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `删除失败 ${failures.length} 个项目`);
      if (side === "remote" && requestActiveProfileSecretIfNeeded(failures[0])) return;
    }
  };

  const {
    copyDeleteConfirmCsv,
    downloadDeleteConfirmCsv,
    copyDeleteConfirmJson,
    downloadDeleteConfirmJson
  } = buildDeleteConfirmActions({
    deleteConfirm,
    copyWithFallback,
    pushToast
  });

  const renameSelected = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length > 1) {
      openBatchRenameDialog(side, entries);
      return;
    }
    const entry = entries[0] ?? (side === "local" ? visibleSelectedLocal : visibleSelectedRemote);
    if (!entry) return;
    const name = await promptText("新名称", { defaultValue: entry.name });
    if (!name || name === entry.name) return;
    try {
      if (side === "local") {
        await api.renameLocalPath(entry.path, name);
        await refreshLocalFiles();
      } else if (activeProfile) {
        const path = await api.renameRemotePath(activeProfile.id, entry.path, name, passwordForActive);
        await refreshRemoteFiles(path);
      }
      pushToast("success", "已重命名");
    } catch (error) {
      if (side === "remote" && requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `重命名失败: ${String(error)}`);
    }
  };

  const openBatchRenameDialog = (side: FileSide, entries: FileEntry[]) => {
    if (entries.length === 0) return;
    setBatchRenameSide(side);
    setBatchRenameTargets(entries);
    setBatchRenameFind("");
    setBatchRenameReplace("");
    setBatchRenamePrefix("");
    setBatchRenameSuffix("");
    setBatchRenameNumberStart("1");
    setBatchRenameNumberPadding("2");
    setBatchRenamePreserveExtension(true);
    setBatchRenameCaseSensitive(false);
    setDialog("batchRename");
  };

  const applyBatchRename = async (items: BatchRenamePlanItem[]) => {
    if (items.length === 0) return;
    if (batchRenameSide === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return;
    const failures: string[] = [];
    let renamed = 0;
    let lastPath: string | null = null;
    for (const item of items) {
      try {
        if (batchRenameSide === "local") {
          await api.renameLocalPath(item.entry.path, item.newName);
          lastPath = joinLocalPath(parentPathForSide("local", item.entry.path), item.newName);
        } else {
          lastPath = await api.renameRemotePath(activeProfile!.id, item.entry.path, item.newName, passwordForActive);
        }
        renamed += 1;
      } catch (error) {
        failures.push(`${item.entry.name} -> ${item.newName}: ${String(error)}`);
      }
    }

    if (batchRenameSide === "local") {
      await refreshLocalFiles(lastPath ?? undefined);
    } else {
      await refreshRemoteFiles(lastPath ?? undefined);
    }
    setDialog(null);
    setBatchRenameTargets([]);
    if (renamed > 0) {
      pushToast("success", renamed === 1 ? "已重命名" : `已批量重命名 ${renamed} 个项目`);
    }
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`批量重命名失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `批量重命名失败 ${failures.length} 个项目`);
      if (batchRenameSide === "remote" && requestActiveProfileSecretIfNeeded(failures[0])) return;
    }
  };

  const {
    duplicateRemoteSelected,
    duplicateLocalSelected,
    moveLocalSelected,
    moveRemoteSelected
  } = buildFileMutationActions({
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
  });

  const locateRemoteSelected = () => {
    if (!visibleSelectedRemote || isLocalProtocol(activeProfile?.protocol ?? "Local")) return;
    navigateRemotePath(remoteParentPath(visibleSelectedRemote.path));
  };

  const sendRemotePathToTerminal = async () => {
    if (!activeProfile || !isSshProtocol(activeProfile.protocol)) return;
    const entry = visibleSelectedRemote;
    const targetPath = entry ? (entry.isDir ? entry.path : remoteParentPath(entry.path)) : remotePath;
    try {
      let terminal =
        activeTab && activeTab.profileId === activeProfile.id && activeTab.status === "connected"
          ? activeTab
          : tabs.find((tab) => tab.profileId === activeProfile.id && tab.status === "connected") ?? null;
      if (!terminal) {
        terminal = await api.connectProfile(activeProfile.id, passwordForActive);
        rememberProfileSecret(activeProfile.id, passwordForActive);
        appendTab(terminal);
        setStatus(`正在连接 ${terminal.endpoint}`);
        await reloadProfiles().catch(() => undefined);
      } else {
        setActiveTabId(terminal.id);
      }
      await api.terminalSend(terminal.id, `cd -- ${shellQuote(targetPath)}\r`);
      pushToast("success", "终端目录已切换");
    } catch (error) {
      const message = String(error);
      if (shouldPromptForPassword(activeProfile, message)) {
        requestProfileSecret(activeProfile, message);
        pushToast("info", "请输入连接密码/口令");
        return;
      }
      pushToast("error", `发送到终端失败: ${message}`);
    }
  };

  const openChmodDialog = (side: FileSide, entry: FileEntry | null, entries?: FileEntry[]) => {
    if (!entry) return;
    const targets = entries?.length ? entries : [entry];
    setChmodSide(side);
    setChmodTarget(entry);
    setChmodTargets(targets);
    setChmodMode(formatMode(entry.permissions) || (entry.isDir ? "755" : "644"));
    setChmodRecursive(targets.some((target) => target.isDir));
    setDialog("chmod");
  };

  const applyChmod = async () => {
    if (!chmodTarget) return;
    const targets = chmodTargets.length ? chmodTargets : [chmodTarget];
    const effectiveTargets = targets.filter((target) => target.fileType !== "symlink");
    if (effectiveTargets.length === 0) {
      pushToast("info", "符号链接不会修改目标权限");
      setDialog(null);
      return;
    }
    const resolvedModes = effectiveTargets.map((target) => ({
      target,
      mode: resolvePermissionMode(chmodMode, target)
    }));
    if (resolvedModes.some((item) => item.mode === undefined || item.mode === null)) {
      pushToast("error", "权限格式不正确");
      return;
    }
    if (chmodSide === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return;
    const failures: string[] = [];
    let updated = 0;
    for (const item of resolvedModes) {
      const target = item.target;
      const mode = item.mode as number;
      try {
        if (chmodSide === "local") {
          await api.chmodLocalPath(target.path, mode, chmodRecursive && target.isDir);
        } else {
          await api.chmodRemotePath(activeProfile!.id, target.path, mode, chmodRecursive && target.isDir, passwordForActive);
        }
        updated += 1;
      } catch (error) {
        failures.push(`${target.name}: ${String(error)}`);
      }
    }
    setDialog(null);
    if (chmodSide === "local") {
      await refreshLocalFiles();
    } else {
      await refreshRemoteFiles();
    }
    const skipped = targets.length - effectiveTargets.length;
    if (updated > 0) {
      const scope = chmodSide === "local" ? "本地" : "";
      const suffix = skipped > 0 ? `，已跳过 ${skipped} 个符号链接` : "";
      pushToast("success", updated === 1 ? `${scope}权限已更新${suffix}` : `已更新 ${updated} 个${scope}项目的权限${suffix}`);
    }
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`权限修改失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `权限修改失败 ${failures.length} 个项目`);
      if (chmodSide === "remote" && requestActiveProfileSecretIfNeeded(failures[0])) return;
    }
  };

  const openPropertiesDialog = (side: FileSide, entry: FileEntry | null, entries?: FileEntry[]) => {
    if (!entry) return;
    const targets = entries?.length ? entries : [entry];
    setPropertiesSide(side);
    setPropertiesTarget(entry);
    setPropertiesTargets(targets);
    setPropertiesUid(commonEntryValue(targets, (target) => (target.uid == null ? "" : String(target.uid))));
    setPropertiesGid(commonEntryValue(targets, (target) => (target.gid == null ? "" : String(target.gid))));
    setPropertiesMode(commonEntryValue(targets, (target) => formatMode(target.permissions)));
    setPropertiesMtime(commonEntryValue(targets, (target) => formatDateTimeLocal(target.modifiedAt)));
    setPropertiesStats(null);
    setPropertiesStatsLoading(false);
    setPropertiesChecksum("");
    setPropertiesChecksumLoading(false);
    setPropertiesRecursive(targets.some((target) => target.isDir));
    setDialog("properties");
  };

  const calculatePropertiesStats = async () => {
    if (!propertiesTarget || propertiesTargets.length > 1 || !propertiesTarget.isDir) return;
    setPropertiesStatsLoading(true);
    try {
      if (propertiesSide === "local") {
        setPropertiesStats(await api.localPathStats(propertiesTarget.path));
      } else if (activeProfile && !isLocalProtocol(activeProfile.protocol)) {
        setPropertiesStats(await api.remotePathStats(activeProfile.id, propertiesTarget.path, passwordForActive));
      }
    } catch (error) {
      if (propertiesSide === "remote" && requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `统计失败: ${String(error)}`);
    } finally {
      setPropertiesStatsLoading(false);
    }
  };

  const calculatePropertiesChecksum = async () => {
    if (!propertiesTarget || propertiesTargets.length > 1 || propertiesTarget.isDir) return;
    if (propertiesTarget.fileType === "symlink") {
      pushToast("info", "符号链接不计算 SHA-256");
      return;
    }
    setPropertiesChecksumLoading(true);
    try {
      const checksum =
        propertiesSide === "local"
          ? await api.localFileSha256(propertiesTarget.path)
          : activeProfile && !isLocalProtocol(activeProfile.protocol)
            ? await api.remoteFileSha256(activeProfile.id, propertiesTarget.path, passwordForActive)
            : "";
      if (checksum) setPropertiesChecksum(checksum);
    } catch (error) {
      if (propertiesSide === "remote" && requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `校验失败: ${String(error)}`);
    } finally {
      setPropertiesChecksumLoading(false);
    }
  };

  const {
    copyPropertiesReport,
    copyPropertiesCsv,
    downloadPropertiesCsv,
    copyPropertiesJson,
    downloadPropertiesJson
  } = buildPropertiesReportActions({
    propertiesSide,
    propertiesTarget,
    propertiesTargets,
    propertiesReportOptions: {
      uid: propertiesUid,
      gid: propertiesGid,
      mode: propertiesMode,
      mtime: propertiesMtime,
      stats: propertiesStats,
      checksum: propertiesChecksum,
      recursive: propertiesRecursive
    },
    copyWithFallback,
    pushToast
  });
  const {
    copySelectedSha256,
    copySelectedSha256Csv,
    downloadSelectedSha256Csv,
    copySelectedSha256Json,
    downloadSelectedSha256Json
  } = buildSelectedSha256Actions({
    activeProfile,
    passwordForActive,
    visibleSelectedLocalEntries,
    visibleSelectedRemoteEntries,
    copyWithFallback,
    pushToast,
    setStatus,
    requestProfileSecret
  });

  const compareSelectedSha256 = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || !visibleSelectedLocal || !visibleSelectedRemote) return;
    if (visibleSelectedLocal.isDir || visibleSelectedRemote.isDir) {
      pushToast("error", "只能校验文件");
      return;
    }
    if (visibleSelectedLocal.fileType === "symlink" || visibleSelectedRemote.fileType === "symlink") {
      pushToast("info", "符号链接不参与 SHA-256 对比");
      return;
    }
    try {
      const [localHash, remoteHash] = await Promise.all([
        api.localFileSha256(visibleSelectedLocal.path),
        api.remoteFileSha256(activeProfile.id, visibleSelectedRemote.path, passwordForActive)
      ]);
      const same = localHash === remoteHash;
      setStatus(
        same
          ? `SHA-256 一致: ${localHash}`
          : `SHA-256 不一致: 本地 ${localHash.slice(0, 12)}... / 远程 ${remoteHash.slice(0, 12)}...`
      );
      pushToast(same ? "success" : "error", same ? "SHA-256 一致" : "SHA-256 不一致");
    } catch (error) {
      if (requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `校验失败: ${String(error)}`);
    }
  };

  const runWindowAction = async (action: WindowAction) => {
    if (!hasTauriRuntime()) return;
    try {
      const appWindow = getCurrentWindow();
      if (action === "minimize") await appWindow.minimize();
      if (action === "maximize") await appWindow.toggleMaximize();
      if (action === "close") await appWindow.close();
    } catch (error) {
      const message = `窗口操作失败: ${String(error)}`;
      setStatus(message);
      pushToast("error", message);
    }
  };

  const applyProperties = async () => {
    if (!propertiesTarget) return;
    const targets = propertiesTargets.length ? propertiesTargets : [propertiesTarget];
    const editableTargets = targets.filter((target) => target.fileType !== "symlink");
    const multiple = targets.length > 1;
    const uid = parseOptionalOwnerId(propertiesUid);
    const gid = parseOptionalOwnerId(propertiesGid);
    if (propertiesSide === "remote" && (uid === undefined || gid === undefined)) {
      pushToast("error", "UID/GID 必须是有效数字");
      return;
    }
    const mode = resolvePermissionMode(propertiesMode, propertiesTarget);
    if (mode === undefined) {
      pushToast("error", "权限格式不正确");
      return;
    }
    const mtime = parseDateTimeLocal(propertiesMtime);
    if (mtime === undefined) {
      pushToast("error", "修改时间格式不正确");
      return;
    }
    const originalMode = propertiesTarget.permissions ?? null;
    const shouldChmod = mode !== null && (multiple || mode !== originalMode);
    const targetModes = shouldChmod
      ? editableTargets.map((target) => ({
          target,
          mode: resolvePermissionMode(propertiesMode, target)
        }))
      : [];
    if (targetModes.some((item) => item.mode === undefined || item.mode === null)) {
      pushToast("error", "权限格式不正确");
      return;
    }
    const targetModeByPath = new Map(targetModes.map((item) => [item.target.path, item.mode as number]));
    const originalMtime = Math.floor(new Date(propertiesTarget.modifiedAt).getTime() / 1000);
    const shouldTouch = mtime != null && (multiple || mtime !== originalMtime);
    const shouldChown =
      propertiesSide === "remote" &&
      (multiple
        ? uid !== null || gid !== null
        : (uid !== null && uid !== (propertiesTarget.uid ?? null)) || (gid !== null && gid !== (propertiesTarget.gid ?? null)));
    if (!shouldChmod && !shouldChown && !shouldTouch) {
      pushToast("error", "没有需要应用的属性变更");
      return;
    }
    if (propertiesSide === "local") {
      if ((shouldChmod || shouldTouch) && editableTargets.length === 0) {
        pushToast("info", "符号链接不会修改目标权限或时间");
        setDialog(null);
        return;
      }

      const failures: string[] = [];
      let updated = 0;
      for (const target of editableTargets) {
        try {
          if (shouldChmod && mode !== null) {
            await api.chmodLocalPath(target.path, targetModeByPath.get(target.path)!, propertiesRecursive && target.isDir);
          }
          if (shouldTouch && mtime != null) {
            await api.touchLocalPath(target.path, mtime, propertiesRecursive && target.isDir);
          }
          updated += 1;
        } catch (error) {
          failures.push(`${target.name}: ${String(error)}`);
        }
      }

      setDialog(null);
      await refreshLocalFiles();
      const skipped = targets.length - editableTargets.length;
      if (updated > 0) {
        const suffix = skipped > 0 ? `，已跳过 ${skipped} 个符号链接` : "";
        pushToast("success", updated === 1 ? `本地属性已更新${suffix}` : `已更新 ${updated} 个本地项目的属性${suffix}`);
      }
      if (failures.length > 0) {
        const summary = failures.slice(0, 3).join("；");
        setStatus(`本地属性修改失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
        pushToast("error", `本地属性修改失败 ${failures.length} 个项目`);
      }
      return;
    }

    if (!activeProfile) return;
    if (editableTargets.length === 0) {
      pushToast("info", "符号链接不会修改权限、属主或时间");
      setDialog(null);
      return;
    }

    const failures: string[] = [];
    let updated = 0;
    for (const target of editableTargets) {
      try {
        if (shouldChmod && mode !== null) {
          await api.chmodRemotePath(activeProfile.id, target.path, targetModeByPath.get(target.path)!, propertiesRecursive && target.isDir, passwordForActive);
        }
        if (shouldChown) {
          await api.chownRemotePath(
            activeProfile.id,
            target.path,
            uid ?? null,
            gid ?? null,
            propertiesRecursive && target.isDir,
            passwordForActive
          );
        }
        if (shouldTouch && mtime != null) {
          await api.touchRemotePath(
            activeProfile.id,
            target.path,
            mtime,
            propertiesRecursive && target.isDir,
            passwordForActive
          );
        }
        updated += 1;
      } catch (error) {
        failures.push(`${target.name}: ${String(error)}`);
      }
    }

    setDialog(null);
    await refreshRemoteFiles();
    const skipped = targets.length - editableTargets.length;
    if (updated > 0) {
      const suffix = skipped > 0 ? `，已跳过 ${skipped} 个符号链接` : "";
      pushToast("success", updated === 1 ? `属性已更新${suffix}` : `已更新 ${updated} 个项目的属性${suffix}`);
    }
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`属性修改失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `属性修改失败 ${failures.length} 个项目`);
      if (shouldPromptForPassword(activeProfile, failures[0])) {
        requestProfileSecret(activeProfile, failures[0]);
        pushToast("info", "请输入连接密码/口令");
      }
    }
  };

  const createRemoteFile = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const name = await promptText("文件名称或相对路径");
    if (!name) return;
    try {
      const path = await api.createRemoteFile(activeProfile.id, remotePath, name, passwordForActive);
      await revealCreatedPath("remote", path);
      const file = await api.readRemoteFile(activeProfile.id, path, passwordForActive);
      setEditorSide("remote");
      setEditorFile(editorFileMetadata(file));
      setEditorPreviewPosition("head");
      setEditorContent(file.content);
      setDialog("editor");
      pushToast("success", "文件已创建");
    } catch (error) {
      if (requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `文件创建失败: ${String(error)}`);
    }
  };

  const createRemoteSymlink = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const target = await promptText("链接目标路径", { defaultValue: selectedRemote?.path ?? "" });
    if (!target?.trim()) return;
    const name = await promptText("链接名称或相对路径", { defaultValue: selectedRemote ? `${selectedRemote.name}.link` : "" });
    if (!name?.trim()) return;
    try {
      const path = await api.createRemoteSymlink(activeProfile.id, remotePath, name.trim(), target.trim(), passwordForActive);
      await revealCreatedPath("remote", path);
      pushToast("success", "软链接已创建");
    } catch (error) {
      if (requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `软链接创建失败: ${String(error)}`);
    }
  };

  const openRemoteEditor = async (entry: FileEntry | null, position: TextPreviewPosition = "head") => {
    if (!activeProfile || !entry || entry.isDir || isLocalProtocol(activeProfile.protocol)) return;
    if (entry.fileType === "symlink") {
      pushToast("info", "符号链接不直接编辑，请打开链接目标");
      return;
    }
    try {
      const file =
        position === "tail"
          ? await api.readRemoteFileTail(activeProfile.id, entry.path, passwordForActive)
          : await api.readRemoteFile(activeProfile.id, entry.path, passwordForActive);
      setEditorSide("remote");
      setEditorFile(editorFileMetadata(file));
      setEditorPreviewPosition(position);
      setEditorContent(file.content);
      setDialog("editor");
      if (file.isBinary) pushToast("info", "疑似二进制文件，已切换为查看");
      if (file.truncated) pushToast("info", position === "tail" ? "文件较大，仅加载末尾 1MB" : "文件较大，仅加载前 1MB");
    } catch (error) {
      if (requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `文件读取失败: ${String(error)}`);
    }
  };

  const openRemoteEditorForProfile = async (
    profile: Profile,
    password: string,
    entry: FileEntry | null,
    position: TextPreviewPosition = "head"
  ) => {
    if (!entry || entry.isDir || isLocalProtocol(profile.protocol)) return;
    if (entry.fileType === "symlink") {
      pushToast("info", "符号链接不直接编辑，请打开链接目标");
      return;
    }
    try {
      const file =
        position === "tail"
          ? await api.readRemoteFileTail(profile.id, entry.path, password || undefined)
          : await api.readRemoteFile(profile.id, entry.path, password || undefined);
      setEditorSide("remote");
      setEditorFile(editorFileMetadata(file));
      setEditorPreviewPosition(position);
      setEditorContent(file.content);
      setDialog("editor");
      if (file.isBinary) pushToast("info", "疑似二进制文件，已切换为查看");
      if (file.truncated) pushToast("info", position === "tail" ? "文件较大，仅加载末尾 1MB" : "文件较大，仅加载前 1MB");
    } catch (error) {
      if (shouldPromptForPassword(profile, String(error))) {
        requestProfileSecret(profile, String(error));
        return;
      }
      pushToast("error", `文件读取失败: ${String(error)}`);
    }
  };

  const openLocalEditor = async (entry: FileEntry | null, position: TextPreviewPosition = "head") => {
    if (!entry || entry.isDir) return;
    if (entry.fileType === "symlink") {
      pushToast("info", "符号链接不直接编辑，请打开链接目标");
      return;
    }
    try {
      const file = position === "tail" ? await api.readLocalFileTail(entry.path) : await api.readLocalFile(entry.path);
      setEditorSide("local");
      setEditorFile(editorFileMetadata(file));
      setEditorPreviewPosition(position);
      setEditorContent(file.content);
      setDialog("editor");
      if (file.isBinary) pushToast("info", "疑似二进制文件，已切换为查看");
      if (file.truncated) pushToast("info", position === "tail" ? "文件较大，仅加载末尾 1MB" : "文件较大，仅加载前 1MB");
    } catch (error) {
      pushToast("error", `文件读取失败: ${String(error)}`);
    }
  };

  const loadEditorPreview = async (position: TextPreviewPosition) => {
    if (!editorFile) return;
    try {
      const file =
        editorSide === "local"
          ? position === "tail"
            ? await api.readLocalFileTail(editorFile.path)
            : await api.readLocalFile(editorFile.path)
          : activeProfile
            ? position === "tail"
              ? await api.readRemoteFileTail(activeProfile.id, editorFile.path, passwordForActive)
              : await api.readRemoteFile(activeProfile.id, editorFile.path, passwordForActive)
            : null;
      if (!file) return;
      setEditorFile(editorFileMetadata(file));
      setEditorPreviewPosition(position);
      setEditorContent(file.content);
      pushToast("success", position === "tail" ? "已加载文件末尾" : "已加载文件开头");
    } catch (error) {
      if (editorSide === "remote" && requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `文件读取失败: ${String(error)}`);
    }
  };

  const locateSymlinkTarget = async (side: FileSide, entry: FileEntry | null) => {
    if (!entry || entry.fileType !== "symlink" || !entry.linkTarget?.trim()) return;
    const targetPath = resolveSymlinkTargetPath(side, entry);
    if (!targetPath) return;
    try {
      if (side === "local") {
        const files = await api.listLocalDir(targetPath);
        replaceLocalFiles(files, undefined, { preserveSelection: false });
        navigateLocalPath(targetPath);
        return;
      }

      if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
      const files = await api.listRemoteDir(activeProfile.id, targetPath, passwordForActive);
      replaceRemoteFiles(files, undefined, { preserveSelection: false });
      navigateRemotePath(targetPath);
    } catch (error) {
      if (side === "remote" && requestActiveProfileSecretIfNeeded(error)) return;
      const parentPath = parentPathForSide(side, targetPath);
      if (side === "local") {
        navigateLocalPath(parentPath, targetPath);
      } else {
        navigateRemotePath(parentPath, targetPath);
      }
      pushToast("info", "已定位到链接目标所在目录");
    }
  };

  const saveEditor = async () => {
    if (!editorFile) return;
    if (editorFile.isBinary || editorFile.truncated) {
      pushToast("error", "当前文件处于只读预览状态");
      return;
    }
    try {
      if (editorSide === "local") {
        await api.writeLocalFile(editorFile.path, editorContent);
        await refreshLocalFiles(editorFile.path);
      } else {
        if (!activeProfile) return;
        await api.writeRemoteFile(activeProfile.id, editorFile.path, editorContent, passwordForActive);
        await refreshRemoteFiles(editorFile.path);
      }
      setDialog(null);
      pushToast("success", "文件已保存");
    } catch (error) {
      if (editorSide === "remote" && requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `文件保存失败: ${String(error)}`);
    }
  };

  const searchRemoteFiles = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const query = await promptText("搜索远程文件", { defaultValue: visibleSelectedRemote?.name ?? "" });
    if (!query?.trim()) return;
    try {
      const files = await api.searchRemote(activeProfile.id, remotePath, query.trim(), 300, passwordForActive);
      applyRemoteSearch(files, { root: remotePath, query: query.trim(), count: files.length });
      setStatus(`远程搜索 ${remotePath}: ${query.trim()} (${files.length})`);
    } catch (error) {
      if (requestActiveProfileSecretIfNeeded(error)) return;
      pushToast("error", `搜索失败: ${String(error)}`);
    }
  };

  const searchLocalFiles = async () => {
    const query = await promptText("搜索本地文件", { defaultValue: visibleSelectedLocal?.name ?? "" });
    if (!query?.trim()) return;
    try {
      const files = await api.searchLocal(localPath, query.trim(), 300);
      applyLocalSearch(files, { root: localPath, query: query.trim(), count: files.length });
      setStatus(`本地搜索 ${localPath}: ${query.trim()} (${files.length})`);
    } catch (error) {
      pushToast("error", `搜索失败: ${String(error)}`);
    }
  };

  const calculateSelectionStats = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    if (side === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return;
    setSelectionStatsLoading(side);
    let totalSize = 0;
    let fileCount = 0;
    let dirCount = 0;
    let counted = 0;
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        const stats =
          side === "local"
            ? await api.localPathStats(entry.path)
            : await api.remotePathStats(activeProfile!.id, entry.path, passwordForActive);
        totalSize += stats.totalSize;
        fileCount += stats.fileCount;
        dirCount += stats.dirCount;
        counted += 1;
      } catch (error) {
        failures.push(`${entry.name}: ${String(error)}`);
      }
    }

    try {
      if (counted > 0) {
        const next = `总大小 ${formatSize(totalSize)} / ${fileCount} 文件${dirCount ? ` / ${dirCount} 目录` : ""}`;
        if (side === "local") {
          setLocalSelectionStats(next);
        } else {
          setRemoteSelectionStats(next);
        }
      }
      if (failures.length > 0) {
        const summary = failures.slice(0, 3).join("；");
        setStatus(`大小计算失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
        pushToast("error", `大小计算失败 ${failures.length} 个项目`);
        if (side === "remote" && activeProfile && shouldPromptForPassword(activeProfile, failures[0])) {
          requestProfileSecret(activeProfile, failures[0]);
          pushToast("info", "请输入连接密码/口令");
        }
      }
    } catch (error) {
      pushToast("error", `大小计算失败: ${String(error)}`);
    } finally {
      setSelectionStatsLoading(null);
    }
  };

  const startTransferEntries = async (direction: "upload" | "download", entries: FileEntry[], successPrefix = "传输") => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    if (entries.length === 0) return;
    const failures: string[] = [];
    let started = 0;
    for (const entry of entries) {
      try {
        if (direction === "upload") {
          await api.startTransfer(activeProfile.id, "upload", entry.path, remotePath, transferConflict, passwordForActive);
        } else {
          await api.startTransfer(activeProfile.id, "download", localPath, entry.path, transferConflict, passwordForActive);
        }
        started += 1;
      } catch (error) {
        failures.push(`${entry.name}: ${String(error)}`);
      }
    }
    if (started > 0) {
      busRef.current.emit("refreshTransfers", undefined);
      busRef.current.emit("toast", {
        tone: "success",
        text: started === 1 ? `${successPrefix}已开始` : `${started} 个${successPrefix}已开始`
      });
    }
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`传输启动失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `传输启动失败 ${failures.length} 个项目`);
      if (shouldPromptForPassword(activeProfile, failures[0])) {
        requestProfileSecret(activeProfile, failures[0]);
        pushToast("info", "请输入连接密码/口令");
      }
    }
  };

  const startTransferPlanItems = async (plan: SyncPlanState, successPrefix = "计划传输") => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    if (plan.items.length === 0) return;
    const conflict = plan.conflictStrategy ?? transferConflict;
    const failures: string[] = [];
    let started = 0;
    for (const item of plan.items) {
      try {
        if (plan.direction === "upload") {
          await api.startTransfer(activeProfile.id, "upload", item.source || item.entry.path, remoteParentPath(item.target), conflict, passwordForActive);
        } else {
          await api.startTransfer(activeProfile.id, "download", localParentPath(item.target), item.source || item.entry.path, conflict, passwordForActive);
        }
        started += 1;
      } catch (error) {
        failures.push(`${item.name}: ${String(error)}`);
      }
    }
    if (started > 0) {
      busRef.current.emit("refreshTransfers", undefined);
      busRef.current.emit("toast", {
        tone: "success",
        text: started === 1 ? `${successPrefix}已开始` : `${started} 个${successPrefix}已开始`
      });
    }
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`计划传输启动失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `计划传输启动失败 ${failures.length} 个项目`);
      if (shouldPromptForPassword(activeProfile, failures[0])) {
        requestProfileSecret(activeProfile, failures[0]);
        pushToast("info", "请输入连接密码/口令");
      }
    }
  };

  const startTransfer = async (direction: "upload" | "download") => {
    const entries = direction === "upload" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    await startTransferEntries(direction, entries);
  };

  const uploadExternalPaths = useCallback(
    async (paths: string[]) => {
      if (!activeProfile || isLocalProtocol(activeProfile.protocol)) {
        pushToast("info", "请选择远程会话后再拖入上传");
        return;
      }
      if (!remoteHomeReady) {
        pushToast("info", "远程目录尚未就绪");
        return;
      }
      const uniquePaths = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
      if (uniquePaths.length === 0) return;

      const failures: string[] = [];
      let started = 0;
      for (const path of uniquePaths) {
        try {
          await api.startTransfer(activeProfile.id, "upload", path, remotePath, transferConflict, passwordForActive);
          started += 1;
        } catch (error) {
          failures.push(`${pathBaseName(path) || path}: ${String(error)}`);
        }
      }

      if (started > 0) {
        busRef.current.emit("refreshTransfers", undefined);
        busRef.current.emit("toast", {
          tone: "success",
          text: started === 1 ? "上传已开始" : `${started} 个上传已开始`
        });
      }
      if (failures.length > 0) {
        const summary = failures.slice(0, 3).join("；");
        setStatus(`上传启动失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
        pushToast("error", `上传启动失败 ${failures.length} 个项目`);
        if (shouldPromptForPassword(activeProfile, failures[0])) {
          requestProfileSecret(activeProfile, failures[0]);
          pushToast("info", "请输入连接密码/口令");
        }
      }
    },
    [activeProfile, passwordForActive, pushToast, remoteHomeReady, remotePath, transferConflict]
  );

  const syncComparedEntries = async (direction: "upload" | "download", scope: "all" | "missing" = "all") => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries =
      direction === "upload"
        ? baseVisibleLocalFiles.filter((entry) => {
            const kind = directoryCompare.local.get(entry.path)?.kind;
            return scope === "missing" ? kind === "only-local" : kind === "only-local" || kind === "different";
          })
        : baseVisibleRemoteFiles.filter((entry) => {
            const kind = directoryCompare.remote.get(entry.path)?.kind;
            return scope === "missing" ? kind === "only-remote" : kind === "only-remote" || kind === "different";
          });
    if (entries.length === 0) return;
    const title =
      direction === "upload"
        ? scope === "missing"
          ? "上传仅本地项目"
          : "上传目录差异"
        : scope === "missing"
          ? "下载仅远程项目"
          : "下载目录差异";
    const marks = direction === "upload" ? directoryCompare.local : directoryCompare.remote;
    setSyncPlan({
      direction,
      mode: "transfer",
      scope,
      conflictStrategy: transferConflict,
      title,
      items: entries.map((entry) => {
        const mark = marks.get(entry.path);
        return {
          entry,
          action: mark?.kind === "different" ? "overwrite" : "create",
          name: entry.name,
          source: entry.path,
          target:
            direction === "upload"
              ? joinRemotePath(remotePath || ".", entry.name)
              : joinLocalPath(localPath || ".", entry.name),
          detail: mark?.detail ?? compareKindLabel(mark?.kind ?? "different")
        };
      })
    });
    setDialog("syncPlan");
  };

  const executeSyncPlan = async () => {
    if (!syncPlan) return;
    const currentPlan = syncPlan;
    setDialog(null);
    setSyncPlan(null);
    if (currentPlan.mode === "metadata") {
      await applyMetadataSyncPlan(currentPlan);
      return;
    }
    await startTransferPlanItems(currentPlan, currentPlan.scope === "missing" ? "缺失项传输" : "差异传输");
  };

  const syncComparedMetadata = async (direction: "upload" | "download") => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const localByName = new Map(baseVisibleLocalFiles.map((file) => [file.name, file]));
    const remoteByName = new Map(baseVisibleRemoteFiles.map((file) => [file.name, file]));
    const pairs = [...localByName.entries()]
      .map(([name, local]) => ({ local, remote: remoteByName.get(name) }))
      .filter(({ local, remote }) => remote && directoryCompare.local.get(local.path)?.kind === "different") as Array<{
        local: FileEntry;
        remote: FileEntry;
      }>;
    const targets = pairs.filter(({ local, remote }) => local.fileType !== "symlink" && remote.fileType !== "symlink");
    if (targets.length === 0) {
      pushToast("info", "没有可同步的元数据差异");
      return;
    }
    const items: SyncPlanItem[] = targets
      .flatMap(({ local, remote }) => {
        const source = direction === "upload" ? local : remote;
        const target = direction === "upload" ? remote : local;
        const changes = metadataSyncChanges(source, target, direction);
        if (changes.length === 0) return [];
        return [{
          entry: target,
          sourceEntry: source,
          targetEntry: target,
          action: "metadata" as const,
          name: target.name,
          source: source.path,
          target: target.path,
          detail: changes.join("、"),
          changes
        }];
      });
    if (items.length === 0) {
      pushToast("info", "没有可同步的元数据差异");
      return;
    }
    setSyncPlan({
      direction,
      mode: "metadata",
      scope: "metadata",
      title: direction === "upload" ? "元数据同步到远程" : "元数据同步到本地",
      items
    });
    setDialog("syncPlan");
  };

  const applyMetadataSyncPlan = async (plan: SyncPlanState) => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    let applied = 0;
    const failures: string[] = [];
    for (const item of plan.items) {
      try {
        const source = item.sourceEntry;
        const target = item.targetEntry;
        if (!source || !target) continue;
        if (source.permissions != null && source.permissions !== target.permissions) {
          if (plan.direction === "upload") {
            await api.chmodRemotePath(activeProfile.id, target.path, source.permissions, false, passwordForActive);
          } else {
            await api.chmodLocalPath(target.path, source.permissions, false);
          }
          applied += 1;
        }
        const sourceMtime = Math.floor(new Date(source.modifiedAt).getTime() / 1000);
        const targetMtime = Math.floor(new Date(target.modifiedAt).getTime() / 1000);
        if (Number.isFinite(sourceMtime) && Number.isFinite(targetMtime) && Math.abs(sourceMtime - targetMtime) > 2) {
          if (plan.direction === "upload") {
            await api.touchRemotePath(activeProfile.id, target.path, sourceMtime, false, passwordForActive);
          } else {
            await api.touchLocalPath(target.path, sourceMtime, false);
          }
          applied += 1;
        }
        if (
          plan.direction === "upload" &&
          (source.uid != null || source.gid != null) &&
          (source.uid !== target.uid || source.gid !== target.gid)
        ) {
          await api.chownRemotePath(activeProfile.id, target.path, source.uid ?? null, source.gid ?? null, false, passwordForActive);
          applied += 1;
        }
      } catch (error) {
        failures.push(`${item.name}: ${String(error)}`);
      }
    }
    if (plan.direction === "upload") {
      await refreshRemoteFiles();
    } else {
      await refreshLocalFiles();
    }
    if (applied > 0 || failures.length === 0) {
      pushToast("success", applied > 0 ? `已同步 ${applied} 项元数据` : "元数据已一致");
    }
    if (failures.length > 0) {
      const summary = failures.slice(0, 3).join("；");
      setStatus(`元数据同步失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
      pushToast("error", `元数据同步失败 ${failures.length} 个项目`);
      if (shouldPromptForPassword(activeProfile, failures[0])) {
        requestProfileSecret(activeProfile, failures[0]);
        pushToast("info", "请输入连接密码/口令");
      }
    }
  };

  const filePaneSideAtPosition = useCallback((position: { x: number; y: number }): FileSide | null => {
    const ratio = window.devicePixelRatio || 1;
    const candidates = [
      { x: position.x, y: position.y },
      { x: position.x / ratio, y: position.y / ratio }
    ];
    for (const point of candidates) {
      if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) continue;
      const element = document.elementFromPoint(point.x, point.y) as HTMLElement | null;
      const pane = element?.closest<HTMLElement>("[data-file-pane-side]");
      const side = pane?.dataset.filePaneSide;
      if (side === "local" || side === "remote") return side;
    }
    return null;
  }, []);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setDragOverSide((current) => (current === "remote" ? null : current));
          return;
        }

        const side = filePaneSideAtPosition(payload.position);
        if (payload.type === "enter" || payload.type === "over") {
          if (remoteBrowserReady && remoteHomeReady && (side === "remote" || (isFileManagerWindow && side !== "local"))) {
            setDragOverSide("remote");
          } else {
            setDragOverSide((current) => (current === "remote" ? null : current));
          }
          return;
        }

        if (payload.type === "drop") {
          setDragOverSide((current) => (current === "remote" ? null : current));
          if (side === "local") {
            pushToast("info", "请拖放到远程面板上传");
            return;
          }
          if (side !== "remote" && !isFileManagerWindow) {
            return;
          }
          void uploadExternalPaths(payload.paths);
        }
      })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error) => {
        console.warn("failed to listen drag drop events", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [filePaneSideAtPosition, isFileManagerWindow, pushToast, remoteBrowserReady, remoteHomeReady, uploadExternalPaths]);

  const beginFileDrag = (side: FileSide, file: FileEntry, event: DragEvent<HTMLButtonElement>) => {
    const selectedPaths = side === "local" ? selectedLocalPaths : selectedRemotePaths;
    const selectedEntries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    const entries = selectedPaths.includes(file.path) && selectedEntries.length > 0 ? selectedEntries : [file];
    fileDragRef.current = { side, entries };
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", entries.map((entry) => entry.path).join("\n"));
  };

  const handleFileDragOver = (side: FileSide, event: DragEvent<HTMLDivElement>) => {
    const payload = fileDragRef.current;
    if (!payload || payload.side === side) return;
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOverSide(side);
  };

  const handleFileDragLeave = (side: FileSide, event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    setDragOverSide((current) => (current === side ? null : current));
  };

  const handleFileDrop = async (side: FileSide, event: DragEvent<HTMLDivElement>) => {
    const payload = fileDragRef.current;
    fileDragRef.current = null;
    setDragOverSide(null);
    if (!payload || payload.side === side) return;
    event.preventDefault();
    if (payload.side === "local" && side === "remote") {
      await startTransferEntries("upload", payload.entries);
    } else if (payload.side === "remote" && side === "local") {
      await startTransferEntries("download", payload.entries);
    }
  };

  const endFileDrag = () => {
    fileDragRef.current = null;
    setDragOverSide(null);
  };

  const filteredProfiles = useMemo(() => {
    const needle = deferredSessionSearch.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(needle) ||
        profile.group.toLowerCase().includes(needle) ||
        profile.host.toLowerCase().includes(needle)
    );
  }, [deferredSessionSearch, profiles]);
  const remoteProfileOptions = useMemo<SelectOption<string>[]>(() => {
    const options = profiles
      .filter((profile) => isRemoteProtocol(profile.protocol))
      .map((profile) => ({
        value: profile.id,
        label: `${profile.name} (${profile.username}@${profile.host}:${profile.port})`
      }));
    return options.length > 0 ? options : [{ value: "", label: "无远程会话", disabled: true }];
  }, [profiles]);
  const fileManagerProfileValue =
    activeProfile && isRemoteProtocol(activeProfile.protocol) ? activeProfile.id : remoteProfileOptions[0]?.value ?? "";
  const selectRemoteBrowserProfile = (profileId: string) => {
    if (!profileId) return;
    window.localStorage.setItem(fileManagerProfileStorageKey, profileId);
    setSelectedProfileId(profileId);
    resetRemoteBrowserProfile(profileId);
  };
  useEffect(() => {
    if (!isFileManagerWindow) return;
    const switchProfile = (profileId: string | null) => {
      if (!profileId || !profiles.some((profile) => profile.id === profileId && isRemoteProtocol(profile.protocol))) {
        return;
      }
      setSelectedProfileId(profileId);
      resetRemoteBrowserProfile(profileId);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === fileManagerProfileStorageKey) {
        switchProfile(event.newValue);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [isFileManagerWindow, profiles, resetRemoteBrowserProfile]);
  const handleTerminalDrain = (next: TerminalDrain, profileId: string) => {
    setTabs((current) => {
      let changed = false;
      const updated = current.map((tab) => {
        if (tab.id !== next.id) return tab;
        const same =
          tab.status === next.status &&
          tab.statusLabel === next.statusLabel &&
          (tab.lastError ?? "") === (next.lastError ?? "") &&
          (tab.hostKeyIssue?.fingerprint ?? "") === (next.hostKeyIssue?.fingerprint ?? "") &&
          (tab.currentDirectory ?? "") === (next.currentDirectory ?? "");
        if (same) return tab;
        changed = true;
        return {
          ...tab,
          status: next.status,
          statusLabel: next.statusLabel,
          lastError: next.lastError,
          hostKeyIssue: next.hostKeyIssue,
          currentDirectory: next.currentDirectory
        };
      });
      return changed ? updated : current;
    });
    if (next.hostKeyIssue) {
      setHostKeyPrompt({ profileId, issue: next.hostKeyIssue });
    }
    void retryAuthFailure(next, profileId).catch((error) => {
      setStatus(`认证重试失败: ${String(error)}`);
      pushToast("error", "认证重试失败");
    });
  };
  const transferQueueProps = buildTransferQueueProps({
    transfers,
    history: transferHistory,
    conflict: transferConflict,
    profiles,
    formatSize,
    onConflict: setTransferConflict,
    onTransfers: setTransfers,
    onHistory: setTransferHistory,
    onSelectedProfile: setSelectedProfileId,
    refreshTransfers,
    pushToast,
    copyWithFallback,
    onCopyCsv: copyTransferAuditCsv,
    onDownloadCsv: downloadTransferAuditCsv,
    navigateLocalPath,
    navigateRemotePath
  });
  const canUseRemoteFileActions = Boolean(activeProfile && !isLocalProtocol(activeProfile.protocol));
  const canSendRemotePathToTerminal = Boolean(activeProfile && isSshProtocol(activeProfile.protocol));
  const {
    copySelectedPaths,
    copySelectedNames,
    copySelectedParentPaths,
    copySelectedRelativePaths,
    copySelectedFileInfo,
    copySelectedFileInfoCsv,
    downloadSelectedFileInfoCsv,
    copyCurrentDirectoryFileInfoCsv,
    downloadCurrentDirectoryFileInfoCsv,
    copySelectedLinkTargets
  } = buildFileSelectionClipboardActions({
    localPath,
    remotePath,
    visibleSelectedLocalEntries,
    visibleSelectedRemoteEntries,
    localFiles,
    remoteFiles,
    copyWithFallback,
    pushToast
  });

  const localFilePaneActions = buildLocalFilePaneActions({
    selected: visibleSelectedLocal,
    selectedEntries: visibleSelectedLocalEntries,
    visibleFiles: visibleLocalFiles,
    directoryEntryCount: localFiles.length,
    localPath,
    canUseRemote: canUseRemoteFileActions,
    compareDiffCount: directoryCompare.summary.onlyLocal + directoryCompare.summary.different,
    onOpenSelected: () => {
      if (!visibleSelectedLocal) return;
      if (visibleSelectedLocal.isDir) {
        navigateLocalPath(visibleSelectedLocal.path);
        return;
      }
      if (visibleSelectedLocal.fileType === "symlink") {
        void locateSymlinkTarget("local", visibleSelectedLocal);
        return;
      }
      void openLocalEditor(visibleSelectedLocal);
    },
    onUpload: () => {
      void startTransfer("upload");
    },
    onSyncDifference: () => {
      void syncComparedEntries("upload");
    },
    onSearch: searchLocalFiles,
    onCreateFile: createLocalFile,
    onCreateDirectory: () => makeDir("local"),
    onCreateSymlink: createLocalSymlink,
    onDuplicate: duplicateLocalSelected,
    onMove: moveLocalSelected,
    onRename: () => renameSelected("local"),
    onRemove: () => removeSelected("local"),
    onCopyPaths: () => copySelectedPaths("local"),
    onCopyNames: () => copySelectedNames("local"),
    onCopyParentPaths: () => copySelectedParentPaths("local"),
    onCopyRelativePaths: () => copySelectedRelativePaths("local"),
    onCopyFileInfo: () => copySelectedFileInfo("local"),
    onCopyFileInfoCsv: () => copySelectedFileInfoCsv("local"),
    onDownloadFileInfoCsv: () => downloadSelectedFileInfoCsv("local"),
    onCopyCurrentDirectoryCsv: () => copyCurrentDirectoryFileInfoCsv("local"),
    onDownloadCurrentDirectoryCsv: () => downloadCurrentDirectoryFileInfoCsv("local"),
    onCopyLinkTargets: () => copySelectedLinkTargets("local"),
    onCopySha256: () => copySelectedSha256("local"),
    onCopySha256Csv: () => copySelectedSha256Csv("local"),
    onDownloadSha256Csv: () => downloadSelectedSha256Csv("local"),
    onCopySha256Json: () => copySelectedSha256Json("local"),
    onDownloadSha256Json: () => downloadSelectedSha256Json("local"),
    onCopyChmodCommands: () => copyChmodCommands("local"),
    onCopyTouchCommands: () => copyTouchCommands("local"),
    onCopyScpUploadCommands: () => copyScpCommands("upload"),
    onCopyRsyncUploadCommands: () => copyRsyncCommands("upload"),
    onCopyRsyncUploadDryRun: () => copyRsyncCommands("upload", true),
    onOpenShellHere: openLocalShellHere,
    onRevealSelected: revealLocalSelected,
    onEditSelected: (position) => {
      void openLocalEditor(visibleSelectedLocal, position);
    },
    onOpenProperties: () => openPropertiesDialog("local", visibleSelectedLocal, visibleSelectedLocalEntries),
    onOpenChmod: () => openChmodDialog("local", visibleSelectedLocal, visibleSelectedLocalEntries),
    onSelectAll: () => selectAllFiles("local"),
    onInvertSelection: () => invertFileSelection("local"),
    onClearSelection: clearLocalSelection,
    onRefresh: refreshLocalFiles
  });
  const remoteFilePaneActions = buildRemoteFilePaneActions({
    selected: visibleSelectedRemote,
    selectedEntries: visibleSelectedRemoteEntries,
    visibleFiles: visibleRemoteFiles,
    directoryEntryCount: remoteFiles.length,
    canUseRemote: canUseRemoteFileActions,
    canUseSsh: canSendRemotePathToTerminal,
    compareDiffCount: directoryCompare.summary.onlyRemote + directoryCompare.summary.different,
    onOpenSelected: () => {
      if (!visibleSelectedRemote) return;
      if (visibleSelectedRemote.isDir) {
        navigateRemotePath(visibleSelectedRemote.path);
        return;
      }
      if (visibleSelectedRemote.fileType === "symlink") {
        void locateSymlinkTarget("remote", visibleSelectedRemote);
        return;
      }
      void openRemoteEditor(visibleSelectedRemote);
    },
    onDownload: () => {
      void startTransfer("download");
    },
    onSyncDifference: () => {
      void syncComparedEntries("download");
    },
    onCreateFile: createRemoteFile,
    onCreateDirectory: () => makeDir("remote"),
    onCreateSymlink: createRemoteSymlink,
    onDuplicate: duplicateRemoteSelected,
    onMove: moveRemoteSelected,
    onRename: () => renameSelected("remote"),
    onEditSelected: (position) => {
      void openRemoteEditor(visibleSelectedRemote, position);
    },
    onLocateSelected: locateRemoteSelected,
    onCopyPaths: () => copySelectedPaths("remote"),
    onCopyNames: () => copySelectedNames("remote"),
    onCopyParentPaths: () => copySelectedParentPaths("remote"),
    onCopyRelativePaths: () => copySelectedRelativePaths("remote"),
    onCopyFileInfo: () => copySelectedFileInfo("remote"),
    onCopyFileInfoCsv: () => copySelectedFileInfoCsv("remote"),
    onDownloadFileInfoCsv: () => downloadSelectedFileInfoCsv("remote"),
    onCopyCurrentDirectoryCsv: () => copyCurrentDirectoryFileInfoCsv("remote"),
    onDownloadCurrentDirectoryCsv: () => downloadCurrentDirectoryFileInfoCsv("remote"),
    onCopyLinkTargets: () => copySelectedLinkTargets("remote"),
    onCopySymlinkCommands: copyRemoteSymlinkCommands,
    onCopySha256: () => copySelectedSha256("remote"),
    onCopySha256Csv: () => copySelectedSha256Csv("remote"),
    onDownloadSha256Csv: () => downloadSelectedSha256Csv("remote"),
    onCopySha256Json: () => copySelectedSha256Json("remote"),
    onDownloadSha256Json: () => downloadSelectedSha256Json("remote"),
    onCopyStatCommands: copyRemoteStatCommands,
    onCopyRemoteSha256Commands: copyRemoteSha256Commands,
    onCopyDuCommands: copyRemoteDuCommands,
    onCopyListCommands: copyRemoteListCommands,
    onCopyChmodCommands: () => copyChmodCommands("remote"),
    onCopyChownCommands: copyChownCommands,
    onCopyTouchCommands: () => copyTouchCommands("remote"),
    onCopyDeleteCommands: copyRemoteDeleteCommands,
    onCopyUris: copyRemoteUris,
    onCopyScpDownloadCommands: () => copyScpCommands("download"),
    onCopyRsyncDownloadCommands: () => copyRsyncCommands("download"),
    onCopyRsyncDownloadDryRun: () => copyRsyncCommands("download", true),
    onSendPathToTerminal: sendRemotePathToTerminal,
    onSearch: searchRemoteFiles,
    onOpenProperties: () => openPropertiesDialog("remote", visibleSelectedRemote, visibleSelectedRemoteEntries),
    onOpenChmod: () => openChmodDialog("remote", visibleSelectedRemote, visibleSelectedRemoteEntries),
    onRemove: () => removeSelected("remote"),
    onSelectAll: () => selectAllFiles("remote"),
    onInvertSelection: () => invertFileSelection("remote"),
    onClearSelection: clearRemoteSelection,
    onRefresh: refreshRemoteFiles
  });
  const localFilePaneExtraActions = buildLocalFilePaneExtraActions({
    localPath,
    showHidden: showLocalHidden,
    selectedEntries: visibleSelectedLocalEntries,
    onCreateFile: createLocalFile,
    onToggleHidden: () => setShowLocalHidden((current) => !current),
    onSearch: searchLocalFiles,
    onUpload: () => {
      void startTransfer("upload");
    }
  });
  const remoteFilePaneExtraActions = buildRemoteFilePaneExtraActions({
    canUseRemote: canUseRemoteFileActions,
    showHidden: showRemoteHidden,
    selectedEntries: visibleSelectedRemoteEntries,
    onCreateFile: createRemoteFile,
    onToggleHidden: () => setShowRemoteHidden((current) => !current),
    onSearch: searchRemoteFiles,
    onDownload: () => {
      void startTransfer("download");
    }
  });
  const appMenus = buildAppMenus({
    theme: settings.theme,
    canReconnect: Boolean(activeProfile),
    onNewProfile: () => openProfileEditor(),
    onImportSessions: importSessions,
    onExportSessions: exportSessions,
    onQuickConnect: () => setDialog("quick"),
    onReconnectActive: reconnectActive,
    onOpenLocalShell: openLocalShell,
    onOpenTransfers: () => setDialog("transfers"),
    onOpenFileManager: openSftpManager,
    onOpenSettings: () => setDialog("settings"),
    onCycleTheme: () => {
      const nextTheme = settings.theme === "deep" ? "graphite" : settings.theme === "graphite" ? "light" : "deep";
      void persistSettings({ ...settings, theme: nextTheme });
    },
    onWindowAction: (action) => {
      void runWindowAction(action);
    },
    onAbout: () => {
      setStatus("RustShell SSH 终端工具");
      pushToast("info", "RustShell SSH 终端工具");
    }
  });
  return (
    <div
      className={cn(
        "relative isolate grid h-screen w-screen overflow-hidden text-foreground",
        isFileManagerWindow ? "grid-rows-[minmax(0,1fr)] rounded-lg" : "grid-rows-[52px_minmax(0,1fr)] rounded-[10px] border",
        appBackgroundActive ? "bg-transparent" : "bg-background"
      )}
      data-app-bg={appBackgroundActive ? "" : undefined}
      style={appBackgroundActive ? ({ backgroundColor: "transparent", "--app-surface-alpha": String(appBackground.surfaceAlpha) } as CSSProperties) : undefined}
    >
      {appBackgroundActive && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: backgroundImageValue(appBackground) }} />
          <div className="absolute inset-0" style={{ background: "var(--background)", opacity: appBackground.dim / 100 }} />
        </div>
      )}
      <CommandPalette open={commandOpen} menus={appMenus} onOpenChange={setCommandOpen} />
      {!isFileManagerWindow && (
        <AppTopbar
          menus={appMenus}
          hostSearch={hostSearch}
          onHostSearchChange={setHostSearch}
          onConnect={connectFromSearch}
          onStartWindowDrag={startWindowDrag}
          onWindowAction={(action) => {
            void runWindowAction(action);
          }}
        />
      )}

      <WorkspaceLayout
        isFileManagerWindow={isFileManagerWindow}
        leftPanelCollapsed={leftPanelCollapsed}
        rightPanelCollapsed={rightPanelCollapsed}
        style={workspaceStyle}
        leftPanel={
          <SessionSidebar
            collapsed={leftPanelCollapsed}
            profiles={filteredProfiles}
            activeProfile={activeProfile}
            search={sessionSearch}
            serverStatus={serverStatus}
            serverStatusLoading={serverStatusLoading}
            serverStatusError={serverStatusError}
            onSearchChange={setSessionSearch}
            onExpand={() => setLeftPanelCollapsed(false)}
            onCollapse={() => setLeftPanelCollapsed(true)}
            onNewProfile={() => openProfileEditor()}
            onSelectProfile={(profile) => setSelectedProfileId(profile.id)}
            onConnectProfile={connectProfile}
            onRequestSecret={requestProfileSecret}
            onEditProfile={openProfileEditor}
            onCopyCommand={copyConnectionCommand}
            onDuplicateProfile={duplicateSession}
            onDeleteProfile={deleteSession}
            onPromptText={promptText}
            onCreateProfileInGroup={(group) => openProfileEditor(undefined, group)}
            onDeleteFolder={deleteSessionFolder}
            onRefreshServerStatus={() => refreshServerStatus(true)}
          />
        }
        terminalArea={
          <TerminalArea
            tabs={tabs}
            activeTab={activeTab}
            activeTabId={activeTabId}
            primaryPaneActiveTabId={primaryPaneActiveTabId}
            splitPaneTabIds={splitPaneTabIds}
            splitPaneActiveTabId={splitPaneActiveTabId}
            splitDirection={splitDirection}
            splitRatio={splitRatio}
            onSplitRatioChange={setSplitRatio}
            onSplitRight={(tab) => {
              splitTabByDrop(tab.id, "right");
            }}
            onSplitDown={(tab) => {
              splitTabByDrop(tab.id, "bottom");
            }}
            onSplitTabDrop={splitTabByDrop}
            onMoveTabToPrimaryPane={moveTabToPrimaryPane}
            onMoveTabToSplitPane={moveTabToSplitPane}
            onUnsplit={unsplitTerminalPanes}
            fileDockOpenForTab={fileDockOpenForTab}
            onToggleFileDock={toggleFileDockForTab}
            renderFileDock={renderTerminalFileDock}
            terminalBackgroundAlpha={appBackgroundActive ? Math.min(appBackground.surfaceAlpha, 58) : 100}
            settings={settings}
            commandForTab={commandForTab}
            snippets={terminalSnippets}
            activeProfileAvailable={Boolean(activeProfile)}
            canReconnectTab={canReconnectTab}
            onActivateTab={activateTerminalTab}
            onDuplicateTab={(tab) => {
              void duplicateTab(tab);
            }}
            onCloseTab={(tabId) => {
              void closeTabWithConfirm(tabId);
            }}
            onTerminalDrain={handleTerminalDrain}
            onReplayConsumed={markTerminalReplayConsumed}
            onCreateProfile={() => openProfileEditor()}
            onQuickConnect={() => setDialog("quick")}
            onOpenSelectedProfile={() => {
              if (activeProfile) void connectProfile(activeProfile);
            }}
            onOpenFileManager={openSftpManager}
            onCommandChange={setCommandForTab}
            onSendCommand={(tab, command) => {
              void sendTerminalCommand(tab, command);
            }}
            onCopyTab={(tab) => {
              void copyTerminal(tab);
            }}
            onPasteTab={(tab) => {
              void pasteToTerminal(tab);
            }}
            onClearTab={(tab) => {
              void clearTerminal(tab);
            }}
            onReconnectTab={(tab) => {
              void reconnectTab(tab);
            }}
          />
        }
        onStartPanelResize={startPanelResize}
        onResetPanelWidth={resetPanelWidth}
      >

        <FileManagerShell
          collapsed={rightPanelCollapsed}
          standaloneWindow={isFileManagerWindow}
          profileValue={fileManagerProfileValue}
          profileOptions={remoteProfileOptions}
          compareDirectories={compareDirectories}
          canToggleCompare={baseVisibleLocalFiles.length > 0 || baseVisibleRemoteFiles.length > 0}
          canImportSyncPlan={Boolean(activeProfile && !isLocalProtocol(activeProfile.protocol))}
          canCompareSelectedSha256={Boolean(
            activeProfile &&
              !isLocalProtocol(activeProfile.protocol) &&
              visibleSelectedLocal &&
              visibleSelectedRemote &&
              !visibleSelectedLocal.isDir &&
              !visibleSelectedRemote.isDir &&
              visibleSelectedLocal.fileType !== "symlink" &&
              visibleSelectedRemote.fileType !== "symlink"
          )}
          compareSummary={directoryCompare.summary}
          compareView={compareView}
          compareTotalCount={directoryCompareCount}
          compareDiffCount={directoryCompareDiffCount}
          canRemoteCompareActions={Boolean(activeProfile && !isLocalProtocol(activeProfile.protocol))}
          onOpenPanel={openSftpManager}
          onStartWindowDrag={startWindowDrag}
          onSelectProfile={selectRemoteBrowserProfile}
          onToggleCompare={() => setCompareDirectories((current) => !current)}
          onImportSyncPlan={importSyncPlanJson}
          onCompareSelectedSha256={compareSelectedSha256}
          onOpenTransferQueue={() => {
            setDialog("transfers");
            if (!isFileManagerWindow) setRightPanelCollapsed(true);
          }}
          onCollapsePanel={() => setRightPanelCollapsed(true)}
          onWindowAction={(action) => {
            void runWindowAction(action);
          }}
          onCompareViewChange={setCompareView}
          onCopyCompareCsv={copyDirectoryCompareCsv}
          onDownloadCompareCsv={downloadDirectoryCompareCsv}
          onCopyCompareJson={copyDirectoryCompareJson}
          onDownloadCompareJson={downloadDirectoryCompareJson}
          onCopyCompareDiffCsv={copyDirectoryCompareDiffCsv}
          onDownloadCompareDiffCsv={downloadDirectoryCompareDiffCsv}
          onSelectLocalDiff={() => selectComparedEntries("local")}
          onSelectRemoteDiff={() => selectComparedEntries("remote")}
          onSelectDifferentPairs={() => selectComparedPairs("different")}
          onSyncUploadDiff={() => syncComparedEntries("upload")}
          onSyncUploadMissing={() => syncComparedEntries("upload", "missing")}
          onSyncUploadMetadata={() => syncComparedMetadata("upload")}
          onSyncDownloadDiff={() => syncComparedEntries("download")}
          onSyncDownloadMissing={() => syncComparedEntries("download", "missing")}
          onSyncDownloadMetadata={() => syncComparedMetadata("download")}
        >
            <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${isFileManagerWindow ? "col-start-1 row-start-3 [&>*]:mt-0 max-[820px]:[grid-row:auto]" : ""}`}>
            <FilePane
              side="local"
              title="本地"
              path={localPath}
              files={visibleLocalFiles}
              compareMarks={compareDirectories ? directoryCompare.local : emptyCompareMarks}
              selected={visibleSelectedLocal}
              selectedPaths={selectedLocalPaths}
              selectionCount={visibleSelectedLocalEntries.length}
              sort={localSort}
              filter={localFilter}
              bookmarks={localPathBookmarks}
              onPath={navigateLocalPath}
              onFilter={setLocalFilter}
              onSelect={(file, event) => selectFile("local", file, event, visibleLocalFiles)}
              onDragStart={(file, event) => beginFileDrag("local", file, event)}
              onDragEnd={endFileDrag}
              onDragOver={(event) => handleFileDragOver("local", event)}
              onDragLeave={(event) => handleFileDragLeave("local", event)}
              onDrop={(event) => handleFileDrop("local", event)}
              dropActive={dragOverSide === "local"}
              onSort={sortLocalBy}
              onOpen={(file) =>
                file.isDir ? navigateLocalPath(file.path) : file.fileType === "symlink" ? locateSymlinkTarget("local", file) : openLocalEditor(file)
              }
              onBack={() => goLocalHistory("back")}
              onForward={() => goLocalHistory("forward")}
              canBack={localBackHistory.length > 0}
              canForward={localForwardHistory.length > 0}
              onHome={async () => navigateLocalPath(await api.localHome())}
              onParent={() => openParentDir("local")}
              onRefresh={refreshLocalFiles}
              onMkdir={() => makeDir("local")}
              onRename={() => renameSelected("local")}
              onRemove={() => removeSelected("local")}
              onSelectAll={() => selectAllFiles("local")}
              onClearSelection={clearLocalSelection}
              onBookmarkCurrent={() => addPathBookmark("local")}
              onOpenBookmark={(path) => openPathBookmark("local", path)}
              onRemoveBookmark={(path) => removePathBookmark("local", path)}
              notice={
                localSearch && (
                  <SearchNotice
                    root={localSearch.root}
                    query={localSearch.query}
                    count={localSearch.count}
                    onClear={refreshLocalFiles}
                  />
                )
              }
              contextActions={localFilePaneActions}
              extraActions={localFilePaneExtraActions}
              compareMarkLabel={compareMarkLabel}
              formatOwner={formatOwner}
              formatSize={formatSize}
              formatFileDateTime={formatFileDateTime}
              formatEntrySymbolicMode={formatEntrySymbolicMode}
            />
            </div>
            <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${isFileManagerWindow ? "col-start-2 row-start-3 [&>*]:mt-0 max-[820px]:col-start-1 max-[820px]:[grid-row:auto]" : ""}`} ref={remoteFilePaneRef}>
              <FilePane
                side="remote"
                title="远程"
                path={remotePath}
                files={visibleRemoteFiles}
                compareMarks={compareDirectories ? directoryCompare.remote : emptyCompareMarks}
                selected={visibleSelectedRemote}
                selectedPaths={selectedRemotePaths}
                selectionCount={visibleSelectedRemoteEntries.length}
                sort={remoteSort}
                filter={remoteFilter}
                bookmarks={remotePathBookmarks}
                onPath={navigateRemotePath}
                onFilter={setRemoteFilter}
                onSelect={(file, event) => selectFile("remote", file, event, visibleRemoteFiles)}
                onDragStart={(file, event) => beginFileDrag("remote", file, event)}
                onDragEnd={endFileDrag}
                onDragOver={(event) => handleFileDragOver("remote", event)}
                onDragLeave={(event) => handleFileDragLeave("remote", event)}
                onDrop={(event) => handleFileDrop("remote", event)}
                dropActive={dragOverSide === "remote"}
                onSort={sortRemoteBy}
                onOpen={(file) =>
                  file.isDir ? navigateRemotePath(file.path) : file.fileType === "symlink" ? locateSymlinkTarget("remote", file) : openRemoteEditor(file)
                }
                onBack={() => goRemoteHistory("back")}
                onForward={() => goRemoteHistory("forward")}
                canBack={remoteBackHistory.length > 0}
                canForward={remoteForwardHistory.length > 0}
                onHome={async () => {
                  if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
                  try {
                    navigateRemotePath(await api.remoteHome(activeProfile.id, passwordForActive));
                  } catch (error) {
                    if (requestActiveProfileSecretIfNeeded(error)) return;
                    pushToast("error", `远程主目录读取失败: ${String(error)}`);
                  }
                }}
                onParent={() => openParentDir("remote")}
                onRefresh={refreshRemoteFiles}
                onMkdir={() => makeDir("remote")}
                onRename={() => renameSelected("remote")}
                onRemove={() => removeSelected("remote")}
                onSelectAll={() => selectAllFiles("remote")}
                onClearSelection={clearRemoteSelection}
                onBookmarkCurrent={() => addPathBookmark("remote")}
                onOpenBookmark={(path) => openPathBookmark("remote", path)}
                onRemoveBookmark={(path) => removePathBookmark("remote", path)}
                contextActions={remoteFilePaneActions}
                notice={
                  remoteSearch && (
                    <SearchNotice
                      root={remoteSearch.root}
                      query={remoteSearch.query}
                      count={remoteSearch.count}
                      onClear={refreshRemoteFiles}
                    />
                  )
                }
                extraActions={remoteFilePaneExtraActions}
                compareMarkLabel={compareMarkLabel}
                formatOwner={formatOwner}
                formatSize={formatSize}
                formatFileDateTime={formatFileDateTime}
                formatEntrySymbolicMode={formatEntrySymbolicMode}
              />
            </div>
        </FileManagerShell>
      </WorkspaceLayout>

      <AppDialogs
        dialog={dialog}
        onDialogChange={setDialog}
        quick={quick}
        onQuickChange={setQuick}
        onConnectQuick={connectQuick}
        secretProfile={secretProfile}
        secretPassword={secretProfile ? profileSecretDrafts[secretProfile.id] ?? "" : ""}
        onSecretPasswordChange={(profileId, password) =>
          setProfileSecretDrafts((current) => ({
            ...current,
            [profileId]: password
          }))
        }
        onCloseSecret={() => {
          setDialog(null);
          setSecretProfileId(null);
        }}
        onConnectSecretProfile={connectSecretProfile}
        editingProfile={editingProfile}
        onEditingProfileChange={setEditingProfile}
        onSaveProfile={saveProfile}
        onPickProfileKeyFile={pickProfileKeyFile}
        settings={settings}
        onSettingsChange={setSettings}
        onOpenKnownHostsManager={openKnownHostsManager}
        onSaveSettings={saveSettings}
        knownHostsText={knownHostsText}
        onKnownHostsTextChange={setKnownHostsText}
        onClearKnownHosts={clearKnownHosts}
        onSaveKnownHosts={saveKnownHosts}
        chmodTarget={chmodTarget}
        chmodSide={chmodSide}
        chmodTargets={chmodTargets}
        chmodMode={chmodMode}
        chmodRecursive={chmodRecursive}
        onChmodModeChange={setChmodMode}
        onChmodRecursiveChange={setChmodRecursive}
        onApplyChmod={applyChmod}
        batchRenameSide={batchRenameSide}
        batchRenameTargets={batchRenameTargets}
        batchRenameExistingEntries={batchRenameSide === "local" ? localFiles : remoteFiles}
        batchRenameFind={batchRenameFind}
        batchRenameReplace={batchRenameReplace}
        batchRenamePrefix={batchRenamePrefix}
        batchRenameSuffix={batchRenameSuffix}
        batchRenameNumberStart={batchRenameNumberStart}
        batchRenameNumberPadding={batchRenameNumberPadding}
        batchRenamePreserveExtension={batchRenamePreserveExtension}
        batchRenameCaseSensitive={batchRenameCaseSensitive}
        onBatchRenameFindChange={setBatchRenameFind}
        onBatchRenameReplaceChange={setBatchRenameReplace}
        onBatchRenamePrefixChange={setBatchRenamePrefix}
        onBatchRenameSuffixChange={setBatchRenameSuffix}
        onBatchRenameNumberStartChange={setBatchRenameNumberStart}
        onBatchRenameNumberPaddingChange={setBatchRenameNumberPadding}
        onBatchRenamePreserveExtensionChange={setBatchRenamePreserveExtension}
        onBatchRenameCaseSensitiveChange={setBatchRenameCaseSensitive}
        onApplyBatchRename={applyBatchRename}
        deleteConfirm={deleteConfirm}
        onCopyDeleteConfirmCsv={copyDeleteConfirmCsv}
        onDownloadDeleteConfirmCsv={downloadDeleteConfirmCsv}
        onCopyDeleteConfirmJson={copyDeleteConfirmJson}
        onDownloadDeleteConfirmJson={downloadDeleteConfirmJson}
        onCloseDeleteConfirm={() => {
          setDialog(null);
          setDeleteConfirm(null);
        }}
        onConfirmDeleteSelected={confirmDeleteSelected}
        syncPlan={syncPlan}
        transferConflict={transferConflict}
        formatSize={formatSize}
        onShowTextDialog={showTextDialog}
        onCloseSyncPlan={() => {
          setDialog(null);
          setSyncPlan(null);
        }}
        onExecuteSyncPlan={executeSyncPlan}
        transferQueueProps={transferQueueProps}
        propertiesSide={propertiesSide}
        propertiesTarget={propertiesTarget}
        propertiesTargets={propertiesTargets}
        propertiesUid={propertiesUid}
        propertiesGid={propertiesGid}
        propertiesMode={propertiesMode}
        propertiesMtime={propertiesMtime}
        propertiesStats={propertiesStats}
        propertiesStatsLoading={propertiesStatsLoading}
        propertiesChecksum={propertiesChecksum}
        propertiesChecksumLoading={propertiesChecksumLoading}
        propertiesRecursive={propertiesRecursive}
        formatDate={formatDate}
        fileTypeLabel={fileTypeLabel}
        onPropertiesUidChange={setPropertiesUid}
        onPropertiesGidChange={setPropertiesGid}
        onPropertiesModeChange={setPropertiesMode}
        onPropertiesMtimeChange={setPropertiesMtime}
        onCalculatePropertiesStats={calculatePropertiesStats}
        onCalculatePropertiesChecksum={calculatePropertiesChecksum}
        onCopyPropertiesReport={copyPropertiesReport}
        onCopyPropertiesCsv={copyPropertiesCsv}
        onDownloadPropertiesCsv={downloadPropertiesCsv}
        onCopyPropertiesJson={copyPropertiesJson}
        onDownloadPropertiesJson={downloadPropertiesJson}
        onPropertiesRecursiveChange={setPropertiesRecursive}
        onApplyProperties={applyProperties}
        editorSide={editorSide}
        editorFile={editorFile}
        editorPreviewPosition={editorPreviewPosition}
        editorContent={editorContent}
        onEditorContentChange={setEditorContent}
        onLoadEditorHead={() => loadEditorPreview("head")}
        onLoadEditorTail={() => loadEditorPreview("tail")}
        onSaveEditor={saveEditor}
        hostKeyPrompt={hostKeyPrompt}
        onCloseHostKeyPrompt={() => setHostKeyPrompt(null)}
        onAcceptHostKey={acceptHostKey}
        appModal={appModal}
        onResolveAppModal={resolveAppModal}
      />

      <Toaster position="bottom-right" toastOptions={{ duration: 3600 }} />
    </div>
  );

}
