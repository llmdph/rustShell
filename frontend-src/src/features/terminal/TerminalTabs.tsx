import { Copy, FolderOpen, SplitSquareHorizontal, SplitSquareVertical, X } from "lucide-react";
import { useRef, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import type { TerminalView } from "@/api";
import { ActionContextMenu, type FileAction } from "@/components/app/ActionContextMenu";
import { cn } from "@/lib/utils";

export const TERMINAL_TAB_DRAG_MIME = "application/x-rustshell-terminal-tab";

export type TerminalTabDragPoint = {
  clientX: number;
  clientY: number;
};

type TerminalTabsProps = {
  tabs: TerminalView[];
  activeTabId: string | null;
  splitPaneTabIds: string[];
  className?: string;
  onActivate: (tab: TerminalView) => void;
  onDuplicate: (tab: TerminalView) => void;
  onClose: (tabId: string) => void;
  onSplitRight: (tab: TerminalView) => void;
  onSplitDown: (tab: TerminalView) => void;
  onUnsplit: () => void;
  onDropTab?: (tabId: string, insertIndex?: number) => void;
  onTabDragMove?: (tabId: string, point: TerminalTabDragPoint) => void;
  onTabDragDrop?: (tabId: string, point: TerminalTabDragPoint) => void;
  onTabDragCancel?: () => void;
  fileDockOpen: boolean;
  onToggleFileDock: () => void;
};

const statusDotClass: Record<TerminalView["status"], string> = {
  disconnected: "bg-muted-foreground",
  connected: "bg-emerald-500",
  connecting: "bg-yellow-500",
  failed: "bg-destructive"
};

function tabIdFromDrag(event: DragEvent<HTMLElement>) {
  return event.dataTransfer.getData(TERMINAL_TAB_DRAG_MIME) || event.dataTransfer.getData("text/plain");
}

export function TerminalTabs({
  tabs,
  activeTabId,
  splitPaneTabIds,
  className,
  onActivate,
  onDuplicate,
  onClose,
  onSplitRight,
  onSplitDown,
  onUnsplit,
  onDropTab,
  onTabDragMove,
  onTabDragDrop,
  onTabDragCancel,
  fileDockOpen,
  onToggleFileDock
}: TerminalTabsProps) {
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    tab: TerminalView;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);

  const tabActions = (tab: TerminalView): FileAction[] => [
    {
      label: "复制窗口",
      icon: <Copy size={14} />,
      onClick: () => onDuplicate(tab)
    },
    { type: "separator" },
    splitPaneTabIds.includes(tab.id)
      ? {
          label: "取消分屏",
          icon: <SplitSquareHorizontal size={14} />,
          onClick: onUnsplit
        }
      : {
          label: "与当前标签左右分屏",
          icon: <SplitSquareHorizontal size={14} />,
          disabled: tab.id === activeTabId || tabs.length < 2,
          onClick: () => onSplitRight(tab)
        },
    {
      label: "与当前标签上下分屏",
      icon: <SplitSquareVertical size={14} />,
      disabled: tab.id === activeTabId || tabs.length < 2,
      onClick: () => onSplitDown(tab)
    },
    { type: "separator" },
    {
      label: fileDockOpen ? "关闭下方文件区" : "打开下方文件区",
      icon: <FolderOpen size={14} />,
      onClick: onToggleFileDock
    },
    { type: "separator" },
    {
      label: "关闭窗口",
      icon: <X size={14} />,
      danger: true,
      onClick: () => onClose(tab.id)
    }
  ];

  const beginTabPointerDrag = (tab: TerminalView, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-terminal-tab-action]")) return;
    dragRef.current = {
      tab,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };

    const cleanup = () => {
      document.body.classList.remove("is-dragging-terminal-tab");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      dragRef.current = null;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== moveEvent.pointerId) return;
      const distance = Math.hypot(moveEvent.clientX - state.startX, moveEvent.clientY - state.startY);
      if (!state.dragging && distance < 5) return;
      if (!state.dragging) {
        state.dragging = true;
        suppressClickRef.current = true;
        document.body.classList.add("is-dragging-terminal-tab");
      }
      moveEvent.preventDefault();
      onTabDragMove?.(state.tab.id, { clientX: moveEvent.clientX, clientY: moveEvent.clientY });
    };

    const handleUp = (upEvent: globalThis.PointerEvent) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== upEvent.pointerId) return;
      if (state.dragging) {
        upEvent.preventDefault();
        onTabDragDrop?.(state.tab.id, { clientX: upEvent.clientX, clientY: upEvent.clientY });
      }
      cleanup();
    };

    const handleCancel = (cancelEvent: globalThis.PointerEvent) => {
      const state = dragRef.current;
      if (!state || state.pointerId !== cancelEvent.pointerId) return;
      onTabDragCancel?.();
      cleanup();
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
  };

  const handleActivate = (tab: TerminalView, event?: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      event?.preventDefault();
      event?.stopPropagation();
      return;
    }
    onActivate(tab);
  };

  const handleKeyActivate = (tab: TerminalView, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onActivate(tab);
  };

  return (
    <div
      data-terminal-tabs
      className={cn("flex min-w-0 max-w-full items-end gap-0 overflow-hidden overflow-y-hidden border-b border-border/70 bg-muted px-2 dark:bg-background", className)}
      onDragOver={(event) => {
        if (!onDropTab) return;
        const tabId = tabIdFromDrag(event);
        if (!tabId) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        if (!onDropTab) return;
        const tabId = tabIdFromDrag(event);
        if (!tabId) return;
        event.preventDefault();
        event.stopPropagation();
        onDropTab(tabId);
      }}
    >
      {tabs.map((tab) => (
        <ActionContextMenu key={tab.id} actions={tabActions(tab)}>
          <div
            role="tab"
            tabIndex={0}
            data-terminal-tab-id={tab.id}
            className={cn(
              "relative flex h-7 min-w-0 max-w-36 flex-1 cursor-grab select-none items-center justify-start gap-1.5 overflow-hidden rounded-none border-0 border-r border-border/70 bg-transparent px-1.5 py-0 text-xs text-muted-foreground shadow-none before:absolute before:bottom-0 before:left-0 before:h-0.5 before:w-full before:bg-transparent before:content-[''] hover:bg-accent/70 hover:text-foreground active:cursor-grabbing",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              tab.id === activeTabId && "bg-background text-foreground before:bg-primary dark:bg-card"
            )}
            aria-selected={tab.id === activeTabId}
            title="拖到终端边缘分屏，拖回主标签栏取消分屏"
            onClick={(event) => handleActivate(tab, event)}
            onKeyDown={(event) => handleKeyActivate(tab, event)}
            onPointerDown={(event) => beginTabPointerDrag(tab, event)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(TERMINAL_TAB_DRAG_MIME, tab.id);
              event.dataTransfer.setData("text/plain", tab.id);
            }}
            onContextMenu={(event) => {
              event.stopPropagation();
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
                onClose(tab.id);
              }
            }}
          >
            <span className={cn("size-1.5 flex-none rounded-full", statusDotClass[tab.status])} />
            <span className="min-w-0 flex-1 truncate text-xs">{tab.title}</span>
            <button
              type="button"
              data-terminal-tab-action
              className="ml-auto grid size-4 flex-none place-items-center rounded-sm text-muted-foreground hover:bg-border/70 hover:text-foreground"
              aria-label={`关闭 ${tab.title}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        </ActionContextMenu>
      ))}
    </div>
  );
}
