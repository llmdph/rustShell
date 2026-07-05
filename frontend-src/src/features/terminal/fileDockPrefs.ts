const STORAGE_KEY = "rustshell.fileDock.autoOpen";

export function loadFileDockAuto(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveFileDockAuto(value: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    // ignore
  }
}
