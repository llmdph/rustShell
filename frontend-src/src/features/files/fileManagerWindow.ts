import { getCurrentWindow } from "@tauri-apps/api/window";

import { hasTauriRuntime } from "@/api";

export const fileManagerProfileStorageKey = "rustshell.fileManagerProfileId";

export function readFileManagerWindowParams() {
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
}
