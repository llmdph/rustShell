import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: "frontend-src",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 1422,
    strictPort: true
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2020",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "frontend-src/index.html"),
        fileManager: resolve(__dirname, "frontend-src/file-manager.html")
      }
    }
  }
});
