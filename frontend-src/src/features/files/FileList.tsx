import { useVirtualizer } from "@tanstack/react-virtual";
import { Folder, Link2 } from "lucide-react";
import { memo, useMemo, useRef, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";

import type { FileEntry } from "@/api";
import { ActionContextMenu, type FileAction } from "@/components/app/ActionContextMenu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMode } from "@/features/files/permissions";
import { cn } from "@/lib/utils";
import type { FileCompareMark, FileSort, FileSortKey } from "@/features/files/filePaneTypes";

const ROW_GRID =
  "grid w-full min-h-[26px] items-center gap-[7px] px-[5px] text-left text-[11px] " +
  "grid-cols-[minmax(160px,1.4fr)_minmax(88px,112px)_minmax(42px,58px)_minmax(54px,68px)_minmax(92px,118px)] " +
  "@max-[560px]/file-list:grid-cols-[minmax(150px,1fr)_72px_58px_98px] " +
  "@max-[450px]/file-list:grid-cols-[minmax(150px,1fr)_58px_94px] " +
  "@max-[340px]/file-list:grid-cols-[minmax(132px,1fr)_58px] " +
  "@max-[280px]/file-list:grid-cols-[minmax(0,1fr)]";

const COMPARE_BORDER: Record<string, string> = {
  same: "border-r-[3px] border-r-emerald-500/60",
  different: "border-r-[3px] border-r-orange-500/80",
  "only-local": "border-r-[3px] border-r-yellow-500/80",
  "only-remote": "border-r-[3px] border-r-sky-400/80"
};

const COMPARE_BG: Record<string, string> = {
  different: "bg-orange-500/10",
  "only-local": "bg-yellow-500/10",
  "only-remote": "bg-sky-400/10"
};

type FileListProps = {
  files: FileEntry[];
  compareMarks: Map<string, FileCompareMark>;
  selected: FileEntry | null;
  selectedPaths: string[];
  sort: FileSort;
  onSelect: (file: FileEntry, event: MouseEvent<HTMLButtonElement>) => void;
  onSort: (key: FileSortKey) => void;
  onOpen: (file: FileEntry) => void;
  onDragStart: (file: FileEntry, event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onRemove: () => void;
  onRename: () => void;
  onContextMenu: (event: MouseEvent, file?: FileEntry, alreadySelected?: boolean) => void;
  contextActions: FileAction[];
  compareMarkLabel: (mark: FileCompareMark) => string;
  formatOwner: (file: FileEntry) => string;
  formatSize: (size: number) => string;
  formatFileDateTime: (value: string, withSeconds?: boolean) => string;
  formatEntrySymbolicMode: (file: FileEntry) => string;
  variant?: "default" | "flat";
};

export function FileList({
  files,
  compareMarks,
  selected,
  selectedPaths,
  sort,
  onSelect,
  onSort,
  onOpen,
  onDragStart,
  onDragEnd,
  onSelectAll,
  onClearSelection,
  onRemove,
  onRename,
  onContextMenu,
  contextActions,
  compareMarkLabel,
  formatOwner,
  formatSize,
  formatFileDateTime,
  formatEntrySymbolicMode,
  variant = "default"
}: FileListProps) {
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const listBodyRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getItemKey: (index) => files[index]?.path ?? index,
    getScrollElement: () => listBodyRef.current,
    estimateSize: () => 26,
    overscan: 18
  });
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      onSelectAll();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClearSelection();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selectedPaths.length === 0) return;
      event.preventDefault();
      onRemove();
      return;
    }
    if (event.key === "F2") {
      if (!selected || selectedPaths.length > 1) return;
      event.preventDefault();
      onRename();
      return;
    }
    if (event.key === "Enter") {
      if (!selected) return;
      event.preventDefault();
      onOpen(selected);
    }
  };

  return (
    <ActionContextMenu actions={contextActions}>
      <div
        data-file-list-root
        data-file-list-variant={variant}
        className={cn(
          "@container/file-list flex h-full min-h-[120px] min-w-0 flex-1 flex-col overflow-hidden bg-background",
          variant === "flat" ? "rounded-none border-0" : "rounded-md border"
        )}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onContextMenu={(event) => onContextMenu(event)}
      >
        <div className={cn(ROW_GRID, "shrink-0 border-b bg-muted/60 text-muted-foreground")}>
          <SortHeader label="名称" sortKey="name" sort={sort} onSort={onSort} />
          <SortHeader label="权限" sortKey="permissions" sort={sort} onSort={onSort} className="@max-[450px]/file-list:hidden" />
          <SortHeader label="属主" sortKey="owner" sort={sort} onSort={onSort} className="@max-[560px]/file-list:hidden" />
          <SortHeader label="大小" sortKey="size" sort={sort} onSort={onSort} className="@max-[280px]/file-list:hidden" />
          <SortHeader label="时间" sortKey="modifiedAt" sort={sort} onSort={onSort} className="@max-[340px]/file-list:hidden" />
        </div>
        <div ref={listBodyRef} data-scroll-container className="min-h-0 flex-1 overflow-auto">
          <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const file = files[virtualRow.index];
              if (!file) return null;
              return (
                <FileRow
                  key={file.path}
                  file={file}
                  compareMark={compareMarks.get(file.path)}
                  selected={selectedPathSet.has(file.path)}
                  primary={selected?.path === file.path}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                  contextActions={contextActions}
                  compareMarkLabel={compareMarkLabel}
                  formatOwner={formatOwner}
                  formatSize={formatSize}
                  formatFileDateTime={formatFileDateTime}
                  formatEntrySymbolicMode={formatEntrySymbolicMode}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onContextMenu={onContextMenu}
                />
              );
            })}
          </div>
        </div>
      </div>
    </ActionContextMenu>
  );
}

type FileRowProps = {
  file: FileEntry;
  compareMark?: FileCompareMark;
  selected: boolean;
  primary: boolean;
  style: CSSProperties;
  contextActions: FileAction[];
  compareMarkLabel: (mark: FileCompareMark) => string;
  formatOwner: (file: FileEntry) => string;
  formatSize: (size: number) => string;
  formatFileDateTime: (value: string, withSeconds?: boolean) => string;
  formatEntrySymbolicMode: (file: FileEntry) => string;
  onSelect: (file: FileEntry, event: MouseEvent<HTMLButtonElement>) => void;
  onOpen: (file: FileEntry) => void;
  onDragStart: (file: FileEntry, event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onContextMenu: (event: MouseEvent, file?: FileEntry, alreadySelected?: boolean) => void;
};

const FileRow = memo(function FileRow({
  file,
  compareMark,
  selected,
  primary,
  style,
  contextActions,
  compareMarkLabel,
  formatOwner,
  formatSize,
  formatFileDateTime,
  formatEntrySymbolicMode,
  onSelect,
  onOpen,
  onDragStart,
  onDragEnd,
  onContextMenu
}: FileRowProps) {
  const compareText = compareMark ? compareMarkLabel(compareMark) : "";
  const compareDetail = compareMark?.detail ?? "";

  return (
    <ActionContextMenu actions={contextActions}>
      <button
        style={style}
        className={cn(
          ROW_GRID,
          "text-foreground hover:bg-accent",
          compareMark && COMPARE_BORDER[compareMark.kind],
          compareMark && !selected && COMPARE_BG[compareMark.kind],
          selected && "bg-primary/15",
          primary && "[box-shadow:inset_3px_0_0_0_var(--ring)]"
        )}
        onClick={(event) => onSelect(file, event)}
        onDoubleClick={() => onOpen(file)}
        draggable
        onDragStart={(event) => onDragStart(file, event)}
        onDragEnd={onDragEnd}
        onContextMenu={(event) => {
          event.stopPropagation();
          onContextMenu(event, file, selected);
        }}
        title={[file.linkTarget ? `${file.path} -> ${file.linkTarget}` : file.path, compareDetail || compareText]
          .filter(Boolean)
          .join(" · ")}
      >
        <span className="inline-flex w-full min-w-0 items-center gap-[5px]">
          {file.fileType === "symlink" ? <Link2 size={13} className="shrink-0" /> : file.isDir ? <Folder size={13} className="shrink-0" /> : <span className="h-2.5 w-[7px] shrink-0 rounded-[1px] bg-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          {compareText && <span className="max-w-24 shrink-0 truncate rounded-[3px] bg-secondary px-1 py-px text-[11px] text-muted-foreground @max-[450px]/file-list:hidden" title={compareDetail || compareText}>{compareText}</span>}
          {file.linkTarget && <span className="min-w-0 truncate text-muted-foreground @max-[560px]/file-list:hidden">-&gt; {file.linkTarget}</span>}
        </span>
        <PermissionCell file={file} formatEntrySymbolicMode={formatEntrySymbolicMode} />
        <span className="min-w-0 truncate @max-[560px]/file-list:hidden">{formatOwner(file)}</span>
        <span className="min-w-0 truncate @max-[280px]/file-list:hidden">{file.isDir ? "-" : formatSize(file.size)}</span>
        <span className="min-w-0 truncate @max-[340px]/file-list:hidden" title={formatFileDateTime(file.modifiedAt, true)}>{formatFileDateTime(file.modifiedAt)}</span>
      </button>
    </ActionContextMenu>
  );
}, areFileRowPropsEqual);

function areFileRowPropsEqual(prev: FileRowProps, next: FileRowProps) {
  return (
    prev.file === next.file &&
    prev.compareMark === next.compareMark &&
    prev.selected === next.selected &&
    prev.primary === next.primary &&
    prev.contextActions === next.contextActions &&
    prev.compareMarkLabel === next.compareMarkLabel &&
    prev.formatOwner === next.formatOwner &&
    prev.formatSize === next.formatSize &&
    prev.formatFileDateTime === next.formatFileDateTime &&
    prev.formatEntrySymbolicMode === next.formatEntrySymbolicMode &&
    prev.onSelect === next.onSelect &&
    prev.onOpen === next.onOpen &&
    prev.onDragStart === next.onDragStart &&
    prev.onDragEnd === next.onDragEnd &&
    prev.onContextMenu === next.onContextMenu &&
    sameVirtualRowStyle(prev.style, next.style)
  );
}

function sameVirtualRowStyle(prev?: CSSProperties, next?: CSSProperties) {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return prev.position === next.position && prev.top === next.top && prev.left === next.left && prev.transform === next.transform;
}

const PermissionCell = memo(function PermissionCell({
  file,
  formatEntrySymbolicMode
}: {
  file: FileEntry;
  formatEntrySymbolicMode: (file: FileEntry) => string;
}) {
  const mode = formatMode(file.permissions);
  if (!mode) return <span className="font-mono text-muted-foreground @max-[450px]/file-list:hidden">-</span>;
  const symbolic = formatEntrySymbolicMode(file);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] @max-[450px]/file-list:hidden" title={`${mode} ${symbolic}`}>
      <Badge
        variant="outline"
        className="h-5 min-w-8 rounded-sm px-1.5 py-0 text-[10px] font-semibold leading-none text-foreground"
      >
        {mode}
      </Badge>
      <span className="min-w-0 truncate text-[10px] text-muted-foreground max-[1180px]:hidden">{symbolic}</span>
    </span>
  );
});

const SortHeader = memo(function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className
}: {
  label: string;
  sortKey: FileSortKey;
  sort: FileSort;
  onSort: (key: FileSortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("h-6 min-w-0 justify-start gap-[3px] rounded-none px-0 text-left font-normal", active && "text-foreground", className)}
      onClick={() => onSort(sortKey)}
    >
      <span className="min-w-0">{label}</span>
      {active && <span>{sort.direction === "asc" ? "↑" : "↓"}</span>}
    </Button>
  );
});
