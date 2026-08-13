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

type XtermCoreHandle = {
  _core?: {
    coreService?: { isCursorInitialized?: boolean; isCursorHidden?: boolean };
    _coreService?: { isCursorInitialized?: boolean; isCursorHidden?: boolean };
    _showCursor?: () => void;
    _renderService?: {
      dimensions?: {
        css?: { cell?: { width?: number; height?: number } };
      };
    };
  };
  core?: {
    coreService?: { isCursorInitialized?: boolean; isCursorHidden?: boolean };
    _coreService?: { isCursorInitialized?: boolean; isCursorHidden?: boolean };
    _showCursor?: () => void;
    _renderService?: {
      dimensions?: {
        css?: { cell?: { width?: number; height?: number } };
      };
    };
  };
};

function readCellSize(term: Terminal, screen: HTMLElement, cols: number, rows: number) {
  const handle = term as unknown as XtermCoreHandle;
  const core = handle._core ?? handle.core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (cell?.width && cell.height && cell.width >= 1 && cell.height >= 1) {
    return { cellW: cell.width, cellH: cell.height };
  }
  // Rows are sized to the glyph grid. The screen element is often wider than
  // that grid (leftover gutter), so clientWidth/cols drifts the overlay right.
  const row = screen.querySelector(".xterm-rows > div");
  if (row instanceof HTMLElement) {
    const rowW = parseFloat(row.style.width);
    const rowH = row.getBoundingClientRect().height;
    if (Number.isFinite(rowW) && rowW > 0 && rowH >= 1) {
      return { cellW: rowW / cols, cellH: rowH };
    }
  }
  return { cellW: screen.clientWidth / cols, cellH: screen.clientHeight / rows };
}

/// Paint a caret we own. xterm's DOM cell is gated by isCursorInitialized,
/// isCursorHidden (ConPTY often emits CSI ?25l because the hidden console
/// window is "unfocused"), and letter-spacing that can collapse the span to
/// 0px. An overlay with explicit cell metrics is independent of all three.
function syncTermCaret(term: Terminal) {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!(screen instanceof HTMLElement)) return;
  let caret = screen.querySelector(":scope > [data-xterm-caret]");
  if (!(caret instanceof HTMLDivElement)) {
    caret = document.createElement("div");
    caret.dataset.xtermCaret = "";
    caret.setAttribute("aria-hidden", "true");
    screen.appendChild(caret);
  }
  const cols = Math.max(term.cols, 1);
  const rows = Math.max(term.rows, 1);
  const { cellW, cellH } = readCellSize(term, screen, cols, rows);
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW < 1 || cellH < 1) {
    caret.style.visibility = "hidden";
    return;
  }

  // If xterm did emit a cursor cell, snap to its box so we cannot drift from
  // the glyph grid. A collapsed (0-width) span still has a correct origin.
  const native = screen.querySelector(".xterm-cursor");
  if (native instanceof HTMLElement) {
    const screenRect = screen.getBoundingClientRect();
    const cellRect = native.getBoundingClientRect();
    if (cellRect.height >= 1) {
      caret.style.visibility = "visible";
      caret.style.width = `${cellRect.width >= 1 ? cellRect.width : cellW}px`;
      caret.style.height = `${cellRect.height}px`;
      caret.style.transform = `translate(${cellRect.left - screenRect.left}px, ${cellRect.top - screenRect.top}px)`;
      return;
    }
  }

  const buf = term.buffer.active;
  const x = Math.max(0, Math.min(buf.cursorX, cols - 1));
  const y = Math.max(0, Math.min(buf.cursorY, rows - 1));
  caret.style.visibility = "visible";
  caret.style.width = `${cellW}px`;
  caret.style.height = `${cellH}px`;
  caret.style.transform = `translate(${x * cellW}px, ${y * cellH}px)`;
}

/// xterm's DomRenderer only emits a .xterm-cursor cell after
/// CoreService.isCursorInitialized is true. That latch normally flips inside
/// Terminal#_showCursor (textarea focus / keydown). A plain write() of the
/// shell prompt never flips it, and our window boots hidden then reveals after
/// paint — mount-time focus() can set activeElement without a focus event, so
/// the latch stays false and the pane stays caret-less until a real click.
/// Reach the service through a few known shapes and force a refresh so the
/// block caret exists from the first painted frame.
function primeCursor(term: Terminal) {
  try {
    const handle = term as unknown as XtermCoreHandle;
    const core = handle._core ?? handle.core;
    const coreService = core?.coreService ?? core?._coreService;
    if (coreService) {
      coreService.isCursorInitialized = true;
      // ConPTY hides the Win32 cursor when the pseudo console is not the
      // foreground window, and that arrives as CSI ?25l. Keep xterm's own
      // cell unhidden; the overlay caret is the visible one either way.
      coreService.isCursorHidden = false;
    }
    if (typeof core?._showCursor === "function") {
      core._showCursor();
    }
  } catch {
    // Internal shape moved under an xterm upgrade — still try a plain refresh.
  }
  try {
    // Force DomRenderer to repaint the cursor cell at the real buffer position.
    const y = term.buffer.active.cursorY;
    term.refresh(Math.max(0, y), Math.max(term.rows - 1, y));
  } catch {
    try {
      term.refresh(0, Math.max(term.rows - 1, 0));
    } catch {
      // refresh() can throw if the host was torn down between open and prime.
    }
  }
  try {
    syncTermCaret(term);
  } catch {
    // Host torn down between open and prime.
  }
}



function schedulePrimeCursor(term: Terminal, frames = 2) {
  let left = frames;
  const tick = () => {
    primeCursor(term);
    left -= 1;
    if (left > 0) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

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
    termRef.current?.write(output, () => {
      if (termRef.current) {
        try {
          termRef.current.scrollToBottom();
        } catch {
          // ignore
        }
        primeCursor(termRef.current);
      }
      updateTerminalScrollbar();
    });
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
      // Solid block. Blink keyframes use `background-color: inherit` on the off
      // frame; WebView2 / reduced-motion can freeze there and the caret vanishes.
      cursorBlink: false,
      cursorStyle: "block",
      // Unfocused panes keep a solid block so the caret never disappears when
      // the tools bar or another tab steals focus.
      cursorInactiveStyle: "block",
      convertEol: true,
      // DOM renderer + system ClearType. Consolas is fuller than Cascadia Mono
      // regular and has real bold; avoid WebGL atlas (no subpixel AA → jaggies).
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei UI", "Microsoft YaHei", monospace',
      fontSize: settings.fontSize,
      fontWeight: "400",
      fontWeightBold: "700",
      letterSpacing: 0,
      lineHeight: 1,
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
    if (hostRef.current) hostRef.current.dataset.xtermRenderer = "dom";
    const initialReplay = terminal.text;
    if (initialReplay) {
      term.write(initialReplay, () => {
        if (!disposed) primeCursor(term);
      });
      onReplayConsumed(terminal.id);
    }
    // xterm gates the cursor cell behind CoreService.isCursorInitialized, which
    // it flips only inside the textarea focus/keydown handlers. At mount the
    // window is often not yet OS-focused (hidden-until-painted boot, background
    // WebView2 tabs), so focus() sets activeElement without firing a focus event
    // and the caret would stay absent until a real click. Prime the latch here
    // so the block caret is present immediately; focus() below is now purely
    // about routing the keyboard to the active pane.
    primeCursor(term);
    schedulePrimeCursor(term, 8);
    try {
      term.scrollToBottom();
    } catch {
      // ignore
    }
    if (active) term.focus();
    // Variable fonts can finish loading after open; remeasure so the caret
    // cell does not stay at a zero/stale width from the fallback face.
    const refreshAfterFonts = () => {
      if (disposed || termRef.current !== term) return;
      try {
        fit.fit();
        term.scrollToBottom();
        primeCursor(term);
        if (active) term.focus();
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
    const scrollDisposable = term.onScroll(() => {
      updateTerminalScrollbar(true);
      syncTermCaret(term);
    });
    const renderDisposable = term.onRender(() => syncTermCaret(term));
    const cursorDisposable = term.onCursorMove(() => syncTermCaret(term));

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
      try {
        term.scrollToBottom();
        primeCursor(term);
      } catch {
        // ignore
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
      renderDisposable.dispose();
      cursorDisposable.dispose();
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
    term.options.fontWeight = "400";
    term.options.fontWeightBold = "700";
    term.options.scrollback = settings.scrollback;
    term.options.theme = xtermTheme(settings.theme, terminalBackgroundAlpha);
    const frame = window.requestAnimationFrame(() => {
      if (!termRef.current || !fitRef.current) return;
      fitRef.current.fit();
      if (lastTermSizeRef.current.cols !== termRef.current.cols || lastTermSizeRef.current.rows !== termRef.current.rows) {
        lastTermSizeRef.current = { cols: termRef.current.cols, rows: termRef.current.rows };
        api.terminalResize(terminal.id, termRef.current.cols, termRef.current.rows).catch(() => undefined);
      }
      primeCursor(termRef.current);
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
      primeCursor(termRef.current);
      termRef.current.focus();
      api.terminalResize(terminal.id, termRef.current.cols, termRef.current.rows).catch(() => undefined);
      if (drainOutputRef.current) {
        scheduleDrainWrite("");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, scheduleDrainWrite, terminal.id, updateTerminalScrollbar]);

  // Hidden-until-painted boot and OS focus changes can leave the caret latch
  // false even after mount. Re-prime when the document becomes visible/focused.
  useEffect(() => {
    const reprime = () => {
      if (!shown || !termRef.current) return;
      primeCursor(termRef.current);
      if (active) termRef.current.focus();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") reprime();
    };
    window.addEventListener("focus", reprime);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", reprime);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, shown]);

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
        if (shown && termRef.current) {
          primeCursor(termRef.current);
          termRef.current.focus();
        }
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
