import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, WholeWord, X } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

export type TerminalSearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

/** `index` is -1 when the addon stopped counting (past its highlight limit). */
export type TerminalSearchResult = {
  index: number;
  count: number;
};

export const emptyTerminalSearchResult: TerminalSearchResult = { index: -1, count: 0 };

/** Search state lives inside the XtermView that owns the addon. Toolbar buttons
 * sit outside that tree, so they ask for the overlay through the same window
 * event channel the terminal layout already uses for cross-component signals. */
export const TERMINAL_SEARCH_EVENT = "rustshell:terminal-search";

export function requestTerminalSearch(terminalId: string) {
  window.dispatchEvent(new CustomEvent(TERMINAL_SEARCH_EVENT, { detail: { terminalId } }));
}

type TerminalSearchOverlayProps = {
  query: string;
  options: TerminalSearchOptions;
  result: TerminalSearchResult;
  inputRef: Ref<HTMLInputElement>;
  onQueryChange: (query: string) => void;
  onToggleOption: (option: keyof TerminalSearchOptions) => void;
  onStep: (reverse: boolean) => void;
  onClose: () => void;
  onInputBlur: () => void;
  onInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
};

const stepClass =
  "grid size-[22px] place-items-center rounded-sm text-muted-foreground outline-none transition-[color,background-color] duration-[var(--duration-fast)] ease-[var(--ease-swift)] hover:bg-accent hover:text-foreground focus-visible:ring-[2px] focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40";

const toggleClass =
  "grid h-[22px] w-[26px] place-items-center rounded-sm outline-none transition-[color,background-color] duration-[var(--duration-fast)] ease-[var(--ease-swift)] focus-visible:ring-[2px] focus-visible:ring-ring/60";

/** Readout stays a fixed width by zero-padding the position to the total's digits,
 * so the bar never reflows while stepping through matches. */
function formatReadout(query: string, { index, count }: TerminalSearchResult) {
  if (!query) return "··/··";
  if (count === 0) return "00/00";
  const total = String(count);
  if (index < 0) return `${"·".repeat(total.length)}/${total}`;
  return `${String(index + 1).padStart(total.length, "0")}/${total}`;
}

export function TerminalSearchOverlay({
  query,
  options,
  result,
  inputRef,
  onQueryChange,
  onToggleOption,
  onStep,
  onClose,
  onInputBlur,
  onInputKeyDown
}: TerminalSearchOverlayProps) {
  const misses = query.length > 0 && result.count === 0;
  const canStep = result.count > 0;
  const progress = result.count > 0 && result.index >= 0 ? ((result.index + 1) / result.count) * 100 : 0;

  return (
    <div
      data-terminal-search
      className="animate-in fade-in-0 slide-in-from-top-2 absolute right-3 top-2.5 z-[6] w-[min(430px,calc(100%-1.5rem))] duration-[var(--duration-slow)] ease-[var(--ease-spring)]"
    >
      <div
        className={cn(
          "relative flex items-center gap-1 overflow-hidden rounded-md border bg-popover/92 py-1 pl-2 pr-1 shadow-lg backdrop-blur-md transition-[border-color] duration-[var(--duration-base)] ease-[var(--ease-swift)]",
          misses ? "border-destructive/55" : "border-border/80"
        )}
      >
        {/* Instrument hairline: a filament of signal light along the top edge. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-signal/55 to-transparent"
        />
        <Search size={13} strokeWidth={2} className="shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          onBlur={onInputBlur}
          spellCheck={false}
          autoComplete="off"
          aria-label="在终端缓冲区中查找"
          placeholder="查找输出…"
          className="h-[22px] min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/65"
        />
        <span
          aria-live="polite"
          className={cn(
            "shrink-0 select-none font-mono text-[10.5px] tabular-nums tracking-tight transition-colors duration-[var(--duration-base)]",
            misses ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {formatReadout(query, result)}
        </span>
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
        <button type="button" className={stepClass} title="上一个匹配（Shift+Enter）" aria-label="上一个匹配" disabled={!canStep} onClick={() => onStep(true)}>
          <ChevronUp size={13} />
        </button>
        <button type="button" className={stepClass} title="下一个匹配（Enter）" aria-label="下一个匹配" disabled={!canStep} onClick={() => onStep(false)}>
          <ChevronDown size={13} />
        </button>
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
        <SearchToggle active={options.caseSensitive} title="区分大小写" onToggle={() => onToggleOption("caseSensitive")}>
          <CaseSensitive size={13} />
        </SearchToggle>
        <SearchToggle active={options.wholeWord} title="全词匹配" onToggle={() => onToggleOption("wholeWord")}>
          <WholeWord size={13} />
        </SearchToggle>
        <SearchToggle active={options.regex} title="正则表达式" onToggle={() => onToggleOption("regex")}>
          <Regex size={13} />
        </SearchToggle>
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
        <button type="button" className={stepClass} title="关闭查找（Esc）" aria-label="关闭查找" onClick={onClose}>
          <X size={13} />
        </button>
        {/* Position rail: where the active match sits inside the whole result set. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border/40">
          <span
            className="block h-full bg-signal/70 transition-[width] duration-[var(--duration-base)] ease-[var(--ease-swift)]"
            style={{ width: `${progress}%` }}
          />
        </span>
      </div>
    </div>
  );
}

function SearchToggle({
  active,
  title,
  onToggle,
  children
}: {
  active: boolean;
  title: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onToggle}
      className={cn(toggleClass, active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
    >
      {children}
    </button>
  );
}
