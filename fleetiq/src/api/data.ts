import type { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as celld from "../adapters/celld";
import { D1Query, KvPut, QueueAction } from "../contract";
import { ensureProjectDir } from "../services/deploy";
import { audited, failure, requireApp } from "./util";

// Data explorer: KV, D1, Queues, R2 — all through the celld CLI so the fleet's ownership rules apply.
export function dataRoutes(api: Hono) {
  // ---- KV ----
  api.get("/api/apps/:name/kv/:ns", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try {
      const [list, info] = await Promise.all([celld.kvList(app.prefix, c.req.param("ns"), { after: c.req.query("after") }), celld.kvInfo(app.prefix, c.req.param("ns")).catch(() => null)]);
      return c.json({ ...list, info });
    } catch (e) { return failure(c, e); }
  });
  api.get("/api/apps/:name/kv/:ns/value", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const key = c.req.query("key"); if (!key) return c.json({ error: "key is required" }, 400);
    try { return c.json({ key, value: await celld.kvGet(app.prefix, c.req.param("ns"), key) }); } catch (e) { return failure(c, e); }
  });
  api.put("/api/apps/:name/kv/:ns/value", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const { key, value } = KvPut.parse(await c.req.json());
    try { await audited(c, "kv.put", `${app.name}/${c.req.param("ns")}/${key}`, () => celld.kvPut(app.prefix, c.req.param("ns"), key, value), () => `${value.length} bytes`); return c.json({ ok: true }); }
    catch (e) { return failure(c, e); }
  });
  api.delete("/api/apps/:name/kv/:ns/value", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const key = c.req.query("key"); if (!key) return c.json({ error: "key is required" }, 400);
    try { await audited(c, "kv.delete", `${app.name}/${c.req.param("ns")}/${key}`, () => celld.kvDelete(app.prefix, c.req.param("ns"), key)); return c.json({ ok: true }); }
    catch (e) { return failure(c, e); }
  });

  // ---- D1 (operator only: any statement can write) ----
  api.post("/api/apps/:name/d1/:db/query", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const { sql } = D1Query.parse(await c.req.json());
    try {
      const dir = await ensureProjectDir(app);
      const t0 = performance.now();
      const r = await audited(c, "d1.execute", `${app.name}/${c.req.param("db")}`, () => celld.d1Execute(app.prefix, c.req.param("db"), sql, dir), () => sql.replace(/\s+/g, " ").slice(0, 200));
      return c.json({ ...r, ms: Math.round(performance.now() - t0) });
    } catch (e) { return failure(c, e); }
  });
  api.get("/api/apps/:name/d1/:db/migrations", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try { return c.json({ output: await celld.d1Migrations(app.prefix, c.req.param("db"), await ensureProjectDir(app)) }); } catch (e) { return failure(c, e); }
  });
  api.post("/api/apps/:name/d1/:db/migrations", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try {
      const out = await audited(c, "d1.migrate", `${app.name}/${c.req.param("db")}`, async () => celld.d1Migrations(app.prefix, c.req.param("db"), await ensureProjectDir(app), true));
      return c.json({ output: out });
    } catch (e) { return failure(c, e); }
  });

  // ---- Queues ----
  api.get("/api/apps/:name/queues/:q", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try {
      const [info, peek] = await Promise.all([celld.queueInfo(app.prefix, c.req.param("q")), celld.queuePeek(app.prefix, c.req.param("q")).catch(() => ({ messages: [] }))]);
      return c.json({ info, messages: peek.messages ?? [] });
    } catch (e) { return failure(c, e); }
  });
  api.post("/api/apps/:name/queues/:q/:action", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const action = QueueAction.parse(c.req.param("action"));
    try { const out = await audited(c, `queue.${action}`, `${app.name}/${c.req.param("q")}`, () => celld.queueAction(app.prefix, c.req.param("q"), action)); return c.json({ ok: true, output: out }); }
    catch (e) { return failure(c, e); }
  });

  // ---- R2 ----
  api.get("/api/apps/:name/r2/:bucket", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try { return c.json(await celld.r2List(app.prefix, c.req.param("bucket"), { after: c.req.query("after") })); } catch (e) { return failure(c, e); }
  });
  api.post("/api/apps/:name/r2/:bucket", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file"); const key = String(form?.get("key") || (file instanceof File ? file.name : ""));
    if (!(file instanceof File) || !key) return c.json({ error: "attach a file (and optionally a key)" }, 400);
    const tmp = join(tmpdir(), `fleetiq-r2-${crypto.randomUUID()}`);
    try {
      await Bun.write(tmp, file);
      await audited(c, "r2.put", `${app.name}/${c.req.param("bucket")}/${key}`, () => celld.r2Put(app.prefix, c.req.param("bucket"), key, tmp, file.type || undefined), () => `${file.size} bytes`);
      return c.json({ ok: true, key });
    } catch (e) { return failure(c, e); }
    finally { await Bun.file(tmp).delete().catch(() => {}); }
  });
  api.delete("/api/apps/:name/r2/:bucket", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const key = c.req.query("key"); if (!key) return c.json({ error: "key is required" }, 400);
    try { await audited(c, "r2.delete", `${app.name}/${c.req.param("bucket")}/${key}`, () => celld.r2Delete(app.prefix, c.req.param("bucket"), key)); return c.json({ ok: true }); }
    catch (e) { return failure(c, e); }
  });
}
