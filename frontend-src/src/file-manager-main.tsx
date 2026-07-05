import { mountApp } from "./app-entry";

mountApp({
  removeBootElementId: "file-manager-boot",
  beforeRender: () => {
    (window as Window & { __RUSTSHELL_VIEW__?: string }).__RUSTSHELL_VIEW__ = "file-manager";
  }
});
