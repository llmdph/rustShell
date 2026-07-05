import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "frontend-src",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "frontend-src/src")
    }
  },
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
      },
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("@radix-ui") || id.includes("cmdk")) return "vendor-radix";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("react") || id.includes("scheduler")) return "vendor-react";
          return "vendor";
        }
      }
    }
  }
});
