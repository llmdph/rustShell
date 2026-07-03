import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import App from "./App";

function BootCleanup() {
  React.useEffect(() => {
    document.getElementById("file-manager-boot")?.remove();
  }, []);

  return <App />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BootCleanup />
  </React.StrictMode>
);
