import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
// Real workerd HMR — you develop against the actual edge runtime.
export default defineConfig({ plugins: [cloudflare()] });
