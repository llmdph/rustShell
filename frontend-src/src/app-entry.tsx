import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import "@xterm/xterm/css/xterm.css";

const App = React.lazy(() => import("./App"));

type AppEntryOptions = {
  removeBootElementId?: string;
  beforeRender?: () => void;
};

/**
 * The main window is created hidden (tauri.conf `visible: false`) so the user
 * never sees the webview's white first frame or a half-styled UI. This effect
 * runs after the lazy-loaded App has actually committed; two animation frames
 * later the content is guaranteed painted, and only then does the window
 * appear. The file-manager window is shown by Rust — showing again is a no-op.
 */
function useRevealWindowWhenPainted() {
  React.useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
          getCurrentWindow()
            .show()
            .catch(() => undefined)
        );
      });
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, []);
}

function AppRoot({ removeBootElementId }: { removeBootElementId?: string }) {
  useRevealWindowWhenPainted();

  React.useEffect(() => {
    if (removeBootElementId) {
      document.getElementById(removeBootElementId)?.remove();
    }
  }, [removeBootElementId]);

  return <App />;
}

export function mountApp({ removeBootElementId, beforeRender }: AppEntryOptions = {}) {
  beforeRender?.();

  createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <AppRoot removeBootElementId={removeBootElementId} />
      </React.Suspense>
    </React.StrictMode>
  );
}
