import { defineConfig } from "astro/config";
// Static build served by the FleetIQ Bun server. Flat files (apps.html -> /apps) and
// no inline scripts, so the strict CSP (script-src 'self') holds.
export default defineConfig({
  output: "static",
  build: { format: "file", inlineStylesheets: "never" },
  vite: { build: { assetsInlineLimit: 0 } },
  server: { port: 4321, host: true },
  devToolbar: { enabled: false },
});
