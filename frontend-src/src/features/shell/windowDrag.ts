import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent } from "react";

import { hasTauriRuntime } from "@/api";

const windowDragExcludeSelector =
  "button, input, select, textarea, a, [role='button'], [role='menu'], .window-controls, [data-window-drag-ignore]";

export async function startWindowDrag(event: MouseEvent<HTMLElement>) {
  if (!hasTauriRuntime() || event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest(windowDragExcludeSelector)) return;
  event.preventDefault();
  await getCurrentWindow().startDragging().catch(() => undefined);
}
