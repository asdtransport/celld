import { defineConfig } from "astro/config";
// Static build: celld (and Workers) serve web/dist through the ASSETS binding.
// Pages fetch /api/* client-side, same-origin, so an Access JWT or session cookie rides along.
export default defineConfig({
  output: "static",
  // celld 0.6.2 404s nested dir/index.html under auto-trailing-slash; flat files (items.html -> /items) work everywhere.
  build: { format: "file" },
  server: { port: 4321, host: true },
  devToolbar: { enabled: false },
});
