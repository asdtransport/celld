import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { ZodError } from "zod";
export interface CoreConfig {
  allowedOrigins?: string[]; maxBodyBytes?: number;
  rateLimit?: { max: number; windowMs: number }; buildSha?: string;
  dbPing?: () => void; routes: (app: Hono) => void;
}
export function makeApi(cfg: CoreConfig): Hono {
  const app = new Hono();
  const origins = cfg.allowedOrigins ?? ["*"];
  const maxBody = cfg.maxBodyBytes ?? 64 * 1024;
  const rl = cfg.rateLimit ?? { max: 300, windowMs: 60_000 };
  app.use("/api/*", cors({ origin: (o) => (origins.includes("*") ? o || "*" : origins.includes(o) ? o : origins[0] ?? "") }));
  app.use("/api/*", bodyLimit({ maxSize: maxBody, onError: (c) => c.json({ error: "payload too large" }, 413) }));
  const hits = new Map<string, { n: number; reset: number }>();
  app.use("/api/*", async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "local";
    const now = Date.now(); const e = hits.get(ip);
    if (!e || now > e.reset) hits.set(ip, { n: 1, reset: now + rl.windowMs });
    else if (++e.n > rl.max) return c.json({ error: "rate limited" }, 429);
    return next();
  });
  app.onError((err, c) => { if (err instanceof ZodError) return c.json({ error: "validation", issues: err.issues }, 400); console.error(err); return c.json({ error: "internal" }, 500); });
  app.get("/api/health", (c) => { let db = "ok"; try { cfg.dbPing?.(); } catch { db = "down"; } const version = cfg.buildSha ?? (c.env as any)?.BUILD_SHA ?? (typeof process !== "undefined" ? process.env.BUILD_SHA : undefined) ?? "dev"; return c.json({ ok: db === "ok", version, db, ts: Date.now() }, db === "ok" ? 200 : 503); });
  cfg.routes(app);
  return app;
}
