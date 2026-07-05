import { useCallback, useMemo, useState, type CSSProperties, type MouseEvent } from "react";

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

  const startPanelResize = useCallback(
    (side: PanelSide, event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = side === "left" ? leftPanelWidth : rightPanelWidth;
      if (side === "left") {
        setLeftPanelCollapsed(false);
      } else {
        setRightPanelCollapsed(false);
      }

      const move = (moveEvent: globalThis.MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = side === "left" ? startWidth + delta : startWidth - delta;
        const setWidth = side === "left" ? setLeftPanelWidth : setRightPanelWidth;
        setWidth(clampNumber(nextWidth, minPanelWidth, maxPanelWidth));
      };

      const stop = () => {
        document.body.classList.remove("is-resizing-panel");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", stop);
      };

      document.body.classList.add("is-resizing-panel");
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", stop);
    },
    [leftPanelWidth, rightPanelWidth]
  );

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
