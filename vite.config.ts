/**
 * Akhtar Autos Desktop — Vite config for Tauri WebView.
 * Outputs static assets to dist/ (see src-tauri/tauri.conf.json frontendDist).
 * Desktop-specific overrides live here; the original web app is untouched.
 */
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const host = process.env["TAURI_DEV_HOST"];

export default defineConfig({
  tanstackStart: {
    // Existing server entry kept for Start compatibility; Tauri serves the client build only.
    server: { entry: "server" },
  },
  vite: {
    clearScreen: false,
    envPrefix: ["VITE_", "TAURI_"],
    server: {
      port: 5173,
      strictPort: true,
      host: host || false,
      ...(host
        ? {
            hmr: {
              protocol: "ws",
              host,
              port: 1421,
            },
          }
        : {}),
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      target: "esnext",
    },
  },
});
