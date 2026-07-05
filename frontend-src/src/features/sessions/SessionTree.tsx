import { useVirtualizer } from "@tanstack/react-virtual";
import { Cable, ChevronRight, Copy, Folder, FolderPlus, KeyRound, Monitor, Settings, Trash2 } from "lucide-react";
import { memo, useRef, type CSSProperties } from "react";

import type { Profile } from "@/api";
import { ActionContextMenu, type FileAction } from "@/components/app/ActionContextMenu";
import { isLocalProtocol, normalizeProtocolLabel } from "@/features/sessions/profileProtocol";
import { isProtectedSessionFolder } from "@/features/sessions/sessionFolders";
import { useSessionFolders, type SessionTreeItem } from "@/features/sessions/useSessionFolders";
import { cn } from "@/lib/utils";

type SessionTreeProps = {
  profiles: Profile[];
  activeProfileId: string | null;
  onSelect: (profile: Profile) => void;
  onConnect: (profile: Profile) => void;
  onSecret: (profile: Profile) => void;
  onEdit: (profile: Profile) => void;
  onCopyCommand: (profile: Profile) => void;
  onDuplicate: (profile: Profile) => void;
  onDelete: (profile: Profile) => void;
  onPromptText: (title: string) => Promise<string | null>;
  onCreateProfile: (group: string) => void;
  onDeleteFolder: (group: string) => Promise<boolean>;
};

export function SessionTree({
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
}: SessionTreeProps) {
  const treeRef = useRef<HTMLDivElement | null>(null);
  const { visibleItems, toggleGroup, addFolder, deleteFolder } = useSessionFolders({ profiles, onPromptText, onDeleteFolder });
  const rowVirtualizer = useVirtualizer({
    count: visibleItems.length,
    getItemKey: (index) => visibleItems[index]?.id ?? index,
    getScrollElement: () => treeRef.current,
    estimateSize: () => 22,
    overscan: 16
  });

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

  const renderTreeItem = (item: SessionTreeItem, style: CSSProperties) => {
    if (item.kind === "folder") {
      return (
        <SessionFolderRow
          key={item.id}
          name={item.node.name}
          collapsed={item.collapsed}
          indent={3 + item.depth * 13}
          style={style}
          actions={folderActions(item.node.path)}
          onToggle={() => toggleGroup(item.node.path)}
        />
      );
    }

    const profile = item.profile;
    return (
      <SessionProfileRow
        key={item.id}
        profile={profile}
        active={profile.id === activeProfileId}
        indent={20 + item.depth * 13}
        style={style}
        actions={contextActions(profile)}
        onSelect={onSelect}
        onConnect={onConnect}
      />
    );
  };

  return (
    <div className="mt-2 min-h-0 flex-auto overflow-auto [overflow:overlay]" ref={treeRef}>
      <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const item = visibleItems[virtualRow.index];
          if (!item) return null;
          return renderTreeItem(item, {
            position: "absolute",
            top: 0,
            left: 0,
            transform: `translateY(${virtualRow.start}px)`
          });
        })}
      </div>
    </div>
  );
}

const SessionFolderRow = memo(function SessionFolderRow({
  name,
  collapsed,
  indent,
  style,
  actions,
  onToggle
}: {
  name: string;
  collapsed: boolean;
  indent: number;
  style: CSSProperties;
  actions: FileAction[];
  onToggle: () => void;
}) {
  return (
    <ActionContextMenu actions={actions}>
      <button
        className="grid h-5 w-full grid-cols-[12px_14px_minmax(0,1fr)] items-center gap-0.5 rounded-[2px] border-0 bg-transparent pr-[3px] text-left text-xs font-semibold leading-none text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
        style={{ ...style, paddingLeft: indent }}
        onClick={onToggle}
        title={collapsed ? "展开目录" : "收起目录"}
      >
        <ChevronRight className={cn("text-muted-foreground/90 transition-transform duration-150", !collapsed && "rotate-90")} size={11} />
        <Folder className="text-muted-foreground/90" size={12} />
        <span className="min-w-0 truncate">{name}</span>
      </button>
    </ActionContextMenu>
  );
});

const SessionProfileRow = memo(function SessionProfileRow({
  profile,
  active,
  indent,
  style,
  actions,
  onSelect,
  onConnect
}: {
  profile: Profile;
  active: boolean;
  indent: number;
  style: CSSProperties;
  actions: FileAction[];
  onSelect: (profile: Profile) => void;
  onConnect: (profile: Profile) => void;
}) {
  return (
    <ActionContextMenu actions={actions}>
      <button
        className={cn(
          "grid min-h-5 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-[5px] rounded-[1px] border-0 bg-transparent pr-1 text-left text-xs leading-none text-foreground transition-colors hover:bg-muted/70",
          active && "bg-primary/25 hover:bg-primary/25"
        )}
        style={{ ...style, paddingLeft: indent }}
        onDoubleClick={() => onConnect(profile)}
        onClick={() => onSelect(profile)}
      >
        <span className="block min-w-0 truncate">
          <span className="block min-w-0 truncate">{profile.name}</span>
          <span className="hidden min-w-0 truncate">{formatLastConnected(profile.lastConnectedAt)}</span>
        </span>
        <span className="text-[10px] leading-none text-muted-foreground">{normalizeProtocolLabel(profile.protocol)}</span>
      </button>
    </ActionContextMenu>
  );
});

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

function profileTimeValue(value?: string | null) {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}
