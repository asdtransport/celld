import { Database } from "bun:sqlite";
import { join, normalize, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { buildApp } from "./app";
import { DDL } from "./db/ddl";
import { setDb } from "./db/runtime";
// Local entry: bun:sqlite is synchronous, so the same sync repo the DO uses runs here.
// The UI is the Astro build (web/dist) — the same files celld and Workers serve. No hand-written HTML.
const sqlite = new Database(process.env.APP_DB ?? "local/app.db");
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec(DDL);
setDb(drizzle(sqlite));
const app = buildApp({
  buildSha: process.env.BUILD_SHA,
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",").filter(Boolean),
});
const WEB = resolve(process.env.WEB_DIST ?? "web/dist");

async function staticFile(pathname: string): Promise<Response> {
  const clean = normalize(decodeURIComponent(pathname));
  const rel = clean === "/" ? "index.html" : clean.slice(1);
  for (const candidate of [rel, `${rel.replace(/\/$/, "")}.html`, `${rel}/index.html`]) {
    const full = resolve(WEB, candidate);
    if (!full.startsWith(WEB)) break;
    const f = Bun.file(full);
    if (await f.exists()) return new Response(f);
  }
  if (!(await Bun.file(join(WEB, "index.html")).exists())) {
    return new Response("The web build is missing. Run `make web-build`, then reload.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response("Not found", { status: 404 });
}

const port = Number(process.env.PORT ?? 8787);
Bun.serve({
  port,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/")) return app.fetch(req);
    return staticFile(u.pathname);
  },
});
console.log(`CellIQ local -> http://localhost:${port}`);
