import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUp,
  BookmarkMinus,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Edit3,
  FolderPlus,
  Home,
  MoveRight,
  RefreshCcw,
  Search,
  Trash2,
  X
} from "lucide-react";

import { AppSelect } from "@/components/app/AppSelect";
import { IconButton } from "@/components/app/IconButton";
import { Input } from "@/components/ui/input";
import { PathBreadcrumbs } from "@/features/files/PathBreadcrumbs";
import type { PathBookmark } from "@/features/files/filePaneTypes";

type FilePaneChromeProps = {
  title: string;
  path: string;
  selectionCount: number;
  filter: string;
  bookmarks: PathBookmark[];
  canBack: boolean;
  canForward: boolean;
  notice?: ReactNode;
  extraActions: ReactNode;
  onPath: (path: string) => void;
  onFilter: (filter: string) => void;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onMkdir: () => void;
  onRename: () => void;
  onRemove: () => void;
  onBookmarkCurrent: () => void;
  onOpenBookmark: (path: string) => void;
  onRemoveBookmark: (path: string) => void;
};

export function FilePaneChrome({
  title,
  path,
  selectionCount,
  filter,
  bookmarks,
  canBack,
  canForward,
  notice,
  extraActions,
  onPath,
  onFilter,
  onBack,
  onForward,
  onHome,
  onParent,
  onRefresh,
  onMkdir,
  onRename,
  onRemove,
  onBookmarkCurrent,
  onOpenBookmark,
  onRemoveBookmark
}: FilePaneChromeProps) {
  const [pathDraft, setPathDraft] = useState(path);
  const [bookmarkPath, setBookmarkPath] = useState("");

  useEffect(() => {
    setPathDraft(path);
  }, [path]);

  useEffect(() => {
    if (bookmarkPath && !bookmarks.some((bookmark) => bookmark.path === bookmarkPath)) {
      setBookmarkPath("");
    }
  }, [bookmarkPath, bookmarks]);

  const commitPath = () => {
    const next = pathDraft.trim();
    if (!next) {
      setPathDraft(path);
      return;
    }
    if (next === path) return;
    onPath(next);
  };

  return (
    <>
      <div className="mb-[5px] grid min-h-7 min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
        <div className="text-xs font-semibold text-muted-foreground">{title}</div>
        <div data-scroll-container className="flex min-h-7 min-w-0 gap-1 overflow-x-auto overflow-y-hidden [&_[data-slot=button]]:size-7 [&_[data-slot=button]]:min-w-7 [&_[data-slot=button]]:p-0">
          <Input
            className="h-7 min-w-0 flex-[1_0_120px] px-[7px] text-xs"
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPath();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setPathDraft(path);
              }
            }}
            onBlur={() => {
              if (!pathDraft.trim()) setPathDraft(path);
            }}
          />
          <IconButton title="跳转路径" icon={<MoveRight size={14} />} onClick={commitPath} disabled={!pathDraft.trim() || pathDraft === path} />
          <IconButton title="后退" icon={<ChevronLeft size={14} />} onClick={onBack} disabled={!canBack} />
          <IconButton title="前进" icon={<ChevronRight size={14} />} onClick={onForward} disabled={!canForward} />
          <IconButton title="主目录" icon={<Home size={14} />} onClick={onHome} />
          <IconButton title="上级目录" icon={<ArrowUp size={14} />} onClick={onParent} />
          <IconButton title="刷新" icon={<RefreshCcw size={14} />} onClick={onRefresh} />
          <IconButton title="新建目录" icon={<FolderPlus size={14} />} onClick={onMkdir} />
          <IconButton title={selectionCount > 1 ? "批量重命名" : "重命名"} icon={<Edit3 size={14} />} onClick={onRename} disabled={selectionCount === 0} />
          <IconButton title="删除" icon={<Trash2 size={14} />} onClick={onRemove} disabled={selectionCount === 0} />
          {extraActions}
        </div>
      </div>
      <PathBreadcrumbs path={path} title={title} onPath={onPath} />
      <div className="mb-1 grid min-w-0 grid-cols-[minmax(120px,1fr)_minmax(112px,0.72fr)] items-center gap-1">
        <div className="flex h-6 min-w-0 items-center gap-1 rounded-md border border-border/60 bg-input/30 px-[5px] text-[11px] text-muted-foreground transition-colors focus-within:border-ring/60 [&>svg]:size-3 [&>svg]:shrink-0">
          <Search size={13} />
          <Input className="h-[22px] min-w-0 flex-1 border-0 bg-transparent p-0 text-[11px] shadow-none focus-visible:ring-0" value={filter} onChange={(event) => onFilter(event.target.value)} placeholder="过滤当前列表" />
          <IconButton title="清空过滤" className="size-[18px] min-w-[18px] p-0" icon={<X size={13} />} onClick={() => onFilter("")} disabled={!filter} />
        </div>
        <div className="flex min-w-0 gap-1">
          <AppSelect
            className="h-6 min-w-0 flex-1 text-[11px]"
            triggerClassName="border-border/70 bg-input/80 px-2 pr-6 text-[11px]"
            value={bookmarkPath}
            ariaLabel="收藏路径"
            options={[
              { value: "", label: "收藏路径" },
              ...bookmarks.map((bookmark) => ({ value: bookmark.path, label: bookmark.label }))
            ]}
            onChange={(next) => {
              setBookmarkPath(next);
              if (next) onOpenBookmark(next);
            }}
          />
          <IconButton
            title="收藏当前路径"
            className="size-6 min-w-6 p-0"
            icon={<BookmarkPlus size={14} />}
            onClick={onBookmarkCurrent}
            disabled={!path.trim()}
          />
          <IconButton
            title="移除收藏"
            className="size-6 min-w-6 p-0"
            icon={<BookmarkMinus size={14} />}
            onClick={() => {
              if (!bookmarkPath) return;
              onRemoveBookmark(bookmarkPath);
              setBookmarkPath("");
            }}
            disabled={!bookmarkPath}
          />
        </div>
      </div>
      {notice}
    </>
  );
}

export function SearchNotice({ root, query, count, onClear }: { root: string; query: string; count: number; onClear: () => void }) {
  return (
    <div className="mb-[7px] flex h-7 items-center gap-1.5 rounded-md border bg-muted/40 px-1.5 text-xs">
      <Search size={13} />
      <span className="min-w-0 flex-1 truncate" title={`${root} / ${query}`}>
        {query} · {count} 条
      </span>
      <IconButton title="退出搜索" className="size-[22px] min-w-[22px] p-0" icon={<X size={13} />} onClick={onClear} />
    </div>
  );
}
