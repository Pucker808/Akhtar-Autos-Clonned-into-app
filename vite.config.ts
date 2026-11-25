/**
 * Akhtar Autos Desktop — Vite config for Tauri WebView.
 * Outputs static assets to dist/client (see src-tauri/tauri.conf.json frontendDist).
 * Desktop-specific overrides live here; the original web app is untouched.
 */
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const host = process.env["TAURI_DEV_HOST"];

const server: {
  port: number;
  strictPort: true;
  host: string | false;
  watch: { ignored: string[] };
  hmr?: { protocol: string; host: string; port: number };
} = {
  port: 5173,
  strictPort: true,
  host: host || false,
  watch: {
    ignored: ["**/src-tauri/**"],
  },
};
if (host) {
  server.hmr = {
    protocol: "ws",
    host,
    port: 1421,
  };
}

export default defineConfig({
  // Tauri has no Node/Worker server: skip the Nitro (Cloudflare) deploy build.
  nitro: false,
  tanstackStart: {
    // Used at build time to prerender the static shell.
    server: { entry: "server" },
    // SPA mode: emit a static index.html that renders entirely in the WebView.
    spa: { enabled: true, prerender: { outputPath: "/index.html" } },
  },
  vite: {
    clearScreen: false,
    envPrefix: ["VITE_", "TAURI_"],
    server,
    build: {
      target: "esnext",
    },
  },
});
