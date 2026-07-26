import { useCallback, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";

import { clampNumber } from "@/lib/math";

const defaultLeftPanelWidth = 272;
const defaultRightPanelWidth = 386;
const minPanelWidth = 220;
const maxPanelWidth = 620;
const collapsedPanelWidth = 38;

type PanelSide = "left" | "right";

export function useWorkspacePanels(isFileManagerWindow: boolean) {
  const [leftPanelWidth, setLeftPanelWidth] = useState(defaultLeftPanelWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(defaultRightPanelWidth);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(!isFileManagerWindow);

  // Latest widths without putting them in `startPanelResize`'s dep array, which
  // would hand every consumer a new callback on each mousemove.
  const widthsRef = useRef({ left: leftPanelWidth, right: rightPanelWidth });
  widthsRef.current = { left: leftPanelWidth, right: rightPanelWidth };

  const startPanelResize = useCallback((side: PanelSide, event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? widthsRef.current.left : widthsRef.current.right;
    const property = side === "left" ? "--left-panel-width" : "--right-panel-width";
    const workspace = document.querySelector<HTMLElement>("[data-workspace-layout]");
    if (side === "left") {
      setLeftPanelCollapsed(false);
    } else {
      setRightPanelCollapsed(false);
    }

    // The width only feeds a CSS custom property, so drive it directly during
    // the drag and commit to React state once on release. Calling setState per
    // mousemove re-rendered the whole app — including every terminal pane — at
    // pointer frequency. `workspaceStyle` is memoised on the committed widths,
    // so an unrelated re-render mid-drag reuses the same style object and React
    // leaves our inline write alone.
    let latestWidth = startWidth;
    const move = (moveEvent: globalThis.MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = side === "left" ? startWidth + delta : startWidth - delta;
      latestWidth = clampNumber(nextWidth, minPanelWidth, maxPanelWidth);
      workspace?.style.setProperty(property, `${latestWidth}px`);
    };

    const stop = () => {
      document.body.classList.remove("is-resizing-panel");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      const setWidth = side === "left" ? setLeftPanelWidth : setRightPanelWidth;
      setWidth(latestWidth);
    };

    document.body.classList.add("is-resizing-panel");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }, []);

  const resetPanelWidth = useCallback((side: PanelSide) => {
    if (side === "left") {
      setLeftPanelWidth(defaultLeftPanelWidth);
      setLeftPanelCollapsed(false);
      return;
    }
    setRightPanelWidth(defaultRightPanelWidth);
    setRightPanelCollapsed(false);
  }, []);

  const workspaceStyle = useMemo(
    () =>
      ({
        "--left-panel-width": `${leftPanelCollapsed ? collapsedPanelWidth : leftPanelWidth}px`,
        "--right-panel-width": `${rightPanelCollapsed ? collapsedPanelWidth : rightPanelWidth}px`
      }) as CSSProperties,
    [leftPanelCollapsed, leftPanelWidth, rightPanelCollapsed, rightPanelWidth]
  );

  return {
    leftPanelCollapsed,
    rightPanelCollapsed,
    setLeftPanelCollapsed,
    setRightPanelCollapsed,
    startPanelResize,
    resetPanelWidth,
    workspaceStyle
  };
}
