import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import "@xterm/xterm/css/xterm.css";

const App = React.lazy(() => import("./App"));

type AppEntryOptions = {
  removeBootElementId?: string;
  beforeRender?: () => void;
};

function AppRoot({ removeBootElementId }: { removeBootElementId?: string }) {
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
