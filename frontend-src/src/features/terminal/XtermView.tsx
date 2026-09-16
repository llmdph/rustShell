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
import {
  pasteClipboardIntoTerminal,
  registerTerminalClipboard,
  writeTerminalSelection
} from "./terminalClipboard";

/// Same stack as `--font-mono` (bottom snippet chips). Keep the quoted
/// family first — xterm writes this into both CSS and OffscreenCanvas.
const TERMINAL_FONT_FAMILY =
  '"Geist Mono Variable", ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace';

const TERMINAL_FONT_SIZE_MIN = 10;
const TERMINAL_FONT_SIZE_MAX = 28;

function terminalFontSize(value: number) {
  if (!Number.isFinite(value)) return 14;
  return clampNumber(value, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX);
}

function loadTerminalFont(fontSize: number) {
  if (!document.fonts?.load) return Promise.resolve();
  return Promise.all([
    document.fonts.load(`${fontSize}px "Geist Mono Variable"`),
    document.fonts.load(`700 ${fontSize}px "Geist Mono Variable"`)
  ]).then(
    () => undefined,
    () => undefined
  );
}

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

/// Classic xterm 16-color palette. Keep it explicit so a future theme reset
/// cannot silently drop shell prompt / ls colors back to monochrome.
const XTERM_ANSI = {
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec"
} as const;

const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function xterm256Palette() {
  const colors: string[] = [
    XTERM_ANSI.black,
    XTERM_ANSI.red,
    XTERM_ANSI.green,
    XTERM_ANSI.yellow,
    XTERM_ANSI.blue,
    XTERM_ANSI.magenta,
    XTERM_ANSI.cyan,
    XTERM_ANSI.white,
    XTERM_ANSI.brightBlack,
    XTERM_ANSI.brightRed,
    XTERM_ANSI.brightGreen,
    XTERM_ANSI.brightYellow,
    XTERM_ANSI.brightBlue,
    XTERM_ANSI.brightMagenta,
    XTERM_ANSI.brightCyan,
    XTERM_ANSI.brightWhite
  ];
  for (let i = 0; i < 216; i += 1) {
    const r = XTERM_CUBE_LEVELS[Math.floor(i / 36)];
    const g = XTERM_CUBE_LEVELS[Math.floor(i / 6) % 6];
    const b = XTERM_CUBE_LEVELS[i % 6];
    colors.push(`#${hexByte(r)}${hexByte(g)}${hexByte(b)}`);
  }
  for (let i = 0; i < 24; i += 1) {
    const v = 8 + i * 10;
    colors.push(`#${hexByte(v)}${hexByte(v)}${hexByte(v)}`);
  }
  return colors;
}

/// WebView2 has dropped xterm's injected (non-important) SGR classes before.
/// Own the 256-color sheet with !important so prompt/ls/git stay colored.
function injectXtermAnsiColors(host: HTMLElement) {
  let sheet = host.querySelector(":scope > style[data-xterm-ansi]");
  if (!(sheet instanceof HTMLStyleElement)) {
    sheet = document.createElement("style");
    sheet.dataset.xtermAnsi = "";
    host.appendChild(sheet);
  }
  sheet.textContent = xterm256Palette()
    .map(
      (color, index) =>
        `[data-xterm-host] .xterm-fg-${index}{color:${color}!important}` +
        `[data-xterm-host] .xterm-bg-${index}{background-color:${color}!important}`
    )
    .join("");
}

function xtermTheme(theme: AppSettings["theme"], backgroundAlpha = 100) {
  // Chrome stays neutral; ANSI semantic colors stay vivid for prompts / ls / git.
  // Cursor colors stay fully opaque — blending a transparent bg onto the caret
  // is what made it disappear against the phosphor cell in some WebView builds.
  if (theme === "light") {
    return {
      background: alphaColor([255, 255, 255], backgroundAlpha),
      foreground: "#171717",
      cursor: "#171717",
      cursorAccent: "#ffffff",
      // 8-digit hex keeps alpha. Opaque #rrggbb is forced to 30% by xterm and
      // disappears on a near-white cell.
      selectionBackground: "#17171748",
      selectionInactiveBackground: "#1717172e",
      ...XTERM_ANSI
    };
  }
  return {
    background: alphaColor([10, 10, 10], backgroundAlpha),
    foreground: "#e5e5e5",
    cursor: "#fafafa",
    cursorAccent: "#0a0a0a",
    selectionBackground: "#ffffff4d",
    selectionInactiveBackground: "#ffffff2e",
    ...XTERM_ANSI
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

  const barW = 2;
  // Buffer coordinates only. Snapping to the native cursor cell via
  // getBoundingClientRect forced layout on every keystroke and made the
  // overlay lag the glyph it is meant to track.
  const buf = term.buffer.active;
  const x = Math.max(0, Math.min(buf.cursorX, cols - 1));
  const y = Math.max(0, Math.min(buf.cursorY, rows - 1));
  caret.style.visibility = "visible";
  caret.style.width = `${barW}px`;
  caret.style.height = `${cellH}px`;
  caret.style.transform = `translate(${x * cellW}px, ${y * cellH}px)`;
}

/// xterm's selection overlay is placed with CharSizeService cell metrics.
/// OffscreenCanvas often reports a different line box than the DOM rows (Geist
/// vs fallback face), so the wash lands on the wrong row. Paint from the
/// actual row boxes, same origin as the caret.
function syncTermSelection(term: Terminal, keepIfEmpty = false) {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!(screen instanceof HTMLElement)) return;
  let layer = screen.querySelector(":scope > [data-xterm-selection]");
  if (!(layer instanceof HTMLDivElement)) {
    layer = document.createElement("div");
    layer.dataset.xtermSelection = "";
    layer.setAttribute("aria-hidden", "true");
    screen.appendChild(layer);
  }
  const pos = term.getSelectionPosition();
  if (!pos || !term.hasSelection()) {
    if (!keepIfEmpty) layer.replaceChildren();
    return;
  }
  const viewportY = term.buffer.active.viewportY;
  const startY = pos.start.y - viewportY;
  const endY = pos.end.y - viewportY;
  const startX = pos.start.x;
  const endX = pos.end.x;
  const rowEls = screen.querySelectorAll(".xterm-rows > div");
  const screenRect = screen.getBoundingClientRect();
  const cols = Math.max(term.cols, 1);
  const from = Math.max(0, startY);
  const to = Math.min(rowEls.length - 1, endY);
  const fragment = document.createDocumentFragment();
  for (let y = from; y <= to; y++) {
    const row = rowEls[y];
    if (!(row instanceof HTMLElement)) continue;
    const rowRect = row.getBoundingClientRect();
    if (rowRect.height < 1) continue;
    const cellW = rowRect.width / cols;
    const colStart = y === startY ? startX : 0;
    const colEnd = y === endY ? endX : cols;
    if (colEnd <= colStart) continue;
    const div = document.createElement("div");
    div.style.left = `${(rowRect.left - screenRect.left) + colStart * cellW}px`;
    div.style.width = `${(colEnd - colStart) * cellW}px`;
    div.style.top = `${rowRect.top - screenRect.top}px`;
    div.style.height = `${rowRect.height}px`;
    fragment.appendChild(div);
  }
  layer.replaceChildren(fragment);
}

function syncTermOverlays(term: Terminal, keepIfEmpty = false) {
  syncTermCaret(term);
  syncTermSelection(term, keepIfEmpty);
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
  const fontSize = terminalFontSize(settings.fontSize);
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
  const fontSizeRef = useRef(fontSize);
  const copyOnSelectRef = useRef(settings.copyOnSelect);
  const statusRef = useRef(terminal.status);
  const onDrainRef = useRef(onDrain);
  fontSizeRef.current = fontSize;
  copyOnSelectRef.current = settings.copyOnSelect;
  statusRef.current = terminal.status;

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
      const target = event.target;
      const inChrome =
        target instanceof HTMLElement &&
        Boolean(target.closest("[data-terminal-search], input, textarea:not(.xterm-helper-textarea)"));
      const composing = event.isComposing || event.keyCode === 229;
      const isInsert = event.key === "Insert" || event.code === "Insert";
      if (!inChrome && !composing) {
        // Ctrl+C stays SIGINT. Copy/paste use the Windows Terminal chords.
        if ((modifier && event.shiftKey && event.key.toLowerCase() === "c") || (event.ctrlKey && !event.shiftKey && !event.altKey && isInsert)) {
          event.preventDefault();
          event.stopPropagation();
          const term = termRef.current;
          if (term) void writeTerminalSelection(term);
          return;
        }
        if ((modifier && event.shiftKey && event.key.toLowerCase() === "v") || (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && isInsert)) {
          event.preventDefault();
          event.stopPropagation();
          const term = termRef.current;
          if (term && statusRef.current === "connected") void pasteClipboardIntoTerminal(term);
          return;
        }
      }
      // Space is not emitted from xterm's keydown path (keyCode 32 < 48); it
      // waits for the 0×0 helper textarea's input/keypress. WebView2 then
      // treats Space as page-down on the overflow:scroll viewport — at the
      // bottom that is a silent no-op, so letters work and spaces do not.
      if (
        event.key === " " &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !composing
      ) {
        if (inChrome) return;
        event.preventDefault();
        event.stopPropagation();
        termRef.current?.input(" ");
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
      const term = termRef.current;
      if (!term) return;
      try {
        const buf = term.buffer.active;
        if (buf.viewportY >= buf.baseY) term.scrollToBottom();
      } catch {
        // ignore
      }
      updateTerminalScrollbar();
    });
  }, [updateTerminalScrollbar]);

  const scheduleDrainWrite = useCallback(
    (output: string) => {
      drainOutputRef.current += output;
      if (drainWriteFrameRef.current !== null) return;
      // Keystroke echo is a handful of bytes. Write it now so the glyph is
      // not stuck until the next vsync. Larger bursts (cat, logs) still
      // coalesce on rAF to keep the DOM renderer from falling behind.
      if (drainOutputRef.current.length <= 128) {
        flushDrainOutput();
        return;
      }
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
    const host = hostRef.current;
    if (!host || !terminalMountRef.current) return;
    let disposed = false;
    const theme = xtermTheme(settings.theme, terminalBackgroundAlpha);
    const term = new Terminal({
      allowTransparency: true,
      // SearchAddon paints its match highlights through registerDecoration,
      // which xterm still gates behind the proposed-API flag. Without this the
      // addon throws on every findNext and the overlay reports zero matches.
      allowProposedApi: true,
      // Overlay caret is a solid 2px bar. Native xterm blink can freeze
      // invisible in WebView2; we do not add our own blink either.
      cursorBlink: false,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "bar",
      convertEol: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      // DOM renderer + ClearType. Avoid WebGL atlas (no subpixel AA → jaggies).
      // Face is locked again in CSS; this string is what CharSizeService measures.
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize,
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
    if (hostRef.current) {
      hostRef.current.dataset.xtermRenderer = "dom";
      injectXtermAnsiColors(hostRef.current);
    }
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
    // cell does not stay at a zero/stale width from the Consolas fallback face.
    const refreshAfterFonts = () => {
      if (disposed || termRef.current !== term) return;
      try {
        // Touch fontFamily so CharSizeService remeasures after @font-face is in.
        term.options.fontFamily = TERMINAL_FONT_FAMILY;
        term.options.fontSize = fontSizeRef.current;
        fit.fit();
        term.refresh(0, Math.max(0, term.rows - 1));
        term.scrollToBottom();
        primeCursor(term);
        syncTermSelection(term);
        if (active) term.focus();
      } catch {
        // fit can throw if the host is display:none mid-unmount
      }
      updateTerminalScrollbar();
    };
    void loadTerminalFont(fontSize).then(refreshAfterFonts);
    if (document.fonts?.ready) {
      void document.fonts.ready.then(refreshAfterFonts);
    }
    window.requestAnimationFrame(refreshAfterFonts);

    const viewport = hostRef.current.querySelector<HTMLElement>(".xterm-viewport");
    const handleViewportScroll = () => updateTerminalScrollbar(true);
    viewport?.addEventListener("scroll", handleViewportScroll, { passive: true });
    let selecting = false;
    const scrollDisposable = term.onScroll(() => {
      updateTerminalScrollbar(true);
      syncTermOverlays(term, selecting);
    });
    const renderDisposable = term.onRender(() => syncTermOverlays(term, selecting));
    const cursorDisposable = term.onCursorMove(() => syncTermOverlays(term, selecting));

    const flushInput = () => {
      sendScheduledRef.current = false;
      const payload = sendBufferRef.current;
      if (!payload) return;
      sendBufferRef.current = "";
      api.terminalSend(terminal.id, payload).catch(() => undefined);
    };

    let caretIdleTimer = 0;
    const markCaretTyping = () => {
      const caret = host.querySelector("[data-xterm-caret]");
      if (!(caret instanceof HTMLElement)) return;
      caret.classList.add("is-typing");
      window.clearTimeout(caretIdleTimer);
      caretIdleTimer = window.setTimeout(() => caret.classList.remove("is-typing"), 700);
    };

    term.onData((data) => {
      markCaretTyping();
      sendBufferRef.current += data;
      if (sendScheduledRef.current) return;
      sendScheduledRef.current = true;
      // Same-turn coalescing (paste / composed input) without waiting for
      // vsync. rAF added 0–16ms to every discrete keystroke.
      queueMicrotask(flushInput);
    });

    let selectionPaintFrame = 0;
    const eventInChrome = (event: Event) => {
      const target = event.target;
      return (
        target instanceof HTMLElement &&
        Boolean(target.closest("[data-terminal-search], input, textarea:not(.xterm-helper-textarea)"))
      );
    };
    const paintLiveSelection = () => {
      selectionPaintFrame = 0;
      if (disposed) return;
      syncTermSelection(term);
    };
    const scheduleSelectionPaint = () => {
      if (selectionPaintFrame) return;
      selectionPaintFrame = window.requestAnimationFrame(paintLiveSelection);
    };
    const onSelectMouseDown = (event: MouseEvent) => {
      if (event.button === 0 && !eventInChrome(event)) {
        selecting = true;
        scheduleSelectionPaint();
      }
    };
    const onSelectMouseMove = () => {
      if (selecting) scheduleSelectionPaint();
    };
    // xterm's drag mousemove calls stopImmediatePropagation on document, so
    // bubble listeners on window never run. Capture on document sees the
    // move first; the rAF then paints after xterm has updated the model.
    const onSelectMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const wasSelecting = selecting;
      selecting = false;
      if (!wasSelecting) return;
      scheduleSelectionPaint();
      if (copyOnSelectRef.current) void writeTerminalSelection(term);
    };
    const onContextMenu = (event: MouseEvent) => {
      if (eventInChrome(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const hasSelection = term.hasSelection();
      if (copyOnSelectRef.current || !hasSelection) {
        if (statusRef.current === "connected") void pasteClipboardIntoTerminal(term);
        return;
      }
      void writeTerminalSelection(term).then((copied) => {
        if (copied) term.clearSelection();
      });
    };
    const selectionDisposable = term.onSelectionChange(() => {
      syncTermSelection(term);
      if (selecting || !copyOnSelectRef.current) return;
      void writeTerminalSelection(term);
    });
    host.addEventListener("mousedown", onSelectMouseDown);
    document.addEventListener("mousemove", onSelectMouseMove, true);
    window.addEventListener("mouseup", onSelectMouseUp);
    host.addEventListener("contextmenu", onContextMenu, true);
    const nativeSelection = term.element?.querySelector(".xterm-selection");
    const selectionObserver =
      nativeSelection instanceof HTMLElement
        ? new MutationObserver(() => scheduleSelectionPaint())
        : null;
    selectionObserver?.observe(nativeSelection as HTMLElement, { childList: true });
    const unregisterClipboard = registerTerminalClipboard(terminal.id, {
      copySelection: () => writeTerminalSelection(term),
      paste: async () => {
        if (statusRef.current !== "connected") return false;
        return pasteClipboardIntoTerminal(term);
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
      selectionDisposable.dispose();
      searchResults.dispose();
      selecting = false;
      window.clearTimeout(caretIdleTimer);
      if (selectionPaintFrame) window.cancelAnimationFrame(selectionPaintFrame);
      selectionObserver?.disconnect();
      host.removeEventListener("mousedown", onSelectMouseDown);
      document.removeEventListener("mousemove", onSelectMouseMove, true);
      window.removeEventListener("mouseup", onSelectMouseUp);
      host.removeEventListener("contextmenu", onContextMenu, true);
      unregisterClipboard();
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
    let cancelled = false;
    const apply = () => {
      if (cancelled || termRef.current !== term) return;
      term.options.fontFamily = TERMINAL_FONT_FAMILY;
      term.options.fontSize = fontSize;
      term.options.fontWeight = "400";
      term.options.fontWeightBold = "700";
      term.options.scrollback = settings.scrollback;
      term.options.theme = xtermTheme(settings.theme, terminalBackgroundAlpha);
      try {
        fitRef.current?.fit();
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        // fit can throw if the host is display:none mid-unmount
      }
      if (lastTermSizeRef.current.cols !== term.cols || lastTermSizeRef.current.rows !== term.rows) {
        lastTermSizeRef.current = { cols: term.cols, rows: term.rows };
        api.terminalResize(terminal.id, term.cols, term.rows).catch(() => undefined);
      }
      primeCursor(term);
      updateTerminalScrollbar();
    };
    apply();
    void loadTerminalFont(fontSize).then(apply);
    const frame = window.requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [fontSize, settings.scrollback, settings.theme, terminal.id, terminalBackgroundAlpha, updateTerminalScrollbar]);

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
          "--xterm-cursor-accent": terminalCursorAccent,
          "--terminal-font-size": `${fontSize}px`
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
