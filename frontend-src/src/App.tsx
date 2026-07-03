import { FitAddon } from "@xterm/addon-fit";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Terminal } from "@xterm/xterm";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUp,
  BookmarkMinus,
  BookmarkPlus,
  Cable,
  Calculator,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Clock,
  ClipboardPaste,
  Copy,
  Crosshair,
  Download,
  Edit3,
  Eraser,
  Eye,
  EyeOff,
  Folder,
  FolderPlus,
  FolderSync,
  Home,
  KeyRound,
  Link2,
  ListChecks,
  ListX,
  Maximize2,
  Minus,
  Monitor,
  MoveRight,
  RefreshCcw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  Fragment,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import {
  api,
  hasTauriRuntime,
  type AppSettings,
  type FileEntry,
  type HostKeyIssue,
  type Profile,
  type Protocol,
  type QuickConnectRequest,
  type RemotePathStats,
  type ServerStatus,
  type TextFile,
  type TransferConflictStrategy,
  type TerminalDrain,
  type TerminalView,
  type TransferView
} from "./api";
import { EventBus } from "./events";

type Toast = { id: number; tone: "info" | "success" | "error"; text: string };
type Dialog =
  | "quick"
  | "profile"
  | "secret"
  | "settings"
  | "hostkeys"
  | "chmod"
  | "properties"
  | "editor"
  | "batchRename"
  | "deleteConfirm"
  | "syncPlan"
  | "transfers"
  | null;
type AppPromptOptions = {
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  readOnly?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
};
type AppConfirmOptions = {
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};
type AppModalPromptState = {
  kind: "prompt";
  title: string;
  message?: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  readOnly?: boolean;
  confirmLabel: string;
  cancelLabel: string;
};
type AppModalConfirmState = {
  kind: "confirm";
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
};
type AppModalState = AppModalPromptState | AppModalConfirmState;
type FileSide = "local" | "remote";
type TextPreviewPosition = "head" | "tail";
type FileSortKey = "name" | "permissions" | "owner" | "size" | "modifiedAt";
type FileSort = { key: FileSortKey; direction: "asc" | "desc" };
type CompareView = "all" | "diff" | "same" | "only-local" | "only-remote" | "different";
type PermissionClass = "u" | "g" | "o";
type PermissionLetter = "r" | "w" | "x";
type FileCompareKind = "same" | "different" | "only-local" | "only-remote";
type FileCompareMark = { kind: FileCompareKind; detail: string };
type DirectoryCompare = {
  local: Map<string, FileCompareMark>;
  remote: Map<string, FileCompareMark>;
  summary: { same: number; different: number; onlyLocal: number; onlyRemote: number };
};
type FileDragPayload = { side: FileSide; entries: FileEntry[] };
type PathBookmark = { label: string; path: string };
type FileSearchState = { root: string; query: string; count: number };
type BatchRenamePlanItem = { entry: FileEntry; newName: string };
type DeleteConfirmState = { side: FileSide; entries: FileEntry[] };
type SyncPlanItem = {
  entry: FileEntry;
  sourceEntry?: FileEntry;
  targetEntry?: FileEntry;
  action: "create" | "overwrite" | "metadata";
  name: string;
  source: string;
  target: string;
  detail: string;
  changes?: string[];
};
type SyncPlanState = {
  direction: "upload" | "download";
  mode: "transfer" | "metadata";
  scope: "all" | "missing" | "metadata";
  conflictStrategy?: TransferConflictStrategy | null;
  title: string;
  items: SyncPlanItem[];
};
type Sha256AuditRecord = { side: FileSide; file: FileEntry; hash: string };
type PropertiesReportOptions = {
  uid: string;
  gid: string;
  mode: string;
  mtime: string;
  stats: RemotePathStats | null;
  checksum: string;
  recursive: boolean;
};
type FileAction =
  | { type: "separator" }
  | { type?: "action"; label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean };
type AppMenuAction =
  | { type: "separator" }
  | { type?: "action"; label: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean };
type AppMenuGroup = { label: string; items: AppMenuAction[] };
type SelectOption<T extends string = string> = { value: T; label: string; disabled?: boolean };
type AppEvents = {
  toast: Omit<Toast, "id">;
  refreshTransfers: undefined;
};

const defaultFileSort: FileSort = { key: "name", direction: "asc" };
const emptyCompareMarks = new Map<string, FileCompareMark>();
const terminalSnippets = ["pwd", "ls -la", "df -h", "free -h", "ps aux | head", "whoami"];
const defaultLeftPanelWidth = 272;
const defaultRightPanelWidth = 386;
const minPanelWidth = 220;
const maxPanelWidth = 620;
const collapsedPanelWidth = 38;

const defaultSettings: AppSettings = {
  theme: "deep",
  fontSize: 14,
  copyOnSelect: false,
  scrollback: 10000,
  localShell: "",
  confirmOnExit: true
};

const defaultQuick: QuickConnectRequest = {
  protocol: "SSH",
  name: "新建 SSH 会话",
  host: "",
  port: 22,
  username: "root",
  password: "",
  rememberPassword: false
};

const pathBookmarkStorageKey = "rustshell.pathBookmarks.v1";
const sessionFolderStorageKey = "rustshell.sessionFolders.v1";
const fileManagerProfileStorageKey = "rustshell.fileManagerProfileId";
const windowDragExcludeSelector =
  "button, input, select, textarea, a, [role='button'], [role='menu'], .window-controls, [data-window-drag-ignore]";

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function transferListSignature(transfers: TransferView[]) {
  return transfers
    .map((transfer) =>
      [
        transfer.id,
        transfer.status,
        transfer.transferred,
        transfer.total,
        transfer.speedBps,
        transfer.etaSeconds ?? "",
        transfer.attempts,
        transfer.message ?? "",
        transfer.finishedAt ?? ""
      ].join(":")
    )
    .join("|");
}

function sameTransferList(left: TransferView[], right: TransferView[]) {
  return left.length === right.length && transferListSignature(left) === transferListSignature(right);
}

function editorFileMetadata(file: TextFile): TextFile {
  return { ...file, content: "" };
}

export default function App() {
  const fileWindowParams = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const windowLabel = hasTauriRuntime() ? getCurrentWindow().label : "";
    const viewFlag = (window as Window & { __RUSTSHELL_VIEW__?: string }).__RUSTSHELL_VIEW__;
    const isFileManagerWindow =
      viewFlag === "file-manager" ||
      windowLabel === "file-manager" ||
      params.get("view") === "file-manager" ||
      window.location.pathname.endsWith("/file-manager.html");
    return {
      isFileManagerWindow,
      profileId: isFileManagerWindow ? params.get("profileId") || window.localStorage.getItem(fileManagerProfileStorageKey) : null
    };
  }, []);
  const isFileManagerWindow = fileWindowParams.isFileManagerWindow;
  const busRef = useRef(new EventBus<AppEvents>());
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [tabs, setTabs] = useState<TerminalView[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(fileWindowParams.profileId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [appModal, setAppModal] = useState<AppModalState | null>(null);
  const appModalResolveRef = useRef<((value: string | boolean | null) => void) | null>(null);
  const [quick, setQuick] = useState<QuickConnectRequest>(defaultQuick);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [secretProfileId, setSecretProfileId] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [knownHostsText, setKnownHostsText] = useState("");
  const [status, setStatus] = useState("就绪");
  const [hostSearch, setHostSearch] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [leftPanelWidth, setLeftPanelWidth] = useState(defaultLeftPanelWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(defaultRightPanelWidth);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(!isFileManagerWindow);
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("/root");
  const [remoteHomeReady, setRemoteHomeReady] = useState(false);
  const [remoteBrowserProfileId, setRemoteBrowserProfileId] = useState<string | null>(
    isFileManagerWindow ? fileWindowParams.profileId : null
  );
  const [localBackHistory, setLocalBackHistory] = useState<string[]>([]);
  const [localForwardHistory, setLocalForwardHistory] = useState<string[]>([]);
  const [remoteBackHistory, setRemoteBackHistory] = useState<string[]>([]);
  const [remoteForwardHistory, setRemoteForwardHistory] = useState<string[]>([]);
  const [localPathBookmarks, setLocalPathBookmarks] = useState<PathBookmark[]>(() => loadPathBookmarks("local"));
  const [remotePathBookmarks, setRemotePathBookmarks] = useState<PathBookmark[]>(() => loadPathBookmarks("remote"));
  const [localFiles, setLocalFiles] = useState<FileEntry[]>([]);
  const [remoteFiles, setRemoteFiles] = useState<FileEntry[]>([]);
  const [showLocalHidden, setShowLocalHidden] = useState(true);
  const [showRemoteHidden, setShowRemoteHidden] = useState(true);
  const [localFilter, setLocalFilter] = useState("");
  const [remoteFilter, setRemoteFilter] = useState("");
  const [localSearch, setLocalSearch] = useState<FileSearchState | null>(null);
  const [remoteSearch, setRemoteSearch] = useState<FileSearchState | null>(null);
  const [compareDirectories, setCompareDirectories] = useState(false);
  const [compareView, setCompareView] = useState<CompareView>("all");
  const [localSort, setLocalSort] = useState<FileSort>(defaultFileSort);
  const [remoteSort, setRemoteSort] = useState<FileSort>(defaultFileSort);
  const [selectedLocal, setSelectedLocal] = useState<FileEntry | null>(null);
  const [selectedRemote, setSelectedRemote] = useState<FileEntry | null>(null);
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<string[]>([]);
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<string[]>([]);
  const [localSelectionStats, setLocalSelectionStats] = useState("");
  const [remoteSelectionStats, setRemoteSelectionStats] = useState("");
  const [selectionStatsLoading, setSelectionStatsLoading] = useState<FileSide | null>(null);
  const selectedLocalRef = useRef<FileEntry | null>(null);
  const selectedRemoteRef = useRef<FileEntry | null>(null);
  const pendingLocalPreferPathRef = useRef<string | null>(null);
  const pendingRemotePreferPathRef = useRef<string | null>(null);
  const localSelectionAnchorRef = useRef<string | null>(null);
  const remoteSelectionAnchorRef = useRef<string | null>(null);
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
  const [transfers, setTransfers] = useState<TransferView[]>([]);
  const [transferHistory, setTransferHistory] = useState<TransferView[]>([]);
  const [transferConflict, setTransferConflict] = useState<TransferConflictStrategy>("overwrite");
  const [terminalCommand, setTerminalCommand] = useState("");
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [serverStatusLoading, setServerStatusLoading] = useState(false);
  const [serverStatusError, setServerStatusError] = useState("");
  const serverStatusProfileIdRef = useRef<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<{ profileId: string; issue: HostKeyIssue } | null>(null);
  const [dragOverSide, setDragOverSide] = useState<FileSide | null>(null);
  const [profileSecrets, setProfileSecrets] = useState<Record<string, string>>({});
  const [profileSecretDrafts, setProfileSecretDrafts] = useState<Record<string, string>>({});
  const bootedRef = useRef(false);
  const authPromptedTabsRef = useRef(new Set<string>());
  const fileDragRef = useRef<FileDragPayload | null>(null);
  const transferStatusRef = useRef(new Map<string, TransferView["status"]>());
  const transfersRef = useRef<TransferView[]>([]);
  const transferHistoryRef = useRef<TransferView[]>([]);
  const remoteFilePaneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const hideTimers = new Map<HTMLElement, number>();
    const scrollKeys = new Set(["PageUp", "PageDown", "Home", "End", " "]);
    const scrollContainerSelector = [
      ".app-select-menu",
      ".left-panel-main",
      ".right-panel",
      ".file-toolbar",
      ".file-list",
      ".file-context-menu",
      ".transfer-list",
      ".modal",
      ".delete-confirm-list",
      ".sync-plan-list",
      ".rename-preview",
      ".editor-textarea",
      ".xterm-viewport"
    ].join(",");
    const isScrollable = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      return (
        ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
          element.scrollHeight > element.clientHeight) ||
        ((overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay") &&
          element.scrollWidth > element.clientWidth)
      );
    };
    const findScrollContainer = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return null;
      let element = target instanceof HTMLElement ? target : target.parentElement;
      const terminalViewport = element?.closest(".xterm")?.querySelector<HTMLElement>(".xterm-viewport");
      if (terminalViewport) {
        return terminalViewport;
      }
      const knownContainer = element?.closest<HTMLElement>(scrollContainerSelector);
      if (knownContainer) {
        return knownContainer;
      }
      while (element && element !== document.body) {
        if (isScrollable(element)) return element;
        element = element.parentElement;
      }
      return null;
    };
    const showScrollbar = (element: HTMLElement | null) => {
      if (!element) return;
      element.classList.add("scrollbar-active");
      const currentTimer = hideTimers.get(element);
      if (currentTimer) {
        window.clearTimeout(currentTimer);
      }
      const nextTimer = window.setTimeout(() => {
        element.classList.remove("scrollbar-active");
        hideTimers.delete(element);
      }, 720);
      hideTimers.set(element, nextTimer);
    };
    const showScrollbarForEvent = (event: Event) => {
      showScrollbar(findScrollContainer(event.target));
    };
    const showScrollbarForKey = (event: globalThis.KeyboardEvent) => {
      if (scrollKeys.has(event.key)) {
        showScrollbar(findScrollContainer(document.activeElement));
      }
    };

    window.addEventListener("scroll", showScrollbarForEvent, true);
    window.addEventListener("wheel", showScrollbarForEvent, { passive: true, capture: true });
    window.addEventListener("touchmove", showScrollbarForEvent, { passive: true, capture: true });
    window.addEventListener("keydown", showScrollbarForKey, true);

    return () => {
      hideTimers.forEach((timer, element) => {
        window.clearTimeout(timer);
        element.classList.remove("scrollbar-active");
      });
      hideTimers.clear();
      window.removeEventListener("scroll", showScrollbarForEvent, true);
      window.removeEventListener("wheel", showScrollbarForEvent, true);
      window.removeEventListener("touchmove", showScrollbarForEvent, true);
      window.removeEventListener("keydown", showScrollbarForKey, true);
    };
  }, []);

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
      setRemoteHomeReady(false);
    }
    setRemoteBrowserProfileId((current) => (current === profile.id ? current : profile.id));
  }, [isFileManagerWindow, profiles, remoteBrowserProfileId, selectedProfileId]);

  const profileSecretValue = (profile: Profile) =>
    profile.password || profileSecretDrafts[profile.id] || profileSecrets[profile.id] || "";
  const baseVisibleLocalFiles = useMemo(
    () => sortFiles(visibleFiles(localFiles, showLocalHidden, localFilter), localSort),
    [localFiles, localFilter, localSort, showLocalHidden]
  );
  const baseVisibleRemoteFiles = useMemo(
    () => sortFiles(visibleFiles(remoteFiles, showRemoteHidden, remoteFilter), remoteSort),
    [remoteFiles, remoteFilter, remoteSort, showRemoteHidden]
  );
  const directoryCompare = useMemo(
    () => buildDirectoryCompare(baseVisibleLocalFiles, baseVisibleRemoteFiles),
    [baseVisibleLocalFiles, baseVisibleRemoteFiles]
  );
  const visibleLocalFiles = useMemo(
    () => filterCompareView(baseVisibleLocalFiles, directoryCompare.local, compareDirectories ? compareView : "all"),
    [baseVisibleLocalFiles, compareDirectories, compareView, directoryCompare.local]
  );
  const visibleRemoteFiles = useMemo(
    () => filterCompareView(baseVisibleRemoteFiles, directoryCompare.remote, compareDirectories ? compareView : "all"),
    [baseVisibleRemoteFiles, compareDirectories, compareView, directoryCompare.remote]
  );
  const directoryCompareCount =
    directoryCompare.summary.same +
    directoryCompare.summary.different +
    directoryCompare.summary.onlyLocal +
    directoryCompare.summary.onlyRemote;
  const directoryCompareDiffCount =
    directoryCompare.summary.different +
    directoryCompare.summary.onlyLocal +
    directoryCompare.summary.onlyRemote;
  const baseVisibleSelectedLocal = visibleSelection(selectedLocal, showLocalHidden, localFilter);
  const baseVisibleSelectedRemote = visibleSelection(selectedRemote, showRemoteHidden, remoteFilter);
  const visibleSelectedLocal = selectionVisibleInFiles(baseVisibleSelectedLocal, visibleLocalFiles);
  const visibleSelectedRemote = selectionVisibleInFiles(baseVisibleSelectedRemote, visibleRemoteFiles);
  const visibleSelectedLocalEntries = useMemo(
    () => selectedEntries(visibleLocalFiles, selectedLocalPaths, visibleSelectedLocal),
    [selectedLocalPaths, visibleLocalFiles, visibleSelectedLocal]
  );
  const visibleSelectedRemoteEntries = useMemo(
    () => selectedEntries(visibleRemoteFiles, selectedRemotePaths, visibleSelectedRemote),
    [selectedRemotePaths, visibleRemoteFiles, visibleSelectedRemote]
  );

  useEffect(() => {
    setLocalSelectionStats("");
  }, [localPath, selectedLocalPaths]);

  useEffect(() => {
    setRemoteSelectionStats("");
  }, [remotePath, selectedRemotePaths]);

  const pushToast = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, tone, text }].slice(-4));
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3600);
  }, []);

  const resolveAppModal = useCallback((value: string | boolean | null) => {
    const resolve = appModalResolveRef.current;
    appModalResolveRef.current = null;
    setAppModal(null);
    resolve?.(value);
  }, []);

  const promptText = useCallback((title: string, options: AppPromptOptions = {}) => {
    return new Promise<string | null>((resolve) => {
      appModalResolveRef.current = (value) => resolve(typeof value === "string" ? value : null);
      setAppModal({
        kind: "prompt",
        title,
        message: options.message,
        value: options.defaultValue ?? "",
        placeholder: options.placeholder,
        multiline: options.multiline,
        readOnly: options.readOnly,
        confirmLabel: options.confirmLabel ?? "确定",
        cancelLabel: options.cancelLabel ?? "取消"
      });
    });
  }, []);

  const confirmAction = useCallback((title: string, options: AppConfirmOptions = {}) => {
    return new Promise<boolean>((resolve) => {
      appModalResolveRef.current = (value) => resolve(value === true);
      setAppModal({
        kind: "confirm",
        title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? "确定",
        cancelLabel: options.cancelLabel ?? "取消",
        danger: options.danger
      });
    });
  }, []);

  const showTextDialog = useCallback(
    (title: string, text: string) =>
      promptText(title, {
        defaultValue: text,
        multiline: true,
        readOnly: true,
        confirmLabel: "关闭",
        cancelLabel: "取消"
      }),
    [promptText]
  );

  const clearLocalSelection = () => {
    setSelectedLocal(null);
    setSelectedLocalPaths([]);
    setLocalSelectionStats("");
    localSelectionAnchorRef.current = null;
  };

  const clearRemoteSelection = () => {
    setSelectedRemote(null);
    setSelectedRemotePaths([]);
    setRemoteSelectionStats("");
    remoteSelectionAnchorRef.current = null;
  };

  const selectFile = (
    side: FileSide,
    file: FileEntry,
    event: MouseEvent<HTMLButtonElement>,
    files: FileEntry[]
  ) => {
    const setPrimary = side === "local" ? setSelectedLocal : setSelectedRemote;
    const setPaths = side === "local" ? setSelectedLocalPaths : setSelectedRemotePaths;
    const anchorRef = side === "local" ? localSelectionAnchorRef : remoteSelectionAnchorRef;
    setPrimary(file);

    if (event.shiftKey && anchorRef.current) {
      const anchorIndex = files.findIndex((item) => item.path === anchorRef.current);
      const currentIndex = files.findIndex((item) => item.path === file.path);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        setPaths(files.slice(start, end + 1).map((item) => item.path));
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      setPaths((current) => togglePath(current, file.path));
      anchorRef.current = file.path;
      return;
    }

    setPaths([file.path]);
    anchorRef.current = file.path;
  };

  const selectAllFiles = (side: FileSide) => {
    const files = side === "local" ? visibleLocalFiles : visibleRemoteFiles;
    if (files.length === 0) return;
    if (side === "local") {
      setSelectedLocal(files[0]);
      setSelectedLocalPaths(files.map((file) => file.path));
      localSelectionAnchorRef.current = files[0].path;
    } else {
      setSelectedRemote(files[0]);
      setSelectedRemotePaths(files.map((file) => file.path));
      remoteSelectionAnchorRef.current = files[0].path;
    }
  };

  const invertFileSelection = (side: FileSide) => {
    const files = side === "local" ? visibleLocalFiles : visibleRemoteFiles;
    if (files.length === 0) return;
    const selectedPathSet = new Set(side === "local" ? selectedLocalPaths : selectedRemotePaths);
    const entries = files.filter((file) => !selectedPathSet.has(file.path));
    if (entries.length === 0) {
      if (side === "local") {
        clearLocalSelection();
      } else {
        clearRemoteSelection();
      }
      setStatus(`${side === "local" ? "本地" : "远程"}已清空选择`);
      return;
    }
    if (side === "local") {
      setSelectedLocal(entries[0]);
      setSelectedLocalPaths(entries.map((entry) => entry.path));
      localSelectionAnchorRef.current = entries[0].path;
    } else {
      setSelectedRemote(entries[0]);
      setSelectedRemotePaths(entries.map((entry) => entry.path));
      remoteSelectionAnchorRef.current = entries[0].path;
    }
    setStatus(`${side === "local" ? "本地" : "远程"}已反选 ${entries.length} 个项目`);
  };

  const selectComparedEntries = (side: FileSide) => {
    const files = side === "local" ? baseVisibleLocalFiles : baseVisibleRemoteFiles;
    const marks = side === "local" ? directoryCompare.local : directoryCompare.remote;
    const entries = files.filter((entry) => {
      const kind = marks.get(entry.path)?.kind;
      return side === "local"
        ? kind === "only-local" || kind === "different"
        : kind === "only-remote" || kind === "different";
    });
    if (entries.length === 0) {
      pushToast("info", "没有可选择的对比差异");
      return;
    }
    if (side === "local") {
      setSelectedLocal(entries[0]);
      setSelectedLocalPaths(entries.map((entry) => entry.path));
      localSelectionAnchorRef.current = entries[0].path;
    } else {
      setSelectedRemote(entries[0]);
      setSelectedRemotePaths(entries.map((entry) => entry.path));
      remoteSelectionAnchorRef.current = entries[0].path;
    }
    setStatus(`${side === "local" ? "本地" : "远程"}已选择 ${entries.length} 个对比差异`);
  };

  const selectComparedPairs = (kind: FileCompareKind) => {
    const remoteByName = new Map(baseVisibleRemoteFiles.map((entry) => [entry.name, entry]));
    const pairs = baseVisibleLocalFiles
      .map((local) => {
        const mark = directoryCompare.local.get(local.path);
        const remote = remoteByName.get(local.name) ?? null;
        return mark?.kind === kind && remote ? { local, remote } : null;
      })
      .filter((pair): pair is { local: FileEntry; remote: FileEntry } => Boolean(pair));
    if (pairs.length === 0) {
      pushToast("info", "没有可选择的双侧对比项");
      return;
    }
    setSelectedLocal(pairs[0].local);
    setSelectedLocalPaths(pairs.map((pair) => pair.local.path));
    localSelectionAnchorRef.current = pairs[0].local.path;
    setSelectedRemote(pairs[0].remote);
    setSelectedRemotePaths(pairs.map((pair) => pair.remote.path));
    remoteSelectionAnchorRef.current = pairs[0].remote.path;
    setStatus(`已在双侧选择 ${pairs.length} 个${compareKindLabel(kind)}项目`);
  };

  const copyDirectoryCompareCsv = async () => {
    if (directoryCompareCount === 0) return;
    const text = directoryCompareCsv(baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", "目录对比 CSV 已复制");
    } catch {
      await showTextDialog("复制目录对比 CSV", text);
    }
  };

  const downloadDirectoryCompareCsv = () => {
    if (directoryCompareCount === 0) return;
    downloadTextFile(directoryCompareCsvName(), directoryCompareCsv(baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare), "text/csv;charset=utf-8");
    pushToast("success", "目录对比 CSV 已下载");
  };

  const copyDirectoryCompareJson = async () => {
    if (directoryCompareCount === 0) return;
    const text = directoryCompareJson(localPath, remotePath, baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", "目录对比 JSON 已复制");
    } catch {
      await showTextDialog("复制目录对比 JSON", text);
    }
  };

  const downloadDirectoryCompareJson = () => {
    if (directoryCompareCount === 0) return;
    downloadTextFile(directoryCompareJsonName(), directoryCompareJson(localPath, remotePath, baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare));
    pushToast("success", "目录对比 JSON 已下载");
  };

  const copyDirectoryCompareDiffCsv = async () => {
    if (directoryCompareDiffCount === 0) return;
    const text = directoryCompareCsv(baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare, { includeSame: false });
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", "目录差异 CSV 已复制");
    } catch {
      await showTextDialog("复制目录差异 CSV", text);
    }
  };

  const downloadDirectoryCompareDiffCsv = () => {
    if (directoryCompareDiffCount === 0) return;
    downloadTextFile(
      directoryCompareCsvName("diff"),
      directoryCompareCsv(baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare, { includeSame: false }),
      "text/csv;charset=utf-8"
    );
    pushToast("success", "目录差异 CSV 已下载");
  };

  const copyTransferAuditCsv = async () => {
    const records = transferAuditRecords(transfers, transferHistory);
    if (records.length === 0) return;
    const text = transferAuditCsv(records, profiles);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", `传输审计 CSV 已复制 ${records.length} 条`);
    } catch {
      await showTextDialog("复制传输审计 CSV", text);
    }
  };

  const downloadTransferAuditCsv = () => {
    const records = transferAuditRecords(transfers, transferHistory);
    if (records.length === 0) return;
    downloadTextFile(transferAuditCsvName(), transferAuditCsv(records, profiles), "text/csv;charset=utf-8");
    pushToast("success", `传输审计 CSV 已下载 ${records.length} 条`);
  };

  const copyTransferAuditJson = async () => {
    const records = transferAuditRecords(transfers, transferHistory);
    if (records.length === 0) return;
    const text = transferAuditJson(records, profiles);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", `传输审计 JSON 已复制 ${records.length} 条`);
    } catch {
      await showTextDialog("复制传输审计 JSON", text);
    }
  };

  const downloadTransferAuditJson = () => {
    const records = transferAuditRecords(transfers, transferHistory);
    if (records.length === 0) return;
    downloadTextFile(transferAuditJsonName(), transferAuditJson(records, profiles));
    pushToast("success", `传输审计 JSON 已下载 ${records.length} 条`);
  };

  const navigateLocalPath = (nextPath: string, preferPath?: string) => {
    const next = nextPath.trim();
    if (!next) return;
    if (next === localPath) {
      const picked = preferPath ? pickSelection(localFiles, preferPath, selectedLocalRef.current) : null;
      if (picked) {
        setSelectedLocal(picked);
        setSelectedLocalPaths([picked.path]);
      }
      return;
    }
    pendingLocalPreferPathRef.current = preferPath ?? null;
    setLocalBackHistory((current) => pushHistory(current, localPath));
    setLocalForwardHistory([]);
    clearLocalSelection();
    setLocalPath(next);
  };

  const navigateRemotePath = (nextPath: string, preferPath?: string) => {
    const next = nextPath.trim();
    if (!next) return;
    if (next === remotePath) {
      const picked = preferPath ? pickSelection(remoteFiles, preferPath, selectedRemoteRef.current) : null;
      if (picked) {
        setSelectedRemote(picked);
        setSelectedRemotePaths([picked.path]);
      }
      return;
    }
    pendingRemotePreferPathRef.current = preferPath ?? null;
    setRemoteBackHistory((current) => pushHistory(current, remotePath));
    setRemoteForwardHistory([]);
    clearRemoteSelection();
    setRemotePath(next);
  };

  const goLocalHistory = (direction: "back" | "forward") => {
    if (direction === "back") {
      const previous = localBackHistory[localBackHistory.length - 1];
      if (!previous) return;
      setLocalBackHistory((current) => current.slice(0, -1));
      setLocalForwardHistory((current) => pushHistory(current, localPath, true));
      clearLocalSelection();
      setLocalPath(previous);
      return;
    }
    const next = localForwardHistory[0];
    if (!next) return;
    setLocalForwardHistory((current) => current.slice(1));
    setLocalBackHistory((current) => pushHistory(current, localPath));
    clearLocalSelection();
    setLocalPath(next);
  };

  const goRemoteHistory = (direction: "back" | "forward") => {
    if (direction === "back") {
      const previous = remoteBackHistory[remoteBackHistory.length - 1];
      if (!previous) return;
      setRemoteBackHistory((current) => current.slice(0, -1));
      setRemoteForwardHistory((current) => pushHistory(current, remotePath, true));
      clearRemoteSelection();
      setRemotePath(previous);
      return;
    }
    const next = remoteForwardHistory[0];
    if (!next) return;
    setRemoteForwardHistory((current) => current.slice(1));
    setRemoteBackHistory((current) => pushHistory(current, remotePath));
    clearRemoteSelection();
    setRemotePath(next);
  };

  const addPathBookmark = async (side: FileSide) => {
    const path = (side === "local" ? localPath : remotePath).trim();
    if (!path) return;
    const label = await promptText("收藏名称", { defaultValue: bookmarkLabel(path) });
    if (!label?.trim()) return;
    const setter = side === "local" ? setLocalPathBookmarks : setRemotePathBookmarks;
    setter((current) => upsertBookmark(current, { label: label.trim(), path }));
    pushToast("success", "路径已收藏");
  };

  const removePathBookmark = (side: FileSide, path: string) => {
    const setter = side === "local" ? setLocalPathBookmarks : setRemotePathBookmarks;
    setter((current) => current.filter((bookmark) => bookmark.path !== path));
    pushToast("success", "收藏已移除");
  };

  const openPathBookmark = (side: FileSide, path: string) => {
    if (side === "local") {
      navigateLocalPath(path);
    } else {
      navigateRemotePath(path);
    }
  };

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
    selectedLocalRef.current = selectedLocal;
  }, [selectedLocal]);

  useEffect(() => {
    selectedRemoteRef.current = selectedRemote;
  }, [selectedRemote]);

  useEffect(() => {
    savePathBookmarks("local", localPathBookmarks);
  }, [localPathBookmarks]);

  useEffect(() => {
    savePathBookmarks("remote", remotePathBookmarks);
  }, [remotePathBookmarks]);

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

  const refreshTransfers = useCallback(async () => {
    if (!hasTauriRuntime()) return;
    try {
      const [nextTransfers, nextHistory] = await Promise.all([api.listTransfers(), api.listTransferHistory()]);
      transfersRef.current = nextTransfers;
      transferHistoryRef.current = nextHistory;
      setTransfers((current) => (sameTransferList(current, nextTransfers) ? current : nextTransfers));
      setTransferHistory((current) => (sameTransferList(current, nextHistory) ? current : nextHistory));
    } catch {
      transfersRef.current = [];
      transferHistoryRef.current = [];
      setTransfers((current) => (current.length === 0 ? current : []));
      setTransferHistory((current) => (current.length === 0 ? current : []));
    }
  }, []);

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
    const preferredPath = preferPath ?? pendingLocalPreferPathRef.current ?? undefined;
    pendingLocalPreferPathRef.current = null;
    try {
      const files = await api.listLocalDir(localPath);
      const picked = pickSelection(files, preferredPath, selectedLocalRef.current);
      setLocalFiles(files);
      setSelectedLocal(picked);
      setSelectedLocalPaths(picked ? [picked.path] : []);
      setLocalSearch(null);
      setStatus(`本地 ${localPath}`);
    } catch (error) {
      setStatus(`本地目录读取失败: ${String(error)}`);
      pushToast("error", "本地目录读取失败");
    }
  }, [localPath, pushToast]);

  const loadRemoteFilesFor = useCallback(async (profile: Profile, path: string, password: string | null, preferPath?: string) => {
    const files = await api.listRemoteDir(profile.id, path, password);
    const picked = pickSelection(files, preferPath, selectedRemoteRef.current);
    setRemoteFiles(files);
    setSelectedRemote(picked);
    setSelectedRemotePaths(picked ? [picked.path] : []);
    setRemoteSearch(null);
    setStatus(`远程 ${profile.host}:${path}`);
  }, []);

  const refreshRemoteFiles = useCallback(async (preferPath?: string) => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) {
      setRemoteFiles([]);
      clearRemoteSelection();
      setRemoteSearch(null);
      return;
    }
    const preferredPath = preferPath ?? pendingRemotePreferPathRef.current ?? undefined;
    pendingRemotePreferPathRef.current = null;
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
  }, [activeProfile, loadRemoteFilesFor, passwordForActive, pushToast, remotePath]);

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

  useEffect(() => {
    document.body.classList.remove("theme-deep", "theme-graphite", "theme-light");
    document.body.classList.add(`theme-${settings.theme}`);
  }, [settings.theme]);

  useEffect(() => {
    refreshLocalFiles();
  }, [refreshLocalFiles]);

  useEffect(() => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || !remoteBrowserReady) {
      setRemoteHomeReady(false);
      setRemoteFiles([]);
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
        setRemoteFiles([]);
        setRemoteHomeReady(false);
        setStatus(`远程主目录读取失败: ${message}`);
        if (!shouldPromptForPassword(activeProfile, message)) {
          pushToast("error", "远程主目录读取失败");
        }
      });
    return () => {
      disposed = true;
    };
  }, [activeProfile?.id, activeProfile?.protocol, passwordForActive, remoteBrowserReady]);

  useEffect(() => {
    if (remoteBrowserReady && remoteHomeReady) {
      refreshRemoteFiles();
    }
  }, [refreshRemoteFiles, remoteBrowserReady, remoteHomeReady]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const loop = async () => {
      await refreshTransfers();
      if (stopped) return;
      const hasRunning = transfersRef.current.some((transfer) => transfer.status === "running");
      timer = window.setTimeout(loop, hasRunning ? 500 : 2500);
    };
    timer = window.setTimeout(loop, 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refreshTransfers]);

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

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (!hasTauriRuntime()) {
      setStatus("请在 Tauri 窗口中使用");
      return;
    }
    Promise.allSettled([
      api.loadSettings(),
      api.localHome(),
      api.listProfiles(),
      isFileManagerWindow ? Promise.resolve<TerminalView[]>([]) : api.listTerminals()
    ] as const).then(
      ([settingsResult, homeResult, profilesResult, terminalsResult]) => {
        if (settingsResult.status === "fulfilled") setSettings(settingsResult.value);
        if (homeResult.status === "fulfilled") setLocalPath(homeResult.value);
        if (profilesResult.status === "fulfilled") setProfiles(normalizeProfiles(profilesResult.value));
        if (!isFileManagerWindow && terminalsResult.status === "fulfilled" && terminalsResult.value.length > 0) {
          setTabs(terminalsResult.value);
          setActiveTabId(terminalsResult.value[0].id);
          setSelectedProfileId(terminalsResult.value[0].profileId);
        } else if (!isFileManagerWindow) {
          openLocalShell();
        } else {
          setStatus("文件管理器就绪");
        }
      }
    );
  }, [isFileManagerWindow, openLocalShell]);

  const appendTab = (terminal: TerminalView) => {
    setTabs((current) => [...current.filter((tab) => tab.id !== terminal.id), terminal]);
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
      setRemoteBrowserProfileId(secretProfile.id);
      setRemoteHomeReady(false);
      setStatus(`正在打开 SFTP ${secretProfile.host || secretProfile.name}`);
      return;
    }
    await connectProfile({ ...secretProfile, password });
  };

  const reconnectActive = async () => {
    if (!activeProfile) return;
    await connectProfile(activeProfile);
  };

  const copyActiveTerminal = async () => {
    if (!activeTab) return;
    let text = activeTab.text || "";
    if (hasTauriRuntime()) {
      try {
        text = (await api.terminalSnapshot(activeTab.id)).text || text;
      } catch {
        // Fall back to any replay text still held by React.
      }
    }
    if (!text) {
      pushToast("info", "终端暂无可复制内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", "终端内容已复制");
    } catch {
      await showTextDialog("复制终端内容", text);
    }
  };

  const pasteToActiveTerminal = async () => {
    if (!activeTab || activeTab.status !== "connected") return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      await api.terminalSend(activeTab.id, text);
    } catch (error) {
      pushToast("error", `粘贴失败: ${String(error)}`);
    }
  };

  const clearActiveTerminal = async () => {
    if (!activeTab || activeTab.status !== "connected") return;
    await api.terminalSend(activeTab.id, "\f").catch((error) => pushToast("error", `清屏失败: ${String(error)}`));
  };

  const sendTerminalCommand = async (command: string) => {
    if (!activeTab || activeTab.status !== "connected") return;
    const value = command.trim();
    if (!value) return;
    try {
      await api.terminalSend(activeTab.id, `${value}\r`);
      setTerminalCommand("");
    } catch (error) {
      pushToast("error", `命令发送失败: ${String(error)}`);
    }
  };

  const closeTab = async (tabId: string) => {
    await api.closeTerminal(tabId).catch(() => undefined);
    setTabs((current) => current.filter((tab) => tab.id !== tabId));
    setActiveTabId((current) => (current === tabId ? null : current));
    authPromptedTabsRef.current.delete(tabId);
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

  const terminalTabActions = (tabId: string): FileAction[] => {
    const tab = tabs.find((item) => item.id === tabId);
    return [
      {
        label: "复制窗口",
        icon: <Copy size={14} />,
        disabled: !tab,
        onClick: () => {
          if (tab) void duplicateTab(tab);
        }
      },
      { type: "separator" },
      {
        label: "关闭窗口",
        icon: <X size={14} />,
        disabled: !tab,
        danger: true,
        onClick: () => {
          if (tab) void closeTab(tab.id);
        }
      }
    ];
  };

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
      setProfileSecrets((current) => {
        const updated = { ...current };
        delete updated[profile.id];
        return updated;
      });
      setProfileSecretDrafts((current) => {
        const updated = { ...current };
        delete updated[profile.id];
        return updated;
      });
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

  const saveSettings = async () => {
    try {
      const saved = await api.saveSettings(settings);
      setSettings(saved);
      setDialog(null);
      pushToast("success", "设置已保存");
    } catch (error) {
      pushToast("error", `设置保存失败: ${String(error)}`);
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

  const copySelectedPaths = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = entries.map((entry) => entry.path).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "路径已复制" : `${entries.length} 个路径已复制`);
    } catch {
      await showTextDialog("复制路径", text);
    }
  };

  const copySelectedNames = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = entries.map((entry) => entry.name).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "名称已复制" : `${entries.length} 个名称已复制`);
    } catch {
      await showTextDialog("复制名称", text);
    }
  };

  const copySelectedParentPaths = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = entries.map((entry) => parentPathForSide(side, entry.path)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "父目录路径已复制" : `${entries.length} 个父目录路径已复制`);
    } catch {
      await showTextDialog("复制父目录路径", text);
    }
  };

  const copySelectedRelativePaths = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const base = side === "local" ? localPath : remotePath;
    const text = entries.map((entry) => relativePathForSide(side, base, entry.path)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "相对路径已复制" : `${entries.length} 个相对路径已复制`);
    } catch {
      await showTextDialog("复制相对路径", text);
    }
  };

  const copySelectedFileInfo = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = fileInfoTable(entries);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "文件信息已复制" : `${entries.length} 个文件信息已复制`);
    } catch {
      await showTextDialog("复制文件信息", text);
    }
  };

  const copySelectedFileInfoCsv = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = fileInfoCsv(entries);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "CSV 文件信息已复制" : `${entries.length} 个 CSV 文件信息已复制`);
    } catch {
      await showTextDialog("复制 CSV 文件信息", text);
    }
  };

  const downloadSelectedFileInfoCsv = (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    downloadTextFile(fileInfoCsvName(side), fileInfoCsv(entries), "text/csv;charset=utf-8");
    pushToast("success", entries.length === 1 ? "CSV 清单已下载" : `${entries.length} 个项目的 CSV 清单已下载`);
  };

  const copyCurrentDirectoryFileInfoCsv = async (side: FileSide) => {
    const entries = side === "local" ? localFiles : remoteFiles;
    if (entries.length === 0) return;
    const text = fileInfoCsv(entries);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", `${side === "local" ? "本地" : "远程"}当前目录 CSV 已复制 ${entries.length} 条`);
    } catch {
      await showTextDialog("复制当前目录 CSV 清单", text);
    }
  };

  const downloadCurrentDirectoryFileInfoCsv = (side: FileSide) => {
    const entries = side === "local" ? localFiles : remoteFiles;
    if (entries.length === 0) return;
    downloadTextFile(directoryListingCsvName(side), fileInfoCsv(entries), "text/csv;charset=utf-8");
    pushToast("success", `${side === "local" ? "本地" : "远程"}当前目录 CSV 已下载 ${entries.length} 条`);
  };

  const copySelectedLinkTargets = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    const targets = entries.map((entry) => entry.linkTarget?.trim()).filter(Boolean) as string[];
    if (targets.length === 0) {
      pushToast("info", "所选项目没有链接目标");
      return;
    }
    const text = targets.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", targets.length === 1 ? "链接目标已复制" : `${targets.length} 个链接目标已复制`);
    } catch {
      await showTextDialog("复制链接目标", text);
    }
  };

  const copyRemoteSymlinkCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = visibleSelectedRemoteEntries.filter((entry) => entry.fileType === "symlink" && entry.linkTarget?.trim());
    if (entries.length === 0) {
      pushToast("info", "所选远程项目没有可复制的符号链接命令");
      return;
    }
    const text = entries.map((entry) => remoteSymlinkCommand(activeProfile, entry)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "ln -s 命令已复制" : `${entries.length} 条 ln -s 命令已复制`);
    } catch {
      await showTextDialog("复制 ln -s 命令", text);
    }
  };

  const copyRemoteUris = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteSftpUri(activeProfile, entry.path)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", visibleSelectedRemoteEntries.length === 1 ? "SFTP 地址已复制" : `${visibleSelectedRemoteEntries.length} 个 SFTP 地址已复制`);
    } catch {
      await showTextDialog("复制 SFTP 地址", text);
    }
  };

  const copyScpCommands = async (direction: "upload" | "download") => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = direction === "upload" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = entries
      .map((entry) =>
        direction === "upload"
          ? scpUploadCommand(activeProfile, entry, remotePath)
          : scpDownloadCommand(activeProfile, entry, localPath || ".")
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "scp 命令已复制" : `${entries.length} 条 scp 命令已复制`);
    } catch {
      await showTextDialog("复制 scp 命令", text);
    }
  };

  const copyRsyncCommands = async (direction: "upload" | "download", dryRun = false) => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = direction === "upload" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    if (entries.length === 0) return;
    const text = entries
      .map((entry) =>
        direction === "upload"
          ? rsyncUploadCommand(activeProfile, entry, remotePath, dryRun)
          : rsyncDownloadCommand(activeProfile, entry, localPath || ".", dryRun)
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? `rsync${dryRun ? " 预演" : ""}命令已复制` : `${entries.length} 条 rsync${dryRun ? " 预演" : ""}命令已复制`);
    } catch {
      await showTextDialog(dryRun ? "复制 rsync 预演命令" : "复制 rsync 命令", text);
    }
  };

  const copyChmodCommands = async (side: FileSide) => {
    const entries = (side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries).filter(
      (entry) => entry.permissions != null && entry.fileType !== "symlink"
    );
    if (entries.length === 0) {
      pushToast("info", "所选项目没有可复制的权限命令");
      return;
    }
    if (side === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return;
    const text = entries
      .map((entry) => (side === "remote" ? remoteChmodCommand(activeProfile!, entry) : localChmodCommand(entry)))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "chmod 命令已复制" : `${entries.length} 条 chmod 命令已复制`);
    } catch {
      await showTextDialog("复制 chmod 命令", text);
    }
  };

  const copyChownCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = visibleSelectedRemoteEntries.filter(
      (entry) => entry.fileType !== "symlink" && (entry.uid != null || entry.gid != null)
    );
    if (entries.length === 0) {
      pushToast("info", "所选远程项目没有可复制的属主命令");
      return;
    }
    const text = entries.map((entry) => remoteChownCommand(activeProfile, entry)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "chown 命令已复制" : `${entries.length} 条 chown 命令已复制`);
    } catch {
      await showTextDialog("复制 chown 命令", text);
    }
  };

  const copyTouchCommands = async (side: FileSide) => {
    const entries = (side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries).filter(
      (entry) => entry.fileType !== "symlink" && touchTimestamp(entry.modifiedAt)
    );
    if (entries.length === 0) {
      pushToast("info", "所选项目没有可复制的时间命令");
      return;
    }
    if (side === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return;
    const text = entries
      .map((entry) => (side === "remote" ? remoteTouchCommand(activeProfile!, entry) : localTouchCommand(entry)))
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "touch 命令已复制" : `${entries.length} 条 touch 命令已复制`);
    } catch {
      await showTextDialog("复制 touch 命令", text);
    }
  };

  const copyRemoteDeleteCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteDeleteCommand(activeProfile, entry)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", visibleSelectedRemoteEntries.length === 1 ? "删除命令已复制" : `${visibleSelectedRemoteEntries.length} 条删除命令已复制`);
    } catch {
      await showTextDialog("复制删除命令", text);
    }
  };

  const copyRemoteStatCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteStatCommand(activeProfile, entry)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", visibleSelectedRemoteEntries.length === 1 ? "stat 命令已复制" : `${visibleSelectedRemoteEntries.length} 条 stat 命令已复制`);
    } catch {
      await showTextDialog("复制 stat 命令", text);
    }
  };

  const copyRemoteSha256Commands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
    const entries = visibleSelectedRemoteEntries.filter((entry) => !entry.isDir && entry.fileType !== "symlink");
    if (entries.length === 0) return;
    const text = entries.map((entry) => remoteSha256Command(activeProfile, entry)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", entries.length === 1 ? "sha256sum 命令已复制" : `${entries.length} 条 sha256sum 命令已复制`);
    } catch {
      await showTextDialog("复制 sha256sum 命令", text);
    }
  };

  const copyRemoteDuCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteDuCommand(activeProfile, entry)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", visibleSelectedRemoteEntries.length === 1 ? "du 命令已复制" : `${visibleSelectedRemoteEntries.length} 条 du 命令已复制`);
    } catch {
      await showTextDialog("复制 du 命令", text);
    }
  };

  const copyRemoteListCommands = async () => {
    if (!activeProfile || isLocalProtocol(activeProfile.protocol) || visibleSelectedRemoteEntries.length === 0) return;
    const text = visibleSelectedRemoteEntries.map((entry) => remoteListCommand(activeProfile, entry)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", visibleSelectedRemoteEntries.length === 1 ? "ls -ld 命令已复制" : `${visibleSelectedRemoteEntries.length} 条 ls -ld 命令已复制`);
    } catch {
      await showTextDialog("复制 ls -ld 命令", text);
    }
  };

  const copyConnectionCommand = async (profile: Profile | null) => {
    if (!profile || isLocalProtocol(profile.protocol)) return;
    const text = connectionCommand(profile);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", "连接命令已复制");
    } catch {
      await showTextDialog("复制连接命令", text);
    }
  };

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

  const copyDeleteConfirmCsv = async () => {
    if (!deleteConfirm) return;
    const text = deleteConfirmCsv(deleteConfirm.side, deleteConfirm.entries);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", "删除清单 CSV 已复制");
    } catch {
      await showTextDialog("复制删除清单 CSV", text);
    }
  };

  const downloadDeleteConfirmCsv = () => {
    if (!deleteConfirm) return;
    downloadTextFile(deleteConfirmCsvName(deleteConfirm.side), deleteConfirmCsv(deleteConfirm.side, deleteConfirm.entries), "text/csv;charset=utf-8");
    pushToast("success", "删除清单 CSV 已下载");
  };

  const copyDeleteConfirmJson = async () => {
    if (!deleteConfirm) return;
    const text = deleteConfirmJson(deleteConfirm.side, deleteConfirm.entries);
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", "删除清单 JSON 已复制");
    } catch {
      await showTextDialog("复制删除清单 JSON", text);
    }
  };

  const downloadDeleteConfirmJson = () => {
    if (!deleteConfirm) return;
    downloadTextFile(deleteConfirmJsonName(deleteConfirm.side), deleteConfirmJson(deleteConfirm.side, deleteConfirm.entries));
    pushToast("success", "删除清单 JSON 已下载");
  };

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

  const copyPropertiesReport = async () => {
    if (!propertiesTarget) return;
    const targets = propertiesTargets.length ? propertiesTargets : [propertiesTarget];
    const text = propertiesReportText(propertiesSide, targets, currentPropertiesReportOptions());
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", targets.length === 1 ? "属性报告已复制" : `${targets.length} 个项目的属性报告已复制`);
    } catch {
      await showTextDialog("复制属性报告", text);
    }
  };

  const copyPropertiesCsv = async () => {
    if (!propertiesTarget) return;
    const targets = propertiesTargets.length ? propertiesTargets : [propertiesTarget];
    const text = propertiesReportCsv(propertiesSide, targets, currentPropertiesReportOptions());
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", targets.length === 1 ? "属性 CSV 已复制" : `${targets.length} 个项目的属性 CSV 已复制`);
    } catch {
      await showTextDialog("复制属性 CSV", text);
    }
  };

  const downloadPropertiesCsv = () => {
    if (!propertiesTarget) return;
    const targets = propertiesTargets.length ? propertiesTargets : [propertiesTarget];
    downloadTextFile(
      propertiesReportCsvName(propertiesSide),
      propertiesReportCsv(propertiesSide, targets, currentPropertiesReportOptions()),
      "text/csv;charset=utf-8"
    );
    pushToast("success", targets.length === 1 ? "属性 CSV 已下载" : `${targets.length} 个项目的属性 CSV 已下载`);
  };

  const copyPropertiesJson = async () => {
    if (!propertiesTarget) return;
    const targets = propertiesTargets.length ? propertiesTargets : [propertiesTarget];
    const text = propertiesReportJson(propertiesSide, targets, currentPropertiesReportOptions());
    try {
      await navigator.clipboard.writeText(text);
      pushToast("success", targets.length === 1 ? "属性 JSON 已复制" : `${targets.length} 个项目的属性 JSON 已复制`);
    } catch {
      await showTextDialog("复制属性 JSON", text);
    }
  };

  const downloadPropertiesJson = () => {
    if (!propertiesTarget) return;
    const targets = propertiesTargets.length ? propertiesTargets : [propertiesTarget];
    downloadTextFile(propertiesReportJsonName(propertiesSide), propertiesReportJson(propertiesSide, targets, currentPropertiesReportOptions()));
    pushToast("success", targets.length === 1 ? "属性 JSON 已下载" : `${targets.length} 个项目的属性 JSON 已下载`);
  };

  const currentPropertiesReportOptions = (): PropertiesReportOptions => ({
    uid: propertiesUid,
    gid: propertiesGid,
    mode: propertiesMode,
    mtime: propertiesMtime,
    stats: propertiesStats,
    checksum: propertiesChecksum,
    recursive: propertiesRecursive
  });

  const collectSelectedSha256 = async (side: FileSide) => {
    const entries = side === "local" ? visibleSelectedLocalEntries : visibleSelectedRemoteEntries;
    const files = entries.filter((entry) => !entry.isDir && entry.fileType !== "symlink");
    if (files.length === 0) {
      pushToast("info", "请选择普通文件计算 SHA-256");
      return null;
    }
    if (side === "remote" && (!activeProfile || isLocalProtocol(activeProfile.protocol))) return null;

    const records: Sha256AuditRecord[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        const hash =
          side === "local"
            ? await api.localFileSha256(file.path)
            : await api.remoteFileSha256(activeProfile!.id, file.path, passwordForActive);
        records.push({ side, file, hash });
      } catch (error) {
        failures.push(`${file.name}: ${String(error)}`);
      }
    }
    return { records, failures };
  };

  const reportSha256Failures = (side: FileSide, failures: string[]) => {
    if (failures.length === 0) return;
    const summary = failures.slice(0, 3).join("；");
    setStatus(`SHA-256 计算失败 ${failures.length} 个：${summary}${failures.length > 3 ? "..." : ""}`);
    pushToast("error", `SHA-256 计算失败 ${failures.length} 个文件`);
    if (side === "remote" && activeProfile && shouldPromptForPassword(activeProfile, failures[0])) {
      requestProfileSecret(activeProfile, failures[0]);
      pushToast("info", "请输入连接密码/口令");
    }
  };

  const copySelectedSha256 = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;

    if (records.length > 0) {
      const text = records.map((record) => `${record.hash}  ${record.file.path}`).join("\n");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        await showTextDialog("复制 SHA-256", text);
      }
      setStatus(`${side === "local" ? "本地" : "远程"} SHA-256 已复制 ${records.length} 个文件`);
      pushToast("success", records.length === 1 ? "SHA-256 已复制" : `${records.length} 个 SHA-256 已复制`);
    }
    reportSha256Failures(side, failures);
  };

  const copySelectedSha256Csv = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;
    if (records.length > 0) {
      const text = sha256AuditCsv(records);
      try {
        await navigator.clipboard.writeText(text);
        pushToast("success", records.length === 1 ? "SHA-256 CSV 已复制" : `${records.length} 个 SHA-256 CSV 已复制`);
      } catch {
        await showTextDialog("复制 SHA-256 CSV", text);
      }
    }
    reportSha256Failures(side, failures);
  };

  const downloadSelectedSha256Csv = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;
    if (records.length > 0) {
      downloadTextFile(sha256AuditCsvName(side), sha256AuditCsv(records), "text/csv;charset=utf-8");
      pushToast("success", records.length === 1 ? "SHA-256 CSV 已下载" : `${records.length} 个 SHA-256 CSV 已下载`);
    }
    reportSha256Failures(side, failures);
  };

  const copySelectedSha256Json = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;
    if (records.length > 0) {
      const text = sha256AuditJson(records);
      try {
        await navigator.clipboard.writeText(text);
        pushToast("success", records.length === 1 ? "SHA-256 JSON 已复制" : `${records.length} 个 SHA-256 JSON 已复制`);
      } catch {
        await showTextDialog("复制 SHA-256 JSON", text);
      }
    }
    reportSha256Failures(side, failures);
  };

  const downloadSelectedSha256Json = async (side: FileSide) => {
    const result = await collectSelectedSha256(side);
    if (!result) return;
    const { records, failures } = result;
    if (records.length > 0) {
      downloadTextFile(sha256AuditJsonName(side), sha256AuditJson(records));
      pushToast("success", records.length === 1 ? "SHA-256 JSON 已下载" : `${records.length} 个 SHA-256 JSON 已下载`);
    }
    reportSha256Failures(side, failures);
  };

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

  const runWindowAction = async (action: "minimize" | "maximize" | "close") => {
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

  const startWindowDrag = async (event: MouseEvent<HTMLElement>) => {
    if (!hasTauriRuntime() || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(windowDragExcludeSelector)) return;
    event.preventDefault();
    await getCurrentWindow().startDragging().catch(() => undefined);
  };

  useEffect(() => {
    if (!tabContextMenu) return;
    const close = () => setTabContextMenu(null);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tabContextMenu]);

  const startPanelResize = (side: "left" | "right", event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? leftPanelWidth : rightPanelWidth;
    if (side === "left") {
      setLeftPanelCollapsed(false);
    } else {
      setRightPanelCollapsed(false);
    }

    const move = (moveEvent: globalThis.MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = side === "left" ? startWidth + delta : startWidth - delta;
      const setWidth = side === "left" ? setLeftPanelWidth : setRightPanelWidth;
      setWidth(clampNumber(nextWidth, minPanelWidth, maxPanelWidth));
    };

    const stop = () => {
      document.body.classList.remove("is-resizing-panel");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };

    document.body.classList.add("is-resizing-panel");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  const resetPanelWidth = (side: "left" | "right") => {
    if (side === "left") {
      setLeftPanelWidth(defaultLeftPanelWidth);
      setLeftPanelCollapsed(false);
      return;
    }
    setRightPanelWidth(defaultRightPanelWidth);
    setRightPanelCollapsed(false);
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
        setLocalFiles(files);
        setSelectedLocal(null);
        setSelectedLocalPaths([]);
        navigateLocalPath(targetPath);
        return;
      }

      if (!activeProfile || isLocalProtocol(activeProfile.protocol)) return;
      const files = await api.listRemoteDir(activeProfile.id, targetPath, passwordForActive);
      setRemoteFiles(files);
      setSelectedRemote(null);
      setSelectedRemotePaths([]);
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
      setRemoteFiles(files);
      clearRemoteSelection();
      setRemoteSearch({ root: remotePath, query: query.trim(), count: files.length });
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
      setLocalFiles(files);
      clearLocalSelection();
      setLocalSearch({ root: localPath, query: query.trim(), count: files.length });
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
    const needle = sessionSearch.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter(
      (profile) =>
        profile.name.toLowerCase().includes(needle) ||
        profile.group.toLowerCase().includes(needle) ||
        profile.host.toLowerCase().includes(needle)
    );
  }, [profiles, sessionSearch]);
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
    setRemoteBrowserProfileId(profileId);
    setRemoteHomeReady(false);
    setRemoteFiles([]);
    setRemoteSearch(null);
    setRemoteBackHistory([]);
    setRemoteForwardHistory([]);
    clearRemoteSelection();
    setRemotePath(".");
  };
  useEffect(() => {
    if (!isFileManagerWindow) return;
    const switchProfile = (profileId: string | null) => {
      if (!profileId || !profiles.some((profile) => profile.id === profileId && isRemoteProtocol(profile.protocol))) {
        return;
      }
      setSelectedProfileId(profileId);
      setRemoteBrowserProfileId(profileId);
      setRemoteHomeReady(false);
      setRemoteFiles([]);
      setRemoteSearch(null);
      setRemoteBackHistory([]);
      setRemoteForwardHistory([]);
      clearRemoteSelection();
      setRemotePath(".");
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === fileManagerProfileStorageKey) {
        switchProfile(event.newValue);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [isFileManagerWindow, profiles]);
  const workspaceStyle = {
    "--left-panel-width": `${leftPanelCollapsed ? collapsedPanelWidth : leftPanelWidth}px`,
    "--right-panel-width": `${rightPanelCollapsed ? collapsedPanelWidth : rightPanelWidth}px`
  } as CSSProperties;
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
  const sideInfoPanel = (
    <section className="info-panel compact-info-panel">
      <div className="compact-info-head">
        <h3>连接概览</h3>
        <IconButton
          title="刷新服务器状态"
          icon={<RefreshCcw size={14} />}
          onClick={() => refreshServerStatus(true)}
          disabled={!activeProfile || serverStatusLoading}
        />
      </div>
      <div className="compact-info-grid">
        <InfoRow label="名称" value={activeProfile?.name ?? "-"} />
        <InfoRow label="主机" value={activeProfile?.host ?? "-"} />
        <InfoRow label="协议" value={normalizeProtocolLabel(activeProfile?.protocol)} />
        <InfoRow label="用户" value={activeProfile?.username ?? "-"} />
        <InfoRow label="端口" value={String(activeProfile?.port ?? "-")} />
        {serverStatus && (
          <>
            <InfoRow label="节点" value={serverStatus.hostname} />
            <InfoRow label="系统" value={compactServerOs(serverStatus.os)} title={serverStatus.os} />
            <InfoRow label="运行" value={compactUptime(serverStatus.uptime)} title={serverStatus.uptime} />
            <InfoRow label="负载" value={serverStatus.loadAverage} />
            <InfoRow label="CPU" value={serverStatus.cpu} />
            <InfoRow label="内存" value={serverStatus.memory} />
            <InfoRow label="磁盘" value={serverStatus.disk} />
          </>
        )}
      </div>
      {!serverStatus && (
        <div className="server-status-empty">
          {serverStatusLoading ? "正在读取服务器状态..." : serverStatusError ? `状态读取失败: ${serverStatusError}` : "暂无状态数据"}
        </div>
      )}
    </section>
  );
  const transferQueuePanel = (
    <TransferQueue
      transfers={transfers}
      history={transferHistory}
      conflict={transferConflict}
      onConflict={setTransferConflict}
      onCancel={async (id) => {
        await api.cancelTransfer(id).catch(() => undefined);
        await refreshTransfers();
      }}
      onRetry={async (id) => {
        await api.retryTransfer(id).catch((error) => pushToast("error", `重试失败: ${String(error)}`));
        await refreshTransfers();
      }}
      onRemove={async (id) => {
        await api
          .removeTransfer(id)
          .then(async (next) => {
            setTransfers(next);
            setTransferHistory(await api.listTransferHistory());
          })
          .catch((error) => pushToast("error", `移除失败: ${String(error)}`));
      }}
      onClear={async () => {
        const nextTransfers = await api.clearFinishedTransfers();
        const nextHistory = await api.clearTransferHistory();
        setTransfers(nextTransfers);
        setTransferHistory(nextHistory);
        pushToast("success", "已清理完成和历史传输");
      }}
      onCancelRunning={async (ids) => {
        if (ids.length === 0) return;
        await Promise.all(ids.map((id) => api.cancelTransfer(id).catch(() => undefined)));
        await refreshTransfers();
        pushToast("success", `已取消 ${ids.length} 个传输`);
      }}
      onRetryFailed={async (ids) => {
        if (ids.length === 0) return;
        await Promise.all(ids.map((id) => api.retryTransfer(id).catch((error) => pushToast("error", `重试失败: ${String(error)}`))));
        await refreshTransfers();
      }}
      onCopyCsv={copyTransferAuditCsv}
      onDownloadCsv={downloadTransferAuditCsv}
      onOpenLocalPath={async (path, reveal) => {
        try {
          await api.openLocalPath(path, reveal);
        } catch (error) {
          pushToast("error", `${reveal ? "打开所在文件夹" : "打开文件"}失败: ${String(error)}`);
        }
      }}
      onCopyDetail={async (transfer) => {
        const text = transferDetailText(transfer, profiles);
        try {
          await navigator.clipboard.writeText(text);
          pushToast("success", "传输详情已复制");
        } catch {
          await showTextDialog("复制传输详情", text);
        }
      }}
      onLocate={async (transfer) => {
        try {
          if (transfer.direction === "download") {
            const targetPath = transferDownloadResultPath(transfer);
            navigateLocalPath(localParentPath(targetPath), targetPath);
            return;
          }
          setSelectedProfileId(transfer.profileId);
          const targetPath = transferUploadResultPath(transfer);
          navigateRemotePath(remoteParentPath(targetPath), targetPath);
        } catch (error) {
          pushToast("error", `定位失败: ${String(error)}`);
        }
      }}
    />
  );
  const appMenus: AppMenuGroup[] = [
    {
      label: "文件(F)",
      items: [
        { label: "新建会话", hint: "New", onClick: () => openProfileEditor() },
        { type: "separator" },
        { label: "导入会话", hint: "JSON", onClick: importSessions },
        { label: "导出会话", hint: "JSON", onClick: exportSessions }
      ]
    },
    {
      label: "连接(C)",
      items: [
        { label: "快速连接", hint: "Quick", onClick: () => setDialog("quick") },
        { label: "重连当前", hint: "Reconnect", onClick: reconnectActive, disabled: !activeProfile },
        { type: "separator" },
        { label: "打开本地终端", hint: "Local", onClick: openLocalShell }
      ]
    },
    {
      label: "工具(T)",
      items: [
        { label: "传输队列", hint: "Transfers", onClick: () => setDialog("transfers") },
        {
          label: "文件管理器",
          hint: "Files",
          onClick: openSftpManager
        }
      ]
    },
    {
      label: "选项(O)",
      items: [
        { label: "设置", hint: "Settings", onClick: () => setDialog("settings") },
        {
          label: "切换主题",
          hint: settings.theme === "deep" ? "Graphite" : settings.theme === "graphite" ? "Light" : "Deep",
          onClick: () =>
            setSettings((current) => ({
              ...current,
              theme: current.theme === "deep" ? "graphite" : current.theme === "graphite" ? "light" : "deep"
            }))
        }
      ]
    },
    {
      label: "窗口(W)",
      items: [
        { label: "最小化", onClick: () => void runWindowAction("minimize") },
        { label: "最大化/还原", onClick: () => void runWindowAction("maximize") }
      ]
    },
    {
      label: "帮助(H)",
      items: [
        {
          label: "关于 RustShell",
          hint: "Info",
          onClick: () => {
            setStatus("RustShell SSH 终端工具");
            pushToast("info", "RustShell SSH 终端工具");
          }
        }
      ]
    }
  ];
  const windowControls = (
    <div className="window-controls" aria-label="窗口控制">
      <button title="最小化" onClick={() => void runWindowAction("minimize")}>
        <Minus size={14} />
      </button>
      <button title="最大化/还原" onClick={() => void runWindowAction("maximize")}>
        <Maximize2 size={13} />
      </button>
      <button title="关闭" onClick={() => void runWindowAction("close")}>
        <X size={14} />
      </button>
    </div>
  );

  return (
    <div className={`app-shell ${isFileManagerWindow ? "file-window-shell" : ""}`}>
      {!isFileManagerWindow && (
        <header className="topbar" onMouseDown={startWindowDrag}>
          <div className="brand" data-tauri-drag-region>
            <img className="brand-mark" src="/rustshell-logo.svg" alt="" aria-hidden="true" draggable={false} />
            <div data-tauri-drag-region>
              <div className="brand-title">RustShell</div>
            </div>
          </div>
          <AppMenuBar menus={appMenus} />
          <div className="topbar-drag-region" data-tauri-drag-region />
          <div className="topbar-connect">
            <input
              className="host-search"
              value={hostSearch}
              onChange={(event) => setHostSearch(event.target.value)}
              placeholder="主机名、IP 或会话名称"
              onKeyDown={(event) => {
                if (event.key === "Enter") connectFromSearch();
              }}
            />
            <button className="primary-button" onClick={connectFromSearch}>
              连接
            </button>
          </div>
          {windowControls}
        </header>
      )}

      <main
        className={`workspace ${isFileManagerWindow ? "file-window-workspace" : ""} ${
          leftPanelCollapsed ? "left-collapsed" : ""
        } ${rightPanelCollapsed ? "right-collapsed" : ""}`}
        style={workspaceStyle}
      >
        {!isFileManagerWindow && (
          <>
        <aside className={`left-panel ${leftPanelCollapsed ? "collapsed" : ""}`}>
          {leftPanelCollapsed ? (
            <button className="panel-rail-button" title="展开会话管理器" onClick={() => setLeftPanelCollapsed(false)}>
              <ChevronRight size={16} />
            </button>
          ) : (
            <>
              <div className="left-panel-main">
                <PanelHeader
                  title="会话管理器"
                  action={
                    <div className="panel-header-actions">
                      <IconButton title="新建会话" icon={<CirclePlus size={14} />} onClick={() => openProfileEditor()} />
                      <IconButton title="收起左侧" icon={<ChevronLeft size={14} />} onClick={() => setLeftPanelCollapsed(true)} />
                    </div>
                  }
                />
                <input
                  className="panel-search"
                  value={sessionSearch}
                  onChange={(event) => setSessionSearch(event.target.value)}
                  placeholder="搜索会话"
                />
                <SessionTree
                  profiles={filteredProfiles}
                  activeProfileId={activeProfile?.id ?? null}
                  onSelect={(profile) => setSelectedProfileId(profile.id)}
                  onConnect={connectProfile}
                  onSecret={requestProfileSecret}
                  onEdit={openProfileEditor}
                  onCopyCommand={copyConnectionCommand}
                  onDuplicate={duplicateSession}
                  onDelete={deleteSession}
                  onPromptText={promptText}
                  onCreateProfile={(group) => openProfileEditor({ ...createBlankProfile(), group: normalizeSessionGroupPath(group) })}
                  onDeleteFolder={deleteSessionFolder}
                />
              </div>
              {sideInfoPanel}
            </>
          )}
        </aside>

        <div
          className="panel-resizer left-resizer"
          role="separator"
          aria-orientation="vertical"
          title="拖拽调整左侧宽度，双击恢复"
          onMouseDown={(event) => startPanelResize("left", event)}
          onDoubleClick={() => resetPanelWidth("left")}
        />

        <section className="terminal-area">
          <div className="tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`tab ${tab.id === activeTabId ? "active" : ""}`}
                onClick={() => {
                  setActiveTabId(tab.id);
                  startTransition(() => setSelectedProfileId(tab.profileId));
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveTabId(tab.id);
                  startTransition(() => setSelectedProfileId(tab.profileId));
                  setTabContextMenu({
                    x: clampNumber(event.clientX, 8, window.innerWidth - 210),
                    y: clampNumber(event.clientY, 8, window.innerHeight - 120),
                    tabId: tab.id
                  });
                }}
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    event.stopPropagation();
                    closeTab(tab.id);
                  }
                }}
              >
                <span className={`status-dot ${tab.status}`} />
                <span className="tab-title">{tab.title}</span>
                <span
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X size={13} />
                </span>
              </button>
            ))}
            {tabContextMenu && (
              <FileContextMenu
                x={tabContextMenu.x}
                y={tabContextMenu.y}
                actions={terminalTabActions(tabContextMenu.tabId)}
                onClose={() => setTabContextMenu(null)}
              />
            )}
          </div>
          <div className="terminal-stack">
            {tabs.length > 0 ? (
              tabs.map((tab) => (
                <XtermView
                  key={tab.id}
                  terminal={tab}
                  settings={settings}
                  active={tab.id === activeTab?.id}
                  onDrain={(next) => handleTerminalDrain(next, tab.profileId)}
                  onReplayConsumed={markTerminalReplayConsumed}
                />
              ))
            ) : (
              <div className="empty-terminal">
                <div className="empty-terminal-panel">
                  <div className="empty-terminal-title">没有打开的会话</div>
                  <div className="empty-terminal-actions">
                    <button type="button" className="empty-terminal-action" onClick={() => openProfileEditor()}>
                      <CirclePlus size={28} />
                      <span>新建会话</span>
                    </button>
                    <button type="button" className="empty-terminal-action" onClick={() => setDialog("quick")}>
                      <Cable size={28} />
                      <span>快速连接</span>
                    </button>
                    <button
                      type="button"
                      className="empty-terminal-action"
                      onClick={() => activeProfile && connectProfile(activeProfile)}
                      disabled={!activeProfile}
                    >
                      <Monitor size={28} />
                      <span>打开选中</span>
                    </button>
                    <button type="button" className="empty-terminal-action" onClick={openSftpManager}>
                      <Folder size={28} />
                      <span>文件管理器</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <section className="terminal-tools terminal-tools-inline">
            <div className="terminal-tool-grid">
              <IconButton title="复制终端内容" icon={<Copy size={14} />} onClick={copyActiveTerminal} disabled={!activeTab} />
              <IconButton
                title="粘贴到终端"
                icon={<ClipboardPaste size={14} />}
                onClick={pasteToActiveTerminal}
                disabled={!activeTab || activeTab.status !== "connected"}
              />
              <IconButton
                title="清屏"
                icon={<Eraser size={14} />}
                onClick={clearActiveTerminal}
                disabled={!activeTab || activeTab.status !== "connected"}
              />
              <IconButton title="重连" icon={<RefreshCcw size={14} />} onClick={reconnectActive} disabled={!activeProfile} />
              <IconButton title="关闭会话" icon={<X size={14} />} onClick={() => activeTab && closeTab(activeTab.id)} disabled={!activeTab} />
            </div>
            <div className="terminal-snippets">
              {terminalSnippets.map((command) => (
                <button
                  key={command}
                  onClick={() => sendTerminalCommand(command)}
                  disabled={!activeTab || activeTab.status !== "connected"}
                  title={`发送 ${command}`}
                >
                  {command}
                </button>
              ))}
            </div>
            <div className="terminal-command-row">
              <input
                value={terminalCommand}
                onChange={(event) => setTerminalCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    sendTerminalCommand(terminalCommand);
                  }
                }}
                placeholder="输入命令"
              />
              <IconButton
                title="发送命令"
                icon={<Send size={14} />}
                onClick={() => sendTerminalCommand(terminalCommand)}
                disabled={!activeTab || activeTab.status !== "connected" || !terminalCommand.trim()}
              />
            </div>
          </section>
        </section>

        <div
          className="panel-resizer right-resizer"
          role="separator"
          aria-orientation="vertical"
          title="拖拽调整右侧宽度，双击恢复"
          onMouseDown={(event) => startPanelResize("right", event)}
          onDoubleClick={() => resetPanelWidth("right")}
        />
          </>
        )}

        <aside className={`right-panel ${rightPanelCollapsed ? "collapsed" : ""}`}>
          {rightPanelCollapsed && !isFileManagerWindow ? (
            <button className="panel-rail-button" title="打开文件管理器" onClick={openSftpManager}>
              <FolderSync size={16} />
            </button>
          ) : (
            <>
              <section className="file-panel">
                <div
                  className="file-panel-heading"
                  data-tauri-drag-region={isFileManagerWindow ? "" : undefined}
                  onMouseDown={isFileManagerWindow ? startWindowDrag : undefined}
                >
                  <h3 data-tauri-drag-region={isFileManagerWindow ? "" : undefined}>
                    文件管理器
                  </h3>
                  {isFileManagerWindow && (
                    <AppSelect
                      className="file-profile-select"
                      value={fileManagerProfileValue}
                      options={remoteProfileOptions}
                      onChange={selectRemoteBrowserProfile}
                      ariaLabel="选择远程会话"
                      disabled={remoteProfileOptions.length === 1 && !remoteProfileOptions[0].value}
                    />
                  )}
                  <IconButton
                    title={compareDirectories ? "关闭目录对比" : "开启目录对比"}
                    icon={<FolderSync size={14} />}
                    onClick={() => setCompareDirectories((current) => !current)}
                    disabled={baseVisibleLocalFiles.length === 0 && baseVisibleRemoteFiles.length === 0}
                  />
                  <IconButton
                    title="导入同步计划 JSON"
                    icon={<Upload size={14} />}
                    onClick={importSyncPlanJson}
                    disabled={!activeProfile || isLocalProtocol(activeProfile.protocol)}
                  />
                  <IconButton
                    title="校验选中文件 SHA-256"
                    icon={<Calculator size={14} />}
                    onClick={compareSelectedSha256}
                    disabled={
                      !activeProfile ||
                      isLocalProtocol(activeProfile.protocol) ||
                      !visibleSelectedLocal ||
                      !visibleSelectedRemote ||
                      visibleSelectedLocal.isDir ||
                      visibleSelectedRemote.isDir ||
                      visibleSelectedLocal.fileType === "symlink" ||
                      visibleSelectedRemote.fileType === "symlink"
                    }
                  />
                  <IconButton
                    title="传输队列"
                    icon={<ListChecks size={14} />}
                    onClick={() => {
                      setDialog("transfers");
                      if (!isFileManagerWindow) setRightPanelCollapsed(true);
                    }}
                  />
                  {isFileManagerWindow ? (
                    windowControls
                  ) : (
                    <IconButton
                      title="收起右侧"
                      icon={<ChevronRight size={14} />}
                      onClick={() => setRightPanelCollapsed(true)}
                    />
                  )}
                </div>
            {compareDirectories && (
              <div className="file-compare-summary">
                <span>仅本地 {directoryCompare.summary.onlyLocal}</span>
                <span>仅远程 {directoryCompare.summary.onlyRemote}</span>
                <span>不同 {directoryCompare.summary.different}</span>
                <span>相同 {directoryCompare.summary.same}</span>
                <button className={compareView === "all" ? "active" : ""} onClick={() => setCompareView("all")} title="显示全部对比结果">
                  全部
                </button>
                <button className={compareView === "diff" ? "active" : ""} onClick={() => setCompareView("diff")} title="只显示仅本地、仅远程和不同项">
                  仅差异
                </button>
                <button className={compareView === "same" ? "active" : ""} onClick={() => setCompareView("same")} title="只显示相同项">
                  仅相同
                </button>
                <button className={compareView === "only-local" ? "active" : ""} onClick={() => setCompareView("only-local")} title="只显示远程不存在的本地项目">
                  仅本地
                </button>
                <button className={compareView === "only-remote" ? "active" : ""} onClick={() => setCompareView("only-remote")} title="只显示本地不存在的远程项目">
                  仅远程
                </button>
                <button className={compareView === "different" ? "active" : ""} onClick={() => setCompareView("different")} title="只显示双侧都存在但元数据或内容特征不同的项目">
                  不同
                </button>
                <button onClick={copyDirectoryCompareCsv} disabled={directoryCompareCount === 0} title="复制当前目录对比 CSV 报告">
                  <Copy size={13} /> 复制 CSV
                </button>
                <button onClick={downloadDirectoryCompareCsv} disabled={directoryCompareCount === 0} title="下载当前目录对比 CSV 报告">
                  <Download size={13} /> 下载 CSV
                </button>
                <button onClick={copyDirectoryCompareJson} disabled={directoryCompareCount === 0} title="复制当前目录对比 JSON 报告">
                  <Copy size={13} /> 复制 JSON
                </button>
                <button onClick={downloadDirectoryCompareJson} disabled={directoryCompareCount === 0} title="下载当前目录对比 JSON 报告">
                  <Download size={13} /> 下载 JSON
                </button>
                <button onClick={copyDirectoryCompareDiffCsv} disabled={directoryCompareDiffCount === 0} title="复制仅包含差异项的目录对比 CSV">
                  <Copy size={13} /> 复制差异 CSV
                </button>
                <button onClick={downloadDirectoryCompareDiffCsv} disabled={directoryCompareDiffCount === 0} title="下载仅包含差异项的目录对比 CSV">
                  <Download size={13} /> 下载差异 CSV
                </button>
                <button
                  onClick={() => selectComparedEntries("local")}
                  disabled={directoryCompare.summary.onlyLocal + directoryCompare.summary.different === 0}
                  title="选择本地侧仅本地和不同项目"
                >
                  <ListChecks size={13} /> 选本地差异
                </button>
                <button
                  onClick={() => selectComparedEntries("remote")}
                  disabled={directoryCompare.summary.onlyRemote + directoryCompare.summary.different === 0}
                  title="选择远程侧仅远程和不同项目"
                >
                  <ListChecks size={13} /> 选远程差异
                </button>
                <button
                  onClick={() => selectComparedPairs("different")}
                  disabled={directoryCompare.summary.different === 0}
                  title="同时选择本地和远程两侧名称相同但元数据不同的项目"
                >
                  <ListChecks size={13} /> 选双侧不同
                </button>
                <button
                  onClick={() => syncComparedEntries("upload")}
                  disabled={
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    directoryCompare.summary.onlyLocal + directoryCompare.summary.different === 0
                  }
                  title="上传仅本地和不同项目"
                >
                  <Upload size={13} /> 上传差异
                </button>
                <button
                  onClick={() => syncComparedEntries("upload", "missing")}
                  disabled={!activeProfile || isLocalProtocol(activeProfile.protocol) || directoryCompare.summary.onlyLocal === 0}
                  title="只上传远程不存在的本地项目，不处理双侧不同项目"
                >
                  <Upload size={13} /> 上传仅本地
                </button>
                <button
                  onClick={() => syncComparedMetadata("upload")}
                  disabled={!activeProfile || isLocalProtocol(activeProfile.protocol) || directoryCompare.summary.different === 0}
                  title="仅把本地权限/时间等元数据应用到远程"
                >
                  <Settings size={13} /> 元数据到远程
                </button>
                <button
                  onClick={() => syncComparedEntries("download")}
                  disabled={
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    directoryCompare.summary.onlyRemote + directoryCompare.summary.different === 0
                  }
                  title="下载仅远程和不同项目"
                >
                  <Download size={13} /> 下载差异
                </button>
                <button
                  onClick={() => syncComparedEntries("download", "missing")}
                  disabled={!activeProfile || isLocalProtocol(activeProfile.protocol) || directoryCompare.summary.onlyRemote === 0}
                  title="只下载本地不存在的远程项目，不处理双侧不同项目"
                >
                  <Download size={13} /> 下载仅远程
                </button>
                <button
                  onClick={() => syncComparedMetadata("download")}
                  disabled={!activeProfile || isLocalProtocol(activeProfile.protocol) || directoryCompare.summary.different === 0}
                  title="仅把远程权限/时间等元数据应用到本地"
                >
                  <Settings size={13} /> 元数据到本地
                </button>
              </div>
            )}
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
              onSort={(key) => setLocalSort((current) => nextFileSort(current, key))}
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
              onInvertSelection={() => invertFileSelection("local")}
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
              contextActions={[
                {
                  label:
                    visibleSelectedLocal?.fileType === "symlink"
                      ? "定位链接目标"
                      : visibleSelectedLocal?.isDir
                        ? "打开目录"
                        : "打开/编辑",
                  icon: visibleSelectedLocal?.fileType === "symlink" ? <Link2 size={14} /> : visibleSelectedLocal?.isDir ? <Folder size={14} /> : <Edit3 size={14} />,
                  onClick: () =>
                    visibleSelectedLocal &&
                    (visibleSelectedLocal.isDir
                      ? navigateLocalPath(visibleSelectedLocal.path)
                      : visibleSelectedLocal.fileType === "symlink"
                        ? locateSymlinkTarget("local", visibleSelectedLocal)
                        : openLocalEditor(visibleSelectedLocal)),
                  disabled: !visibleSelectedLocal || visibleSelectedLocalEntries.length > 1
                },
                {
                  label: "上传到远程",
                  icon: <Upload size={14} />,
                  onClick: () => startTransfer("upload"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "上传本地差异",
                  icon: <FolderSync size={14} />,
                  onClick: () => syncComparedEntries("upload"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    directoryCompare.summary.onlyLocal + directoryCompare.summary.different === 0
                },
                {
                  label: "搜索",
                  icon: <Search size={14} />,
                  onClick: searchLocalFiles,
                  disabled: !localPath.trim()
                },
                { type: "separator" },
                { label: "新建文件", icon: <CirclePlus size={14} />, onClick: createLocalFile },
                { label: "新建目录", icon: <FolderPlus size={14} />, onClick: () => makeDir("local") },
                { label: "软链接", icon: <Link2 size={14} />, onClick: createLocalSymlink, disabled: !localPath.trim() },
                { type: "separator" },
                {
                  label: "复制",
                  icon: <Copy size={14} />,
                  onClick: duplicateLocalSelected,
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "移动到",
                  icon: <MoveRight size={14} />,
                  onClick: moveLocalSelected,
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                { type: "separator" },
                {
                  label: visibleSelectedLocalEntries.length > 1 ? "批量重命名" : "重命名",
                  icon: <Edit3 size={14} />,
                  onClick: () => renameSelected("local"),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "删除",
                  icon: <Trash2 size={14} />,
                  onClick: () => removeSelected("local"),
                  disabled: visibleSelectedLocalEntries.length === 0,
                  danger: true
                },
                { type: "separator" },
                {
                  label: "复制路径",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedPaths("local"),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "复制名称",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedNames("local"),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "复制父目录路径",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedParentPaths("local"),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "复制相对路径",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedRelativePaths("local"),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "复制文件信息",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedFileInfo("local"),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "复制 CSV 清单",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedFileInfoCsv("local"),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "下载 CSV 清单",
                  icon: <Download size={14} />,
                  onClick: () => downloadSelectedFileInfoCsv("local"),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "复制当前目录 CSV",
                  icon: <Copy size={14} />,
                  onClick: () => copyCurrentDirectoryFileInfoCsv("local"),
                  disabled: localFiles.length === 0
                },
                {
                  label: "下载当前目录 CSV",
                  icon: <Download size={14} />,
                  onClick: () => downloadCurrentDirectoryFileInfoCsv("local"),
                  disabled: localFiles.length === 0
                },
                {
                  label: "复制链接目标",
                  icon: <Link2 size={14} />,
                  onClick: () => copySelectedLinkTargets("local"),
                  disabled: !visibleSelectedLocalEntries.some((entry) => entry.linkTarget)
                },
                {
                  label: "复制 SHA-256",
                  icon: <Calculator size={14} />,
                  onClick: () => copySelectedSha256("local"),
                  disabled: !visibleSelectedLocalEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "复制 SHA-256 CSV",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedSha256Csv("local"),
                  disabled: !visibleSelectedLocalEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "下载 SHA-256 CSV",
                  icon: <Download size={14} />,
                  onClick: () => downloadSelectedSha256Csv("local"),
                  disabled: !visibleSelectedLocalEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "复制 SHA-256 JSON",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedSha256Json("local"),
                  disabled: !visibleSelectedLocalEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "下载 SHA-256 JSON",
                  icon: <Download size={14} />,
                  onClick: () => downloadSelectedSha256Json("local"),
                  disabled: !visibleSelectedLocalEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "复制 chmod 命令",
                  icon: <ShieldCheck size={14} />,
                  onClick: () => copyChmodCommands("local"),
                  disabled: !visibleSelectedLocalEntries.some((entry) => entry.permissions != null && entry.fileType !== "symlink")
                },
                {
                  label: "复制 touch 命令",
                  icon: <Clock size={14} />,
                  onClick: () => copyTouchCommands("local"),
                  disabled: !visibleSelectedLocalEntries.some((entry) => entry.fileType !== "symlink" && touchTimestamp(entry.modifiedAt))
                },
                {
                  label: "复制 scp 上传命令",
                  icon: <Monitor size={14} />,
                  onClick: () => copyScpCommands("upload"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "复制 rsync 上传命令",
                  icon: <FolderSync size={14} />,
                  onClick: () => copyRsyncCommands("upload"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "复制 rsync 上传预演",
                  icon: <FolderSync size={14} />,
                  onClick: () => copyRsyncCommands("upload", true),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "本地终端进入此目录",
                  icon: <Monitor size={14} />,
                  onClick: openLocalShellHere,
                  disabled: !localPath.trim() || visibleSelectedLocalEntries.length > 1
                },
                {
                  label: "在资源管理器中显示",
                  icon: <Crosshair size={14} />,
                  onClick: revealLocalSelected,
                  disabled: !visibleSelectedLocal || visibleSelectedLocalEntries.length > 1
                },
                {
                  label: "编辑文件",
                  icon: <Edit3 size={14} />,
                  onClick: () => openLocalEditor(visibleSelectedLocal),
                  disabled: !canEditTextFile(visibleSelectedLocal) || visibleSelectedLocalEntries.length > 1
                },
                {
                  label: "查看末尾",
                  icon: <Eye size={14} />,
                  onClick: () => openLocalEditor(visibleSelectedLocal, "tail"),
                  disabled: !canEditTextFile(visibleSelectedLocal) || visibleSelectedLocalEntries.length > 1
                },
                {
                  label: "属性",
                  icon: <Settings size={14} />,
                  onClick: () => openPropertiesDialog("local", visibleSelectedLocal, visibleSelectedLocalEntries),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                {
                  label: "权限",
                  icon: <ShieldCheck size={14} />,
                  onClick: () => openChmodDialog("local", visibleSelectedLocal, visibleSelectedLocalEntries),
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                { type: "separator" },
                {
                  label: "全选",
                  icon: <ListChecks size={14} />,
                  onClick: () => selectAllFiles("local"),
                  disabled: visibleLocalFiles.length === 0
                },
                {
                  label: "反选",
                  icon: <Check size={14} />,
                  onClick: () => invertFileSelection("local"),
                  disabled: visibleLocalFiles.length === 0
                },
                {
                  label: "清空选择",
                  icon: <ListX size={14} />,
                  onClick: clearLocalSelection,
                  disabled: visibleSelectedLocalEntries.length === 0
                },
                { label: "刷新", icon: <RefreshCcw size={14} />, onClick: refreshLocalFiles }
              ]}
              extraActions={
                <>
                  <IconButton
                    title="新建文件"
                    icon={<CirclePlus size={14} />}
                    onClick={createLocalFile}
                    disabled={!localPath.trim()}
                  />
                  <IconButton
                    title={showLocalHidden ? "隐藏隐藏项" : "显示隐藏项"}
                    icon={showLocalHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    onClick={() => setShowLocalHidden((current) => !current)}
                  />
                  <IconButton
                    title="搜索"
                    icon={<Search size={14} />}
                    onClick={searchLocalFiles}
                    disabled={!localPath.trim()}
                  />
                  <IconButton
                    title="上传"
                    icon={<Upload size={14} />}
                    onClick={() => startTransfer("upload")}
                    disabled={visibleSelectedLocalEntries.length === 0}
                  />
                </>
              }
            />
            <div className="file-pane-anchor file-pane-remote-anchor" ref={remoteFilePaneRef}>
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
                onSort={(key) => setRemoteSort((current) => nextFileSort(current, key))}
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
                onInvertSelection={() => invertFileSelection("remote")}
                onClearSelection={clearRemoteSelection}
                onBookmarkCurrent={() => addPathBookmark("remote")}
                onOpenBookmark={(path) => openPathBookmark("remote", path)}
                onRemoveBookmark={(path) => removePathBookmark("remote", path)}
                contextActions={[
                {
                  label:
                    visibleSelectedRemote?.fileType === "symlink"
                      ? "定位链接目标"
                      : visibleSelectedRemote?.isDir
                        ? "打开目录"
                        : "打开/编辑",
                  icon: visibleSelectedRemote?.fileType === "symlink" ? <Link2 size={14} /> : visibleSelectedRemote?.isDir ? <Folder size={14} /> : <Edit3 size={14} />,
                  onClick: () =>
                    visibleSelectedRemote &&
                    (visibleSelectedRemote.isDir
                      ? navigateRemotePath(visibleSelectedRemote.path)
                      : visibleSelectedRemote.fileType === "symlink"
                        ? locateSymlinkTarget("remote", visibleSelectedRemote)
                        : openRemoteEditor(visibleSelectedRemote)),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemote ||
                    visibleSelectedRemoteEntries.length > 1
                },
                {
                  label: "下载到本地",
                  icon: <Download size={14} />,
                  onClick: () => startTransfer("download"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "下载远程差异",
                  icon: <FolderSync size={14} />,
                  onClick: () => syncComparedEntries("download"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    directoryCompare.summary.onlyRemote + directoryCompare.summary.different === 0
                },
                { type: "separator" },
                {
                  label: "新建文件",
                  icon: <CirclePlus size={14} />,
                  onClick: createRemoteFile,
                  disabled: !activeProfile || isLocalProtocol(activeProfile.protocol)
                },
                {
                  label: "新建目录",
                  icon: <FolderPlus size={14} />,
                  onClick: () => makeDir("remote"),
                  disabled: !activeProfile || isLocalProtocol(activeProfile.protocol)
                },
                {
                  label: "新建软链接",
                  icon: <Link2 size={14} />,
                  onClick: createRemoteSymlink,
                  disabled: !activeProfile || isLocalProtocol(activeProfile.protocol)
                },
                { type: "separator" },
                {
                  label: "复制",
                  icon: <Copy size={14} />,
                  onClick: duplicateRemoteSelected,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "移动到",
                  icon: <MoveRight size={14} />,
                  onClick: moveRemoteSelected,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: visibleSelectedRemoteEntries.length > 1 ? "批量重命名" : "重命名",
                  icon: <Edit3 size={14} />,
                  onClick: () => renameSelected("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                { type: "separator" },
                {
                  label: "编辑文件",
                  icon: <Edit3 size={14} />,
                  onClick: () => openRemoteEditor(visibleSelectedRemote),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !canEditTextFile(visibleSelectedRemote) ||
                    visibleSelectedRemoteEntries.length > 1
                },
                {
                  label: "查看末尾",
                  icon: <Eye size={14} />,
                  onClick: () => openRemoteEditor(visibleSelectedRemote, "tail"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !canEditTextFile(visibleSelectedRemote) ||
                    visibleSelectedRemoteEntries.length > 1
                },
                { type: "separator" },
                {
                  label: "定位所在目录",
                  icon: <Crosshair size={14} />,
                  onClick: locateRemoteSelected,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemote ||
                    visibleSelectedRemoteEntries.length > 1
                },
                {
                  label: "复制路径",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedPaths("remote"),
                  disabled: visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制名称",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedNames("remote"),
                  disabled: visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制父目录路径",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedParentPaths("remote"),
                  disabled: visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制相对路径",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedRelativePaths("remote"),
                  disabled: visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制文件信息",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedFileInfo("remote"),
                  disabled: visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制 CSV 清单",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedFileInfoCsv("remote"),
                  disabled: visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "下载 CSV 清单",
                  icon: <Download size={14} />,
                  onClick: () => downloadSelectedFileInfoCsv("remote"),
                  disabled: visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制当前目录 CSV",
                  icon: <Copy size={14} />,
                  onClick: () => copyCurrentDirectoryFileInfoCsv("remote"),
                  disabled: remoteFiles.length === 0
                },
                {
                  label: "下载当前目录 CSV",
                  icon: <Download size={14} />,
                  onClick: () => downloadCurrentDirectoryFileInfoCsv("remote"),
                  disabled: remoteFiles.length === 0
                },
                {
                  label: "复制链接目标",
                  icon: <Link2 size={14} />,
                  onClick: () => copySelectedLinkTargets("remote"),
                  disabled: !visibleSelectedRemoteEntries.some((entry) => entry.linkTarget)
                },
                {
                  label: "复制 ln -s 命令",
                  icon: <Link2 size={14} />,
                  onClick: copyRemoteSymlinkCommands,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => entry.fileType === "symlink" && entry.linkTarget?.trim())
                },
                {
                  label: "复制 SHA-256",
                  icon: <Calculator size={14} />,
                  onClick: () => copySelectedSha256("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "复制 SHA-256 CSV",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedSha256Csv("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "下载 SHA-256 CSV",
                  icon: <Download size={14} />,
                  onClick: () => downloadSelectedSha256Csv("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "复制 SHA-256 JSON",
                  icon: <Copy size={14} />,
                  onClick: () => copySelectedSha256Json("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "下载 SHA-256 JSON",
                  icon: <Download size={14} />,
                  onClick: () => downloadSelectedSha256Json("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "复制 stat 命令",
                  icon: <Settings size={14} />,
                  onClick: copyRemoteStatCommands,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制 sha256sum 命令",
                  icon: <Calculator size={14} />,
                  onClick: copyRemoteSha256Commands,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => !entry.isDir && entry.fileType !== "symlink")
                },
                {
                  label: "复制 du 命令",
                  icon: <Calculator size={14} />,
                  onClick: copyRemoteDuCommands,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制 ls -ld 命令",
                  icon: <ListChecks size={14} />,
                  onClick: copyRemoteListCommands,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制 chmod 命令",
                  icon: <ShieldCheck size={14} />,
                  onClick: () => copyChmodCommands("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => entry.permissions != null && entry.fileType !== "symlink")
                },
                {
                  label: "复制 chown 命令",
                  icon: <ShieldCheck size={14} />,
                  onClick: copyChownCommands,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some(
                      (entry) => entry.fileType !== "symlink" && (entry.uid != null || entry.gid != null)
                    )
                },
                {
                  label: "复制 touch 命令",
                  icon: <Clock size={14} />,
                  onClick: () => copyTouchCommands("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    !visibleSelectedRemoteEntries.some((entry) => entry.fileType !== "symlink" && touchTimestamp(entry.modifiedAt))
                },
                {
                  label: "复制删除命令",
                  icon: <Trash2 size={14} />,
                  onClick: copyRemoteDeleteCommands,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制 SFTP 地址",
                  icon: <Link2 size={14} />,
                  onClick: copyRemoteUris,
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制 scp 下载命令",
                  icon: <Monitor size={14} />,
                  onClick: () => copyScpCommands("download"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制 rsync 下载命令",
                  icon: <FolderSync size={14} />,
                  onClick: () => copyRsyncCommands("download"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "复制 rsync 下载预演",
                  icon: <FolderSync size={14} />,
                  onClick: () => copyRsyncCommands("download", true),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "终端进入此目录",
                  icon: <Monitor size={14} />,
                  onClick: sendRemotePathToTerminal,
                  disabled:
                    !activeProfile ||
                    !isSshProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length > 1
                },
                {
                  label: "搜索",
                  icon: <Search size={14} />,
                  onClick: searchRemoteFiles,
                  disabled: !activeProfile || isLocalProtocol(activeProfile.protocol)
                },
                {
                  label: "属性",
                  icon: <Settings size={14} />,
                  onClick: () => openPropertiesDialog("remote", visibleSelectedRemote, visibleSelectedRemoteEntries),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "权限",
                  icon: <ShieldCheck size={14} />,
                  onClick: () => openChmodDialog("remote", visibleSelectedRemote, visibleSelectedRemoteEntries),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0
                },
                { type: "separator" },
                {
                  label: "删除",
                  icon: <Trash2 size={14} />,
                  onClick: () => removeSelected("remote"),
                  disabled:
                    !activeProfile ||
                    isLocalProtocol(activeProfile.protocol) ||
                    visibleSelectedRemoteEntries.length === 0,
                  danger: true
                },
                {
                  label: "全选",
                  icon: <ListChecks size={14} />,
                  onClick: () => selectAllFiles("remote"),
                  disabled: visibleRemoteFiles.length === 0
                },
                {
                  label: "反选",
                  icon: <Check size={14} />,
                  onClick: () => invertFileSelection("remote"),
                  disabled: visibleRemoteFiles.length === 0
                },
                {
                  label: "清空选择",
                  icon: <ListX size={14} />,
                  onClick: clearRemoteSelection,
                  disabled: visibleSelectedRemoteEntries.length === 0
                },
                {
                  label: "刷新",
                  icon: <RefreshCcw size={14} />,
                  onClick: refreshRemoteFiles,
                  disabled: !activeProfile || isLocalProtocol(activeProfile.protocol)
                }
              ]}
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
              extraActions={
                <>
                  <IconButton
                    title={showRemoteHidden ? "隐藏隐藏项" : "显示隐藏项"}
                    icon={showRemoteHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    onClick={() => setShowRemoteHidden((current) => !current)}
                  />
                  <IconButton
                    title="新建文件"
                    icon={<CirclePlus size={14} />}
                    onClick={createRemoteFile}
                    disabled={!activeProfile || isLocalProtocol(activeProfile.protocol)}
                  />
                  <IconButton
                    title="搜索"
                    icon={<Search size={14} />}
                    onClick={searchRemoteFiles}
                    disabled={!activeProfile || isLocalProtocol(activeProfile.protocol)}
                  />
                  <IconButton
                    title="下载"
                    icon={<Download size={14} />}
                    onClick={() => startTransfer("download")}
                    disabled={visibleSelectedRemoteEntries.length === 0}
                  />
                </>
              }
            />
            </div>
          </section>

            </>
          )}
        </aside>
      </main>

      {dialog === "quick" && (
        <QuickDialog
          value={quick}
          onChange={setQuick}
          onClose={() => setDialog(null)}
          onConnect={connectQuick}
        />
      )}

      {dialog === "secret" && secretProfile && (
        <SecretDialog
          profile={secretProfile}
          password={profileSecretDrafts[secretProfile.id] ?? ""}
          onPassword={(password) =>
            setProfileSecretDrafts((current) => ({
              ...current,
              [secretProfile.id]: password
            }))
          }
          onClose={() => {
            setDialog(null);
            setSecretProfileId(null);
          }}
          onConnect={connectSecretProfile}
        />
      )}

      {dialog === "profile" && editingProfile && (
        <ProfileDialog
          profile={editingProfile}
          onChange={setEditingProfile}
          onClose={() => setDialog(null)}
          onSave={saveProfile}
          onPickKeyFile={pickProfileKeyFile}
        />
      )}

      {dialog === "settings" && (
        <SettingsDialog
          settings={settings}
          onChange={setSettings}
          onClose={() => setDialog(null)}
          onHostKeys={openKnownHostsManager}
          onSave={saveSettings}
        />
      )}

      {dialog === "hostkeys" && (
        <KnownHostsDialog
          content={knownHostsText}
          onChange={setKnownHostsText}
          onClose={() => setDialog(null)}
          onClear={clearKnownHosts}
          onSave={saveKnownHosts}
        />
      )}

      {dialog === "chmod" && chmodTarget && (
        <ChmodDialog
          entry={chmodTarget}
          side={chmodSide}
          targetCount={chmodTargets.length || 1}
          hasDirectory={(chmodTargets.length ? chmodTargets : [chmodTarget]).some((target) => target.isDir)}
          mode={chmodMode}
          recursive={chmodRecursive}
          onMode={setChmodMode}
          onRecursive={setChmodRecursive}
          onClose={() => setDialog(null)}
          onApply={applyChmod}
        />
      )}

      {dialog === "batchRename" && batchRenameTargets.length > 0 && (
        <BatchRenameDialog
          side={batchRenameSide}
          entries={batchRenameTargets}
          existingEntries={batchRenameSide === "local" ? localFiles : remoteFiles}
          find={batchRenameFind}
          replace={batchRenameReplace}
          prefix={batchRenamePrefix}
          suffix={batchRenameSuffix}
          numberStart={batchRenameNumberStart}
          numberPadding={batchRenameNumberPadding}
          preserveExtension={batchRenamePreserveExtension}
          caseSensitive={batchRenameCaseSensitive}
          onFind={setBatchRenameFind}
          onReplace={setBatchRenameReplace}
          onPrefix={setBatchRenamePrefix}
          onSuffix={setBatchRenameSuffix}
          onNumberStart={setBatchRenameNumberStart}
          onNumberPadding={setBatchRenameNumberPadding}
          onPreserveExtension={setBatchRenamePreserveExtension}
          onCaseSensitive={setBatchRenameCaseSensitive}
          onClose={() => setDialog(null)}
          onApply={applyBatchRename}
        />
      )}

      {dialog === "deleteConfirm" && deleteConfirm && (
        <DeleteConfirmDialog
          side={deleteConfirm.side}
          entries={deleteConfirm.entries}
          onCopyCsv={copyDeleteConfirmCsv}
          onDownloadCsv={downloadDeleteConfirmCsv}
          onCopyJson={copyDeleteConfirmJson}
          onDownloadJson={downloadDeleteConfirmJson}
          onClose={() => {
            setDialog(null);
            setDeleteConfirm(null);
          }}
          onConfirm={confirmDeleteSelected}
        />
      )}

      {dialog === "syncPlan" && syncPlan && (
        <SyncPlanDialog
          plan={syncPlan}
          conflict={syncPlan.conflictStrategy ?? transferConflict}
          onShowTextDialog={showTextDialog}
          onClose={() => {
            setDialog(null);
            setSyncPlan(null);
          }}
          onConfirm={executeSyncPlan}
        />
      )}

      {dialog === "transfers" && (
        <div className="modal-backdrop">
          <div className="modal modal-wide transfer-dialog">
            <div className="modal-title">
              传输队列
              <button onClick={() => setDialog(null)} title="关闭">
                <X size={14} />
              </button>
            </div>
            {transferQueuePanel}
          </div>
        </div>
      )}

      {dialog === "properties" && propertiesTarget && (
        <PropertiesDialog
          side={propertiesSide}
          entry={propertiesTarget}
          targetCount={propertiesTargets.length || 1}
          hasDirectory={(propertiesTargets.length ? propertiesTargets : [propertiesTarget]).some((target) => target.isDir)}
          uid={propertiesUid}
          gid={propertiesGid}
          mode={propertiesMode}
          mtime={propertiesMtime}
          stats={propertiesStats}
          statsLoading={propertiesStatsLoading}
          checksum={propertiesChecksum}
          checksumLoading={propertiesChecksumLoading}
          recursive={propertiesRecursive}
          onUid={setPropertiesUid}
          onGid={setPropertiesGid}
          onMode={setPropertiesMode}
          onMtime={setPropertiesMtime}
          onCalculateStats={calculatePropertiesStats}
          onCalculateChecksum={calculatePropertiesChecksum}
          onCopyReport={copyPropertiesReport}
          onCopyCsv={copyPropertiesCsv}
          onDownloadCsv={downloadPropertiesCsv}
          onCopyJson={copyPropertiesJson}
          onDownloadJson={downloadPropertiesJson}
          onRecursive={setPropertiesRecursive}
          onClose={() => setDialog(null)}
          onApply={applyProperties}
        />
      )}

      {dialog === "editor" && editorFile && (
        <TextEditorDialog
          side={editorSide}
          file={editorFile}
          position={editorPreviewPosition}
          content={editorContent}
          onContent={setEditorContent}
          onClose={() => setDialog(null)}
          onLoadHead={() => loadEditorPreview("head")}
          onLoadTail={() => loadEditorPreview("tail")}
          onSave={saveEditor}
        />
      )}

      {hostKeyPrompt && (
        <HostKeyDialog
          issue={hostKeyPrompt.issue}
          onClose={() => setHostKeyPrompt(null)}
          onAccept={acceptHostKey}
        />
      )}

      {appModal && <AppModalDialog modal={appModal} onResolve={resolveAppModal} />}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );

  function openProfileEditor(profile?: Profile) {
    if (!profile) {
      setEditingProfile(createBlankProfile());
      setDialog("profile");
      return;
    }

    const normalized = normalizeProfile(profile);
    setEditingProfile({
      ...normalized,
      password: profileSecretDrafts[normalized.id] ?? profileSecrets[normalized.id] ?? normalized.password ?? ""
    });
    setDialog("profile");
  }
}

function XtermView({
  terminal,
  settings,
  active,
  onDrain,
  onReplayConsumed
}: {
  terminal: TerminalView;
  settings: AppSettings;
  active: boolean;
  onDrain: (drain: TerminalDrain) => void;
  onReplayConsumed: (terminalId: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalMountRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarHideRef = useRef<number | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sendBufferRef = useRef("");
  const sendScheduledRef = useRef(false);
  const resizeFrameRef = useRef<number | null>(null);
  const lastHostSizeRef = useRef({ width: 0, height: 0 });
  const lastTermSizeRef = useRef({ cols: 0, rows: 0 });
  const onDrainRef = useRef(onDrain);

  useEffect(() => {
    onDrainRef.current = onDrain;
  }, [onDrain]);

  const updateTerminalScrollbar = useCallback((show = false) => {
    const host = hostRef.current;
    const rail = terminalScrollbarRef.current;
    const thumb = terminalScrollbarThumbRef.current;
    const viewport = host?.querySelector<HTMLElement>(".xterm-viewport");
    if (!host || !rail || !thumb || !viewport) return;

    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const railHeight = rail.clientHeight;
    if (maxScroll <= 1 || railHeight <= 0) {
      host.classList.add("terminal-scrollbar-disabled");
      host.classList.remove("terminal-scrollbar-active");
      return;
    }

    host.classList.remove("terminal-scrollbar-disabled");
    const thumbHeight = clampNumber(Math.round((viewport.clientHeight / viewport.scrollHeight) * railHeight), 28, railHeight);
    const thumbTop = Math.round((viewport.scrollTop / maxScroll) * (railHeight - thumbHeight));
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;

    if (!show) return;
    host.classList.add("terminal-scrollbar-active");
    if (terminalScrollbarHideRef.current !== null) {
      window.clearTimeout(terminalScrollbarHideRef.current);
    }
    terminalScrollbarHideRef.current = window.setTimeout(() => {
      host.classList.remove("terminal-scrollbar-active");
      terminalScrollbarHideRef.current = null;
    }, 760);
  }, []);

  const handleTerminalScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    const rail = terminalScrollbarRef.current;
    const thumb = terminalScrollbarThumbRef.current;
    const viewport = host?.querySelector<HTMLElement>(".xterm-viewport");
    if (!host || !rail || !thumb || !viewport) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const railRect = rail.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const maxThumbTop = railRect.height - thumbRect.height;
    const pointerOffset = event.target === thumb ? event.clientY - thumbRect.top : thumbRect.height / 2;

    const applyScroll = (clientY: number) => {
      if (maxScroll <= 0 || maxThumbTop <= 0) return;
      const nextTop = clampNumber(clientY - railRect.top - pointerOffset, 0, maxThumbTop);
      viewport.scrollTop = (nextTop / maxThumbTop) * maxScroll;
      updateTerminalScrollbar(true);
    };

    const handleMove = (moveEvent: globalThis.PointerEvent) => applyScroll(moveEvent.clientY);
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    applyScroll(event.clientY);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  useEffect(() => {
    if (!hostRef.current || !terminalMountRef.current) return;
    let disposed = false;
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "Cascadia Mono, Consolas, Microsoft YaHei UI, monospace",
      fontSize: settings.fontSize,
      lineHeight: 1.18,
      scrollback: settings.scrollback,
      theme: xtermTheme(settings.theme)
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalMountRef.current);
    const initialReplay = terminal.text;
    if (initialReplay) {
      term.write(initialReplay);
      onReplayConsumed(terminal.id);
    }
    if (active) term.focus();

    const viewport = hostRef.current.querySelector<HTMLElement>(".xterm-viewport");
    const handleViewportScroll = () => updateTerminalScrollbar(true);
    viewport?.addEventListener("scroll", handleViewportScroll, { passive: true });
    const scrollDisposable = term.onScroll(() => updateTerminalScrollbar(true));

    const flushInput = () => {
      sendScheduledRef.current = false;
      if (!sendBufferRef.current) return;
      const payload = sendBufferRef.current;
      sendBufferRef.current = "";
      if (disposed) return;
      api.terminalSend(terminal.id, payload).catch(() => undefined);
    };

    term.onData((data) => {
      sendBufferRef.current += data;
      if (!sendScheduledRef.current) {
        sendScheduledRef.current = true;
        queueMicrotask(flushInput);
      }
    });
    termRef.current = term;
    fitRef.current = fit;
    lastHostSizeRef.current = { width: 0, height: 0 };
    lastTermSizeRef.current = { cols: 0, rows: 0 };

    const fitAndResize = () => {
      resizeFrameRef.current = null;
      if (disposed || !hostRef.current) return;

      const fitElement = hostRef.current.querySelector<HTMLElement>(".xterm") ?? hostRef.current;
      const rect = fitElement.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width <= 0 || height <= 0) return;

      if (lastHostSizeRef.current.width === width && lastHostSizeRef.current.height === height) {
        return;
      }
      lastHostSizeRef.current = { width, height };

      fit.fit();
      if (lastTermSizeRef.current.cols !== term.cols || lastTermSizeRef.current.rows !== term.rows) {
        lastTermSizeRef.current = { cols: term.cols, rows: term.rows };
        api.terminalResize(terminal.id, term.cols, term.rows).catch(() => undefined);
      }
      updateTerminalScrollbar();
    };

    const scheduleResize = () => {
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(fitAndResize);
    };

    const observer = new ResizeObserver(scheduleResize);
    observer.observe(hostRef.current);
    const xtermElement = hostRef.current.querySelector<HTMLElement>(".xterm");
    if (xtermElement) {
      observer.observe(xtermElement);
    }
    if (viewport) {
      observer.observe(viewport);
    }
    scheduleResize();
    updateTerminalScrollbar();

    return () => {
      disposed = true;
      viewport?.removeEventListener("scroll", handleViewportScroll);
      scrollDisposable.dispose();
      observer.disconnect();
      if (terminalScrollbarHideRef.current !== null) {
        window.clearTimeout(terminalScrollbarHideRef.current);
        terminalScrollbarHideRef.current = null;
      }
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (sendBufferRef.current) {
        const payload = sendBufferRef.current;
        sendBufferRef.current = "";
        api.terminalSend(terminal.id, payload).catch(() => undefined);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminal.id, onReplayConsumed, updateTerminalScrollbar]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = settings.fontSize;
    term.options.scrollback = settings.scrollback;
    term.options.theme = xtermTheme(settings.theme);
    const frame = window.requestAnimationFrame(() => {
      if (!termRef.current || !fitRef.current) return;
      fitRef.current.fit();
      if (lastTermSizeRef.current.cols !== termRef.current.cols || lastTermSizeRef.current.rows !== termRef.current.rows) {
        lastTermSizeRef.current = { cols: termRef.current.cols, rows: termRef.current.rows };
        api.terminalResize(terminal.id, termRef.current.cols, termRef.current.rows).catch(() => undefined);
      }
      updateTerminalScrollbar();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [settings.fontSize, settings.scrollback, settings.theme, terminal.id, updateTerminalScrollbar]);

  useEffect(() => {
    if (!active || !hostRef.current || !termRef.current || !fitRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (!hostRef.current || !termRef.current || !fitRef.current) return;
      const fitElement = hostRef.current.querySelector<HTMLElement>(".xterm") ?? hostRef.current;
      const rect = fitElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      fitRef.current.fit();
      updateTerminalScrollbar();
      termRef.current.focus();
      api.terminalResize(terminal.id, termRef.current.cols, termRef.current.rows).catch(() => undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, terminal.id, updateTerminalScrollbar]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let lastStatus = terminal.status;
    let lastError = terminal.lastError ?? "";
    let lastHostKey = terminal.hostKeyIssue?.fingerprint ?? "";
    let lastDirectory = terminal.currentDirectory ?? "";

    const drainLoop = async () => {
      let nextDelay = 12;
      try {
        const drain = await api.terminalDrain(terminal.id);
        if (drain.output) {
          termRef.current?.write(drain.output);
        }
        const nextError = drain.lastError ?? "";
        const nextHostKey = drain.hostKeyIssue?.fingerprint ?? "";
        const nextDirectory = drain.currentDirectory ?? "";
        const metadataChanged =
          drain.status !== lastStatus ||
          nextError !== lastError ||
          nextHostKey !== lastHostKey ||
          nextDirectory !== lastDirectory;
        if (drain.output) {
          nextDelay = 0;
        }
        if (metadataChanged) {
          nextDelay = 0;
          lastStatus = drain.status;
          lastError = nextError;
          lastHostKey = nextHostKey;
          lastDirectory = nextDirectory;
          onDrainRef.current(drain);
        }
      } catch {
        stopped = true;
      }
      if (!stopped) {
        timer = window.setTimeout(drainLoop, nextDelay);
      }
    };

    timer = window.setTimeout(drainLoop, 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [terminal.id]);

  return (
    <div className={`xterm-host xterm-pane ${active ? "active" : ""}`} ref={hostRef}>
      <div className="xterm-mount" ref={terminalMountRef} />
      <div className="terminal-scrollbar" ref={terminalScrollbarRef} onPointerDown={handleTerminalScrollbarPointerDown}>
        <div className="terminal-scrollbar-thumb" ref={terminalScrollbarThumbRef} />
      </div>
    </div>
  );
}

function SessionTree({
  profiles,
  activeProfileId,
  onSelect,
  onConnect,
  onSecret,
  onEdit,
  onCopyCommand,
  onDuplicate,
  onDelete,
  onPromptText,
  onCreateProfile,
  onDeleteFolder
}: {
  profiles: Profile[];
  activeProfileId: string | null;
  onSelect: (profile: Profile) => void;
  onConnect: (profile: Profile) => void;
  onSecret: (profile: Profile) => void;
  onEdit: (profile: Profile) => void;
  onCopyCommand: (profile: Profile) => void;
  onDuplicate: (profile: Profile) => void;
  onDelete: (profile: Profile) => void;
  onPromptText: (title: string, options?: AppPromptOptions) => Promise<string | null>;
  onCreateProfile: (group: string) => void;
  onDeleteFolder: (group: string) => Promise<boolean>;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [customFolders, setCustomFolders] = useState<string[]>(loadSessionFolders);
  const tree = useMemo(() => buildSessionFolderTree(profiles, customFolders), [customFolders, profiles]);
  const toggleGroup = (group: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };
  const addFolder = async (parentPath: string) => {
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
  };
  const deleteFolder = async (path: string) => {
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
  };
  const openFolderContextMenu = (event: MouseEvent<HTMLButtonElement>, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    setFolderContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)),
      path
    });
  };
  const openContextMenu = (event: MouseEvent<HTMLButtonElement>, profile: Profile) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 250)),
      profile
    });
  };

  useEffect(() => {
    if (!contextMenu && !folderContextMenu) return;
    const close = () => {
      setContextMenu(null);
      setFolderContextMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu, folderContextMenu]);

  const contextActions = (profile: Profile): FileAction[] => [
    {
      label: "连接",
      icon: <Monitor size={14} />,
      onClick: () => onConnect(profile)
    },
    {
      label: "输入密码并连接",
      icon: <KeyRound size={14} />,
      onClick: () => onSecret(profile),
      disabled: isLocalProtocol(profile.protocol)
    },
    { type: "separator" },
    {
      label: "属性",
      icon: <Settings size={14} />,
      onClick: () => onEdit(profile)
    },
    {
      label: "复制连接命令",
      icon: <Copy size={14} />,
      onClick: () => onCopyCommand(profile)
    },
    {
      label: "复制会话",
      icon: <Copy size={14} />,
      onClick: () => onDuplicate(profile)
    },
    { type: "separator" },
    {
      label: "删除",
      icon: <Trash2 size={14} />,
      onClick: () => onDelete(profile),
      danger: true
    }
  ];
  const folderActions = (path: string): FileAction[] => [
    {
      label: "新建目录",
      icon: <FolderPlus size={14} />,
      onClick: () => addFolder(path)
    },
    {
      label: "新建连接",
      icon: <Cable size={14} />,
      onClick: () => onCreateProfile(path)
    },
    { type: "separator" },
    {
      label: "删除目录",
      icon: <Trash2 size={14} />,
      onClick: () => {
        void deleteFolder(path);
      },
      disabled: isProtectedSessionFolder(path),
      danger: true
    }
  ];

  const renderFolder = (node: SessionFolderNode, depth = 0): ReactNode => {
    const collapsed = collapsedGroups.has(node.path);
    return (
      <div key={node.path} className={`session-group ${collapsed ? "collapsed" : ""}`}>
        <button
          className="group-title"
          style={{ "--tree-depth": depth } as CSSProperties}
          onClick={() => toggleGroup(node.path)}
          onContextMenu={(event) => openFolderContextMenu(event, node.path)}
          title={collapsed ? "展开目录" : "收起目录"}
        >
          <ChevronRight size={11} />
          <Folder size={12} />
          <span>{node.name}</span>
        </button>
        {!collapsed && (
          <>
            {node.profiles.map((profile) => (
              <button
                key={profile.id}
                className={`session-item ${profile.id === activeProfileId ? "active" : ""}`}
                style={{ "--tree-depth": depth + 1 } as CSSProperties}
                onDoubleClick={() => onConnect(profile)}
                onClick={() => onSelect(profile)}
                onContextMenu={(event) => openContextMenu(event, profile)}
              >
                <span className="session-dot" style={{ background: color(profile.color) }} />
                <span className="session-main">
                  <span className="session-name">{profile.name}</span>
                  <span className="session-last">{formatLastConnected(profile.lastConnectedAt)}</span>
                </span>
                <span className="session-protocol">{normalizeProtocolLabel(profile.protocol)}</span>
              </button>
            ))}
            {node.children.map((child) => renderFolder(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="session-tree">
      {tree.map((node) => renderFolder(node))}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={contextActions(contextMenu.profile)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {folderContextMenu && (
        <FileContextMenu
          x={folderContextMenu.x}
          y={folderContextMenu.y}
          actions={folderActions(folderContextMenu.path)}
          onClose={() => setFolderContextMenu(null)}
        />
      )}
    </div>
  );
}

function FilePane({
  side,
  title,
  path,
  files,
  compareMarks,
  selected,
  selectedPaths,
  selectionCount,
  sort,
  filter,
  bookmarks,
  onPath,
  onFilter,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dropActive,
  onSort,
  onOpen,
  onBack,
  onForward,
  canBack,
  canForward,
  onHome,
  onParent,
  onRefresh,
  onMkdir,
  onRename,
  onRemove,
  onSelectAll,
  onInvertSelection,
  onClearSelection,
  onBookmarkCurrent,
  onOpenBookmark,
  onRemoveBookmark,
  contextActions,
  notice,
  extraActions
}: {
  side: FileSide;
  title: string;
  path: string;
  files: FileEntry[];
  compareMarks: Map<string, FileCompareMark>;
  selected: FileEntry | null;
  selectedPaths: string[];
  selectionCount: number;
  sort: FileSort;
  filter: string;
  bookmarks: PathBookmark[];
  onPath: (path: string) => void;
  onFilter: (filter: string) => void;
  onSelect: (file: FileEntry, event: MouseEvent<HTMLButtonElement>) => void;
  onDragStart: (file: FileEntry, event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  dropActive: boolean;
  onSort: (key: FileSortKey) => void;
  onOpen: (file: FileEntry) => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  onHome: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onMkdir: () => void;
  onRename: () => void;
  onRemove: () => void;
  onSelectAll: () => void;
  onInvertSelection: () => void;
  onClearSelection: () => void;
  onBookmarkCurrent: () => void;
  onOpenBookmark: (path: string) => void;
  onRemoveBookmark: (path: string) => void;
  contextActions: FileAction[];
  notice?: ReactNode;
  extraActions: ReactNode;
}) {
  const [pathDraft, setPathDraft] = useState(path);
  const [bookmarkPath, setBookmarkPath] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setPathDraft(path);
  }, [path]);

  useEffect(() => {
    if (bookmarkPath && !bookmarks.some((bookmark) => bookmark.path === bookmarkPath)) {
      setBookmarkPath("");
    }
  }, [bookmarkPath, bookmarks]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const openContextMenu = (event: MouseEvent, file?: FileEntry, alreadySelected = false) => {
    event.preventDefault();
    event.stopPropagation();
    if (file && !alreadySelected) {
      onSelect(file, event as MouseEvent<HTMLButtonElement>);
    }
    const width = 220;
    const height = Math.min(420, contextActions.length * 34 + 16);
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))
    });
  };

  const commitPath = () => {
    const next = pathDraft.trim();
    if (!next) {
      setPathDraft(path);
      return;
    }
    if (next === path) return;
    onPath(next);
  };

  return (
    <div
      className={`file-pane file-pane-${side} ${dropActive ? "drop-active" : ""}`}
      data-file-pane-side={side}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropActive && <div className="file-drop-hint">拖放到{side === "local" ? "本地下载" : "远程上传"}</div>}
      <div className="file-pane-head">
        <div className="file-pane-title">{title}</div>
        <div className="file-toolbar">
          <input
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPath();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setPathDraft(path);
              }
            }}
            onBlur={() => {
              if (!pathDraft.trim()) setPathDraft(path);
            }}
          />
          <IconButton title="跳转路径" icon={<MoveRight size={14} />} onClick={commitPath} disabled={!pathDraft.trim() || pathDraft === path} />
          <IconButton title="后退" icon={<ChevronLeft size={14} />} onClick={onBack} disabled={!canBack} />
          <IconButton title="前进" icon={<ChevronRight size={14} />} onClick={onForward} disabled={!canForward} />
          <IconButton title="主目录" icon={<Home size={14} />} onClick={onHome} />
          <IconButton title="上级目录" icon={<ArrowUp size={14} />} onClick={onParent} />
          <IconButton title="刷新" icon={<RefreshCcw size={14} />} onClick={onRefresh} />
          <IconButton title="新建目录" icon={<FolderPlus size={14} />} onClick={onMkdir} />
          <IconButton title={selectionCount > 1 ? "批量重命名" : "重命名"} icon={<Edit3 size={14} />} onClick={onRename} disabled={selectionCount === 0} />
          <IconButton title="删除" icon={<Trash2 size={14} />} onClick={onRemove} disabled={selectionCount === 0} />
          {extraActions}
        </div>
      </div>
      <div className="file-filter-bookmarks">
        <div className="file-filter">
          <Search size={13} />
          <input value={filter} onChange={(event) => onFilter(event.target.value)} placeholder="过滤当前列表" />
          <button onClick={() => onFilter("")} disabled={!filter}>
            <X size={13} />
          </button>
        </div>
        <div className="file-bookmarks">
          <AppSelect
            value={bookmarkPath}
            ariaLabel="收藏路径"
            options={[
              { value: "", label: "收藏路径" },
              ...bookmarks.map((bookmark) => ({ value: bookmark.path, label: bookmark.label }))
            ]}
            onChange={(next) => {
              setBookmarkPath(next);
              if (next) onOpenBookmark(next);
            }}
          />
          <IconButton
            title="收藏当前路径"
            icon={<BookmarkPlus size={14} />}
            onClick={onBookmarkCurrent}
            disabled={!path.trim()}
          />
          <IconButton
            title="移除收藏"
            icon={<BookmarkMinus size={14} />}
            onClick={() => {
              if (!bookmarkPath) return;
              onRemoveBookmark(bookmarkPath);
              setBookmarkPath("");
            }}
            disabled={!bookmarkPath}
          />
        </div>
      </div>
      {notice}
      <FileList
        files={files}
        compareMarks={compareMarks}
        selected={selected}
        selectedPaths={selectedPaths}
        sort={sort}
        onSelect={onSelect}
        onSort={onSort}
        onOpen={onOpen}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
        onRemove={onRemove}
        onRename={onRename}
        onContextMenu={openContextMenu}
      />
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={contextActions}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function SearchNotice({
  root,
  query,
  count,
  onClear
}: {
  root: string;
  query: string;
  count: number;
  onClear: () => void;
}) {
  return (
    <div className="file-search-notice">
      <Search size={13} />
      <span title={`${root} / ${query}`}>
        {query} · {count} 条
      </span>
      <button onClick={onClear} title="退出搜索">
        <X size={13} />
      </button>
    </div>
  );
}

function FileContextMenu({
  x,
  y,
  actions,
  onClose
}: {
  x: number;
  y: number;
  actions: FileAction[];
  onClose: () => void;
}) {
  return (
    <div className="file-context-menu" style={{ left: x, top: y }} onContextMenu={(event) => event.preventDefault()}>
      {actions.map((action, index) =>
        action.type === "separator" ? (
          <div key={`separator-${index}`} className="file-context-separator" />
        ) : (
          <button
            key={`${action.label}-${index}`}
            className={action.danger ? "danger" : ""}
            disabled={action.disabled}
            onClick={() => {
              onClose();
              action.onClick();
            }}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        )
      )}
    </div>
  );
}

function AppSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  className = ""
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const selected = options.find((option) => option.value === value) ?? options[0];

  const positionMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = Math.max(rect.width, 136);
    const estimatedHeight = Math.min(240, Math.max(32, options.length * 27 + 4));
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const openUp = below < estimatedHeight && above > below;
    const maxHeight = Math.max(80, Math.min(260, openUp ? above : below));
    const panelHeight = Math.min(estimatedHeight, maxHeight);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
    const top = openUp ? Math.max(8, rect.top - panelHeight - 4) : Math.min(window.innerHeight - 8, rect.bottom + 4);

    setMenuStyle({
      left,
      top,
      width: menuWidth,
      maxHeight
    });
  };

  const openMenu = () => {
    if (disabled) return;
    positionMenu();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={`app-select ${open ? "open" : ""} ${className}`} onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className="app-select-button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="app-select-value">{selected?.label ?? ""}</span>
      </button>
      {open && (
        <div ref={menuRef} className="app-select-menu" style={menuStyle} role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`app-select-option ${option.value === value ? "selected" : ""}`}
              disabled={option.disabled}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FileList({
  files,
  compareMarks,
  selected,
  selectedPaths,
  sort,
  onSelect,
  onSort,
  onOpen,
  onDragStart,
  onDragEnd,
  onSelectAll,
  onClearSelection,
  onRemove,
  onRename,
  onContextMenu
}: {
  files: FileEntry[];
  compareMarks: Map<string, FileCompareMark>;
  selected: FileEntry | null;
  selectedPaths: string[];
  sort: FileSort;
  onSelect: (file: FileEntry, event: MouseEvent<HTMLButtonElement>) => void;
  onSort: (key: FileSortKey) => void;
  onOpen: (file: FileEntry) => void;
  onDragStart: (file: FileEntry, event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onRemove: () => void;
  onRename: () => void;
  onContextMenu: (event: MouseEvent, file?: FileEntry, alreadySelected?: boolean) => void;
}) {
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      onSelectAll();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClearSelection();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selectedPaths.length === 0) return;
      event.preventDefault();
      onRemove();
      return;
    }
    if (event.key === "F2") {
      if (!selected || selectedPaths.length > 1) return;
      event.preventDefault();
      onRename();
      return;
    }
    if (event.key === "Enter") {
      if (!selected) return;
      event.preventDefault();
      onOpen(selected);
    }
  };

  return (
    <div className="file-list" tabIndex={0} onKeyDown={handleKeyDown} onContextMenu={(event) => onContextMenu(event)}>
      <div className="file-row file-head">
        <SortHeader label="名称" sortKey="name" sort={sort} onSort={onSort} />
        <SortHeader label="权限" sortKey="permissions" sort={sort} onSort={onSort} />
        <SortHeader label="属主" sortKey="owner" sort={sort} onSort={onSort} />
        <SortHeader label="大小" sortKey="size" sort={sort} onSort={onSort} />
        <SortHeader label="时间" sortKey="modifiedAt" sort={sort} onSort={onSort} />
      </div>
      {files.map((file) => {
        const compareMark = compareMarks.get(file.path);
        const compareText = compareMark ? compareMarkLabel(compareMark) : "";
        const compareDetail = compareMark?.detail ?? "";
        return (
          <button
            key={file.path}
            className={`file-row ${compareMark ? `compare-${compareMark.kind}` : ""} ${
              selectedPathSet.has(file.path) ? "selected" : ""
            } ${selected?.path === file.path ? "primary" : ""}`}
            onClick={(event) => onSelect(file, event)}
            onDoubleClick={() => onOpen(file)}
            draggable
            onDragStart={(event) => onDragStart(file, event)}
            onDragEnd={onDragEnd}
            onContextMenu={(event) => onContextMenu(event, file, selectedPathSet.has(file.path))}
            title={[file.linkTarget ? `${file.path} -> ${file.linkTarget}` : file.path, compareDetail || compareText]
              .filter(Boolean)
              .join(" · ")}
          >
            <span className="file-name">
              {file.fileType === "symlink" ? <Link2 size={13} /> : file.isDir ? <Folder size={13} /> : <span className="file-dot" />}
              <span className="file-name-text">{file.name}</span>
              {compareText && <span className="compare-badge" title={compareDetail || compareText}>{compareText}</span>}
              {file.linkTarget && <span className="link-target">-&gt; {file.linkTarget}</span>}
            </span>
            <PermissionCell file={file} />
            <span>{formatOwner(file)}</span>
            <span>{file.isDir ? "-" : formatSize(file.size)}</span>
            <span title={formatFileDateTime(file.modifiedAt, true)}>{formatFileDateTime(file.modifiedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}

function PermissionCell({ file }: { file: FileEntry }) {
  const mode = formatMode(file.permissions);
  if (!mode) return <span>-</span>;
  const symbolic = formatEntrySymbolicMode(file);
  return (
    <span className="permission-cell" title={`${mode} ${symbolic}`}>
      <span className="permission-octal">{mode}</span>
      <span className="permission-symbol">{symbolic}</span>
    </span>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort
}: {
  label: string;
  sortKey: FileSortKey;
  sort: FileSort;
  onSort: (key: FileSortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <button className={`sort-head ${active ? "active" : ""}`} onClick={() => onSort(sortKey)}>
      <span>{label}</span>
      {active && <span>{sort.direction === "asc" ? "↑" : "↓"}</span>}
    </button>
  );
}

function TransferQueue({
  transfers,
  history,
  conflict,
  onConflict,
  onCancel,
  onRetry,
  onRemove,
  onClear,
  onCancelRunning,
  onRetryFailed,
  onCopyCsv,
  onDownloadCsv,
  onOpenLocalPath,
  onCopyDetail,
  onLocate
}: {
  transfers: TransferView[];
  history: TransferView[];
  conflict: TransferConflictStrategy;
  onConflict: (value: TransferConflictStrategy) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onCancelRunning: (ids: string[]) => void;
  onRetryFailed: (ids: string[]) => void;
  onCopyCsv: () => void;
  onDownloadCsv: () => void;
  onOpenLocalPath: (path: string, reveal: boolean) => void;
  onCopyDetail: (transfer: TransferView) => void;
  onLocate: (transfer: TransferView) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; transfer: TransferView; archived: boolean } | null>(null);
  const transferItems = transfers.map((transfer) => ({ transfer, archived: false }));
  const runningIds = transfers.filter((transfer) => transfer.status === "running").map((transfer) => transfer.id);
  const retryableIds = transfers
    .filter((transfer) => transfer.status === "failed" || transfer.status === "cancelled")
    .map((transfer) => transfer.id);
  const runningCount = runningIds.length;
  const retryableCount = retryableIds.length;
  const finishedCount = transferItems.filter(({ transfer }) => transfer.status !== "running").length;
  const clearableCount = finishedCount + history.length;
  const auditCount = transferAuditRecords(transfers, history).length;

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  const localPathForTransfer = (transfer: TransferView) =>
    transfer.direction === "upload" ? transfer.source : transferDownloadResultPath(transfer);

  const openContextMenu = (event: MouseEvent<HTMLElement>, transfer: TransferView, archived: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 220;
    const height = 286;
    setContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      transfer,
      archived
    });
  };

  const contextActions = (transfer: TransferView, archived: boolean): FileAction[] => {
    const localPath = localPathForTransfer(transfer);
    const actions: FileAction[] = [
      {
        label: "打开文件",
        icon: <Eye size={13} />,
        onClick: () => onOpenLocalPath(localPath, false),
        disabled: !localPath
      },
      {
        label: "打开所在文件夹",
        icon: <Folder size={13} />,
        onClick: () => onOpenLocalPath(localPath, true),
        disabled: !localPath
      },
      { type: "separator" },
      {
        label: "定位到面板",
        icon: <Crosshair size={13} />,
        onClick: () => onLocate(transfer),
        disabled: !transfer.target && !transfer.message
      },
      {
        label: "复制传输详情",
        icon: <Copy size={13} />,
        onClick: () => onCopyDetail(transfer)
      }
    ];

    if (!archived) {
      actions.push({ type: "separator" });
      if (transfer.status === "running") {
        actions.push({
          label: "取消传输",
          icon: <Square size={13} />,
          onClick: () => onCancel(transfer.id)
        });
      } else {
        actions.push(
          {
            label: "重试传输",
            icon: <RefreshCcw size={13} />,
            onClick: () => onRetry(transfer.id)
          },
          {
            label: "移除任务",
            icon: <Trash2 size={13} />,
            onClick: () => onRemove(transfer.id),
            danger: true
          }
        );
      }
    }

    return actions;
  };

  const renderTransferItem = (transfer: TransferView, archived = false) => {
    const localPath = localPathForTransfer(transfer);
    const displayName = pathBaseName(localPath) || pathBaseName(transfer.source) || pathBaseName(transfer.target) || "-";
    const statusText = transferStatusLabel(transfer.status);
    const fullSizeText = `${formatSize(transfer.transferred)} / ${transfer.total ? formatSize(transfer.total) : "-"}`;
    const sizeText = transfer.total ? `${transferPercent(transfer)}% ${formatSize(transfer.total)}` : formatSize(transfer.transferred);
    const timeText = transfer.finishedAt ? formatTransferTime(transfer.finishedAt) : formatEta(transfer.etaSeconds);
    const rowTitle = [
      `${transfer.direction === "upload" ? "上传" : "下载"} ${displayName}`,
      `进度: ${fullSizeText}`,
      `源: ${transfer.source}`,
      `目标: ${transfer.target}`,
      transfer.message ? `消息: ${transfer.message}` : ""
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <button
        type="button"
        key={`${archived ? "history" : "queue"}-${transfer.id}`}
        className={`transfer-row ${transfer.status}`}
        title={rowTitle}
        onDoubleClick={() => onOpenLocalPath(localPath, false)}
        onContextMenu={(event) => openContextMenu(event, transfer, archived)}
      >
        <span className="transfer-name">
          {transfer.direction === "upload" ? <Upload size={13} /> : <Download size={13} />}
          <span>{displayName}</span>
        </span>
        <span className={`transfer-status-text ${transfer.status}`}>{statusText}</span>
        <span>{conflictLabel(transfer.conflictStrategy)}</span>
        <span>{sizeText}</span>
        <span>{timeText}</span>
      </button>
    );
  };

  return (
    <section className="transfer-panel">
      <div className="transfer-panel-head">
        <h3>
          传输队列
          {transferItems.length > 0 && <span>{runningCount} 运行 / {retryableCount} 可重试</span>}
        </h3>
        <AppSelect<TransferConflictStrategy>
          value={conflict}
          ariaLabel="传输冲突策略"
          options={[
            { value: "overwrite", label: "覆盖" },
            { value: "skip", label: "跳过" },
            { value: "rename", label: "重命名" },
            { value: "resume", label: "续传" }
          ]}
          onChange={onConflict}
        />
        <div className="transfer-actions">
          <button title="取消全部运行中" onClick={() => onCancelRunning(runningIds)} disabled={runningCount === 0}>
            <Square size={12} />
          </button>
          <button title="重试失败/取消项" onClick={() => onRetryFailed(retryableIds)} disabled={retryableCount === 0}>
            <RefreshCcw size={12} />
          </button>
          <button title="复制传输审计 CSV" onClick={onCopyCsv} disabled={auditCount === 0}>
            <Copy size={12} />
          </button>
          <button title="下载传输审计 CSV" onClick={onDownloadCsv} disabled={auditCount === 0}>
            <Download size={12} />
          </button>
          <button title="清理完成和历史传输" onClick={onClear} disabled={clearableCount === 0}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div className="transfer-list" role="table" aria-label="传输队列">
        <div className="transfer-row transfer-table-head" role="row">
          <span role="columnheader">名称</span>
          <span role="columnheader">状态</span>
          <span role="columnheader">策略</span>
          <span role="columnheader">大小</span>
          <span role="columnheader">时间</span>
        </div>
        {transferItems.length === 0 ? (
          <div className="queue-empty">空闲</div>
        ) : (
          transferItems.map(({ transfer, archived }) => renderTransferItem(transfer, archived))
        )}
      </div>
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={contextActions(contextMenu.transfer, contextMenu.archived)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </section>
  );
}

function QuickDialog({
  value,
  onChange,
  onClose,
  onConnect
}: {
  value: QuickConnectRequest;
  onChange: (value: QuickConnectRequest) => void;
  onClose: () => void;
  onConnect: () => void;
}) {
  return (
    <Modal title="快速连接" onClose={onClose}>
      <FormRow label="协议">
        <AppSelect<Protocol>
          value={value.protocol}
          ariaLabel="快速连接协议"
          options={[
            { value: "SSH", label: "SSH" },
            { value: "LocalShell", label: "Local" },
            { value: "SftpOnly", label: "SFTP" }
          ]}
          onChange={(protocol) => onChange({ ...value, protocol })}
        />
      </FormRow>
      <FormRow label="名称">
        <input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} />
      </FormRow>
      <FormRow label="主机名">
        <input value={value.host} onChange={(event) => onChange({ ...value, host: event.target.value })} />
      </FormRow>
      <FormRow label="端口">
        <input type="number" value={value.port} onChange={(event) => onChange({ ...value, port: Number(event.target.value) })} />
      </FormRow>
      <FormRow label="用户名">
        <input value={value.username} onChange={(event) => onChange({ ...value, username: event.target.value })} />
      </FormRow>
      <FormRow label="密码">
        <input type="password" value={value.password ?? ""} onChange={(event) => onChange({ ...value, password: event.target.value })} />
      </FormRow>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={value.rememberPassword}
          onChange={(event) => onChange({ ...value, rememberPassword: event.target.checked })}
        />
        记住密码
      </label>
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onConnect}>
          <Cable size={14} /> 连接
        </button>
      </div>
    </Modal>
  );
}

function SecretDialog({
  profile,
  password,
  onPassword,
  onClose,
  onConnect
}: {
  profile: Profile;
  password: string;
  onPassword: (password: string) => void;
  onClose: () => void;
  onConnect: () => void;
}) {
  const authKind = profileAuthKind(profile.auth);
  const isKeyFile = authKind === "KeyFile";
  const secretLabel = isKeyFile ? "密钥口令" : "密码";
  return (
    <Modal title={isKeyFile ? "密钥口令" : "连接密码"} onClose={onClose}>
      <InfoRow label="会话" value={profile.name} />
      <InfoRow label="主机" value={`${profile.username}@${profile.host}:${profile.port}`} />
      <FormRow label={secretLabel}>
        <input
          autoFocus
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => onPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConnect();
            }
          }}
        />
      </FormRow>
      {isKeyFile && <div className="secret-hint">私钥没有口令时可留空直接连接；如果仍失败，请确认服务器 authorized_keys 已配置对应公钥。</div>}
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onConnect} disabled={!isKeyFile && !password.trim()}>
          <Cable size={14} /> 连接
        </button>
      </div>
    </Modal>
  );
}

function ProfileDialog({
  profile,
  onChange,
  onClose,
  onSave,
  onPickKeyFile
}: {
  profile: Profile;
  onChange: (profile: Profile) => void;
  onClose: () => void;
  onSave: () => void;
  onPickKeyFile: () => void;
}) {
  const protocol = normalizeSavedProtocol(profile.protocol, profile);
  const authKind = profileAuthKind(profile.auth);
  const keyPath = profileKeyPath(profile.auth);
  const isRemote = isRemoteProtocol(protocol);
  const secretLabel = authKind === "KeyFile" ? "密钥口令/密码" : authKind === "Agent" ? "Agent 备用密码" : "连接密码";
  const secretPlaceholder =
    authKind === "KeyFile"
      ? profile.rememberPassword
        ? "留空则使用已保存口令；也可切换密码登录"
        : "加密私钥口令，或切换密码登录"
      : authKind === "Agent"
        ? "Agent 失败时可用此密码登录"
        : profile.rememberPassword
          ? "留空则使用已保存密码"
          : "输入后本次连接可直接使用";
  const switchToPasswordAuth = () =>
    onChange({
      ...profile,
      auth: "Password",
      password: profile.password ?? ""
    });
  return (
    <Modal title="会话属性" onClose={onClose} wide>
      <FormRow label="名称">
        <input value={profile.name} onChange={(event) => onChange({ ...profile, name: event.target.value })} />
      </FormRow>
      <FormRow label="分组">
        <input value={profile.group} onChange={(event) => onChange({ ...profile, group: event.target.value })} />
      </FormRow>
      <FormRow label="协议">
        <AppSelect<Protocol>
          value={protocol}
          ariaLabel="会话协议"
          options={[
            { value: "Ssh", label: "SSH" },
            { value: "SftpOnly", label: "SFTP" },
            { value: "LocalShell", label: "Local" },
            { value: "Serial", label: "Serial" }
          ]}
          onChange={(nextProtocol) => onChange(profileWithProtocol(profile, nextProtocol))}
        />
      </FormRow>
      <FormRow label="主机名">
        <input value={profile.host} onChange={(event) => onChange({ ...profile, host: event.target.value })} />
      </FormRow>
      <FormRow label="端口">
        <input type="number" value={profile.port} onChange={(event) => onChange({ ...profile, port: Number(event.target.value) })} />
      </FormRow>
      <FormRow label="用户名">
        <input
          value={profile.username}
          autoComplete="username"
          onChange={(event) => onChange({ ...profile, username: event.target.value })}
        />
      </FormRow>
      {isRemote && (
        <div className="credential-panel">
          <div className="credential-heading">
            <div className="dialog-section-title">SSH/SFTP 连接凭据</div>
            {authKind !== "Password" && (
              <button type="button" className="credential-switch-button" onClick={switchToPasswordAuth}>
                <KeyRound size={13} /> 密码登录
              </button>
            )}
          </div>
          <FormRow label="认证方式">
            <AppSelect
              value={authKind}
              ariaLabel="认证方式"
              options={[
                { value: "Password", label: "密码" },
                { value: "KeyFile", label: "密钥文件" },
                { value: "Agent", label: "Agent" }
              ]}
              onChange={(nextAuthKind) =>
                onChange({
                  ...profile,
                  auth: authProfileFromKind(nextAuthKind, keyPath),
                  password: profile.password
                })
              }
            />
          </FormRow>
          {authKind === "KeyFile" && (
            <FormRow label="密钥文件">
              <div className="key-file-picker">
                <input
                  value={keyPath}
                  onChange={(event) => onChange({ ...profile, auth: { KeyFile: { path: event.target.value } } })}
                  placeholder="例如 C:\\Users\\me\\.ssh\\id_ed25519"
                />
                <button type="button" onClick={onPickKeyFile} title="选择 SSH 私钥文件">
                  <Folder size={13} />
                  <span>选择</span>
                </button>
                <span className="key-file-hint">选择无 .pub 后缀的私钥文件，如 id_ed25519 或 id_rsa</span>
              </div>
            </FormRow>
          )}
          <FormRow label={secretLabel}>
            <input
              name="ssh-password"
              type="password"
              value={profile.password ?? ""}
              autoComplete="current-password"
              onChange={(event) =>
                onChange({
                  ...profile,
                  password: event.target.value
                })
              }
              placeholder={secretPlaceholder}
            />
          </FormRow>
          {authKind !== "Password" && (
            <FormRow label="密码登录">
              <button type="button" className="inline-auth-button" onClick={switchToPasswordAuth}>
                <KeyRound size={13} /> 切换到密码认证
              </button>
            </FormRow>
          )}
          <label className="checkbox-row credential-remember-row">
            <input
              type="checkbox"
              checked={profile.rememberPassword}
              onChange={(event) => onChange({ ...profile, rememberPassword: event.target.checked })}
            />
            记住密码/口令
          </label>
        </div>
      )}
      <FormRow label="字符集">
        <AppSelect
          value={profile.charset}
          ariaLabel="字符集"
          options={[
            { value: "UTF-8", label: "UTF-8" },
            { value: "GBK", label: "GBK" },
            { value: "GB18030", label: "GB18030" },
            { value: "Shift_JIS", label: "Shift_JIS" }
          ]}
          onChange={(charset) => onChange({ ...profile, charset })}
        />
      </FormRow>
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onSave}>
          <Save size={14} /> 保存
        </button>
      </div>
    </Modal>
  );
}

function SettingsDialog({
  settings,
  onChange,
  onClose,
  onHostKeys,
  onSave
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
  onHostKeys: () => void;
  onSave: () => void;
}) {
  return (
    <Modal title="设置" onClose={onClose}>
      <FormRow label="主题">
        <AppSelect<AppSettings["theme"]>
          value={settings.theme}
          ariaLabel="主题"
          options={[
            { value: "deep", label: "Deep" },
            { value: "graphite", label: "Graphite" },
            { value: "light", label: "Light" }
          ]}
          onChange={(theme) => onChange({ ...settings, theme })}
        />
      </FormRow>
      <FormRow label="字号">
        <input
          type="number"
          value={settings.fontSize}
          onChange={(event) => onChange({ ...settings, fontSize: Number(event.target.value) })}
        />
      </FormRow>
      <FormRow label="回滚行">
        <input
          type="number"
          value={settings.scrollback}
          onChange={(event) => onChange({ ...settings, scrollback: Number(event.target.value) })}
        />
      </FormRow>
      <FormRow label="本地 Shell">
        <input value={settings.localShell} onChange={(event) => onChange({ ...settings, localShell: event.target.value })} />
      </FormRow>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.copyOnSelect}
          onChange={(event) => onChange({ ...settings, copyOnSelect: event.target.checked })}
        />
        选择即复制
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.confirmOnExit}
          onChange={(event) => onChange({ ...settings, confirmOnExit: event.target.checked })}
        />
        关闭确认
      </label>
      <div className="modal-actions split-actions">
        <button onClick={onHostKeys}>
          <ShieldCheck size={14} /> 主机密钥
        </button>
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onSave}>
          <Check size={14} /> 应用
        </button>
      </div>
    </Modal>
  );
}

function KnownHostsDialog({
  content,
  onChange,
  onClose,
  onClear,
  onSave
}: {
  content: string;
  onChange: (content: string) => void;
  onClose: () => void;
  onClear: () => void;
  onSave: () => void;
}) {
  return (
    <Modal title="主机密钥管理" onClose={onClose} wide>
      <textarea
        className="editor-textarea known-hosts-textarea"
        value={content}
        onChange={(event) => onChange(event.target.value)}
        placeholder="known_hosts 为空。信任主机后会写入 OpenSSH known_hosts 格式。"
      />
      <div className="modal-actions">
        <button onClick={onClear}>清空</button>
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onSave}>
          <Save size={14} /> 保存
        </button>
      </div>
    </Modal>
  );
}

function HostKeyDialog({ issue, onClose, onAccept }: { issue: HostKeyIssue; onClose: () => void; onAccept: () => void }) {
  return (
    <Modal title="主机密钥" onClose={onClose}>
      <div className="hostkey-box">
        <InfoRow label="主机" value={`${issue.host}:${issue.port}`} />
        <InfoRow label="类型" value={issue.keyType} />
        <InfoRow label="指纹" value={issue.fingerprint} />
        <InfoRow label="状态" value={issue.changed ? "已变更" : "未信任"} />
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onAccept}>
          <Check size={14} /> 信任
        </button>
      </div>
    </Modal>
  );
}

function BatchRenameDialog({
  side,
  entries,
  existingEntries,
  find,
  replace,
  prefix,
  suffix,
  numberStart,
  numberPadding,
  preserveExtension,
  caseSensitive,
  onFind,
  onReplace,
  onPrefix,
  onSuffix,
  onNumberStart,
  onNumberPadding,
  onPreserveExtension,
  onCaseSensitive,
  onClose,
  onApply
}: {
  side: FileSide;
  entries: FileEntry[];
  existingEntries: FileEntry[];
  find: string;
  replace: string;
  prefix: string;
  suffix: string;
  numberStart: string;
  numberPadding: string;
  preserveExtension: boolean;
  caseSensitive: boolean;
  onFind: (value: string) => void;
  onReplace: (value: string) => void;
  onPrefix: (value: string) => void;
  onSuffix: (value: string) => void;
  onNumberStart: (value: string) => void;
  onNumberPadding: (value: string) => void;
  onPreserveExtension: (value: boolean) => void;
  onCaseSensitive: (value: boolean) => void;
  onClose: () => void;
  onApply: (items: BatchRenamePlanItem[]) => void;
}) {
  const numberConfig = useMemo(() => batchRenameNumberConfig(numberStart, numberPadding), [numberPadding, numberStart]);
  const preview = useMemo(() => {
    const selectedNames = new Set(entries.map((entry) => entry.name));
    const existingNames = new Set(existingEntries.map((entry) => entry.name));
    const rows = entries.map((entry, index) => ({
      entry,
      newName: batchRenameName(entry, index, { find, replace, prefix, suffix, preserveExtension, caseSensitive, ...numberConfig })
    }));
    const counts = new Map<string, number>();
    rows.forEach((row) => counts.set(row.newName, (counts.get(row.newName) ?? 0) + 1));
    return rows.map((row) => {
      const issue = batchRenameIssue(row.entry, row.newName, counts, existingNames, selectedNames);
      return {
        ...row,
        changed: row.newName !== row.entry.name,
        issue
      };
    });
  }, [caseSensitive, entries, existingEntries, find, numberConfig, prefix, preserveExtension, replace, suffix]);
  const plan = preview.filter((row) => row.changed && !row.issue).map((row) => ({ entry: row.entry, newName: row.newName }));
  const issues = preview.filter((row) => row.issue).length;
  const numberIssue = numberConfig.invalid ? "编号起始需为 0-999999，位数需为 0-12" : "";

  return (
    <Modal title="批量重命名" onClose={onClose} wide>
      <InfoRow label="范围" value={`${side === "local" ? "本地" : "远程"} / ${entries.length} 个项目`} />
      <FormRow label="查找">
        <input value={find} onChange={(event) => onFind(event.target.value)} placeholder="留空则只应用前缀/后缀" />
      </FormRow>
      <FormRow label="替换为">
        <input value={replace} onChange={(event) => onReplace(event.target.value)} />
      </FormRow>
      <FormRow label="前缀">
        <input value={prefix} onChange={(event) => onPrefix(event.target.value)} />
      </FormRow>
      <FormRow label="后缀">
        <input value={suffix} onChange={(event) => onSuffix(event.target.value)} />
      </FormRow>
      <FormRow label="编号起始">
        <input type="number" min="0" max="999999" value={numberStart} onChange={(event) => onNumberStart(event.target.value)} />
      </FormRow>
      <FormRow label="编号位数">
        <input type="number" min="0" max="12" value={numberPadding} onChange={(event) => onNumberPadding(event.target.value)} />
      </FormRow>
      <label className="checkbox-row">
        <input type="checkbox" checked={caseSensitive} onChange={(event) => onCaseSensitive(event.target.checked)} />
        区分大小写
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={preserveExtension} onChange={(event) => onPreserveExtension(event.target.checked)} />
        保留文件扩展名
      </label>
      <div className={`rename-token-hint ${numberIssue ? "invalid" : ""}`}>{numberIssue || "在查找替换、前缀或后缀中输入 {n} 可插入序号"}</div>
      <div className="rename-preview">
        {preview.slice(0, 12).map((row) => (
          <div key={row.entry.path} className={`rename-preview-row ${row.issue ? "invalid" : row.changed ? "changed" : ""}`}>
            <span>{row.entry.name}</span>
            <strong>{row.newName}</strong>
            <em>{row.issue || (row.changed ? "将重命名" : "无变化")}</em>
          </div>
        ))}
        {preview.length > 12 && <div className="rename-preview-more">另有 {preview.length - 12} 个项目...</div>}
      </div>
      <div className="modal-actions split-actions">
        <span>{numberIssue || (issues ? `${issues} 个名称需要修正` : `${plan.length} 个项目将重命名`)}</span>
        <div>
          <button onClick={onClose}>取消</button>
          <button className="primary-button" onClick={() => onApply(plan)} disabled={!!numberIssue || plan.length === 0 || issues > 0}>
            <Save size={14} /> 应用
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ChmodDialog({
  entry,
  side,
  targetCount,
  hasDirectory,
  mode,
  recursive,
  onMode,
  onRecursive,
  onClose,
  onApply
}: {
  entry: FileEntry;
  side: FileSide;
  targetCount: number;
  hasDirectory: boolean;
  mode: string;
  recursive: boolean;
  onMode: (mode: string) => void;
  onRecursive: (recursive: boolean) => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const isSymlink = entry.fileType === "symlink";
  const resolvedMode = resolvePermissionMode(mode, entry);
  const parsedMode = typeof resolvedMode === "number" ? resolvedMode : Number.parseInt(formatMode(entry.permissions) || "0", 8) || 0;
  const modeInvalid = resolvedMode === undefined || resolvedMode === null;

  const setPermissionBit = (bit: number, checked: boolean) => {
    const next = checked ? parsedMode | bit : parsedMode & ~bit;
    onMode(formatPermissionInput(next));
  };

  return (
    <Modal title="修改权限" onClose={onClose}>
      <div className="hostkey-box">
        <InfoRow label="名称" value={entry.name} />
        {targetCount > 1 && <InfoRow label="目标" value={`${targetCount} 个项目`} />}
        <InfoRow label="当前" value={formatMode(entry.permissions) || "-"} />
        {isSymlink && <InfoRow label="提示" value="符号链接会跳过权限修改" />}
      </div>
      <FormRow label="权限">
        <input
          value={mode}
          onChange={(event) => onMode(event.target.value)}
          placeholder="755 或 u+rw,g-w,o="
        />
      </FormRow>
      <div className={`permission-preview ${modeInvalid ? "invalid" : ""}`}>
        <span>{modeInvalid ? "格式错误" : formatPermissionInput(parsedMode)}</span>
        <strong>{modeInvalid ? "示例: 755, u+rw,g-w,o=, a+rX" : formatSymbolicMode(parsedMode, entry.isDir)}</strong>
      </div>
      <div className="permission-help">支持八进制和符号模式，例如 u+rw,g-w,o= 或 a+rX。</div>
      <div className="permission-presets">
        {(entry.isDir ? ["755", "775", "700", "750"] : ["644", "664", "600", "755"]).map((preset) => (
          <button key={preset} onClick={() => onMode(preset)}>
            {preset}
          </button>
        ))}
      </div>
      <PermissionMatrix mode={parsedMode} onBit={setPermissionBit} />
      <PermissionSpecials mode={parsedMode} onBit={setPermissionBit} />
      {hasDirectory && (
        <label className="checkbox-row">
          <input type="checkbox" checked={recursive} onChange={(event) => onRecursive(event.target.checked)} />
          递归应用到子项
        </label>
      )}
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onApply} disabled={modeInvalid}>
          <ShieldCheck size={14} /> 应用
        </button>
      </div>
    </Modal>
  );
}

function PermissionMatrix({ mode, onBit }: { mode: number; onBit: (bit: number, checked: boolean) => void }) {
  const rows = [
    { label: "用户", bits: [0o400, 0o200, 0o100] },
    { label: "组", bits: [0o040, 0o020, 0o010] },
    { label: "其它", bits: [0o004, 0o002, 0o001] }
  ];
  const columns = ["读", "写", "执行"];
  return (
    <div className="permission-matrix">
      <span />
      {columns.map((column) => (
        <strong key={column}>{column}</strong>
      ))}
      {rows.map((row) => (
        <Fragment key={row.label}>
          <strong>{row.label}</strong>
          {row.bits.map((bit) => (
            <label key={bit}>
              <input
                type="checkbox"
                checked={(mode & bit) === bit}
                onChange={(event) => onBit(bit, event.target.checked)}
              />
            </label>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function PermissionSpecials({ mode, onBit }: { mode: number; onBit: (bit: number, checked: boolean) => void }) {
  return (
    <div className="permission-specials">
      {[
        { label: "setuid", bit: 0o4000 },
        { label: "setgid", bit: 0o2000 },
        { label: "sticky", bit: 0o1000 }
      ].map(({ label, bit }) => (
        <label key={label}>
          <input
            type="checkbox"
            checked={(mode & bit) === bit}
            onChange={(event) => onBit(bit, event.target.checked)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

function DeleteConfirmDialog({
  side,
  entries,
  onCopyCsv,
  onDownloadCsv,
  onCopyJson,
  onDownloadJson,
  onClose,
  onConfirm
}: {
  side: FileSide;
  entries: FileEntry[];
  onCopyCsv: () => void;
  onDownloadCsv: () => void;
  onCopyJson: () => void;
  onDownloadJson: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const files = entries.filter((entry) => !entry.isDir);
  const dirs = entries.filter((entry) => entry.isDir);
  const bytes = files.reduce((total, entry) => total + entry.size, 0);
  return (
    <Modal title="确认删除" onClose={onClose} wide>
      <div className="danger-summary">
        <Trash2 size={18} />
        <span>
          将删除 {side === "local" ? "本地" : "远程"} {entries.length} 个项目，其中 {dirs.length} 个目录、{files.length} 个文件。
          {dirs.length > 0 ? "目录会递归删除其全部内容。" : ""}
        </span>
      </div>
      <div className="delete-confirm-meta">
        <InfoRow label="文件大小合计" value={formatSize(bytes)} />
        <InfoRow label="目标端" value={side === "local" ? "本地文件系统" : "远程 SFTP"} />
      </div>
      <div className="delete-confirm-list">
        {entries.map((entry) => (
          <div key={entry.path} className="delete-confirm-row">
            <span>{entry.isDir ? "目录" : fileTypeLabel(entry)}</span>
            <strong>{entry.path}</strong>
            <em>{entry.isDir ? "递归" : formatSize(entry.size)}</em>
          </div>
        ))}
      </div>
      <div className="modal-actions split-actions">
        <div>
          <button onClick={onCopyCsv}>
            <Copy size={14} /> 复制 CSV
          </button>
          <button onClick={onDownloadCsv}>
            <Download size={14} /> 下载 CSV
          </button>
          <button onClick={onCopyJson}>
            <Copy size={14} /> 复制 JSON
          </button>
          <button onClick={onDownloadJson}>
            <Download size={14} /> 下载 JSON
          </button>
        </div>
        <div>
          <button onClick={onClose}>取消</button>
          <button className="danger-button" onClick={onConfirm}>
            <Trash2 size={14} /> 确认删除
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SyncPlanDialog({
  plan,
  conflict,
  onShowTextDialog,
  onClose,
  onConfirm
}: {
  plan: SyncPlanState;
  conflict: TransferConflictStrategy;
  onShowTextDialog: (title: string, text: string) => Promise<string | null>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const createCount = plan.items.filter((item) => item.action === "create").length;
  const overwriteCount = plan.items.filter((item) => item.action === "overwrite").length;
  const metadataCount = plan.items.filter((item) => item.action === "metadata").length;
  const bytes = plan.items.reduce((total, item) => total + (item.entry.isDir ? 0 : item.entry.size), 0);
  const copyCsv = async () => {
    const text = syncPlanCsv(plan, conflict);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await onShowTextDialog("复制同步计划 CSV", text);
    }
  };
  const downloadCsv = () => {
    downloadTextFile(syncPlanCsvName(plan), syncPlanCsv(plan, conflict), "text/csv;charset=utf-8");
  };
  const copyJson = async () => {
    const text = syncPlanJson(plan, conflict);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await onShowTextDialog("复制同步计划 JSON", text);
    }
  };
  const downloadJson = () => {
    downloadTextFile(syncPlanJsonName(plan), syncPlanJson(plan, conflict));
  };
  return (
    <Modal title="同步计划预览" onClose={onClose} wide>
      <div className="sync-plan-summary">
        <InfoRow label="计划" value={plan.title} />
        <InfoRow label="方向" value={plan.direction === "upload" ? "本地到远程" : "远程到本地"} />
        <InfoRow label="策略" value={plan.mode === "transfer" ? conflictLabel(conflict) : "仅同步属性"} />
        <InfoRow
          label="项目"
          value={
            plan.mode === "transfer"
              ? `${plan.items.length} 个，新增 ${createCount}，覆盖 ${overwriteCount}`
              : `${plan.items.length} 个，元数据 ${metadataCount}`
          }
        />
        <InfoRow label="文件大小" value={formatSize(bytes)} />
      </div>
      <div className="sync-plan-list">
        {plan.items.map((item) => (
          <div key={item.source} className="sync-plan-row">
            <span>{syncPlanActionLabel(item.action)}</span>
            <strong>{item.name}</strong>
            <em>{item.entry.isDir ? "目录" : formatSize(item.entry.size)}</em>
            <small title={item.detail}>{item.detail}</small>
            <code title={item.target}>{item.target}</code>
          </div>
        ))}
      </div>
      <div className="modal-actions split-actions">
        <div>
          <button onClick={copyCsv}>
            <Copy size={14} /> 复制 CSV
          </button>
          <button onClick={downloadCsv}>
            <Download size={14} /> 下载 CSV
          </button>
          <button onClick={copyJson}>
            <Copy size={14} /> 复制 JSON
          </button>
          <button onClick={downloadJson}>
            <Download size={14} /> 下载 JSON
          </button>
        </div>
        <div>
          <button onClick={onClose}>取消</button>
          <button className="primary-button" onClick={onConfirm}>
            <FolderSync size={14} /> 执行计划
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PropertiesDialog({
  side,
  entry,
  targetCount,
  hasDirectory,
  uid,
  gid,
  mode,
  mtime,
  stats,
  statsLoading,
  checksum,
  checksumLoading,
  recursive,
  onUid,
  onGid,
  onMode,
  onMtime,
  onCalculateStats,
  onCalculateChecksum,
  onCopyReport,
  onCopyCsv,
  onDownloadCsv,
  onCopyJson,
  onDownloadJson,
  onRecursive,
  onClose,
  onApply
}: {
  side: FileSide;
  entry: FileEntry;
  targetCount: number;
  hasDirectory: boolean;
  uid: string;
  gid: string;
  mode: string;
  mtime: string;
  stats: RemotePathStats | null;
  statsLoading: boolean;
  checksum: string;
  checksumLoading: boolean;
  recursive: boolean;
  onUid: (uid: string) => void;
  onGid: (gid: string) => void;
  onMode: (mode: string) => void;
  onMtime: (mtime: string) => void;
  onCalculateStats: () => void;
  onCalculateChecksum: () => void;
  onCopyReport: () => void;
  onCopyCsv: () => void;
  onDownloadCsv: () => void;
  onCopyJson: () => void;
  onDownloadJson: () => void;
  onRecursive: (recursive: boolean) => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const multiple = targetCount > 1;
  const isRemote = side === "remote";
  const isSymlink = entry.fileType === "symlink";
  const displaySize = multiple ? "-" : entry.isDir && stats ? formatSize(stats.totalSize) : entry.isDir ? "-" : formatSize(entry.size);
  const resolvedMode = resolvePermissionMode(mode, entry);
  const parsedMode =
    typeof resolvedMode === "number"
      ? resolvedMode
      : Number.parseInt(formatMode(entry.permissions) || (entry.isDir ? "755" : "644"), 8);
  const modeInvalid = Boolean(mode.trim()) && resolvedMode === undefined;
  const setPermissionBit = (bit: number, checked: boolean) => {
    const next = checked ? parsedMode | bit : parsedMode & ~bit;
    onMode(formatPermissionInput(next));
  };
  return (
    <Modal title={isRemote ? "远程属性" : "本地属性"} onClose={onClose}>
      <div className="hostkey-box">
        <InfoRow label="名称" value={entry.name} />
        {multiple && <InfoRow label="目标" value={`${targetCount} 个项目`} />}
        {!multiple && <InfoRow label="路径" value={entry.path} />}
        <InfoRow label="类型" value={fileTypeLabel(entry)} />
        {!multiple && entry.linkTarget && <InfoRow label="链接到" value={entry.linkTarget} />}
        <InfoRow label="大小" value={displaySize} />
        {!multiple && stats && <InfoRow label="文件数" value={String(stats.fileCount)} />}
        {!multiple && stats && <InfoRow label="目录数" value={String(stats.dirCount)} />}
        {!multiple && checksum && <InfoRow label="SHA-256" value={checksum} />}
        <InfoRow label="当前权限" value={formatMode(entry.permissions) || "-"} />
        {isSymlink && <InfoRow label="提示" value="符号链接会跳过权限、属主和时间修改" />}
        {isRemote && <InfoRow label="UID" value={multiple ? (uid || "混合") : entry.uid == null ? "-" : String(entry.uid)} />}
        {isRemote && <InfoRow label="GID" value={multiple ? (gid || "混合") : entry.gid == null ? "-" : String(entry.gid)} />}
        <InfoRow label="时间" value={multiple ? (mtime ? formatDate(mtime) : "混合") : formatDate(entry.modifiedAt)} />
      </div>
      {!multiple && entry.isDir && (
        <button className="secondary-button" onClick={onCalculateStats} disabled={statsLoading}>
          <Calculator size={14} /> {statsLoading ? "计算中" : "计算大小"}
        </button>
      )}
      {!multiple && !entry.isDir && !isSymlink && (
        <button className="secondary-button" onClick={onCalculateChecksum} disabled={checksumLoading}>
          <Calculator size={14} /> {checksumLoading ? "计算中" : "计算 SHA-256"}
        </button>
      )}
      {isRemote && (
        <>
          <FormRow label="UID">
            <input
              value={uid}
              onChange={(event) => onUid(event.target.value.replace(/\D/g, ""))}
              placeholder={multiple ? "留空不修改" : undefined}
            />
          </FormRow>
          <FormRow label="GID">
            <input
              value={gid}
              onChange={(event) => onGid(event.target.value.replace(/\D/g, ""))}
              placeholder={multiple ? "留空不修改" : undefined}
            />
          </FormRow>
        </>
      )}
      <FormRow label="权限">
        <input
          value={mode}
          onChange={(event) => onMode(event.target.value)}
          placeholder={multiple ? "留空不修改；也可填 u+rw,g-w" : "755 或 u+rw,g-w,o="}
        />
      </FormRow>
      <div className={`permission-preview compact ${modeInvalid ? "invalid" : ""}`}>
        <span>{!mode ? "不修改" : modeInvalid ? "格式错误" : formatPermissionInput(parsedMode)}</span>
        <strong>
          {!mode
            ? multiple
              ? "多选保留原权限"
              : "保留原权限"
            : modeInvalid
              ? "示例: 755, u+rw,g-w,o=, a+rX"
              : formatSymbolicMode(parsedMode, entry.isDir)}
        </strong>
      </div>
      <div className="permission-help">支持八进制和符号模式，例如 u+rw,g-w,o= 或 a+rX。</div>
      <div className="permission-presets">
        {(entry.isDir ? ["755", "775", "700", "750"] : ["644", "664", "600", "755"]).map((preset) => (
          <button key={preset} onClick={() => onMode(preset)}>
            {preset}
          </button>
        ))}
        {multiple && (
          <button onClick={() => onMode("")}>
            不修改
          </button>
        )}
      </div>
      <PermissionMatrix mode={parsedMode} onBit={setPermissionBit} />
      <PermissionSpecials mode={parsedMode} onBit={setPermissionBit} />
      <FormRow label="修改时间">
        <input
          type="datetime-local"
          value={mtime}
          onChange={(event) => onMtime(event.target.value)}
          title={multiple ? "留空不修改" : undefined}
        />
      </FormRow>
      {hasDirectory && (
        <label className="checkbox-row">
          <input type="checkbox" checked={recursive} onChange={(event) => onRecursive(event.target.checked)} />
          递归应用到子项
        </label>
      )}
      <div className="modal-actions">
        <button onClick={onCopyReport}>
          <Copy size={14} /> 复制报告
        </button>
        <button onClick={onCopyCsv}>
          <Copy size={14} /> 复制 CSV
        </button>
        <button onClick={onDownloadCsv}>
          <Download size={14} /> 下载 CSV
        </button>
        <button onClick={onCopyJson}>
          <Copy size={14} /> 复制 JSON
        </button>
        <button onClick={onDownloadJson}>
          <Download size={14} /> 下载 JSON
        </button>
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onApply} disabled={modeInvalid}>
          <Check size={14} /> 应用
        </button>
      </div>
    </Modal>
  );
}

function TextEditorDialog({
  side,
  file,
  position,
  content,
  onContent,
  onClose,
  onLoadHead,
  onLoadTail,
  onSave
}: {
  side: FileSide;
  file: TextFile;
  position: TextPreviewPosition;
  content: string;
  onContent: (content: string) => void;
  onClose: () => void;
  onLoadHead: () => void;
  onLoadTail: () => void;
  onSave: () => void;
}) {
  const readOnly = file.isBinary || file.truncated;
  return (
    <Modal title={side === "local" ? "本地编辑" : "远程编辑"} onClose={onClose} wide>
      <div className="hostkey-box">
        <InfoRow label="路径" value={file.path} />
        <InfoRow label="大小" value={formatSize(file.size)} />
        <InfoRow label="模式" value={readOnly ? `只读预览 / ${position === "tail" ? "末尾" : "开头"}` : "可编辑"} />
      </div>
      {file.truncated && (
        <div className="editor-preview-toolbar">
          <span>大文件仅加载 1MB 预览</span>
          <button type="button" onClick={onLoadHead} disabled={position === "head"}>
            查看开头
          </button>
          <button type="button" onClick={onLoadTail} disabled={position === "tail"}>
            查看末尾
          </button>
        </div>
      )}
      <textarea
        className="editor-textarea"
        value={content}
        onChange={(event) => onContent(event.target.value)}
        readOnly={readOnly}
        spellCheck={false}
      />
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button className="primary-button" onClick={onSave} disabled={readOnly}>
          <Save size={14} /> 保存
        </button>
      </div>
    </Modal>
  );
}

function AppMenuBar({ menus }: { menus: AppMenuGroup[] }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  return (
    <nav className="app-menu-bar" aria-label="应用菜单" onClick={(event) => event.stopPropagation()}>
      {menus.map((menu) => {
        const open = openMenu === menu.label;
        return (
          <div key={menu.label} className={`app-menu-group ${open ? "open" : ""}`} onMouseEnter={() => openMenu && setOpenMenu(menu.label)}>
            <button
              type="button"
              className="app-menu-title"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpenMenu(open ? null : menu.label)}
            >
              {menu.label}
            </button>
            {open && (
              <div className="app-menu-panel" role="menu">
                {menu.items.map((item, index) =>
                  item.type === "separator" ? (
                    <div key={`separator-${index}`} className="app-menu-separator" />
                  ) : (
                    <button
                      key={`${item.label}-${index}`}
                      type="button"
                      role="menuitem"
                      className={`app-menu-item ${item.danger ? "danger" : ""}`}
                      disabled={item.disabled}
                      onClick={() => {
                        if (item.disabled) return;
                        item.onClick();
                        setOpenMenu(null);
                      }}
                    >
                      <span>{item.label}</span>
                      {item.hint && <em>{item.hint}</em>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function AppModalDialog({ modal, onResolve }: { modal: AppModalState; onResolve: (value: string | boolean | null) => void }) {
  const [value, setValue] = useState(modal.kind === "prompt" ? modal.value : "");

  useEffect(() => {
    setValue(modal.kind === "prompt" ? modal.value : "");
  }, [modal]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onResolve(modal.kind === "confirm" ? false : null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modal.kind, onResolve]);

  if (modal.kind === "confirm") {
    return (
      <Modal title={modal.title} onClose={() => onResolve(false)}>
        <div className="app-modal-message">{modal.message}</div>
        <div className="modal-actions">
          <button onClick={() => onResolve(false)}>{modal.cancelLabel}</button>
          <button className={modal.danger ? "danger-button" : "primary-button"} onClick={() => onResolve(true)}>
            {modal.confirmLabel}
          </button>
        </div>
      </Modal>
    );
  }

  const submit = () => onResolve(value);
  return (
    <Modal title={modal.title} onClose={() => onResolve(null)}>
      <form
        className="app-prompt-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {modal.message && <div className="app-modal-message">{modal.message}</div>}
        {modal.multiline ? (
          <textarea
            className="app-prompt-textarea"
            value={value}
            placeholder={modal.placeholder}
            readOnly={modal.readOnly}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submit();
            }}
          />
        ) : (
          <input
            className="app-prompt-input"
            value={value}
            placeholder={modal.placeholder}
            readOnly={modal.readOnly}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <div className="modal-actions">
          <button type="button" onClick={() => onResolve(null)}>
            {modal.cancelLabel}
          </button>
          <button className="primary-button" type="submit">
            {modal.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop">
      <div className={`modal ${wide ? "modal-wide" : ""}`}>
        <div className="modal-title">
          <span>{title}</span>
          <button onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function IconButton({
  label,
  title,
  icon,
  onClick,
  disabled
}: {
  label?: string;
  title?: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="icon-button" onClick={onClick} title={title ?? label} disabled={disabled}>
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}

function PanelHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

function InfoRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong title={title ?? value}>{value}</strong>
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="form-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function createBlankProfile(): Profile {
  return {
    id: crypto.randomUUID(),
    name: "新建 SSH 会话",
    group: "我的会话",
    protocol: "Ssh",
    host: "",
    port: 22,
    username: "root",
    charset: "UTF-8",
    auth: "Password",
    color: [47, 211, 166],
    tags: [],
    lastConnectedAt: null,
    createdAt: new Date().toISOString(),
    rememberPassword: false,
    password: ""
  };
}

function normalizeProfiles(profiles: Profile[]) {
  return profiles.map(normalizeProfile);
}

function normalizeProfile(profile: Profile): Profile {
  const protocol = normalizeSavedProtocol(profile.protocol, profile);
  const isLocal = isLocalProtocol(protocol);
  return {
    ...profile,
    protocol,
    group: profile.group || "我的会话",
    port: Number(profile.port || (isLocal ? 0 : 22)),
    username: profile.username || (isLocal ? "" : "root"),
    charset: profile.charset || "UTF-8",
    auth: isLocal ? "Agent" : normalizeAuthProfile(profile.auth),
    color: profile.color ?? [47, 211, 166],
    tags: profile.tags ?? [],
    lastConnectedAt: profile.lastConnectedAt ?? null,
    rememberPassword: Boolean(profile.rememberPassword),
    password: profile.password ?? ""
  };
}

function profileWithProtocol(profile: Profile, nextProtocol: Protocol): Profile {
  const protocol = normalizeSavedProtocol(nextProtocol);
  if (isLocalProtocol(protocol)) {
    return {
      ...profile,
      protocol,
      port: 0,
      auth: "Agent",
      password: "",
      rememberPassword: false
    };
  }

  return {
    ...profile,
    protocol,
    port: Number(profile.port || 22),
    username: profile.username || "root",
    auth: isLocalProtocol(profile.protocol) ? "Password" : normalizeAuthProfile(profile.auth),
    password: profile.password ?? ""
  };
}

function groupProfiles(profiles: Profile[]): [string, Profile[]][] {
  const groups = new Map<string, Profile[]>();
  [...profiles].sort(compareProfilesByCreated).forEach((profile) => {
    const list = groups.get(profile.group) ?? [];
    list.push(profile);
    groups.set(profile.group, list);
  });
  return [...groups.entries()];
}

type SessionFolderNode = {
  name: string;
  path: string;
  children: SessionFolderNode[];
  profiles: Profile[];
};

function buildSessionFolderTree(profiles: Profile[], customFolders: string[]) {
  const rootMap = new Map<string, SessionFolderNode>();
  const ensureFolder = (path: string) => {
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

      let child = node.children.find((item) => item.name === part);
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
    children: node.children
      .map(sortNode)
      .sort((left, right) => sessionGroupSort(left.path, right.path)),
    profiles: [...node.profiles].sort(compareProfilesByCreated)
  });

  return [...rootMap.values()]
    .map(sortNode)
    .sort((left, right) => sessionGroupSort(left.path, right.path));
}

function normalizeSessionGroupPath(value: string) {
  return value
    .split(/[\\/]+/)
    .map(normalizeSessionFolderPart)
    .filter(Boolean)
    .join("/") || "我的会话";
}

function normalizeSessionFolderPart(value: string) {
  return value.trim().replace(/[\\/]+/g, "");
}

function sessionGroupParent(value: string) {
  const parts = normalizeSessionGroupPath(value).split("/");
  if (parts.length <= 1) return "我的会话";
  return parts.slice(0, -1).join("/");
}

function isSessionGroupInsideFolder(group: string, folder: string) {
  const normalizedGroup = normalizeSessionGroupPath(group || "我的会话");
  const normalizedFolder = normalizeSessionGroupPath(folder);
  return normalizedGroup === normalizedFolder || normalizedGroup.startsWith(`${normalizedFolder}/`);
}

function isProtectedSessionFolder(value: string) {
  const normalized = normalizeSessionGroupPath(value);
  return normalized === "我的会话" || normalized === "本地环境";
}

function sessionGroupSort(left: string, right: string) {
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

function normalizeQuickProtocol(protocol: Protocol): Protocol {
  protocol = normalizeSavedProtocol(protocol);
  if (protocol === "Ssh") return "SSH";
  if (protocol === "SftpOnly") return "SFTP";
  return protocol;
}

function normalizeSavedProtocol(protocol?: Protocol | string | null, profile?: Partial<Profile> | null): Protocol {
  const value = String(protocol ?? "").trim().toLowerCase().replace(/[-_\s]/g, "");
  if (value === "ssh") return "Ssh";
  if (value === "sftp" || value === "sftponly") return "SftpOnly";
  if (value === "local" || value === "localshell" || value === "shell") return "LocalShell";
  if (value === "serial") return "Serial";

  if (profile && (profile.host || profile.username || Number(profile.port || 0) > 0)) {
    return "Ssh";
  }

  return "Ssh";
}

function normalizeProtocolLabel(protocol?: Protocol | string | null) {
  if (!protocol) return "-";
  const normalized = normalizeSavedProtocol(protocol);
  if (normalized === "Ssh") return "SSH";
  if (normalized === "SftpOnly") return "SFTP";
  if (normalized === "LocalShell") return "Local";
  return normalized;
}

function formatLastConnected(value?: string | null) {
  const time = profileTimeValue(value);
  if (!time) return "未连接";
  const now = Date.now();
  const diff = Math.max(0, now - time);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  const date = new Date(time);
  if (date.toDateString() === new Date(now).toDateString()) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function shouldPromptForPassword(profile: Profile, message: string) {
  if (isLocalProtocol(profile.protocol)) return false;
  const normalized = message.toLowerCase();
  return (
    message.includes("需要输入密码") ||
    message.includes("认证失败") ||
    message.includes("拒绝认证") ||
    message.includes("密码") ||
    normalized.includes("authentication") ||
    normalized.includes("auth") ||
    normalized.includes("permission denied") ||
    normalized.includes("password")
  );
}

function compactServerOs(value: string) {
  const text = value.trim();
  if (!text || text === "-") return "-";
  const linuxMatch = text.match(/^Linux\s+(\S+)/i);
  if (linuxMatch) {
    const version = linuxMatch[1].split("-")[0];
    const arch = text.match(/\b(x86_64|aarch64|arm64|amd64|i386|i686)\b/i)?.[1];
    return ["Linux", version, arch].filter(Boolean).join(" ");
  }
  return text.length > 34 ? `${text.slice(0, 31)}...` : text;
}

function compactUptime(value: string) {
  const text = value.trim().replace(/^up\s+/i, "");
  if (!text || text === "-") return "-";
  const units: Array<[RegExp, string]> = [
    [/(\d+)\s+years?/i, "年"],
    [/(\d+)\s+weeks?/i, "周"],
    [/(\d+)\s+days?/i, "天"],
    [/(\d+)\s+hours?/i, "时"],
    [/(\d+)\s+minutes?/i, "分"]
  ];
  const parts = units
    .map(([pattern, label]) => {
      const match = text.match(pattern);
      return match ? `${match[1]}${label}` : null;
    })
    .filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.slice(0, 2).join(" ");

  const clock = text.match(/(?:(\d+)\s+days?,?\s*)?(\d{1,2}):(\d{2})/i);
  if (clock) {
    const day = clock[1] ? `${clock[1]}天` : null;
    const hour = `${Number(clock[2])}时`;
    const minute = `${Number(clock[3])}分`;
    return [day, hour, minute].filter(Boolean).slice(0, 2).join(" ");
  }
  return text.length > 18 ? `${text.slice(0, 15)}...` : text;
}

function profileAuthKind(auth: Profile["auth"]) {
  auth = normalizeAuthProfile(auth);
  if (auth === "Password" || auth === "Agent") return auth;
  return "KeyFile";
}

function profileKeyPath(auth: Profile["auth"]) {
  auth = normalizeAuthProfile(auth);
  return typeof auth === "object" && "KeyFile" in auth ? auth.KeyFile.path : "";
}

function isPublicKeyPath(path: string) {
  return path.trim().toLowerCase().endsWith(".pub");
}

function authProfileFromKind(kind: string, keyPath: string): Profile["auth"] {
  if (kind === "Agent") return "Agent";
  if (kind === "KeyFile") return { KeyFile: { path: keyPath } };
  return "Password";
}

function normalizeAuthProfile(auth?: Profile["auth"] | Record<string, unknown> | string | null): Profile["auth"] {
  if (typeof auth === "string") {
    const value = auth.trim().toLowerCase().replace(/[-_\s]/g, "");
    if (value === "agent") return "Agent";
    if (value === "password" || value === "passwordauth") return "Password";
    if (value === "keyfile" || value === "privatekey" || value === "publickey") return { KeyFile: { path: "" } };
  }
  if (auth === "Agent" || auth === "Password") return auth;
  if (typeof auth === "object" && auth && "KeyFile" in auth) {
    const keyFile = (auth as { KeyFile?: { path?: string } }).KeyFile;
    return { KeyFile: { path: keyFile?.path ?? "" } };
  }
  if (typeof auth === "object" && auth) {
    const legacy = auth as { keyFile?: { path?: string }; key_file?: { path?: string }; path?: string };
    if (legacy.keyFile || legacy.key_file || typeof legacy.path === "string") {
      return { KeyFile: { path: legacy.keyFile?.path ?? legacy.key_file?.path ?? legacy.path ?? "" } };
    }
  }
  return "Password";
}

function batchRenameName(
  entry: FileEntry,
  index: number,
  rule: {
    find: string;
    replace: string;
    prefix: string;
    suffix: string;
    preserveExtension: boolean;
    caseSensitive: boolean;
    start: number;
    padding: number;
  }
) {
  const parts = rule.preserveExtension && !entry.isDir ? splitFileExtension(entry.name) : { stem: entry.name, extension: "" };
  const number = String(rule.start + index).padStart(rule.padding, "0");
  const applyNumber = (value: string) => value.split("{n}").join(number);
  const replaced = rule.find
    ? rule.caseSensitive
      ? parts.stem.split(rule.find).join(applyNumber(rule.replace))
      : parts.stem.replace(new RegExp(escapeRegExp(rule.find), "gi"), applyNumber(rule.replace))
    : parts.stem;
  return `${applyNumber(rule.prefix)}${replaced}${applyNumber(rule.suffix)}${parts.extension}`.trim();
}

function splitFileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return { stem: name, extension: "" };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function batchRenameNumberConfig(start: string, padding: string) {
  const startText = start.trim();
  const paddingText = padding.trim();
  const startValue = Number.parseInt(startText, 10);
  const paddingValue = Number.parseInt(paddingText, 10);
  const invalid =
    !/^\d+$/.test(startText) ||
    !/^\d+$/.test(paddingText) ||
    !Number.isInteger(startValue) ||
    !Number.isInteger(paddingValue) ||
    startValue < 0 ||
    startValue > 999999 ||
    paddingValue < 0 ||
    paddingValue > 12;
  return {
    start: invalid ? 1 : startValue,
    padding: invalid ? 0 : paddingValue,
    invalid
  };
}

function batchRenameIssue(
  entry: FileEntry,
  newName: string,
  targetCounts: Map<string, number>,
  existingNames: Set<string>,
  selectedNames: Set<string>
) {
  if (!newName) return "名称为空";
  if (/[\\/]/.test(newName)) return "包含路径分隔符";
  if (newName === "." || newName === "..") return "名称不可用";
  if ((targetCounts.get(newName) ?? 0) > 1) return "目标重名";
  if (newName !== entry.name && selectedNames.has(newName)) return "占用原名称";
  if (newName !== entry.name && existingNames.has(newName) && !selectedNames.has(newName)) return "已存在";
  return "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLocalProtocol(protocol?: Protocol | string | null) {
  const normalized = normalizeSavedProtocol(protocol);
  return normalized === "LocalShell";
}

function isSshProtocol(protocol?: Protocol | string | null) {
  const normalized = normalizeSavedProtocol(protocol);
  return normalized === "Ssh";
}

function isRemoteProtocol(protocol?: Protocol | string | null) {
  const normalized = normalizeSavedProtocol(protocol);
  return normalized === "Ssh" || normalized === "SftpOnly";
}

function color(value: [number, number, number]) {
  return `rgb(${value[0]}, ${value[1]}, ${value[2]})`;
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatEta(value?: number | null) {
  if (!value) return "ETA -";
  if (value < 60) return `ETA ${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes < 60) return `ETA ${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `ETA ${hours}h ${minutes % 60}m`;
}

function formatTransferTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function conflictLabel(value: TransferConflictStrategy) {
  if (value === "skip") return "跳过";
  if (value === "rename") return "重命名";
  if (value === "resume") return "续传";
  return "覆盖";
}

function transferStatusLabel(value: TransferView["status"]) {
  if (value === "running") return "传输中";
  if (value === "done") return "完成";
  if (value === "failed") return "失败";
  return "已取消";
}

function filePaneStats(files: FileEntry[], selectedEntries: FileEntry[]) {
  const visible = `${files.length} 个项目`;
  if (selectedEntries.length === 0) {
    return {
      visible,
      selected: "",
      title: visible
    };
  }

  const selectedFiles = selectedEntries.filter((entry) => !entry.isDir);
  const selectedDirs = selectedEntries.length - selectedFiles.length;
  const selectedSize = selectedFiles.reduce((sum, entry) => sum + entry.size, 0);
  const parts = [`已选择 ${selectedEntries.length} 个项目`];
  if (selectedFiles.length > 0) parts.push(formatSize(selectedSize));
  if (selectedDirs > 0) parts.push(`${selectedDirs} 个目录`);
  return {
    visible,
    selected: parts.join(" / "),
    title: `${visible}，${parts.join(" / ")}`
  };
}

function fileTypeLabel(entry: FileEntry) {
  if (entry.fileType === "symlink") return "符号链接";
  if (entry.isDir || entry.fileType === "directory") return "目录";
  return "文件";
}

function canEditTextFile(entry?: FileEntry | null) {
  return Boolean(entry && !entry.isDir && entry.fileType !== "symlink");
}

function pickSelection(files: FileEntry[], preferPath?: string, previous?: FileEntry | null) {
  const targetPath = preferPath || previous?.path;
  if (!targetPath) return null;
  return files.find((file) => file.path === targetPath) ?? null;
}

function pushHistory(history: string[], path: string, front = false) {
  const value = path.trim();
  if (!value) return history;
  if (front) {
    if (history[0] === value) return history;
    return [value, ...history].slice(0, 80);
  }
  if (history[history.length - 1] === value) return history;
  return [...history, value].slice(-80);
}

function loadPathBookmarks(side: FileSide): PathBookmark[] {
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

function downloadTextFile(name: string, content: string, type = "application/json;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fileInfoCsvName(side: FileSide) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-${side}-file-info-${stamp}.csv`;
}

function sha256AuditCsvName(side: FileSide) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-${side}-sha256-audit-${stamp}.csv`;
}

function sha256AuditJsonName(side: FileSide) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-${side}-sha256-audit-${stamp}.json`;
}

function propertiesReportCsvName(side: FileSide) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-${side}-properties-${stamp}.csv`;
}

function propertiesReportJsonName(side: FileSide) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-${side}-properties-${stamp}.json`;
}

function directoryListingCsvName(side: FileSide) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-${side}-directory-listing-${stamp}.csv`;
}

function deleteConfirmCsvName(side: FileSide) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-${side}-delete-confirm-${stamp}.csv`;
}

function deleteConfirmJsonName(side: FileSide) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-${side}-delete-confirm-${stamp}.json`;
}

function directoryCompareCsvName(scope = "all") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-directory-compare-${scope}-${stamp}.csv`;
}

function directoryCompareJsonName(scope = "all") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-directory-compare-${scope}-${stamp}.json`;
}

function transferAuditCsvName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-transfer-audit-${stamp}.csv`;
}

function transferAuditJsonName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-transfer-audit-${stamp}.json`;
}

function pickTextFile(accept: string) {
  return new Promise<string | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file.text().then(finish, (error) => {
        input.remove();
        reject(error);
      });
    };
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

function savePathBookmarks(side: FileSide, bookmarks: PathBookmark[]) {
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

function loadSessionFolders() {
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

function saveSessionFolders(folders: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(sessionFolderStorageKey, JSON.stringify(folders));
  } catch {
    // Ignore localStorage failures; folders remain available until reload.
  }
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

function upsertBookmark(bookmarks: PathBookmark[], next: PathBookmark) {
  return [next, ...bookmarks.filter((bookmark) => bookmark.path !== next.path)].slice(0, 80);
}

function bookmarkLabel(path: string) {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  if (!normalized) return path.trim() || "路径";
  const segments = normalized.split(/[\\/]+/);
  return segments[segments.length - 1] || normalized;
}

function visibleFiles(files: FileEntry[], showHidden: boolean, filter: string) {
  const needle = filter.trim().toLowerCase();
  return files.filter((file) => {
    if (!showHidden && isHiddenFile(file)) return false;
    if (!needle) return true;
    return fileSearchText(file).includes(needle);
  });
}

function visibleSelection(selected: FileEntry | null, showHidden: boolean, filter: string) {
  if (!selected) return null;
  if (!showHidden && isHiddenFile(selected)) return null;
  const needle = filter.trim().toLowerCase();
  if (needle && !fileSearchText(selected).includes(needle)) return null;
  return selected;
}

function selectionVisibleInFiles(selected: FileEntry | null, files: FileEntry[]) {
  if (!selected) return null;
  return files.some((file) => file.path === selected.path) ? selected : null;
}

function selectedEntries(files: FileEntry[], selectedPaths: string[], selected: FileEntry | null) {
  const selectedPathSet = new Set(selectedPaths);
  const entries = files.filter((file) => selectedPathSet.has(file.path));
  if (entries.length > 0) return entries;
  return selected ? [selected] : [];
}

function filterCompareView(files: FileEntry[], marks: Map<string, FileCompareMark>, view: CompareView) {
  if (view === "all") return files;
  return files.filter((file) => {
    const kind = marks.get(file.path)?.kind;
    if (view === "same") return kind === "same";
    if (view === "diff") return kind === "only-local" || kind === "only-remote" || kind === "different";
    return kind === view;
  });
}

function buildDirectoryCompare(localFiles: FileEntry[], remoteFiles: FileEntry[]): DirectoryCompare {
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

function compareFilePair(left: FileEntry, right: FileEntry): FileCompareMark {
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

function compareKindLabel(kind: FileCompareKind) {
  if (kind === "only-local") return "仅本地";
  if (kind === "only-remote") return "仅远程";
  if (kind === "different") return "不同";
  return "相同";
}

function compareMarkLabel(mark: FileCompareMark) {
  if (mark.kind !== "different") return compareKindLabel(mark.kind);
  const detail = mark.detail.replace(/^差异:\s*/, "");
  return detail ? `${detail}不同` : "不同";
}

function remoteSftpUri(profile: Profile, path: string) {
  const user = encodeURIComponent(profile.username || "user");
  const host = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
  const port = profile.port || 22;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const encodedPath = normalizedPath
    .split("/")
    .map((part, index) => (index === 0 ? "" : encodeURIComponent(part)))
    .join("/");
  return `sftp://${user}@${host}:${port}${encodedPath}`;
}

function connectionCommand(profile: Profile) {
  const isSftp = normalizeSavedProtocol(profile.protocol) === "SftpOnly";
  const args = [isSftp ? "sftp" : "ssh"];
  const port = Number(profile.port || 22);
  if (port !== 22) args.push(isSftp ? "-P" : "-p", String(port));
  args.push(...keyFileArgs(profile));
  args.push(scpRemotePrefix(profile));
  return args.join(" ");
}

function scpUploadCommand(profile: Profile, entry: FileEntry, remoteDir: string) {
  return scpCommand(profile, entry.isDir, shellQuote(entry.path), `${scpRemotePrefix(profile)}:${shellQuote(remoteDir || ".")}`);
}

function scpDownloadCommand(profile: Profile, entry: FileEntry, localDir: string) {
  return scpCommand(profile, entry.isDir, `${scpRemotePrefix(profile)}:${shellQuote(entry.path)}`, shellQuote(localDir || "."));
}

function rsyncUploadCommand(profile: Profile, entry: FileEntry, remoteDir: string, dryRun = false) {
  return rsyncCommand(profile, shellQuote(entry.path), shellQuote(`${scpRemotePrefix(profile)}:${remoteDir || "."}`), dryRun);
}

function rsyncDownloadCommand(profile: Profile, entry: FileEntry, localDir: string, dryRun = false) {
  return rsyncCommand(profile, shellQuote(`${scpRemotePrefix(profile)}:${entry.path}`), shellQuote(localDir || "."), dryRun);
}

function rsyncCommand(profile: Profile, source: string, target: string, dryRun = false) {
  const args = ["rsync", "-a", "--partial", "--progress", "-e", shellQuote(sshTransportCommand(profile)), source, target];
  if (dryRun) args.splice(1, 0, "--dry-run", "--itemize-changes");
  return args.join(" ");
}

function localChmodCommand(entry: FileEntry) {
  return `chmod ${formatMode(entry.permissions)} ${shellQuote(entry.path)}`;
}

function remoteChmodCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `chmod ${formatMode(entry.permissions)} ${shellQuote(entry.path)}`);
}

function remoteChownCommand(profile: Profile, entry: FileEntry) {
  const owner = `${entry.uid ?? ""}:${entry.gid ?? ""}`;
  return sshRemoteCommand(profile, `chown ${owner} ${shellQuote(entry.path)}`);
}

function localTouchCommand(entry: FileEntry) {
  return `touch -m -t ${touchTimestamp(entry.modifiedAt)} ${shellQuote(entry.path)}`;
}

function remoteTouchCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `touch -m -t ${touchTimestamp(entry.modifiedAt)} ${shellQuote(entry.path)}`);
}

function remoteSymlinkCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `ln -s -- ${shellQuote(entry.linkTarget ?? "")} ${shellQuote(entry.path)}`);
}

function remoteDeleteCommand(profile: Profile, entry: FileEntry) {
  const recursive = entry.isDir && entry.fileType !== "symlink";
  return sshRemoteCommand(profile, `rm ${recursive ? "-r " : ""}-- ${shellQuote(entry.path)}`);
}

function remoteStatCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `stat -- ${shellQuote(entry.path)}`);
}

function remoteSha256Command(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `sha256sum -- ${shellQuote(entry.path)}`);
}

function remoteDuCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `du -sh -- ${shellQuote(entry.path)}`);
}

function remoteListCommand(profile: Profile, entry: FileEntry) {
  return sshRemoteCommand(profile, `ls -ld -- ${shellQuote(entry.path)}`);
}

function sshRemoteCommand(profile: Profile, command: string) {
  return `${sshTransportCommand(profile)} -- ${scpRemotePrefix(profile)} ${command}`;
}

function sshTransportCommand(profile: Profile) {
  const args = ["ssh"];
  if ((profile.port || 22) !== 22) args.push("-p", String(profile.port || 22));
  args.push(...keyFileArgs(profile));
  return args.join(" ");
}

function scpCommand(profile: Profile, recursive: boolean, source: string, target: string) {
  const args = ["scp"];
  if ((profile.port || 22) !== 22) args.push("-P", String(profile.port || 22));
  args.push(...keyFileArgs(profile));
  if (recursive) args.push("-r");
  args.push(source, target);
  return args.join(" ");
}

function keyFileArgs(profile: Profile) {
  const auth = normalizeAuthProfile(profile.auth);
  if (typeof auth === "object" && "KeyFile" in auth && auth.KeyFile.path.trim()) {
    return ["-i", shellQuote(auth.KeyFile.path.trim())];
  }
  return [];
}

function scpRemotePrefix(profile: Profile) {
  const user = profile.username || "user";
  const host = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
  return `${user}@${host}`;
}

function togglePath(paths: string[], path: string) {
  if (paths.includes(path)) {
    const next = paths.filter((item) => item !== path);
    return next.length > 0 ? next : [path];
  }
  return [...paths, path];
}

function commonEntryValue(entries: FileEntry[], getValue: (entry: FileEntry) => string) {
  if (entries.length === 0) return "";
  const first = getValue(entries[0]);
  return entries.every((entry) => getValue(entry) === first) ? first : "";
}

function isHiddenFile(file: FileEntry) {
  return file.name.startsWith(".") && file.name !== "." && file.name !== "..";
}

function fileSearchText(file: FileEntry) {
  return `${file.name}\n${file.path}\n${file.linkTarget ?? ""}`.toLowerCase();
}

function nextFileSort(current: FileSort, key: FileSortKey): FileSort {
  if (current.key !== key) return { key, direction: key === "name" ? "asc" : "desc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

function sortFiles(files: FileEntry[], sort: FileSort) {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...files].sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    const primary = compareFileValue(left, right, sort.key);
    if (primary !== 0) return primary * direction;
    return compareText(left.name, right.name);
  });
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

function duplicateName(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${name.slice(0, dot)} copy${name.slice(dot)}`;
  return `${name} copy`;
}

function uniqueDuplicateName(name: string, occupiedNames: Set<string>) {
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

function remoteParentPath(path: string) {
  const trimmed = path.trim().replace(/\/+$/g, "");
  if (!trimmed || trimmed === ".") return ".";
  if (trimmed === "/") return "/";
  const index = trimmed.lastIndexOf("/");
  if (index === 0) return "/";
  if (index > 0) return trimmed.slice(0, index);
  return ".";
}

function localParentPath(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) return ".";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slash < 0) return ".";
  if (slash === 0) return trimmed[0];
  if (slash === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, slash);
}

function parentPathForSide(side: FileSide, path: string) {
  return side === "remote" ? remoteParentPath(path) : localParentPath(path);
}

function relativePathForSide(side: FileSide, basePath: string, path: string) {
  return side === "remote" ? remoteRelativePath(basePath, path) : localRelativePath(basePath, path);
}

function remoteRelativePath(basePath: string, path: string) {
  const base = normalizeRemotePath(basePath);
  const target = normalizeRemotePath(path);
  if (!base || base === ".") return target;
  if (target === base) return ".";
  const prefix = base === "/" ? "/" : `${base}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : path;
}

function localRelativePath(basePath: string, path: string) {
  const base = normalizeLocalComparablePath(basePath);
  const target = normalizeLocalComparablePath(path);
  if (!base || base === ".") return path;
  if (target === base) return ".";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return target.startsWith(prefix) ? path.replace(/\\/g, "/").slice(prefix.length) : path;
}

function normalizeRemotePath(path: string) {
  const collapsed = path.trim().replace(/\/+/g, "/");
  if (!collapsed) return ".";
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/g, "");
}

function normalizeLocalComparablePath(path: string) {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return trimmed.toLowerCase();
}

function transferUploadResultPath(transfer: TransferView) {
  if (transfer.status === "done" && transfer.message) return transfer.message;
  return joinRemotePath(transfer.target || ".", pathBaseName(transfer.source));
}

function transferDownloadResultPath(transfer: TransferView) {
  if (transfer.status === "done" && transfer.message) return transfer.message;
  return joinLocalPath(transfer.target || ".", pathBaseName(transfer.source));
}

function transferDetailText(transfer: TransferView, profiles: Profile[]) {
  const profile = profiles.find((item) => item.id === transfer.profileId);
  const resultPath = transfer.direction === "upload" ? transferUploadResultPath(transfer) : transferDownloadResultPath(transfer);
  return [
    "RustShell Transfer",
    `ID: ${transfer.id}`,
    `Session: ${profile?.name ?? "-"} (${transfer.profileId})`,
    `Direction: ${transfer.direction === "upload" ? "上传" : "下载"}`,
    `Status: ${transferStatusLabel(transfer.status)} (${transfer.status})`,
    `Conflict: ${conflictLabel(transfer.conflictStrategy)} (${transfer.conflictStrategy})`,
    `Source: ${transfer.source}`,
    `Target: ${transfer.target}`,
    `Result: ${resultPath}`,
    `Progress: ${transferAuditPercent(transfer)}% (${transfer.transferred}/${transfer.total || "-"} bytes)`,
    `Speed: ${transfer.speedBps} B/s`,
    `ETA: ${transfer.etaSeconds == null ? "-" : `${transfer.etaSeconds}s`}`,
    `Attempts: ${transfer.attempts}`,
    `Finished At: ${transfer.finishedAt ? formatTransferTime(transfer.finishedAt) : "-"}`,
    `Message: ${transfer.message ?? "-"}`
  ].join("\n");
}

function pathBaseName(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) return "";
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function resolveSymlinkTargetPath(side: FileSide, entry: FileEntry) {
  const target = entry.linkTarget?.trim() ?? "";
  if (!target) return "";
  if (side === "remote") {
    return target.startsWith("/") ? target : joinRemotePath(remoteParentPath(entry.path), target);
  }
  return isLocalAbsolutePath(target) ? target : joinLocalPath(localParentPath(entry.path), target);
}

function joinRemotePath(parent: string, child: string) {
  if (!parent || parent === ".") return child;
  if (parent === "/") return `/${child.replace(/^\/+/g, "")}`;
  return `${parent.replace(/\/+$/g, "")}/${child.replace(/^\/+/g, "")}`;
}

function joinLocalPath(parent: string, child: string) {
  if (!parent || parent === ".") return child;
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/g, "")}${separator}${child.replace(/^[\\/]+/g, "")}`;
}

function isLocalAbsolutePath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function localCdCommand(path: string, shellCommand = "") {
  if (isPowerShellCommand(shellCommand)) {
    return `Set-Location -LiteralPath ${powershellQuote(path)}\r`;
  }
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    return `cd /d ${cmdQuote(path)}\r`;
  }
  return `cd -- ${shellQuote(path)}\r`;
}

function isPowerShellCommand(shellCommand: string) {
  const command = pathBaseName(firstCommandPart(shellCommand)).toLowerCase();
  return command === "powershell.exe" || command === "powershell" || command === "pwsh.exe" || command === "pwsh";
}

function firstCommandPart(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const quote = trimmed[0] === '"' || trimmed[0] === "'" ? trimmed[0] : "";
  if (quote) {
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

function powershellQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function cmdQuote(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function formatFileDateTime(value: string, withSeconds = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (part: number) => String(part).padStart(2, "0");
  const base = `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

function fileInfoTable(entries: FileEntry[]) {
  return fileInfoRows(entries)
    .map((row) => row.map(escapeTsvCell).join("\t"))
    .join("\n");
}

function fileInfoCsv(entries: FileEntry[]) {
  return "\ufeff" + fileInfoRows(entries)
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n");
}

function sha256AuditCsv(records: Sha256AuditRecord[]) {
  const generated = formatFileDateTime(new Date().toISOString(), true);
  const rows = [
    ["side", "generated_at", "name", "path", "type", "size_bytes", "modified_at", "mode", "owner", "sha256"],
    ...records.map((record) => [
      record.side,
      generated,
      record.file.name,
      record.file.path,
      fileTypeLabel(record.file),
      String(record.file.size),
      formatFileDateTime(record.file.modifiedAt, true),
      formatMode(record.file.permissions) || "",
      formatOwner(record.file),
      record.hash
    ])
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function sha256AuditJson(records: Sha256AuditRecord[]) {
  const sides = [...new Set(records.map((record) => record.side))];
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sides,
      summary: {
        total: records.length,
        local: records.filter((record) => record.side === "local").length,
        remote: records.filter((record) => record.side === "remote").length,
        bytes: records.reduce((total, record) => total + (record.file.isDir ? 0 : record.file.size), 0)
      },
      records: records.map((record) => ({
        side: record.side,
        sha256: record.hash,
        name: record.file.name,
        path: record.file.path,
        type: fileTypeLabel(record.file),
        fileType: record.file.fileType,
        size: record.file.isDir ? null : record.file.size,
        modifiedAt: record.file.modifiedAt,
        mode: formatMode(record.file.permissions) || null,
        symbolicMode: record.file.permissions == null ? null : formatEntrySymbolicMode(record.file),
        owner: record.file.uid == null && record.file.gid == null ? null : `${record.file.uid ?? ""}:${record.file.gid ?? ""}`,
        uid: record.file.uid ?? null,
        gid: record.file.gid ?? null,
        linkTarget: record.file.linkTarget ?? null
      }))
    },
    null,
    2
  );
}

function propertiesReportText(
  side: FileSide,
  entries: FileEntry[],
  options: PropertiesReportOptions
) {
  const multiple = entries.length > 1;
  const primary = entries[0];
  const lines = [
    "RustShell Properties",
    `Side: ${side === "local" ? "local" : "remote"}`,
    `Items: ${entries.length}`,
    `Generated: ${formatFileDateTime(new Date().toISOString(), true)}`
  ];
  if (primary && !multiple) {
    lines.push(
      `Name: ${primary.name}`,
      `Path: ${primary.path}`,
      `Type: ${fileTypeLabel(primary)}`,
      `Link target: ${primary.linkTarget ?? "-"}`,
      `Size: ${primary.isDir ? options.stats ? String(options.stats.totalSize) : "-" : String(primary.size)}`,
      `Size label: ${primary.isDir ? options.stats ? formatSize(options.stats.totalSize) : "-" : formatSize(primary.size)}`,
      `Mode: ${formatMode(primary.permissions) || "-"}`,
      `Owner: ${formatOwner(primary)}`,
      `Modified: ${formatFileDateTime(primary.modifiedAt, true)}`
    );
    if (options.stats) {
      lines.push(`Files: ${options.stats.fileCount}`, `Directories: ${options.stats.dirCount}`);
    }
    if (options.checksum) {
      lines.push(`SHA-256: ${options.checksum}`);
    }
  } else {
    lines.push(
      `Draft mode: ${options.mode || "(unchanged)"}`,
      `Draft uid: ${options.uid || "(unchanged)"}`,
      `Draft gid: ${options.gid || "(unchanged)"}`,
      `Draft mtime: ${options.mtime || "(unchanged)"}`,
      `Recursive: ${options.recursive ? "yes" : "no"}`,
      "",
      "Items:",
      ...entries.map(
        (entry) =>
          `- ${entry.path} | ${fileTypeLabel(entry)} | ${formatMode(entry.permissions) || "-"} | ${formatOwner(entry)} | ${
            entry.isDir ? "-" : entry.size
          } | ${formatFileDateTime(entry.modifiedAt, true)}${entry.linkTarget ? ` | -> ${entry.linkTarget}` : ""}`
      )
    );
  }
  return lines.join("\n");
}

function propertiesReportCsv(side: FileSide, entries: FileEntry[], options: PropertiesReportOptions) {
  const generated = formatFileDateTime(new Date().toISOString(), true);
  const multiple = entries.length > 1;
  const rows = [
    [
      "side",
      "generated_at",
      "selection_count",
      "name",
      "path",
      "type",
      "link_target",
      "mode",
      "owner",
      "uid",
      "gid",
      "size_bytes",
      "modified_at",
      "draft_mode",
      "draft_uid",
      "draft_gid",
      "draft_mtime",
      "recursive",
      "stats_total_size",
      "stats_file_count",
      "stats_dir_count",
      "sha256"
    ],
    ...entries.map((entry, index) => [
      side,
      generated,
      String(entries.length),
      entry.name,
      entry.path,
      fileTypeLabel(entry),
      entry.linkTarget ?? "",
      formatMode(entry.permissions) || "",
      formatOwner(entry),
      entry.uid == null ? "" : String(entry.uid),
      entry.gid == null ? "" : String(entry.gid),
      entry.isDir ? "" : String(entry.size),
      formatFileDateTime(entry.modifiedAt, true),
      options.mode,
      options.uid,
      options.gid,
      options.mtime,
      options.recursive ? "true" : "false",
      !multiple && index === 0 && options.stats ? String(options.stats.totalSize) : "",
      !multiple && index === 0 && options.stats ? String(options.stats.fileCount) : "",
      !multiple && index === 0 && options.stats ? String(options.stats.dirCount) : "",
      !multiple && index === 0 ? options.checksum : ""
    ])
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function propertiesReportJson(side: FileSide, entries: FileEntry[], options: PropertiesReportOptions) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      side,
      selectionCount: entries.length,
      draft: {
        mode: options.mode || null,
        uid: options.uid || null,
        gid: options.gid || null,
        mtime: options.mtime || null,
        recursive: options.recursive
      },
      stats: options.stats
        ? {
            totalSize: options.stats.totalSize,
            fileCount: options.stats.fileCount,
            dirCount: options.stats.dirCount
          }
        : null,
      checksum: options.checksum || null,
      items: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: fileTypeLabel(entry),
        fileType: entry.fileType,
        isDir: entry.isDir,
        linkTarget: entry.linkTarget ?? null,
        size: entry.isDir ? null : entry.size,
        modifiedAt: entry.modifiedAt,
        mode: formatMode(entry.permissions) || null,
        symbolicMode: entry.permissions == null ? null : formatEntrySymbolicMode(entry),
        uid: entry.uid ?? null,
        gid: entry.gid ?? null,
        owner: entry.uid == null && entry.gid == null ? null : `${entry.uid ?? ""}:${entry.gid ?? ""}`
      }))
    },
    null,
    2
  );
}

function deleteConfirmCsv(side: FileSide, entries: FileEntry[]) {
  const rows = [
    ["side", "action", "name", "type", "recursive", "mode", "owner", "size", "modified", "path"],
    ...entries.map((entry) => [
      side,
      "delete",
      entry.name,
      fileTypeLabel(entry),
      entry.isDir ? "true" : "false",
      formatMode(entry.permissions) || "-",
      formatOwner(entry),
      entry.isDir ? "" : String(entry.size),
      formatFileDateTime(entry.modifiedAt, true),
      entry.path
    ])
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function deleteConfirmJson(side: FileSide, entries: FileEntry[]) {
  const files = entries.filter((entry) => !entry.isDir);
  const dirs = entries.filter((entry) => entry.isDir);
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      side,
      action: "delete",
      recursiveDirectories: true,
      summary: {
        total: entries.length,
        files: files.length,
        directories: dirs.length,
        bytes: files.reduce((total, entry) => total + entry.size, 0)
      },
      items: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: fileTypeLabel(entry),
        fileType: entry.fileType,
        recursive: entry.isDir,
        isDir: entry.isDir,
        size: entry.isDir ? null : entry.size,
        modifiedAt: entry.modifiedAt,
        mode: formatMode(entry.permissions) || null,
        symbolicMode: entry.permissions == null ? null : formatEntrySymbolicMode(entry),
        uid: entry.uid ?? null,
        gid: entry.gid ?? null,
        owner: entry.uid == null && entry.gid == null ? null : `${entry.uid ?? ""}:${entry.gid ?? ""}`,
        linkTarget: entry.linkTarget ?? null
      }))
    },
    null,
    2
  );
}

function directoryCompareCsv(
  localFiles: FileEntry[],
  remoteFiles: FileEntry[],
  compare: DirectoryCompare,
  options: { includeSame?: boolean } = {}
) {
  const includeSame = options.includeSame ?? true;
  const localByName = new Map(localFiles.map((file) => [file.name, file]));
  const remoteByName = new Map(remoteFiles.map((file) => [file.name, file]));
  const names = [...new Set([...localByName.keys(), ...remoteByName.keys()])].filter((name) => {
    if (includeSame) return true;
    const local = localByName.get(name) ?? null;
    const remote = remoteByName.get(name) ?? null;
    const mark = local ? compare.local.get(local.path) : remote ? compare.remote.get(remote.path) : null;
    return Boolean(mark && mark.kind !== "same");
  });
  const rows = [
    [
      "name",
      "status",
      "detail",
      "local_path",
      "remote_path",
      "local_type",
      "remote_type",
      "local_mode",
      "remote_mode",
      "local_owner",
      "remote_owner",
      "local_size",
      "remote_size",
      "local_modified",
      "remote_modified"
    ],
    ...names.map((name) => {
      const local = localByName.get(name) ?? null;
      const remote = remoteByName.get(name) ?? null;
      const mark = local ? compare.local.get(local.path) : remote ? compare.remote.get(remote.path) : null;
      return [
        name,
        mark ? compareKindLabel(mark.kind) : "-",
        mark?.detail ?? "-",
        local?.path ?? "",
        remote?.path ?? "",
        local ? fileTypeLabel(local) : "",
        remote ? fileTypeLabel(remote) : "",
        local ? formatMode(local.permissions) || "-" : "",
        remote ? formatMode(remote.permissions) || "-" : "",
        local ? formatOwner(local) : "",
        remote ? formatOwner(remote) : "",
        local ? (local.isDir ? "-" : String(local.size)) : "",
        remote ? (remote.isDir ? "-" : String(remote.size)) : "",
        local ? formatFileDateTime(local.modifiedAt, true) : "",
        remote ? formatFileDateTime(remote.modifiedAt, true) : ""
      ];
    })
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function directoryCompareJson(
  localRoot: string,
  remoteRoot: string,
  localFiles: FileEntry[],
  remoteFiles: FileEntry[],
  compare: DirectoryCompare
) {
  const localByName = new Map(localFiles.map((file) => [file.name, file]));
  const remoteByName = new Map(remoteFiles.map((file) => [file.name, file]));
  const names = [...new Set([...localByName.keys(), ...remoteByName.keys()])].sort((left, right) =>
    left.localeCompare(right, "zh-Hans-CN")
  );
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      localRoot,
      remoteRoot,
      summary: compare.summary,
      items: names.map((name) => {
        const local = localByName.get(name) ?? null;
        const remote = remoteByName.get(name) ?? null;
        const mark = local ? compare.local.get(local.path) : remote ? compare.remote.get(remote.path) : null;
        return {
          name,
          status: mark?.kind ?? "different",
          statusLabel: mark ? compareKindLabel(mark.kind) : "-",
          detail: mark?.detail ?? "",
          local: local ? directoryCompareJsonEntry(local) : null,
          remote: remote ? directoryCompareJsonEntry(remote) : null
        };
      })
    },
    null,
    2
  );
}

function directoryCompareJsonEntry(entry: FileEntry) {
  return {
    path: entry.path,
    type: fileTypeLabel(entry),
    fileType: entry.fileType,
    isDir: entry.isDir,
    size: entry.isDir ? null : entry.size,
    modifiedAt: entry.modifiedAt,
    mode: formatMode(entry.permissions) || null,
    owner: entry.uid == null && entry.gid == null ? null : `${entry.uid ?? ""}:${entry.gid ?? ""}`,
    linkTarget: entry.linkTarget ?? null
  };
}

function transferAuditCsv(transfers: TransferView[], profiles: Profile[]) {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const rows = [
    [
      "id",
      "profile_id",
      "profile_name",
      "direction",
      "direction_label",
      "status",
      "status_label",
      "conflict_strategy",
      "conflict_label",
      "source",
      "target",
      "result_path",
      "transferred_bytes",
      "total_bytes",
      "progress_percent",
      "speed_bps",
      "eta_seconds",
      "attempts",
      "finished_at",
      "message"
    ],
    ...transfers.map((transfer) => {
      const profile = profileById.get(transfer.profileId);
      return [
        transfer.id,
        transfer.profileId,
        profile?.name ?? "",
        transfer.direction,
        transfer.direction === "upload" ? "上传" : "下载",
        transfer.status,
        transferStatusLabel(transfer.status),
        transfer.conflictStrategy,
        conflictLabel(transfer.conflictStrategy),
        transfer.source,
        transfer.target,
        transfer.direction === "upload" ? transferUploadResultPath(transfer) : transferDownloadResultPath(transfer),
        String(transfer.transferred),
        String(transfer.total),
        String(transferAuditPercent(transfer)),
        String(transfer.speedBps),
        transfer.etaSeconds == null ? "" : String(transfer.etaSeconds),
        String(transfer.attempts),
        transfer.finishedAt ?? "",
        transfer.message ?? ""
      ];
    })
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function transferAuditJson(transfers: TransferView[], profiles: Profile[]) {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: {
        total: transfers.length,
        running: transfers.filter((transfer) => transfer.status === "running").length,
        done: transfers.filter((transfer) => transfer.status === "done").length,
        failed: transfers.filter((transfer) => transfer.status === "failed").length,
        cancelled: transfers.filter((transfer) => transfer.status === "cancelled").length,
        uploaded: transfers.filter((transfer) => transfer.direction === "upload").length,
        downloaded: transfers.filter((transfer) => transfer.direction === "download").length
      },
      transfers: transfers.map((transfer) => {
        const profile = profileById.get(transfer.profileId);
        return {
          id: transfer.id,
          profileId: transfer.profileId,
          profileName: profile?.name ?? null,
          endpoint: profile ? `${profile.username}@${profile.host}:${profile.port}` : null,
          direction: transfer.direction,
          directionLabel: transfer.direction === "upload" ? "上传" : "下载",
          status: transfer.status,
          statusLabel: transferStatusLabel(transfer.status),
          conflictStrategy: transfer.conflictStrategy,
          conflictLabel: conflictLabel(transfer.conflictStrategy),
          source: transfer.source,
          target: transfer.target,
          resultPath: transfer.direction === "upload" ? transferUploadResultPath(transfer) : transferDownloadResultPath(transfer),
          transferredBytes: transfer.transferred,
          totalBytes: transfer.total,
          progressPercent: transferAuditPercent(transfer),
          speedBps: transfer.speedBps,
          etaSeconds: transfer.etaSeconds ?? null,
          attempts: transfer.attempts,
          finishedAt: transfer.finishedAt ?? null,
          message: transfer.message ?? null
        };
      })
    },
    null,
    2
  );
}

function transferAuditRecords(transfers: TransferView[], history: TransferView[]) {
  const seen = new Set<string>();
  return [...transfers, ...history].filter((transfer) => {
    if (seen.has(transfer.id)) return false;
    seen.add(transfer.id);
    return true;
  });
}

function metadataSyncChanges(source: FileEntry, target: FileEntry, direction: "upload" | "download") {
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

function syncPlanActionLabel(action: SyncPlanItem["action"]) {
  if (action === "create") return "新增";
  if (action === "metadata") return "元数据";
  return "覆盖";
}

function syncPlanCsvName(plan: SyncPlanState) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-sync-plan-${plan.direction}-${plan.scope}-${stamp}.csv`;
}

function syncPlanJsonName(plan: SyncPlanState) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `rustshell-sync-plan-${plan.direction}-${plan.scope}-${stamp}.json`;
}

function syncPlanCsv(plan: SyncPlanState, conflict: TransferConflictStrategy) {
  const rows = [
    ["mode", "direction", "scope", "conflict_strategy", "action", "changes", "name", "type", "size", "source", "target", "detail"],
    ...plan.items.map((item) => [
      plan.mode,
      plan.direction,
      plan.scope,
      plan.mode === "transfer" ? conflict : "",
      item.action,
      item.changes?.join("|") ?? "",
      item.name,
      item.entry.isDir ? "directory" : item.entry.fileType,
      item.entry.isDir ? "" : String(item.entry.size),
      item.source,
      item.target,
      item.detail
    ])
  ];
  return "\ufeff" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

function syncPlanJson(plan: SyncPlanState, conflict: TransferConflictStrategy) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      title: plan.title,
      mode: plan.mode,
      direction: plan.direction,
      scope: plan.scope,
      conflictStrategy: plan.mode === "transfer" ? conflict : null,
      summary: {
        total: plan.items.length,
        create: plan.items.filter((item) => item.action === "create").length,
        overwrite: plan.items.filter((item) => item.action === "overwrite").length,
        metadata: plan.items.filter((item) => item.action === "metadata").length,
        bytes: plan.items.reduce((total, item) => total + (item.entry.isDir ? 0 : item.entry.size), 0)
      },
      items: plan.items.map((item) => {
        const source = item.sourceEntry ?? item.entry;
        const target = item.targetEntry;
        return {
          action: item.action,
          changes: item.changes ?? [],
          name: item.name,
          type: item.entry.isDir ? "directory" : item.entry.fileType,
          size: item.entry.isDir ? null : item.entry.size,
          source: item.source,
          target: item.target,
          detail: item.detail,
          sourceMode: source.permissions == null ? null : formatMode(source.permissions),
          targetMode: target?.permissions == null ? null : formatMode(target.permissions),
          sourceOwner: source.uid == null && source.gid == null ? null : `${source.uid ?? ""}:${source.gid ?? ""}`,
          targetOwner: !target || (target.uid == null && target.gid == null) ? null : `${target.uid ?? ""}:${target.gid ?? ""}`,
          sourceModifiedAt: source.modifiedAt,
          targetModifiedAt: target?.modifiedAt ?? null,
          sourceLinkTarget: source.linkTarget ?? null,
          targetLinkTarget: target?.linkTarget ?? null
        };
      })
    },
    null,
    2
  );
}

function parseSyncPlanJson(payload: string): SyncPlanState {
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

function fileInfoRows(entries: FileEntry[]) {
  return [
    ["name", "type", "mode", "symbolic", "owner", "size", "modified", "path"],
    ...entries.map((entry) => [
      entry.name,
      fileTypeLabel(entry),
      formatMode(entry.permissions) || "-",
      formatEntrySymbolicMode(entry),
      formatOwner(entry),
      entry.isDir ? "-" : String(entry.size),
      formatFileDateTime(entry.modifiedAt, true),
      entry.path
    ])
  ];
}

function escapeTsvCell(value: string) {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

function escapeCsvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatDateTimeLocal(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function touchTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}

function formatMode(value?: number | null) {
  if (value == null) return "";
  return formatPermissionInput(value);
}

function formatOwner(file: FileEntry) {
  if (file.uid == null && file.gid == null) return "-";
  return `${file.uid ?? "-"}:${file.gid ?? "-"}`;
}

function formatPermissionInput(value: number) {
  const mode = value & 0o7777;
  return mode.toString(8).padStart(mode > 0o777 ? 4 : 3, "0");
}

function formatSymbolicMode(value: number, isDir: boolean) {
  const mode = value & 0o7777;
  const read = (bit: number) => ((mode & bit) === bit ? "r" : "-");
  const write = (bit: number) => ((mode & bit) === bit ? "w" : "-");
  const exec = (bit: number, specialBit?: number, lower = "x", upper = "X") => {
    const executable = (mode & bit) === bit;
    if (specialBit && (mode & specialBit) === specialBit) return executable ? lower : upper;
    return executable ? "x" : "-";
  };
  return [
    isDir ? "d" : "-",
    read(0o400),
    write(0o200),
    exec(0o100, 0o4000, "s", "S"),
    read(0o040),
    write(0o020),
    exec(0o010, 0o2000, "s", "S"),
    read(0o004),
    write(0o002),
    exec(0o001, 0o1000, "t", "T")
  ].join("");
}

function formatEntrySymbolicMode(file: FileEntry) {
  const mode = file.permissions ?? 0;
  const symbolic = formatSymbolicMode(mode, file.isDir);
  if (file.fileType === "symlink") return `l${symbolic.slice(1)}`;
  return symbolic;
}

function parseOptionalOwnerId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4294967295) return undefined;
  return parsed;
}

function parsePermissionMode(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[0-7]{1,4}$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 8);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 0o7777) return undefined;
  return parsed;
}

function resolvePermissionMode(value: string, file: FileEntry) {
  const numeric = parsePermissionMode(value);
  if (numeric !== undefined) return numeric;
  const baseMode = file.permissions;
  if (baseMode == null) return undefined;
  return applySymbolicPermissionMode(value, baseMode, file.isDir);
}

function applySymbolicPermissionMode(value: string, baseMode: number, isDir: boolean) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let mode = baseMode & 0o7777;
  for (const rawClause of trimmed.split(",")) {
    const clause = rawClause.trim();
    const match = clause.match(/^([ugoa]*)([+=-])([rwxXstugo]*)$/);
    if (!match) return undefined;
    const who = match[1] || "a";
    const operator = match[2];
    const perms = match[3];
    const classes = expandPermissionClasses(who);
    if (!classes) return undefined;
    if (operator === "=") {
      mode &= ~permissionClassMask(classes);
    }
    const bits = symbolicPermissionBits(perms, classes, mode, isDir);
    if (bits === undefined) return undefined;
    if (operator === "+" || operator === "=") {
      mode |= bits;
    } else {
      mode &= ~bits;
    }
  }
  return mode & 0o7777;
}

function expandPermissionClasses(value: string) {
  const set = new Set<string>();
  for (const part of value) {
    if (part === "a") {
      set.add("u");
      set.add("g");
      set.add("o");
    } else if (part === "u" || part === "g" || part === "o") {
      set.add(part);
    } else {
      return null;
    }
  }
  if (set.size === 0) {
    set.add("u");
    set.add("g");
    set.add("o");
  }
  return [...set] as PermissionClass[];
}

function permissionClassMask(classes: PermissionClass[]) {
  let mask = 0;
  for (const target of classes) {
    if (target === "u") mask |= 0o4700;
    if (target === "g") mask |= 0o2070;
    if (target === "o") mask |= 0o1007;
  }
  return mask;
}

function symbolicPermissionBits(perms: string, classes: PermissionClass[], mode: number, isDir: boolean) {
  let bits = 0;
  for (const perm of perms) {
    if (perm === "r" || perm === "w" || perm === "x" || perm === "X") {
      if (perm === "X" && !isDir && (mode & 0o111) === 0) continue;
      bits |= permissionLetterBits(classes, (perm === "X" ? "x" : perm) as PermissionLetter);
    } else if (perm === "s") {
      if (classes.includes("u")) bits |= 0o4000;
      if (classes.includes("g")) bits |= 0o2000;
    } else if (perm === "t") {
      if (classes.includes("o")) bits |= 0o1000;
    } else if (perm === "u" || perm === "g" || perm === "o") {
      bits |= copyPermissionClassBits(mode, perm, classes);
    } else {
      return undefined;
    }
  }
  return bits;
}

function permissionLetterBits(classes: PermissionClass[], perm: PermissionLetter) {
  const table: Record<PermissionLetter, Record<PermissionClass, number>> = {
    r: { u: 0o400, g: 0o040, o: 0o004 },
    w: { u: 0o200, g: 0o020, o: 0o002 },
    x: { u: 0o100, g: 0o010, o: 0o001 }
  };
  return classes.reduce((bits, target) => bits | table[perm][target], 0);
}

function copyPermissionClassBits(mode: number, source: PermissionClass, targets: PermissionClass[]) {
  const shiftFrom = source === "u" ? 6 : source === "g" ? 3 : 0;
  const sourceBits = (mode >> shiftFrom) & 0o7;
  return targets.reduce((bits, target) => {
    const shiftTo = target === "u" ? 6 : target === "g" ? 3 : 0;
    return bits | (sourceBits << shiftTo);
  }, 0);
}

function parseDateTimeLocal(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const timestamp = new Date(trimmed).getTime();
  if (Number.isNaN(timestamp)) return undefined;
  return Math.floor(timestamp / 1000);
}

function transferPercent(transfer: TransferView) {
  if (!transfer.total) return transfer.status === "done" ? 100 : 8;
  return Math.min(100, Math.max(4, Math.round((transfer.transferred / transfer.total) * 100)));
}

function transferAuditPercent(transfer: TransferView) {
  if (!transfer.total) return transfer.status === "done" ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((transfer.transferred / transfer.total) * 100)));
}

function xtermTheme(theme: AppSettings["theme"]) {
  if (theme === "light") {
    return {
      background: "#f8fafc",
      foreground: "#1f2937",
      cursor: "#2563eb",
      selectionBackground: "#c7d2fe"
    };
  }
  if (theme === "graphite") {
    return {
      background: "#101214",
      foreground: "#e5e7eb",
      cursor: "#5eead4",
      selectionBackground: "#374151"
    };
  }
  return {
    background: "#020408",
    foreground: "#dce4ec",
    cursor: "#2fd3a6",
    selectionBackground: "#25445f"
  };
}
