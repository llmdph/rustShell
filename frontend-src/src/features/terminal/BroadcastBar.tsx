import { ChevronDown, CornerDownLeft, Radio, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type { TerminalView } from "@/api";
import { IconButton } from "@/components/app/IconButton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { Snippet } from "./terminalSnippets";

type BroadcastBarProps = {
  command: string;
  targets: TerminalView[];
  totalTabs: number;
  snippets: Snippet[];
  onCommandChange: (command: string) => void;
  onSend: (command: string) => void;
  onManageSnippets: () => void;
  onClose: () => void;
};

export function BroadcastBar({
  command,
  targets,
  totalTabs,
  snippets,
  onCommandChange,
  onSend,
  onManageSnippets,
  onClose
}: BroadcastBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const armed = targets.length > 0;
  const canSend = armed && command.trim().length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <section
      data-broadcast-bar
      className="animate-in fade-in-0 slide-in-from-top-2 relative z-[4] flex min-w-0 flex-wrap items-center gap-2 overflow-hidden border-b border-border/70 bg-card/85 px-[9px] py-1.5 duration-[var(--duration-slow)] ease-[var(--ease-spring)]"
    >
      {/* Armed mode reads as a hatched band rather than a colored one — chrome
        * stays monochrome, and the only colored element is the live-link count. */}
      <span aria-hidden className="hatch-armed pointer-events-none absolute inset-0" />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/25 to-transparent"
      />

      <div className="relative flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <Radio size={14} className={cn("shrink-0", armed && "text-foreground")} />
        {/* Latin micro-label tracking would tear the two CJK glyphs apart. */}
        <span className={cn("text-[11px] font-medium tracking-[0.12em]", armed && "text-foreground")}>广播</span>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "relative shrink-0 cursor-default select-none font-mono text-[11px] tabular-nums transition-colors duration-[var(--duration-base)]",
              armed ? "text-signal" : "text-muted-foreground"
            )}
          >
            {targets.length}
            <span className="text-muted-foreground">/{totalTabs}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={6} className="max-w-72">
          {armed ? `将发送到：${targets.map((tab) => tab.title).join("、")}` : "当前没有已连接的会话"}
        </TooltipContent>
      </Tooltip>

      <Input
        ref={inputRef}
        className="relative h-[26px] min-w-[140px] flex-1 rounded px-2 font-mono text-xs focus-visible:ring-0"
        value={command}
        onChange={(event) => onCommandChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSend(command);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={armed ? "输入命令，Enter 发送到所有已连接会话" : "没有已连接的会话"}
        aria-label="广播命令"
        disabled={!armed}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="relative h-[26px] shrink-0 gap-1 bg-card/60 px-2 font-mono text-[11px] text-muted-foreground shadow-none hover:text-foreground"
            disabled={!armed}
          >
            快捷命令
            <ChevronDown size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[min(46vh,380px)] w-64 overflow-y-auto" data-scroll-container>
          <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            广播快捷命令
          </DropdownMenuLabel>
          {snippets.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">还没有快捷命令</div>
          ) : (
            snippets.map((snippet) => (
              <DropdownMenuItem key={snippet.id} className="grid gap-0.5" onSelect={() => onSend(snippet.command)}>
                <span className="w-full truncate text-xs">{snippet.name}</span>
                <span className="w-full truncate font-mono text-[10.5px] text-muted-foreground">{snippet.command}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onManageSnippets}>管理快捷命令…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        size="sm"
        className="relative h-[26px] shrink-0 gap-1.5 px-2.5 text-[11px]"
        onClick={() => onSend(command)}
        disabled={!canSend}
      >
        <CornerDownLeft size={12} />
        发送 ×{targets.length}
      </Button>

      <IconButton className="relative h-[26px] w-[26px] min-w-[26px] p-0" title="关闭广播（Esc）" icon={<X size={13} />} onClick={onClose} />
    </section>
  );
}
