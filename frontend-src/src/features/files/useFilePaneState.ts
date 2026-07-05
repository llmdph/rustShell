import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent
} from "react";

import type { FileEntry } from "@/api";
import { compareKindLabel } from "@/features/files/fileFormatters";
import {
  buildDirectoryCompare,
  defaultFileSort,
  filterCompareView,
  nextFileSort,
  pickSelection,
  pushHistory,
  selectedEntries,
  selectionVisibleInFiles,
  sortFiles,
  togglePath,
  visibleFiles,
  visibleSelection
} from "@/features/files/filePaneModel";
import type {
  CompareView,
  FileCompareKind,
  FileSearchState,
  FileSide,
  FileSort,
  FileSortKey
} from "@/features/files/filePaneTypes";
import { bookmarkLabel, loadPathBookmarks, savePathBookmarks, upsertBookmark } from "@/features/files/pathBookmarks";

type PromptText = (title: string, options?: { defaultValue?: string }) => Promise<string | null>;
type PushToast = (tone: "success" | "info" | "error", text: string) => void;

type ReplaceFilesOptions = {
  preserveSelection?: boolean;
  clearSearch?: boolean;
};

type UseFilePaneStateParams = {
  initialRemoteBrowserProfileId: string | null;
  promptText: PromptText;
  pushToast: PushToast;
  setStatus: (status: string) => void;
};

export function useFilePaneState({
  initialRemoteBrowserProfileId,
  promptText,
  pushToast,
  setStatus
}: UseFilePaneStateParams) {
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("/root");
  const [remoteHomeReady, setRemoteHomeReady] = useState(false);
  const [remoteBrowserProfileId, setRemoteBrowserProfileId] = useState<string | null>(
    initialRemoteBrowserProfileId
  );
  const [localBackHistory, setLocalBackHistory] = useState<string[]>([]);
  const [localForwardHistory, setLocalForwardHistory] = useState<string[]>([]);
  const [remoteBackHistory, setRemoteBackHistory] = useState<string[]>([]);
  const [remoteForwardHistory, setRemoteForwardHistory] = useState<string[]>([]);
  const [localPathBookmarks, setLocalPathBookmarks] = useState(() => loadPathBookmarks("local"));
  const [remotePathBookmarks, setRemotePathBookmarks] = useState(() => loadPathBookmarks("remote"));
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

  const deferredLocalFilter = useDeferredValue(localFilter);
  const deferredRemoteFilter = useDeferredValue(remoteFilter);
  const deferredCompareView = useDeferredValue(compareView);
  const activeCompareView: CompareView = compareDirectories ? deferredCompareView : "all";
  const baseVisibleLocalFiles = useMemo(
    () => sortFiles(visibleFiles(localFiles, showLocalHidden, deferredLocalFilter), localSort),
    [deferredLocalFilter, localFiles, localSort, showLocalHidden]
  );
  const baseVisibleRemoteFiles = useMemo(
    () => sortFiles(visibleFiles(remoteFiles, showRemoteHidden, deferredRemoteFilter), remoteSort),
    [deferredRemoteFilter, remoteFiles, remoteSort, showRemoteHidden]
  );
  const directoryCompare = useMemo(
    () => buildDirectoryCompare(baseVisibleLocalFiles, baseVisibleRemoteFiles),
    [baseVisibleLocalFiles, baseVisibleRemoteFiles]
  );
  const visibleLocalFiles = useMemo(
    () => filterCompareView(baseVisibleLocalFiles, directoryCompare.local, activeCompareView),
    [activeCompareView, baseVisibleLocalFiles, directoryCompare.local]
  );
  const visibleRemoteFiles = useMemo(
    () => filterCompareView(baseVisibleRemoteFiles, directoryCompare.remote, activeCompareView),
    [activeCompareView, baseVisibleRemoteFiles, directoryCompare.remote]
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
  const baseVisibleSelectedLocal = useMemo(
    () => visibleSelection(selectedLocal, showLocalHidden, deferredLocalFilter),
    [deferredLocalFilter, selectedLocal, showLocalHidden]
  );
  const baseVisibleSelectedRemote = useMemo(
    () => visibleSelection(selectedRemote, showRemoteHidden, deferredRemoteFilter),
    [deferredRemoteFilter, selectedRemote, showRemoteHidden]
  );
  const visibleSelectedLocal = useMemo(
    () => selectionVisibleInFiles(baseVisibleSelectedLocal, visibleLocalFiles),
    [baseVisibleSelectedLocal, visibleLocalFiles]
  );
  const visibleSelectedRemote = useMemo(
    () => selectionVisibleInFiles(baseVisibleSelectedRemote, visibleRemoteFiles),
    [baseVisibleSelectedRemote, visibleRemoteFiles]
  );
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

  const clearLocalSelection = useCallback(() => {
    setSelectedLocal(null);
    setSelectedLocalPaths([]);
    setLocalSelectionStats("");
    localSelectionAnchorRef.current = null;
  }, []);

  const clearRemoteSelection = useCallback(() => {
    setSelectedRemote(null);
    setSelectedRemotePaths([]);
    setRemoteSelectionStats("");
    remoteSelectionAnchorRef.current = null;
  }, []);

  const selectFile = useCallback(
    (side: FileSide, file: FileEntry, event: MouseEvent<HTMLButtonElement>, files: FileEntry[]) => {
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
    },
    []
  );

  const selectAllFiles = useCallback(
    (side: FileSide) => {
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
    },
    [visibleLocalFiles, visibleRemoteFiles]
  );

  const invertFileSelection = useCallback(
    (side: FileSide) => {
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
    },
    [
      clearLocalSelection,
      clearRemoteSelection,
      selectedLocalPaths,
      selectedRemotePaths,
      setStatus,
      visibleLocalFiles,
      visibleRemoteFiles
    ]
  );

  const selectComparedEntries = useCallback(
    (side: FileSide) => {
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
    },
    [baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare.local, directoryCompare.remote, pushToast, setStatus]
  );

  const selectComparedPairs = useCallback(
    (kind: FileCompareKind) => {
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
    },
    [baseVisibleLocalFiles, baseVisibleRemoteFiles, directoryCompare.local, pushToast, setStatus]
  );

  const navigateLocalPath = useCallback(
    (nextPath: string, preferPath?: string) => {
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
    },
    [clearLocalSelection, localFiles, localPath]
  );

  const navigateRemotePath = useCallback(
    (nextPath: string, preferPath?: string) => {
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
    },
    [clearRemoteSelection, remoteFiles, remotePath]
  );

  const goLocalHistory = useCallback(
    (direction: "back" | "forward") => {
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
    },
    [clearLocalSelection, localBackHistory, localForwardHistory, localPath]
  );

  const goRemoteHistory = useCallback(
    (direction: "back" | "forward") => {
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
    },
    [clearRemoteSelection, remoteBackHistory, remoteForwardHistory, remotePath]
  );

  const addPathBookmark = useCallback(
    async (side: FileSide) => {
      const path = (side === "local" ? localPath : remotePath).trim();
      if (!path) return;
      const label = await promptText("收藏名称", { defaultValue: bookmarkLabel(path) });
      if (!label?.trim()) return;
      const setter = side === "local" ? setLocalPathBookmarks : setRemotePathBookmarks;
      setter((current) => upsertBookmark(current, { label: label.trim(), path }));
      pushToast("success", "路径已收藏");
    },
    [localPath, promptText, pushToast, remotePath]
  );

  const removePathBookmark = useCallback(
    (side: FileSide, path: string) => {
      const setter = side === "local" ? setLocalPathBookmarks : setRemotePathBookmarks;
      setter((current) => current.filter((bookmark) => bookmark.path !== path));
      pushToast("success", "收藏已移除");
    },
    [pushToast]
  );

  const openPathBookmark = useCallback(
    (side: FileSide, path: string) => {
      if (side === "local") {
        navigateLocalPath(path);
      } else {
        navigateRemotePath(path);
      }
    },
    [navigateLocalPath, navigateRemotePath]
  );

  const consumeLocalPreferPath = useCallback((preferPath?: string) => {
    const preferredPath = preferPath ?? pendingLocalPreferPathRef.current ?? undefined;
    pendingLocalPreferPathRef.current = null;
    return preferredPath;
  }, []);

  const consumeRemotePreferPath = useCallback((preferPath?: string) => {
    const preferredPath = preferPath ?? pendingRemotePreferPathRef.current ?? undefined;
    pendingRemotePreferPathRef.current = null;
    return preferredPath;
  }, []);

  const replaceLocalFiles = useCallback(
    (files: FileEntry[], preferPath?: string, options: ReplaceFilesOptions = {}) => {
      const preserveSelection = options.preserveSelection ?? true;
      const clearSearch = options.clearSearch ?? true;
      const picked = preserveSelection ? pickSelection(files, preferPath, selectedLocalRef.current) : null;
      setLocalFiles(files);
      setSelectedLocal(picked);
      setSelectedLocalPaths(picked ? [picked.path] : []);
      if (!picked) localSelectionAnchorRef.current = null;
      if (clearSearch) setLocalSearch(null);
    },
    []
  );

  const replaceRemoteFiles = useCallback(
    (files: FileEntry[], preferPath?: string, options: ReplaceFilesOptions = {}) => {
      const preserveSelection = options.preserveSelection ?? true;
      const clearSearch = options.clearSearch ?? true;
      const picked = preserveSelection ? pickSelection(files, preferPath, selectedRemoteRef.current) : null;
      setRemoteFiles(files);
      setSelectedRemote(picked);
      setSelectedRemotePaths(picked ? [picked.path] : []);
      if (!picked) remoteSelectionAnchorRef.current = null;
      if (clearSearch) setRemoteSearch(null);
    },
    []
  );

  const applyLocalSearch = useCallback(
    (files: FileEntry[], search: FileSearchState) => {
      setLocalFiles(files);
      clearLocalSelection();
      setLocalSearch(search);
    },
    [clearLocalSelection]
  );

  const applyRemoteSearch = useCallback(
    (files: FileEntry[], search: FileSearchState) => {
      setRemoteFiles(files);
      clearRemoteSelection();
      setRemoteSearch(search);
    },
    [clearRemoteSelection]
  );

  const resetRemoteBrowserProfile = useCallback(
    (profileId: string) => {
      setRemoteBrowserProfileId(profileId);
      setRemoteHomeReady(false);
      setRemoteFiles([]);
      setRemoteSearch(null);
      setRemoteBackHistory([]);
      setRemoteForwardHistory([]);
      clearRemoteSelection();
      setRemotePath(".");
    },
    [clearRemoteSelection]
  );

  const sortLocalBy = useCallback((key: FileSortKey) => {
    setLocalSort((current) => nextFileSort(current, key));
  }, []);

  const sortRemoteBy = useCallback((key: FileSortKey) => {
    setRemoteSort((current) => nextFileSort(current, key));
  }, []);

  return {
    localPath,
    setLocalPath,
    remotePath,
    setRemotePath,
    remoteHomeReady,
    setRemoteHomeReady,
    remoteBrowserProfileId,
    setRemoteBrowserProfileId,
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
    selectedLocal,
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
  };
}
