import { listen as listenTauriEvent } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { clampNumber } from "@/lib/math";
import { api, terminalOutputEvent, type AppSettings, type TerminalDrain, type TerminalView } from "../../api";
import {
  TERMINAL_SEARCH_EVENT,
  TerminalSearchOverlay,
  emptyTerminalSearchResult,
  type TerminalSearchOptions,
  type TerminalSearchResult
} from "./TerminalSearchOverlay";

type XtermViewProps = {
  terminal: TerminalView;
  settings: AppSettings;
  active: boolean;
  visible?: boolean;
  paneStyle?: CSSProperties;
  terminalBackgroundAlpha: number;
  onActivate?: () => void;
  onDrain: (drain: TerminalDrain) => void;
  onReplayConsumed: (terminalId: string) => void;
};

function hexByte(value: number) {
  return clampNumber(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

/// xterm's ThemeService parses colors most reliably as #rrggbb[aa]. Modern
/// space-separated `rgb(10 10 10)` fails its comma regex and only works via a
/// canvas fallback; keep the wire format boring so cursor/bg never drop out.
function alphaColor(rgb: [number, number, number], alpha: number) {
  const opacity = clampNumber(alpha, 55, 100) / 100;
  const [r, g, b] = rgb;
  const base = `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  if (opacity >= 1) return base;
  return `${base}${hexByte(opacity * 255)}`;
}

function xtermTheme(theme: AppSettings["theme"], backgroundAlpha = 100) {
  // shadcn Neutral 对齐：亮=白底近黑字，暗 deep = neutral-950 底近白字；
  // 光标/选区用中性灰阶，彩色只保留 ANSI 语义色（xterm 默认）。
  // Cursor colors stay fully opaque — blending a transparent bg onto the caret
  // is what made it disappear against the phosphor cell in some WebView builds.
  if (theme === "light") {
    return {
      background: alphaColor([255, 255, 255], backgroundAlpha),
      foreground: "#171717",
      cursor: "#171717",
      cursorAccent: "#ffffff",
      selectionBackground: "#d4d4d4"
    };
  }
  return {
    background: alphaColor([10, 10, 10], backgroundAlpha),
    foreground: "#e5e5e5",
    cursor: "#fafafa",
    cursorAccent: "#0a0a0a",
    selectionBackground: "#404040"
  };
}

/// Search highlights are the one place inside the terminal viewport where the
/// signal hue is allowed on content rather than chrome: bulk matches stay a
/// desaturated wash so the scrollback still reads, and only the active match
/// lights up. xterm needs literal #RRGGBB here — CSS vars never reach it.
function xtermSearchDecorations(theme: AppSettings["theme"]) {
  if (theme === "light") {
    return {
      matchBackground: "#dbe7e0",
      matchBorder: "#a4bbaf",
      matchOverviewRuler: "#a4bbaf",
      activeMatchBackground: "#a7e2c3",
      activeMatchBorder: "#177a4a",
      activeMatchColorOverviewRuler: "#177a4a"
    };
  }
  return {
    matchBackground: "#2f3b35",
    matchBorder: "#4c5f55",
    matchOverviewRuler: "#4c5f55",
    activeMatchBackground: "#1d7a4c",
    activeMatchBorder: "#7ef3b4",
    activeMatchColorOverviewRuler: "#7ef3b4"
  };
}

const defaultSearchOptions: TerminalSearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

/// Output arrives as a push event from the backend pump. This poll only exists
/// as a safety net for output that lands between mount and subscription, so it
/// runs rarely and skips entirely while events are flowing.
const DRAIN_SAFETY_POLL_DELAY = 2000;
const DRAIN_EVENT_STALE_AFTER = 1500;

export function XtermView({ terminal, settings, active, visible, paneStyle, terminalBackgroundAlpha, onActivate, onDrain, onReplayConsumed }: XtermViewProps) {
  const shown = visible ?? active;
  const terminalTheme = xtermTheme(settings.theme, terminalBackgroundAlpha);
  const terminalBackground = terminalTheme.background;
  const terminalCursor = terminalTheme.cursor;
  const terminalCursorAccent = terminalTheme.cursorAccent;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalMountRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarHideRef = useRef<number | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState<TerminalSearchOptions>(defaultSearchOptions);
  const [searchResult, setSearchResult] = useState<TerminalSearchResult>(emptyTerminalSearchResult);
  const sendBufferRef = useRef("");
  const sendScheduledRef = useRef(false);
  const drainOutputRef = useRef("");
  const drainWriteFrameRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const lastHostSizeRef = useRef({ width: 0, height: 0 });
  const lastTermSizeRef = useRef({ cols: 0, rows: 0 });
  const pendingResizeRef = useRef(false);
  const onDrainRef = useRef(onDrain);

  useEffect(() => {
    onDrainRef.current = onDrain;
  }, [onDrain]);

  const updateTerminalScrollbar = useCallback((show = false) => {
    const host = hostRef.current;
    const rail = terminalScrollbarRef.current;
    const thumb = terminalScrollbarThumbRef.current;
    const viewport = host?.querySelector<HTMLElement>(".xterm-viewport");
    if (!host || !rail || !thumb || !viewport) return;

    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const railHeight = rail.clientHeight;
    if (maxScroll <= 1 || railHeight <= 0) {
      host.classList.add("terminal-scrollbar-disabled");
      host.classList.remove("terminal-scrollbar-active");
      return;
    }

    host.classList.remove("terminal-scrollbar-disabled");
    const thumbHeight = clampNumber(Math.round((viewport.clientHeight / viewport.scrollHeight) * railHeight), 28, railHeight);
    const thumbTop = Math.round((viewport.scrollTop / maxScroll) * (railHeight - thumbHeight));
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;

    if (!show) return;
    host.classList.add("terminal-scrollbar-active");
    if (terminalScrollbarHideRef.current !== null) {
      window.clearTimeout(terminalScrollbarHideRef.current);
    }
    terminalScrollbarHideRef.current = window.setTimeout(() => {
      host.classList.remove("terminal-scrollbar-active");
      terminalScrollbarHideRef.current = null;
    }, 760);
  }, []);

  const runSearch = useCallback(
    (query: string, options: TerminalSearchOptions, { reverse = false, incremental = false } = {}) => {
      const search = searchRef.current;
      if (!search) return;
      if (!query) {
        search.clearDecorations();
        setSearchResult(emptyTerminalSearchResult);
        return;
      }
      const params: ISearchOptions = {
        ...options,
        // findPrevious ignores `incremental`; only forward typing should grow
        // the current selection instead of jumping to the next match.
        incremental: incremental && !reverse,
        decorations: xtermSearchDecorations(settings.theme)
      };
      try {
        if (reverse) search.findPrevious(query, params);
        else search.findNext(query, params);
      } catch {
        // An unfinished regex is a normal intermediate state while typing.
        setSearchResult(emptyTerminalSearchResult);
      }
    },
    [settings.theme]
  );

  const stepSearch = useCallback(
    (reverse: boolean) => runSearch(searchQuery, searchOptions, { reverse }),
    [runSearch, searchOptions, searchQuery]
  );

  const openSearch = useCallback(() => {
    const selection = termRef.current?.getSelection() ?? "";
    const seed = selection.includes("\n") ? "" : selection.trim();
    setSearchOpen(true);
    if (seed) setSearchQuery(seed);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchResult(emptyTerminalSearchResult);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  }, []);

  // Typing re-runs the search on a short trailing delay so a long scrollback is
  // not re-scanned on every keystroke. Enter / the step buttons bypass this.
  useEffect(() => {
    if (!searchOpen) return;
    const timer = window.setTimeout(() => runSearch(searchQuery, searchOptions, { incremental: true }), 90);
    return () => window.clearTimeout(timer);
  }, [runSearch, searchOpen, searchOptions, searchQuery]);

  // Ctrl+F has to be claimed before xterm forwards it to the shell. React's
  // synthetic capture phase runs at the root container — after xterm's own
  // listener on its textarea — so this has to be a native capture listener.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey;
      if (modifier && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        openSearch();
        return;
      }
      if (!searchOpen) return;
      if (event.key === "Escape") {
        // Only the overlay's own controls may swallow Escape — inside the
        // viewport it still belongs to whatever is running (vim, less, …).
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.closest("[data-terminal-search]")) return;
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
        return;
      }
      if (event.key === "F3") {
        event.preventDefault();
        event.stopPropagation();
        stepSearch(event.shiftKey);
      }
    };
    host.addEventListener("keydown", handleKeyDown, true);
    return () => host.removeEventListener("keydown", handleKeyDown, true);
  }, [closeSearch, openSearch, searchOpen, stepSearch]);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string }>).detail;
      if (detail?.terminalId === terminal.id) openSearch();
    };
    window.addEventListener(TERMINAL_SEARCH_EVENT, handleRequest);
    return () => window.removeEventListener(TERMINAL_SEARCH_EVENT, handleRequest);
  }, [openSearch, terminal.id]);

  const handleSearchInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    stepSearch(event.shiftKey);
  };

  const flushDrainOutput = useCallback(() => {
    drainWriteFrameRef.current = null;
    const output = drainOutputRef.current;
    drainOutputRef.current = "";
    if (!output) return;
    termRef.current?.write(output, () => updateTerminalScrollbar());
  }, [updateTerminalScrollbar]);

  const scheduleDrainWrite = useCallback(
    (output: string) => {
      drainOutputRef.current += output;
      if (drainWriteFrameRef.current !== null) return;
      drainWriteFrameRef.current = window.requestAnimationFrame(flushDrainOutput);
    },
    [flushDrainOutput]
  );

  const handleTerminalScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    const rail = terminalScrollbarRef.current;
    const thumb = terminalScrollbarThumbRef.current;
    const viewport = host?.querySelector<HTMLElement>(".xterm-viewport");
    if (!host || !rail || !thumb || !viewport) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const railRect = rail.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const maxThumbTop = railRect.height - thumbRect.height;
    const pointerOffset = event.target === thumb ? event.clientY - thumbRect.top : thumbRect.height / 2;

    const applyScroll = (clientY: number) => {
      if (maxScroll <= 0 || maxThumbTop <= 0) return;
      const nextTop = clampNumber(clientY - railRect.top - pointerOffset, 0, maxThumbTop);
      viewport.scrollTop = (nextTop / maxThumbTop) * maxScroll;
      updateTerminalScrollbar(true);
    };

    const handleMove = (moveEvent: globalThis.PointerEvent) => applyScroll(moveEvent.clientY);
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };

    applyScroll(event.clientY);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  useEffect(() => {
    if (!hostRef.current || !terminalMountRef.current) return;
    let disposed = false;
    const theme = xtermTheme(settings.theme, terminalBackgroundAlpha);
    const term = new Terminal({
      allowTransparency: true,
      // SearchAddon paints its match highlights through registerDecoration,
      // which xterm still gates behind the proposed-API flag. Without this the
      // addon throws on every findNext and the overlay reports zero matches.
      allowProposedApi: true,
      // Blink is painted as a CSS keyframe that alternates the cell to
      // `background-color: inherit`. Global prefers-reduced-motion (and some
      // WebView2 builds) freeze that on the transparent frame so the caret
      // vanishes. Keep a solid block instead; CSS below also pins the colors.
      cursorBlink: false,
      cursorStyle: "block",
      // Outline is easy to miss on the dark phosphor cell; keep a solid block
      // when the pane is visible but the textarea does not own focus.
      cursorInactiveStyle: "block",
      convertEol: true,
      fontFamily: '"Geist Mono Variable", "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace',
      fontSize: settings.fontSize,
      lineHeight: 1.18,
      scrollback: settings.scrollback,
      theme
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    const searchResults = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchResult({ index: resultIndex, count: resultCount });
    });
    term.open(terminalMountRef.current);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    const initialReplay = terminal.text;
    if (initialReplay) {
      term.write(initialReplay);
      onReplayConsumed(terminal.id);
    }
    // DomRenderer only attaches .xterm-cursor after isCursorInitialized, which
    // xterm sets on first focus/key. Touch focus once so a connected session is
    // not caret-less; release it again for background tabs so the active pane
    // keeps the real focus.
    term.focus();
    if (!active) term.blur();
    // Variable fonts can finish loading after open; remeasure so the caret
    // cell does not stay at a zero/stale width from the fallback face.
    const refreshAfterFonts = () => {
      if (disposed || termRef.current !== term) return;
      try {
        fit.fit();
        term.refresh(0, Math.max(term.rows - 1, 0));
      } catch {
        // fit can throw if the host is display:none mid-unmount
      }
      updateTerminalScrollbar();
    };
    if (document.fonts?.ready) {
      void document.fonts.ready.then(refreshAfterFonts);
    }
    window.requestAnimationFrame(refreshAfterFonts);

    const viewport = hostRef.current.querySelector<HTMLElement>(".xterm-viewport");
    const handleViewportScroll = () => updateTerminalScrollbar(true);
    viewport?.addEventListener("scroll", handleViewportScroll, { passive: true });
    const scrollDisposable = term.onScroll(() => updateTerminalScrollbar(true));

    const flushInput = () => {
      sendScheduledRef.current = false;
      if (!sendBufferRef.current) return;
      const payload = sendBufferRef.current;
      sendBufferRef.current = "";
      if (disposed) return;
      api.terminalSend(terminal.id, payload).catch(() => undefined);
    };

    term.onData((data) => {
      sendBufferRef.current += data;
      if (!sendScheduledRef.current) {
        sendScheduledRef.current = true;
        queueMicrotask(flushInput);
      }
    });
    lastHostSizeRef.current = { width: 0, height: 0 };
    lastTermSizeRef.current = { cols: 0, rows: 0 };

    const fitAndResize = () => {
      resizeFrameRef.current = null;
      if (disposed || !hostRef.current) return;

      const fitElement = hostRef.current.querySelector<HTMLElement>(".xterm") ?? hostRef.current;
      const rect = fitElement.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width <= 0 || height <= 0) return;

      if (lastHostSizeRef.current.width === width && lastHostSizeRef.current.height === height) {
        return;
      }
      lastHostSizeRef.current = { width, height };

      fit.fit();
      if (lastTermSizeRef.current.cols !== term.cols || lastTermSizeRef.current.rows !== term.rows) {
        lastTermSizeRef.current = { cols: term.cols, rows: term.rows };
        api.terminalResize(terminal.id, term.cols, term.rows).catch(() => undefined);
      }
      updateTerminalScrollbar();
    };

    const scheduleResize = () => {
      if (document.body.classList.contains("is-resizing-terminal-layout")) {
        pendingResizeRef.current = true;
        return;
      }
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(fitAndResize);
    };

    const flushDeferredResize = () => {
      if (!pendingResizeRef.current) return;
      pendingResizeRef.current = false;
      scheduleResize();
    };

    const observer = new ResizeObserver(scheduleResize);
    observer.observe(hostRef.current);
    const xtermElement = hostRef.current.querySelector<HTMLElement>(".xterm");
    if (xtermElement) {
      observer.observe(xtermElement);
    }
    if (viewport) {
      observer.observe(viewport);
    }
    scheduleResize();
    updateTerminalScrollbar();
    window.addEventListener("rustshell:terminal-layout-resize-end", flushDeferredResize);

    return () => {
      disposed = true;
      window.removeEventListener("rustshell:terminal-layout-resize-end", flushDeferredResize);
      viewport?.removeEventListener("scroll", handleViewportScroll);
      scrollDisposable.dispose();
      searchResults.dispose();
      observer.disconnect();
      if (terminalScrollbarHideRef.current !== null) {
        window.clearTimeout(terminalScrollbarHideRef.current);
        terminalScrollbarHideRef.current = null;
      }
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (drainWriteFrameRef.current !== null) {
        window.cancelAnimationFrame(drainWriteFrameRef.current);
        drainWriteFrameRef.current = null;
      }
      drainOutputRef.current = "";
      if (sendBufferRef.current) {
        const payload = sendBufferRef.current;
        sendBufferRef.current = "";
        api.terminalSend(terminal.id, payload).catch(() => undefined);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [terminal.id, onReplayConsumed, updateTerminalScrollbar]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = settings.fontSize;
    term.options.scrollback = settings.scrollback;
    term.options.theme = xtermTheme(settings.theme, terminalBackgroundAlpha);
    const frame = window.requestAnimationFrame(() => {
      if (!termRef.current || !fitRef.current) return;
      fitRef.current.fit();
      if (lastTermSizeRef.current.cols !== termRef.current.cols || lastTermSizeRef.current.rows !== termRef.current.rows) {
        lastTermSizeRef.current = { cols: termRef.current.cols, rows: termRef.current.rows };
        api.terminalResize(terminal.id, termRef.current.cols, termRef.current.rows).catch(() => undefined);
      }
      updateTerminalScrollbar();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [settings.fontSize, settings.scrollback, settings.theme, terminal.id, terminalBackgroundAlpha, updateTerminalScrollbar]);

  useEffect(() => {
    if (!active || !hostRef.current || !termRef.current || !fitRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (!hostRef.current || !termRef.current || !fitRef.current) return;
      const fitElement = hostRef.current.querySelector<HTMLElement>(".xterm") ?? hostRef.current;
      const rect = fitElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      fitRef.current.fit();
      updateTerminalScrollbar();
      termRef.current.focus();
      api.terminalResize(terminal.id, termRef.current.cols, termRef.current.rows).catch(() => undefined);
      if (drainOutputRef.current) {
        scheduleDrainWrite("");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, scheduleDrainWrite, terminal.id, updateTerminalScrollbar]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let unlisten: (() => void) | null = null;
    const fast = shown;
    let lastEventAt = 0;
    let lastStatus = terminal.status;
    let lastError = terminal.lastError ?? "";
    let lastHostKey = terminal.hostKeyIssue?.fingerprint ?? "";
    let lastDirectory = terminal.currentDirectory ?? "";

    const consume = (drain: TerminalDrain) => {
      if (stopped) return;
      if (drain.output) {
        if (fast) {
          scheduleDrainWrite(drain.output);
        } else {
          drainOutputRef.current += drain.output;
        }
      }
      const nextError = drain.lastError ?? "";
      const nextHostKey = drain.hostKeyIssue?.fingerprint ?? "";
      const nextDirectory = drain.currentDirectory ?? "";
      const metadataChanged =
        drain.status !== lastStatus ||
        nextError !== lastError ||
        nextHostKey !== lastHostKey ||
        nextDirectory !== lastDirectory;
      if (metadataChanged) {
        lastStatus = drain.status;
        lastError = nextError;
        lastHostKey = nextHostKey;
        lastDirectory = nextDirectory;
        onDrainRef.current(drain);
      }
    };

    void listenTauriEvent<TerminalDrain>(terminalOutputEvent(terminal.id), (event) => {
      lastEventAt = Date.now();
      consume(event.payload);
    })
      .then((dispose) => {
        if (stopped) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);

    // Catch up on anything the backend produced before the listener attached,
    // then only re-check if the push channel has gone quiet unexpectedly.
    const safetyPoll = async (initial: boolean) => {
      if (!initial && Date.now() - lastEventAt < DRAIN_EVENT_STALE_AFTER) {
        timer = window.setTimeout(() => void safetyPoll(false), DRAIN_SAFETY_POLL_DELAY);
        return;
      }
      try {
        consume(await api.terminalDrain(terminal.id));
      } catch {
        stopped = true;
        return;
      }
      if (!stopped) {
        timer = window.setTimeout(() => void safetyPoll(false), DRAIN_SAFETY_POLL_DELAY);
      }
    };

    void safetyPoll(true);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [active, shown, scheduleDrainWrite, terminal.id]);

  return (
    <div
      data-xterm-host
      className={`absolute inset-0 h-full min-h-0 overflow-hidden bg-background px-3 pb-1.5 pt-2.5 [contain:layout] ${
        shown ? "visible opacity-100" : "pointer-events-none invisible opacity-0"
      }`}
      style={
        {
          ...paneStyle,
          "--xterm-background": terminalBackground,
          "--xterm-cursor-color": terminalCursor,
          "--xterm-cursor-accent": terminalCursorAccent
        } as CSSProperties
      }
      onMouseDown={() => {
        if (!active) onActivate?.();
        // Always reclaim focus on press. The host padding sits outside xterm's
        // own hit target, and a already-active tab that lost focus (tools bar,
        // dialog, …) would otherwise stay caret-less until the active id flips.
        if (shown) termRef.current?.focus();
      }}
      ref={hostRef}
    >
      <div className="h-full min-h-0 overflow-hidden" ref={terminalMountRef} />
      {searchOpen && (
        <TerminalSearchOverlay
          query={searchQuery}
          options={searchOptions}
          result={searchResult}
          inputRef={searchInputRef}
          onQueryChange={setSearchQuery}
          onToggleOption={(option) => setSearchOptions((current) => ({ ...current, [option]: !current[option] }))}
          onStep={stepSearch}
          onClose={closeSearch}
          onInputBlur={() => searchRef.current?.clearActiveDecoration()}
          onInputKeyDown={handleSearchInputKeyDown}
        />
      )}
      <div
        data-xterm-scrollbar
        className="pointer-events-none absolute bottom-2 right-[7px] top-3 z-[3] w-[7px] rounded-full p-px opacity-0 transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-swift)]"
        ref={terminalScrollbarRef}
        onPointerDown={handleTerminalScrollbarPointerDown}
      >
        <div className="min-h-7 w-full rounded-full bg-foreground/40 ring-1 ring-foreground/15" ref={terminalScrollbarThumbRef} />
      </div>
    </div>
  );
}
