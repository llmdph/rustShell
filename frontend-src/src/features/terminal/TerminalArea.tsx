import { useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";

import type { AppSettings, TerminalDrain, TerminalView } from "@/api";
import { cn } from "@/lib/utils";

import { TerminalEmptyState } from "./TerminalEmptyState";
import { TerminalTabs, TERMINAL_TAB_DRAG_MIME, type TerminalTabDragPoint } from "./TerminalTabs";
import { TerminalTools } from "./TerminalTools";
import { XtermView } from "./XtermView";

export type TerminalSplitDropTarget = "left" | "right" | "top" | "bottom";
type TerminalPaneId = "primary" | "split";
type TabInsertTarget = {
  pane: TerminalPaneId;
  index: number;
  left: number;
  top: number;
  height: number;
};

type TerminalAreaProps = {
  tabs: TerminalView[];
  activeTab: TerminalView | null;
  activeTabId: string | null;
  primaryPaneActiveTabId: string | null;
  splitPaneTabIds: string[];
  splitPaneActiveTabId: string | null;
  splitDirection: "row" | "column";
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  onSplitRight: (tab: TerminalView) => void;
  onSplitDown: (tab: TerminalView) => void;
  onSplitTabDrop: (tabId: string, target: TerminalSplitDropTarget) => void;
  onMoveTabToPrimaryPane: (tabId: string, insertIndex?: number) => void;
  onMoveTabToSplitPane: (tabId: string, insertIndex?: number) => void;
  onUnsplit: () => void;
  fileDockOpenForTab: (tabId: string) => boolean;
  onToggleFileDock: (tabId: string) => void;
  renderFileDock: (tab: TerminalView) => ReactNode;
  terminalBackgroundAlpha: number;
  settings: AppSettings;
  commandForTab: (tabId: string) => string;
  snippets: string[];
  activeProfileAvailable: boolean;
  canReconnectTab: (tab: TerminalView) => boolean;
  onCommandChange: (tabId: string, command: string) => void;
  onSendCommand: (tab: TerminalView, command: string) => void;
  onCopyTab: (tab: TerminalView) => void;
  onPasteTab: (tab: TerminalView) => void;
  onClearTab: (tab: TerminalView) => void;
  onReconnectTab: (tab: TerminalView) => void;
  onActivateTab: (tab: TerminalView) => void;
  onDuplicateTab: (tab: TerminalView) => void;
  onCloseTab: (tabId: string) => void;
  onTerminalDrain: (drain: TerminalDrain, profileId: string) => void;
  onReplayConsumed: (terminalId: string) => void;
  onCreateProfile: () => void;
  onQuickConnect: () => void;
  onOpenSelectedProfile: () => void;
  onOpenFileManager: () => void;
};

type PaneOptions = {
  paneTabs: TerminalView[];
  activeId: string | null;
  pane: TerminalPaneId;
  style?: CSSProperties;
  tabsRef?: RefObject<HTMLDivElement | null>;
  onDropTab?: (tabId: string, insertIndex?: number) => void;
};

export function TerminalArea({
  tabs,
  activeTab,
  activeTabId,
  primaryPaneActiveTabId,
  splitPaneTabIds,
  splitPaneActiveTabId,
  splitDirection,
  splitRatio,
  onSplitRatioChange,
  onSplitRight,
  onSplitDown,
  onSplitTabDrop,
  onMoveTabToPrimaryPane,
  onMoveTabToSplitPane,
  onUnsplit,
  fileDockOpenForTab,
  onToggleFileDock,
  renderFileDock,
  terminalBackgroundAlpha,
  settings,
  commandForTab,
  snippets,
  activeProfileAvailable,
  canReconnectTab,
  onCommandChange,
  onSendCommand,
  onCopyTab,
  onPasteTab,
  onClearTab,
  onReconnectTab,
  onActivateTab,
  onDuplicateTab,
  onCloseTab,
  onTerminalDrain,
  onReplayConsumed,
  onCreateProfile,
  onQuickConnect,
  onOpenSelectedProfile,
  onOpenFileManager
}: TerminalAreaProps) {
  const stackRef = useRef<HTMLDivElement | null>(null);
  const primaryTabsRef = useRef<HTMLDivElement | null>(null);
  const secondaryTabsRef = useRef<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<TerminalSplitDropTarget | null>(null);
  const [insertTarget, setInsertTarget] = useState<TabInsertTarget | null>(null);
  const splitPaneTabIdSet = new Set(splitPaneTabIds);
  const primaryPaneTabs = splitPaneTabIds.length > 0 ? tabs.filter((tab) => !splitPaneTabIdSet.has(tab.id)) : tabs;
  const splitPaneTabs =
    splitPaneTabIds.length > 0
      ? splitPaneTabIds.map((id) => tabs.find((tab) => tab.id === id)).filter((tab): tab is TerminalView => Boolean(tab))
      : [];
  const splitOn = splitPaneTabs.length > 0 && primaryPaneTabs.length > 0;
  const primaryStyle: CSSProperties | undefined = splitOn
    ? splitDirection === "row"
      ? { right: `calc(${((1 - splitRatio) * 100).toFixed(3)}% + 1px)` }
      : { bottom: `calc(${((1 - splitRatio) * 100).toFixed(3)}% + 1px)` }
    : undefined;
  const secondaryStyle: CSSProperties | undefined = splitOn
    ? splitDirection === "row"
      ? { left: `calc(${(splitRatio * 100).toFixed(3)}% + 1px)` }
      : { top: `calc(${(splitRatio * 100).toFixed(3)}% + 1px)` }
    : undefined;

  const primaryPaneActiveId =
    (primaryPaneActiveTabId && primaryPaneTabs.some((tab) => tab.id === primaryPaneActiveTabId) ? primaryPaneActiveTabId : null) ??
    primaryPaneTabs[0]?.id ??
    null;
  const splitPaneActiveId =
    (splitPaneActiveTabId && splitPaneTabs.some((tab) => tab.id === splitPaneActiveTabId) ? splitPaneActiveTabId : null) ??
    splitPaneTabs[0]?.id ??
    null;

  const draggedTabId = (event: DragEvent<HTMLElement>) =>
    event.dataTransfer.getData(TERMINAL_TAB_DRAG_MIME) || event.dataTransfer.getData("text/plain");

  const splitTargetAtPoint = (point: TerminalTabDragPoint): TerminalSplitDropTarget | null => {
    const stack = stackRef.current;
    if (!stack) return null;
    if (pointInside(primaryTabsRef.current, point) || pointInside(secondaryTabsRef.current, point)) return null;
    const rect = stack.getBoundingClientRect();
    const x = point.clientX - rect.left;
    const y = point.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const candidates: Array<[TerminalSplitDropTarget, number]> = [
      ["left", x],
      ["right", rect.width - x],
      ["top", y],
      ["bottom", rect.height - y]
    ];
    candidates.sort((a, b) => a[1] - b[1]);
    return candidates[0]?.[0] ?? null;
  };

  const splitTargetAt = (event: DragEvent<HTMLElement>): TerminalSplitDropTarget | null =>
    splitTargetAtPoint({ clientX: event.clientX, clientY: event.clientY });

  const pointInside = (element: HTMLElement | null, point: TerminalTabDragPoint) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return point.clientX >= rect.left && point.clientX <= rect.right && point.clientY >= rect.top && point.clientY <= rect.bottom;
  };

  const tabInsertTargetAtPoint = (tabId: string, point: TerminalTabDragPoint): TabInsertTarget | null => {
    const stack = stackRef.current;
    if (!stack) return null;

    const targetForPane = (element: HTMLElement | null, pane: TerminalPaneId): TabInsertTarget | null => {
      if (!element || !pointInside(element, point)) return null;
      const stackRect = stack.getBoundingClientRect();
      const stripRect = element.getBoundingClientRect();
      const tabElements = Array.from(element.querySelectorAll<HTMLElement>("[data-terminal-tab-id]"));
      let rawIndex = tabElements.length;
      for (let index = 0; index < tabElements.length; index += 1) {
        const rect = tabElements[index].getBoundingClientRect();
        if (point.clientX < rect.left + rect.width / 2) {
          rawIndex = index;
          break;
        }
      }

      const oldIndex = tabElements.findIndex((item) => item.dataset.terminalTabId === tabId);
      const index = oldIndex >= 0 && oldIndex < rawIndex ? rawIndex - 1 : rawIndex;
      const markerElement = tabElements[rawIndex] ?? tabElements[tabElements.length - 1] ?? null;
      const markerX =
        tabElements.length === 0
          ? stripRect.left + 8
          : tabElements[rawIndex]
            ? markerElement.getBoundingClientRect().left
            : markerElement.getBoundingClientRect().right;

      return {
        pane,
        index: Math.max(0, Math.min(index, tabElements.length)),
        left: markerX - stackRect.left,
        top: stripRect.top - stackRect.top + 4,
        height: Math.max(12, stripRect.height - 8)
      };
    };

    return targetForPane(primaryTabsRef.current, "primary") ?? targetForPane(secondaryTabsRef.current, "split");
  };

  const handleTabPointerDrag = (tabId: string, point: TerminalTabDragPoint) => {
    if (!tabs.some((tab) => tab.id === tabId)) return;
    const nextInsertTarget = tabInsertTargetAtPoint(tabId, point);
    if (nextInsertTarget) {
      setInsertTarget(nextInsertTarget);
      setDropTarget(null);
      return;
    }
    setInsertTarget(null);
    setDropTarget(splitTargetAtPoint(point));
  };

  const handleTabPointerDrop = (tabId: string, point: TerminalTabDragPoint) => {
    setDropTarget(null);
    setInsertTarget(null);
    if (!tabs.some((tab) => tab.id === tabId)) return;
    const nextInsertTarget = tabInsertTargetAtPoint(tabId, point);
    if (nextInsertTarget) {
      if (nextInsertTarget.pane === "primary") onMoveTabToPrimaryPane(tabId, nextInsertTarget.index);
      else onMoveTabToSplitPane(tabId, nextInsertTarget.index);
      return;
    }
    const target = splitTargetAtPoint(point);
    if (target) onSplitTabDrop(tabId, target);
  };

  const handleStackDragOver = (event: DragEvent<HTMLDivElement>) => {
    const tabId = draggedTabId(event);
    if (!tabId || !tabs.some((tab) => tab.id === tabId)) return;
    const target = splitTargetAt(event);
    if (!target) {
      setDropTarget(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(target);
  };

  const handleStackDrop = (event: DragEvent<HTMLDivElement>) => {
    const tabId = draggedTabId(event);
    const target = dropTarget ?? splitTargetAt(event);
    setDropTarget(null);
    if (!tabId || !target || !tabs.some((tab) => tab.id === tabId)) return;
    event.preventDefault();
    onSplitTabDrop(tabId, target);
  };

  const beginSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const stack = stackRef.current;
    if (!stack) return;
    const applyRatio = (clientX: number, clientY: number) => {
      const rect = stack.getBoundingClientRect();
      const ratio =
        splitDirection === "row"
          ? (clientX - rect.left) / Math.max(1, rect.width)
          : (clientY - rect.top) / Math.max(1, rect.height);
      onSplitRatioChange(Math.min(0.8, Math.max(0.2, ratio)));
    };
    const handleMove = (moveEvent: globalThis.PointerEvent) => applyRatio(moveEvent.clientX, moveEvent.clientY);
    const handleUp = () => {
      document.body.classList.remove("is-resizing-terminal-layout");
      window.dispatchEvent(new CustomEvent("rustshell:terminal-layout-resize-end"));
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    document.body.classList.add("is-resizing-terminal-layout");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
    applyRatio(event.clientX, event.clientY);
  };

  const renderPane = ({ paneTabs, activeId, style, tabsRef, onDropTab }: PaneOptions) => {
    const paneActiveTab = activeId ? paneTabs.find((tab) => tab.id === activeId) ?? paneTabs[0] ?? null : paneTabs[0] ?? null;
    const dockOpen = paneActiveTab ? fileDockOpenForTab(paneActiveTab.id) : false;

    return (
      <div
        className={cn(
          "absolute inset-0 grid min-h-0 min-w-0 overflow-hidden bg-background",
          dockOpen ? "grid-rows-[30px_minmax(140px,1fr)_auto_auto]" : "grid-rows-[30px_minmax(0,1fr)_auto]"
        )}
        style={style}
        data-terminal-pane
      >
        <div ref={tabsRef} className="min-h-0 min-w-0 overflow-hidden">
          <TerminalTabs
            className="h-full bg-muted/95 px-2 dark:bg-background/95"
            tabs={paneTabs}
            activeTabId={paneActiveTab?.id ?? null}
            splitPaneTabIds={splitPaneTabIds}
            onActivate={onActivateTab}
            onDuplicate={onDuplicateTab}
            onClose={onCloseTab}
            onSplitRight={onSplitRight}
            onSplitDown={onSplitDown}
            onUnsplit={onUnsplit}
            onDropTab={onDropTab}
            onTabDragMove={handleTabPointerDrag}
            onTabDragDrop={handleTabPointerDrop}
            onTabDragCancel={() => setDropTarget(null)}
            fileDockOpen={dockOpen}
            onToggleFileDock={() => {
              if (paneActiveTab) onToggleFileDock(paneActiveTab.id);
            }}
          />
        </div>
        <div className="relative min-h-0 min-w-0 overflow-hidden">
          {paneTabs.length > 0 ? (
            paneTabs.map((tab) => (
              <XtermView
                key={tab.id}
                terminal={tab}
                settings={settings}
                active={tab.id === activeTab?.id}
                visible={tab.id === paneActiveTab?.id}
                terminalBackgroundAlpha={terminalBackgroundAlpha}
                onActivate={() => onActivateTab(tab)}
                onDrain={(next) => onTerminalDrain(next, tab.profileId)}
                onReplayConsumed={onReplayConsumed}
              />
            ))
          ) : (
            <TerminalEmptyState
              canOpenSelected={activeProfileAvailable}
              onCreateProfile={onCreateProfile}
              onQuickConnect={onQuickConnect}
              onOpenSelected={onOpenSelectedProfile}
              onOpenFileManager={onOpenFileManager}
            />
          )}
        </div>
        {paneActiveTab && (
          <TerminalTools
            activeTab={paneActiveTab}
            activeProfileAvailable={canReconnectTab(paneActiveTab)}
            command={commandForTab(paneActiveTab.id)}
            snippets={snippets}
            onCommandChange={(next) => onCommandChange(paneActiveTab.id, next)}
            onSendCommand={(next) => onSendCommand(paneActiveTab, next)}
            onCopy={() => onCopyTab(paneActiveTab)}
            onPaste={() => onPasteTab(paneActiveTab)}
            onClear={() => onClearTab(paneActiveTab)}
            onReconnect={() => onReconnectTab(paneActiveTab)}
            onCloseActive={() => onCloseTab(paneActiveTab.id)}
            fileDockOpen={dockOpen}
            onToggleFileDock={() => onToggleFileDock(paneActiveTab.id)}
          />
        )}
        {paneActiveTab && dockOpen ? renderFileDock(paneActiveTab) : null}
      </div>
    );
  };

  return (
    <section data-terminal-area className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-background">
      <div
        data-terminal-stack
        className="relative isolate min-h-0 min-w-0 overflow-hidden bg-background"
        ref={stackRef}
        onDragOver={handleStackDragOver}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropTarget(null);
          setInsertTarget(null);
        }}
        onDrop={handleStackDrop}
      >
        {tabs.length > 0 ? (
          splitOn ? (
            <>
              {renderPane({
                paneTabs: primaryPaneTabs,
                activeId: primaryPaneActiveId,
                pane: "primary",
                style: primaryStyle,
                tabsRef: primaryTabsRef,
                onDropTab: onMoveTabToPrimaryPane
              })}
              {renderPane({
                paneTabs: splitPaneTabs,
                activeId: splitPaneActiveId,
                pane: "split",
                style: secondaryStyle,
                tabsRef: secondaryTabsRef,
                onDropTab: onMoveTabToSplitPane
              })}
            </>
          ) : (
            renderPane({
              paneTabs: tabs,
              activeId: activeTabId ?? tabs[0]?.id ?? null,
              pane: "primary",
              tabsRef: primaryTabsRef,
              onDropTab: onMoveTabToPrimaryPane
            })
          )
        ) : (
          <TerminalEmptyState
            canOpenSelected={activeProfileAvailable}
            onCreateProfile={onCreateProfile}
            onQuickConnect={onQuickConnect}
            onOpenSelected={onOpenSelectedProfile}
            onOpenFileManager={onOpenFileManager}
          />
        )}
        {dropTarget && (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute z-30 border border-primary/65 bg-primary/10 shadow-sm",
              dropTarget === "left" && "inset-y-1 left-1 w-[calc(50%_-_0.25rem)]",
              dropTarget === "right" && "inset-y-1 right-1 w-[calc(50%_-_0.25rem)]",
              dropTarget === "top" && "inset-x-1 top-1 h-[calc(50%_-_0.25rem)]",
              dropTarget === "bottom" && "inset-x-1 bottom-1 h-[calc(50%_-_0.25rem)]"
            )}
          />
        )}
        {insertTarget && (
          <div
            aria-hidden
            className="pointer-events-none absolute z-40 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_0_1px_var(--background)]"
            style={{ left: insertTarget.left, top: insertTarget.top, height: insertTarget.height }}
          />
        )}
        {splitOn && (
          <div
            role="separator"
            aria-orientation={splitDirection === "row" ? "vertical" : "horizontal"}
            className={
              splitDirection === "row"
                ? "absolute inset-y-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize bg-border/70 hover:bg-ring/60"
                : "absolute inset-x-0 z-20 h-1.5 -translate-y-1/2 cursor-row-resize bg-border/70 hover:bg-ring/60"
            }
            style={splitDirection === "row" ? { left: `${(splitRatio * 100).toFixed(3)}%` } : { top: `${(splitRatio * 100).toFixed(3)}%` }}
            title="拖拽调整分屏比例"
            onPointerDown={beginSplitDrag}
          />
        )}
      </div>
    </section>
  );
}
