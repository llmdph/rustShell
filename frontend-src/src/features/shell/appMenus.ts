import type { AppSettings } from "@/api";
import type { AppMenuGroup } from "@/components/app/AppMenuBar";
import type { WindowAction } from "@/components/app/WindowControls";

type BuildAppMenusOptions = {
  theme: AppSettings["theme"];
  canReconnect: boolean;
  onNewProfile: () => void;
  onImportSessions: () => void;
  onExportSessions: () => void;
  onQuickConnect: () => void;
  onReconnectActive: () => void;
  onOpenLocalShell: () => void;
  onOpenTransfers: () => void;
  onOpenFileManager: () => void;
  onOpenSettings: () => void;
  onCycleTheme: () => void;
  onWindowAction: (action: WindowAction) => void;
  onAbout: () => void;
};

function nextThemeHint(theme: AppSettings["theme"]) {
  return theme === "deep" ? "Graphite" : theme === "graphite" ? "Light" : "Deep";
}

export function buildAppMenus({
  theme,
  canReconnect,
  onNewProfile,
  onImportSessions,
  onExportSessions,
  onQuickConnect,
  onReconnectActive,
  onOpenLocalShell,
  onOpenTransfers,
  onOpenFileManager,
  onOpenSettings,
  onCycleTheme,
  onWindowAction,
  onAbout
}: BuildAppMenusOptions): AppMenuGroup[] {
  return [
    {
      label: "文件(F)",
      items: [
        { label: "新建会话", hint: "New", onClick: onNewProfile },
        { type: "separator" },
        { label: "导入会话", hint: "JSON", onClick: onImportSessions },
        { label: "导出会话", hint: "JSON", onClick: onExportSessions }
      ]
    },
    {
      label: "连接(C)",
      items: [
        { label: "快速连接", hint: "Quick", onClick: onQuickConnect },
        { label: "重连当前", hint: "Reconnect", onClick: onReconnectActive, disabled: !canReconnect },
        { type: "separator" },
        { label: "打开本地终端", hint: "Local", onClick: onOpenLocalShell }
      ]
    },
    {
      label: "工具(T)",
      items: [
        { label: "传输队列", hint: "Transfers", onClick: onOpenTransfers },
        {
          label: "文件管理器",
          hint: "Files",
          onClick: onOpenFileManager
        }
      ]
    },
    {
      label: "选项(O)",
      items: [
        { label: "设置", hint: "Settings", onClick: onOpenSettings },
        {
          label: "切换主题",
          hint: nextThemeHint(theme),
          onClick: onCycleTheme
        }
      ]
    },
    {
      label: "窗口(W)",
      items: [
        { label: "最小化", onClick: () => onWindowAction("minimize") },
        { label: "最大化/还原", onClick: () => onWindowAction("maximize") }
      ]
    },
    {
      label: "帮助(H)",
      items: [
        {
          label: "关于 RustShell",
          hint: "Info",
          onClick: onAbout
        }
      ]
    }
  ];
}
