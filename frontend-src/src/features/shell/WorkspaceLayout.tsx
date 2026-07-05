import type { CSSProperties, MouseEvent, ReactNode } from "react";

type WorkspaceLayoutProps = {
  isFileManagerWindow: boolean;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  style: CSSProperties;
  leftPanel: ReactNode;
  terminalArea: ReactNode;
  children: ReactNode;
  onStartPanelResize: (side: "left" | "right", event: MouseEvent<HTMLDivElement>) => void;
  onResetPanelWidth: (side: "left" | "right") => void;
};

export function WorkspaceLayout({
  isFileManagerWindow,
  leftPanelCollapsed,
  rightPanelCollapsed,
  style,
  leftPanel,
  terminalArea,
  children,
  onStartPanelResize,
  onResetPanelWidth
}: WorkspaceLayoutProps) {
  return (
    <main
      data-workspace-layout
      className={
        isFileManagerWindow
          ? "app-surface relative z-0 grid min-h-0 grid-cols-[minmax(0,1fr)] bg-background"
          : `app-surface relative z-0 grid min-h-0 bg-background ${
              rightPanelCollapsed
                ? "grid-cols-[var(--left-panel-width)_8px_minmax(0,1fr)_0_0]"
                : "grid-cols-[var(--left-panel-width)_8px_minmax(0,1fr)_8px_var(--right-panel-width)]"
            }`
      }
      style={style}
    >
      {!isFileManagerWindow && (
        <>
          {leftPanel}
          <PanelResizer
            side="left"
            title="拖拽调整左侧宽度，双击恢复"
            onStartResize={onStartPanelResize}
            onResetWidth={onResetPanelWidth}
          />
          {terminalArea}
          {!rightPanelCollapsed && (
          <PanelResizer
            side="right"
            title="拖拽调整右侧宽度，双击恢复"
            onStartResize={onStartPanelResize}
            onResetWidth={onResetPanelWidth}
          />
          )}
        </>
      )}
      {children}
    </main>
  );
}

type PanelResizerProps = {
  side: "left" | "right";
  title: string;
  onStartResize: (side: "left" | "right", event: MouseEvent<HTMLDivElement>) => void;
  onResetWidth: (side: "left" | "right") => void;
};

function PanelResizer({ side, title, onStartResize, onResetWidth }: PanelResizerProps) {
  return (
    <div
      className="panel-resizer relative min-h-0 min-w-2 cursor-col-resize [background:linear-gradient(90deg,transparent_0_3px,var(--border)_3px_5px,transparent_5px_100%)] after:absolute after:inset-x-0.5 after:inset-y-0 after:rounded after:content-[''] hover:after:bg-ring/30"
      role="separator"
      aria-orientation="vertical"
      title={title}
      onMouseDown={(event) => onStartResize(side, event)}
      onDoubleClick={() => onResetWidth(side)}
    />
  );
}
