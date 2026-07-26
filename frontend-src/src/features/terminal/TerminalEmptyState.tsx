import { Cable, CirclePlus, Folder, Monitor } from "lucide-react";

import { Button } from "@/components/ui/button";

const WORDMARK = "RUSTSHELL";

const actionKeyClass =
  "group grid h-[88px] place-items-center gap-2 rounded-lg text-foreground/90 hover:border-ring/70 hover:bg-accent/60 disabled:opacity-50 dark:hover:border-ring/70 dark:hover:bg-accent/60";

const actionIconClass =
  "size-5 text-muted-foreground transition-transform duration-200 ease-[var(--ease-swift)] group-hover:-translate-y-px group-hover:text-foreground";

type TerminalEmptyStateProps = {
  canOpenSelected: boolean;
  onCreateProfile: () => void;
  onQuickConnect: () => void;
  onOpenSelected: () => void;
  onOpenFileManager: () => void;
};

export function TerminalEmptyState({
  canOpenSelected,
  onCreateProfile,
  onQuickConnect,
  onOpenSelected,
  onOpenFileManager
}: TerminalEmptyStateProps) {
  return (
    <div className="grid min-w-0 flex-1 select-none place-items-center overflow-hidden px-8 py-6 max-[560px]:p-[18px]">
      <div className="grid w-full max-w-[720px] justify-items-center gap-7">
        <div
          className="font-mono leading-none tracking-normal text-foreground/90"
          style={{ fontSize: "clamp(38px, 7.5vw, 84px)", fontWeight: 460 }}
        >
          {WORDMARK.split("").map((glyph, index) => (
            <span key={index} className="glyph-wave font-mono" style={{ animationDelay: `${index * 130}ms` }}>
              {glyph}
            </span>
          ))}
          <span aria-hidden="true" className="boot-cursor text-foreground/60">
            ▍
          </span>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          SSH · SFTP · LOCAL SHELL
        </div>
        <p className="text-[13px] text-muted-foreground">没有打开的会话，从这里开始。</p>
        <div className="grid w-full grid-cols-1 gap-3 min-[561px]:grid-cols-2 min-[901px]:grid-cols-4">
          <Button type="button" variant="outline" className={actionKeyClass} onClick={onCreateProfile}>
            <CirclePlus size={20} strokeWidth={1.75} className={actionIconClass} />
            <span className="text-xs font-medium">新建会话</span>
          </Button>
          <Button type="button" variant="outline" className={actionKeyClass} onClick={onQuickConnect}>
            <Cable size={20} strokeWidth={1.75} className={actionIconClass} />
            <span className="text-xs font-medium">快速连接</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className={actionKeyClass}
            onClick={onOpenSelected}
            disabled={!canOpenSelected}
          >
            <Monitor size={20} strokeWidth={1.75} className={actionIconClass} />
            <span className="text-xs font-medium">打开选中</span>
          </Button>
          <Button type="button" variant="outline" className={actionKeyClass} onClick={onOpenFileManager}>
            <Folder size={20} strokeWidth={1.75} className={actionIconClass} />
            <span className="text-xs font-medium">文件管理器</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
