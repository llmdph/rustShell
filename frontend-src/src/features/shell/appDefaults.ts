import type { AppSettings, QuickConnectRequest } from "@/api";

export const defaultSettings: AppSettings = {
  theme: "deep",
  fontSize: 14,
  copyOnSelect: false,
  scrollback: 10000,
  localShell: "",
  confirmOnExit: true
};

export const defaultQuick: QuickConnectRequest = {
  protocol: "SSH",
  name: "新建 SSH 会话",
  host: "",
  port: 22,
  username: "root",
  password: "",
  rememberPassword: false
};
