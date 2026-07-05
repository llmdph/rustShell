import type { DragEvent, MouseEvent, ReactNode } from "react";

import type { FileEntry } from "@/api";
import type { FileAction } from "@/components/app/ActionContextMenu";
import { FileList } from "@/features/files/FileList";
import { FilePaneChrome } from "@/features/files/FilePaneChrome";
import type { FileCompareMark, FileSide, FileSort, FileSortKey, PathBookmark } from "@/features/files/filePaneTypes";

type FilePaneProps = {
  side: FileSide;
  title: string;
  path: string;
  files: FileEntry[];
  compareMarks: Map<string, FileCompareMark>;
  selected: FileEntry | null;
  selectedPaths: string[];
  selectionCount: number;
  sort: FileSort;
  filter: string;
  bookmarks: PathBookmark[];
  onPath: (path: string) => void;
  onFilter: (filter: string) => void;
  onSelect: (file: FileEntry, event: MouseEvent<HTMLButtonElement>) => void;
  onDragStart: (file: FileEntry, event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  dropActive: boolean;
  onSort: (key: FileSortKey) => void;
  onOpen: (file: FileEntry) => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  onHome: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onMkdir: () => void;
  onRename: () => void;
  onRemove: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBookmarkCurrent: () => void;
  onOpenBookmark: (path: string) => void;
  onRemoveBookmark: (path: string) => void;
  contextActions: FileAction[];
  notice?: ReactNode;
  extraActions: ReactNode;
  compareMarkLabel: (mark: FileCompareMark) => string;
  formatOwner: (file: FileEntry) => string;
  formatSize: (size: number) => string;
  formatFileDateTime: (value: string, withSeconds?: boolean) => string;
  formatEntrySymbolicMode: (file: FileEntry) => string;
};

export function FilePane({
  side,
  title,
  path,
  files,
  compareMarks,
  selected,
  selectedPaths,
  selectionCount,
  sort,
  filter,
  bookmarks,
  onPath,
  onFilter,
  onSelect,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dropActive,
  onSort,
  onOpen,
  onBack,
  onForward,
  canBack,
  canForward,
  onHome,
  onParent,
  onRefresh,
  onMkdir,
  onRename,
  onRemove,
  onSelectAll,
  onClearSelection,
  onBookmarkCurrent,
  onOpenBookmark,
  onRemoveBookmark,
  contextActions,
  notice,
  extraActions,
  compareMarkLabel,
  formatOwner,
  formatSize,
  formatFileDateTime,
  formatEntrySymbolicMode
}: FilePaneProps) {
  const prepareContextMenu = (event: MouseEvent, file?: FileEntry, alreadySelected = false) => {
    if (file && !alreadySelected) {
      onSelect(file, event as MouseEvent<HTMLButtonElement>);
    }
  };

  return (
    <div
      className={`relative mt-2.5 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${dropActive ? "bg-primary/5 outline-dashed outline-1 outline-offset-[3px] outline-primary/60" : ""}`}
      data-file-pane-side={side}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropActive && <div className="pointer-events-none absolute inset-x-2 bottom-2 top-9 z-[5] flex items-center justify-center rounded-lg border border-dashed border-primary/60 bg-background/80 text-[13px]">拖放到{side === "local" ? "本地下载" : "远程上传"}</div>}
      <FilePaneChrome
        title={title}
        path={path}
        selectionCount={selectionCount}
        filter={filter}
        bookmarks={bookmarks}
        canBack={canBack}
        canForward={canForward}
        notice={notice}
        extraActions={extraActions}
        onPath={onPath}
        onFilter={onFilter}
        onBack={onBack}
        onForward={onForward}
        onHome={onHome}
        onParent={onParent}
        onRefresh={onRefresh}
        onMkdir={onMkdir}
        onRename={onRename}
        onRemove={onRemove}
        onBookmarkCurrent={onBookmarkCurrent}
        onOpenBookmark={onOpenBookmark}
        onRemoveBookmark={onRemoveBookmark}
      />
      <FileList
        files={files}
        compareMarks={compareMarks}
        selected={selected}
        selectedPaths={selectedPaths}
        sort={sort}
        onSelect={onSelect}
        onSort={onSort}
        onOpen={onOpen}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onSelectAll={onSelectAll}
        onClearSelection={onClearSelection}
        onRemove={onRemove}
        onRename={onRename}
        onContextMenu={prepareContextMenu}
        contextActions={contextActions}
        compareMarkLabel={compareMarkLabel}
        formatOwner={formatOwner}
        formatSize={formatSize}
        formatFileDateTime={formatFileDateTime}
        formatEntrySymbolicMode={formatEntrySymbolicMode}
      />
    </div>
  );
}
