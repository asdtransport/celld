import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { buildApp } from "./app";
import { config } from "./config";
import { DDL } from "./db/ddl";
import { setDb } from "./db/runtime";
import * as repo from "./lib/repo";
import { startLbReconciler, syncLb } from "./services/network";
import { startScheduler } from "./mover/controller";

// Bun entry. The UI is the Astro build in web/dist — no hand-written HTML lives in the server.
mkdirSync(config.dataDir, { recursive: true });
const sqlite = new Database(process.env.APP_DB ?? join(config.dataDir, "fleetiq.db"));
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec(DDL);
setDb(drizzle(sqlite));

// First run: adopt the app the stack already serves, so the LB keeps routing it once FleetIQ takes over.
const seed = process.env.DEFAULT_APP;
if (seed && !repo.getApp(seed)) {
  repo.createApp({ name: seed, prefix: seed, description: "Adopted from the compose stack", managed: 0, desiredNodes: 0, nodeImage: null, healthPath: process.env.DEFAULT_APP_HEALTH ?? "/api/health", createdBy: "fleetiq" });
  if (!repo.listRoutes().length) repo.upsertRoute("*", seed);
  repo.writeAudit({ actor: "fleetiq", action: "app.adopt", target: seed, outcome: "ok", detail: "default route *" });
}

const app = buildApp({ buildSha: process.env.BUILD_SHA, allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",").filter(Boolean), maxBodyBytes: config.maxUploadBytes, rateLimit: { max: 1200, windowMs: 60_000 } });
const WEB = resolve(process.env.WEB_DIST ?? "web/dist");
const headers = {
  "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
};

async function staticFile(pathname: string): Promise<Response> {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidates = clean === "/" ? ["index.html"] : [clean.slice(1), `${clean.slice(1).replace(/\/$/, "")}.html`, `${clean.slice(1)}/index.html`];
  for (const rel of candidates) {
    const full = resolve(WEB, rel);
    if (!full.startsWith(WEB)) break;
    const f = Bun.file(full);
    if (await f.exists()) {
      const cache = rel.startsWith("_astro/") ? "public, max-age=31536000, immutable" : "no-cache";
      return new Response(f, { headers: { ...headers, "cache-control": cache } });
    }
  }
  const nf = Bun.file(join(WEB, "404.html"));
  return new Response((await nf.exists()) ? nf : "Not found", { status: 404, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

const port = Number(process.env.PORT ?? 8787);
Bun.serve({
  port, maxRequestBodySize: config.maxUploadBytes + 1024 * 1024,
  idleTimeout: 255, // seconds; deploy uploads and /wait calls run long
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/hooks/") || u.pathname === "/mcp" || u.pathname.startsWith("/mcp/")) {
      const r = await app.fetch(req);
      for (const [k, v] of Object.entries(headers)) if (k !== "content-security-policy") r.headers.set(k, v);
      r.headers.set("cache-control", "no-store");
      return r;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return staticFile(u.pathname);
  },
});
if (repo.listRoutes().length && process.env.LB_SYNC !== "0") { syncLb().then((r) => console.log(`lb sync: ${r.pushed ? "pushed" : `not pushed${r.error ? ` (${r.error})` : ""}`}`)); startLbReconciler(); }
if (process.env.MOVER_SCHEDULE !== "0") startScheduler();
console.log(`FleetIQ console -> http://localhost:${port}  (auth: ${config.authMode}, bucket: ${config.bucket})`);
