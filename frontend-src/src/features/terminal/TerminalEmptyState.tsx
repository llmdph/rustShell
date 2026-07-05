import { Cable, CirclePlus, Folder, Monitor } from "lucide-react";

import { Button } from "@/components/ui/button";

const emptyActionClass =
  "grid h-[116px] place-items-center gap-2.5 rounded-xl border-border/70 bg-card/80 px-3 py-4 text-center text-foreground shadow-sm transition-colors hover:border-primary/60 hover:bg-accent disabled:opacity-50 [&_span]:max-w-full [&_span]:truncate [&_span]:text-[13px] [&_span]:font-semibold [&_svg]:size-7 [&_svg]:text-primary/80";

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
    <div className="grid min-w-0 flex-1 place-items-center overflow-hidden px-8 py-6 text-muted-foreground max-[560px]:p-[18px]">
      <div className="grid w-full max-w-[680px] justify-items-center gap-5">
        <div className="text-sm font-semibold text-foreground/90">没有打开的会话</div>
        <div className="grid w-full grid-cols-1 gap-3 min-[561px]:grid-cols-2 min-[901px]:grid-cols-4">
          <Button type="button" variant="outline" className={emptyActionClass} onClick={onCreateProfile}>
            <CirclePlus size={28} />
            <span>新建会话</span>
          </Button>
          <Button type="button" variant="outline" className={emptyActionClass} onClick={onQuickConnect}>
            <Cable size={28} />
            <span>快速连接</span>
          </Button>
          <Button type="button" variant="outline" className={emptyActionClass} onClick={onOpenSelected} disabled={!canOpenSelected}>
            <Monitor size={28} />
            <span>打开选中</span>
          </Button>
          <Button type="button" variant="outline" className={emptyActionClass} onClick={onOpenFileManager}>
            <Folder size={28} />
            <span>文件管理器</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
