import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { listen as listenTauriEvent } from "@tauri-apps/api/event";
import { api, hasTauriRuntime, type AppSettings, type Profile, type TerminalView } from "../../api";
import { normalizeProfiles } from "../sessions/profileModel";

export function useAppTheme(theme: AppSettings["theme"]) {
  useEffect(() => {
    // shadcn/ui theme scope: deep/graphite -> dark, light -> light.
    document.documentElement.classList.toggle("dark", theme !== "light");
  }, [theme]);
}

export function useSettingsSync(setSettings: Dispatch<SetStateAction<AppSettings>>) {
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenTauriEvent<AppSettings>("rustshell://settings", (event) => {
      const next = event.payload;
      if (next && typeof next === "object" && typeof next.theme === "string") {
        setSettings((current) => ({ ...current, ...next }));
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
  }, [setSettings]);
}

export function useCommandPaletteShortcut(setCommandOpen: Dispatch<SetStateAction<boolean>>) {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      const editable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (editable || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setCommandOpen((open) => !open);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setCommandOpen]);
}

type UseAppBootstrapArgs = {
  isFileManagerWindow: boolean;
  openLocalShell: () => Promise<void>;
  setActiveTabId: Dispatch<SetStateAction<string | null>>;
  setLocalPath: Dispatch<SetStateAction<string>>;
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  setSelectedProfileId: Dispatch<SetStateAction<string | null>>;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setTabs: Dispatch<SetStateAction<TerminalView[]>>;
};

export function useAppBootstrap({
  isFileManagerWindow,
  openLocalShell,
  setActiveTabId,
  setLocalPath,
  setProfiles,
  setSelectedProfileId,
  setSettings,
  setStatus,
  setTabs
}: UseAppBootstrapArgs) {
  const bootedRef = useRef(false);

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
    ] as const).then(([settingsResult, homeResult, profilesResult, terminalsResult]) => {
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
    });
  }, [
    isFileManagerWindow,
    openLocalShell,
    setActiveTabId,
    setLocalPath,
    setProfiles,
    setSelectedProfileId,
    setSettings,
    setStatus,
    setTabs
  ]);
}
