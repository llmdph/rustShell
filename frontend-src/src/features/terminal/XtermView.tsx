import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import { clampNumber } from "@/lib/math";
import { api, type AppSettings, type TerminalDrain, type TerminalView } from "../../api";

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

function alphaColor(rgb: [number, number, number], alpha: number) {
  const opacity = clampNumber(alpha, 55, 100) / 100;
  return opacity >= 1 ? `rgb(${rgb.join(" ")})` : `rgba(${rgb.join(", ")}, ${opacity.toFixed(2)})`;
}

function xtermTheme(theme: AppSettings["theme"], backgroundAlpha = 100) {
  // shadcn Neutral 对齐：亮=白底近黑字，暗（deep/graphite 收敛）=neutral-950 底近白字；
  // 光标/选区用中性灰阶，彩色只保留 ANSI 语义色（xterm 默认）。
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

const HIDDEN_DRAIN_DELAY = 250;
const VISIBLE_DRAIN_WARM_IDLE_DELAY = 32;
const VISIBLE_DRAIN_IDLE_DELAY = 80;
const VISIBLE_DRAIN_COLD_IDLE_DELAY = 160;

export function XtermView({ terminal, settings, active, visible, paneStyle, terminalBackgroundAlpha, onActivate, onDrain, onReplayConsumed }: XtermViewProps) {
  const shown = visible ?? active;
  const terminalBackground = xtermTheme(settings.theme, terminalBackgroundAlpha).background;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalMountRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const terminalScrollbarHideRef = useRef<number | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
    const term = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Geist Mono Variable", "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace',
      fontSize: settings.fontSize,
      lineHeight: 1.18,
      scrollback: settings.scrollback,
      theme: xtermTheme(settings.theme, terminalBackgroundAlpha)
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalMountRef.current);
    const initialReplay = terminal.text;
    if (initialReplay) {
      term.write(initialReplay);
      onReplayConsumed(terminal.id);
    }
    if (active) term.focus();

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
    termRef.current = term;
    fitRef.current = fit;
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
    const fast = shown;
    let idleRounds = 0;
    let lastStatus = terminal.status;
    let lastError = terminal.lastError ?? "";
    let lastHostKey = terminal.hostKeyIssue?.fingerprint ?? "";
    let lastDirectory = terminal.currentDirectory ?? "";

    const idleDelay = () => {
      if (!fast) return HIDDEN_DRAIN_DELAY;
      if (idleRounds < 4) return VISIBLE_DRAIN_WARM_IDLE_DELAY;
      if (idleRounds < 20) return VISIBLE_DRAIN_IDLE_DELAY;
      return VISIBLE_DRAIN_COLD_IDLE_DELAY;
    };

    const drainLoop = async () => {
      let nextDelay = idleDelay();
      try {
        const drain = await api.terminalDrain(terminal.id);
        const hasOutput = Boolean(drain.output);
        if (hasOutput) {
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
        if (hasOutput || metadataChanged) {
          idleRounds = 0;
          nextDelay = fast && hasOutput ? 0 : idleDelay();
        } else {
          idleRounds += 1;
          nextDelay = idleDelay();
        }
      } catch {
        stopped = true;
      }
      if (!stopped) {
        timer = window.setTimeout(drainLoop, nextDelay);
      }
    };

    timer = window.setTimeout(drainLoop, 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, shown, scheduleDrainWrite, terminal.id]);

  return (
    <div
      data-xterm-host
      className={`absolute inset-0 h-full min-h-0 overflow-hidden bg-background px-3 pb-1.5 pt-2.5 [contain:layout_paint] ${
        shown ? "visible opacity-100" : "pointer-events-none invisible opacity-0"
      }`}
      style={{ ...paneStyle, "--xterm-background": terminalBackground } as CSSProperties}
      onMouseDown={() => {
        if (!active) onActivate?.();
      }}
      ref={hostRef}
    >
      <div className="h-full min-h-0 overflow-hidden" ref={terminalMountRef} />
      <div
        data-xterm-scrollbar
        className="pointer-events-none absolute bottom-2 right-[7px] top-3 z-[3] w-[7px] rounded-full p-px opacity-0 transition-opacity duration-100"
        ref={terminalScrollbarRef}
        onPointerDown={handleTerminalScrollbarPointerDown}
      >
        <div className="min-h-7 w-full rounded-full bg-foreground/40 ring-1 ring-foreground/15" ref={terminalScrollbarThumbRef} />
      </div>
    </div>
  );
}
