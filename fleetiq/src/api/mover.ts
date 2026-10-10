import type { Context, Hono } from "hono";
import { z } from "zod";
import { actorOf } from "../auth";
import * as repo from "../lib/repo";
import { FLEET_ENDPOINT, cancelRun, resolveSide, restoreApp, runJob, startRun, stopDuringCopy } from "../mover/controller";
import { FLEET_PROVIDER, PROVIDERS, connectorFor, providerOf, redact, validateConfig } from "../mover/providers";
import * as mrepo from "../mover/repo";
import { MoverError } from "../mover/types";
import { migrateData } from "../migrate/run";

const name = z.string().trim().min(1).max(80);
const prefix = z.string().trim().max(500).regex(/^[^\\]*$/).refine((p) => !p.split("/").includes(".."), "no .. in prefixes").default("");
const EndpointIn = z.object({ name: name.regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, "letters, digits, spaces, . _ -"), provider: z.string(), config: z.record(z.string(), z.string()).default({}), prefix });
const EndpointPatch = z.object({ name: name.optional(), config: z.record(z.string(), z.string()).optional(), prefix: prefix.optional() });
const Side = z.object({ endpoint: z.string().min(1), prefix });
const Patterns = z.array(z.string().max(200)).max(50).optional();
const SyncIn = z.object({
  source: Side, destination: Side, mode: z.enum(["copy", "mirror"]).default("copy"), compare: z.enum(["quick", "checksum", "size"]).default("quick"),
  include: Patterns, exclude: Patterns, concurrency: z.number().int().min(1).max(32).default(8), verify: z.boolean().default(true), dryRun: z.boolean().default(false),
  bwLimitMbps: z.number().int().min(1).max(10_000).nullable().default(null), maxDeletePct: z.number().int().min(0).max(100).default(50),
});
const JobIn = SyncIn.omit({ dryRun: true }).extend({ name, everyMinutes: z.number().int().min(5).max(60 * 24 * 31).nullable().default(null), enabled: z.boolean().default(true) });
const BackupIn = z.object({ endpoint: z.string().min(1), prefix: z.string().max(500).optional(), consistent: z.boolean().default(false), everyMinutes: z.number().int().min(5).max(60 * 24 * 31).nullable().default(null), runNow: z.boolean().default(true) });
const RestoreIn = z.object({ endpoint: z.string().min(1), prefix: z.string().max(500), app: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/), nodes: z.number().int().min(1).max(9).default(2), healthPath: z.string().startsWith("/").default("/api/health"), dryRun: z.boolean().default(false) });

const id = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const endpointView = (e: ReturnType<typeof mrepo.getEndpoint> & {}) => ({ id: e.id, name: e.name, provider: e.provider, providerLabel: providerOf(e.provider)?.label ?? e.provider, prefix: e.prefix, config: redact(e.provider, JSON.parse(e.config)), createdBy: e.createdBy, createdAt: e.createdAt });
const runView = (r: ReturnType<typeof mrepo.getRun> & {}) => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null, dryRun: !!r.dryRun });
const jobView = (j: ReturnType<typeof mrepo.getJob> & {}) => {
  const last = mrepo.lastRun(j.id);
  return { ...j, include: j.include ? JSON.parse(j.include) : [], exclude: j.exclude ? JSON.parse(j.exclude) : [], consistent: !!j.consistent, verify: !!j.verify, enabled: !!j.enabled, lastRun: last ? runView(last) : null };
};
function err(c: Context, e: unknown) {
  if (e instanceof MoverError) return c.json({ error: e.message }, e.status as any);
  throw e;
}
async function waitRun(rid: string, maxMs: number) {
  const until = Date.now() + maxMs;
  for (;;) { const r = mrepo.getRun(rid)!; if (!["planning", "running"].includes(r.status) || Date.now() > until) return r; await Bun.sleep(1000); }
}

export function moverRoutes(api: Hono) {
  api.get("/api/mover/providers", (c) => c.json({ providers: PROVIDERS, builtIn: [{ id: FLEET_ENDPOINT, name: FLEET_PROVIDER.label, note: "Every application's data lives under its name here." }] }));

  // ---- endpoints ----
  api.get("/api/mover/endpoints", (c) => c.json(mrepo.listEndpoints().map(endpointView)));
  api.post("/api/mover/endpoints", async (c) => {
    const b = EndpointIn.parse(await c.req.json());
    try {
      if (mrepo.endpointByName(b.name)) return c.json({ error: `an endpoint named ${b.name} exists` }, 409);
      const cfg = validateConfig(b.provider, b.config);
      connectorFor(b.provider, cfg); // validates shape (URLs, folders)
      const e = { id: id("ep"), name: b.name, provider: b.provider, config: JSON.stringify(cfg), prefix: b.prefix.replace(/^\/+/, ""), createdBy: actorOf(c) };
      mrepo.insertEndpoint(e);
      repo.writeAudit({ actor: actorOf(c), action: "mover.endpoint.create", target: b.name, outcome: "ok", detail: providerOf(b.provider)?.label });
      return c.json(endpointView(mrepo.getEndpoint(e.id)!), 201);
    } catch (e) { return err(c, e); }
  });
  api.patch("/api/mover/endpoints/:id", async (c) => {
    const e = mrepo.getEndpoint(c.req.param("id")); if (!e) return c.json({ error: "no such endpoint" }, 404);
    const b = EndpointPatch.parse(await c.req.json());
    try {
      const prev = JSON.parse(e.config) as Record<string, string>;
      // Secret fields left blank or masked keep their saved value.
      const merged = { ...prev, ...Object.fromEntries(Object.entries(b.config ?? {}).filter(([, v]) => v !== "" && !v.startsWith("••••"))) };
      const cfg = validateConfig(e.provider, merged); connectorFor(e.provider, cfg);
      mrepo.updateEndpoint(e.id, { name: b.name ?? e.name, config: JSON.stringify(cfg), prefix: b.prefix ?? e.prefix });
      repo.writeAudit({ actor: actorOf(c), action: "mover.endpoint.update", target: e.name, outcome: "ok" });
      return c.json(endpointView(mrepo.getEndpoint(e.id)!));
    } catch (x) { return err(c, x); }
  });
  api.delete("/api/mover/endpoints/:id", (c) => {
    const e = mrepo.getEndpoint(c.req.param("id")); if (!e) return c.json({ error: "no such endpoint" }, 404);
    const used = mrepo.listJobs().filter((j) => j.srcEndpoint === e.id || j.dstEndpoint === e.id);
    if (used.length) return c.json({ error: `used by ${used.map((j) => j.name).join(", ")}; delete those jobs first` }, 409);
    mrepo.deleteEndpoint(e.id);
    repo.writeAudit({ actor: actorOf(c), action: "mover.endpoint.remove", target: e.name, outcome: "ok" });
    return c.json({ ok: true });
  });
  api.post("/api/mover/endpoints/:id/test", async (c) => {
    const b = z.object({ prefix }).parse(await c.req.json().catch(() => ({})));
    try { const s = resolveSide(c.req.param("id"), b.prefix); const t0 = Date.now(); return c.json({ endpoint: s.label, ...(await s.conn.test(s.prefix)), ms: Date.now() - t0, location: (s.conn as any).location ?? null }); }
    catch (e) { return err(c, e); }
  });
  // Try settings before saving them (the endpoint form's Test button). For an existing endpoint,
  // blank or masked secret fields fall back to the saved values.
  api.post("/api/mover/test-config", async (c) => {
    const b = z.object({ provider: z.string(), config: z.record(z.string(), z.string()).default({}), prefix, endpoint: z.string().optional() }).parse(await c.req.json());
    try {
      const prev = b.endpoint ? mrepo.getEndpoint(b.endpoint) : null;
      const merged = { ...(prev ? JSON.parse(prev.config) : {}), ...Object.fromEntries(Object.entries(b.config).filter(([, v]) => v !== "" && !v.startsWith("••••"))) };
      const cfg = validateConfig(b.provider, merged);
      const conn = connectorFor(b.provider, cfg);
      const t0 = Date.now(); const r = await conn.test(b.prefix.replace(/^\/+/, ""));
      return c.json({ endpoint: conn.label, ms: Date.now() - t0, ...r, location: (conn as any).location ?? null });
    } catch (e) { if (e instanceof MoverError) return c.json({ list: false, write: false, detail: e.message }); throw e; }
  });
  api.get("/api/mover/endpoints/:id/browse", async (c) => {
    const p = c.req.query("prefix") ?? ""; const limit = Math.min(Number(c.req.query("limit") ?? 200), 2000);
    try {
      const s = resolveSide(c.req.param("id"), p);
      const items: any[] = []; let bytes = 0; let count = 0;
      for await (const o of s.conn.list(s.prefix)) { count++; bytes += o.size; if (items.length < limit) items.push({ key: o.key.slice(s.prefix.length), size: o.size, mtime: o.mtime }); if (count >= 100_000) break; }
      return c.json({ endpoint: s.label, count, bytes, truncated: count > items.length, items });
    } catch (e) { return err(c, e); }
  });

  // Download one object (browse → click a file). Streams; nothing is buffered here.
  api.get("/api/mover/endpoints/:id/object", async (c) => {
    const key = c.req.query("key") ?? "";
    if (!key || key.split("/").includes("..")) return c.json({ error: "key required" }, 400);
    try {
      const s = resolveSide(c.req.param("id"), "");
      const o = await s.conn.get(s.prefix + key.replace(/^\/+/, ""));
      if (!o) return c.json({ error: "no such object" }, 404);
      repo.writeAudit({ actor: actorOf(c), action: "mover.download", target: `${s.label}${key}`, outcome: "ok" });
      return new Response(o.body as any, { headers: { "content-type": o.contentType || "application/octet-stream", ...(o.size ? { "content-length": String(o.size) } : {}), "content-disposition": `attachment; filename="${key.split("/").pop()!.replace(/["\\\r\n]/g, "_")}"` } });
    } catch (e) { return err(c, e); }
  });

  // ---- one-off sync ----
  api.post("/api/mover/sync", async (c) => {
    const b = SyncIn.parse(await c.req.json());
    try {
      const nm = (e: string) => mrepo.getEndpoint(e)?.name ?? e;
      const r = startRun({ label: `${nm(b.source.endpoint)}:${b.source.prefix || "/"} → ${nm(b.destination.endpoint)}:${b.destination.prefix || "/"}`, actor: actorOf(c), dryRun: b.dryRun, src: b.source, dst: b.destination, mode: b.mode, compare: b.compare, include: b.include, exclude: b.exclude, concurrency: b.concurrency, verify: b.verify, bwLimitMbps: b.bwLimitMbps, maxDeletePct: b.maxDeletePct });
      return c.json(runView(c.req.query("wait") ? await waitRun(r.id, 240_000) : r), 202);
    } catch (e) { return err(c, e); }
  });

  // ---- jobs ----
  api.get("/api/mover/jobs", (c) => c.json(mrepo.listJobs().map(jobView)));
  api.post("/api/mover/jobs", async (c) => {
    const b = JobIn.parse(await c.req.json());
    try {
      resolveSide(b.source.endpoint, b.source.prefix); resolveSide(b.destination.endpoint, b.destination.prefix);
      const j = { id: id("job"), name: b.name, kind: "sync", app: null, consistent: 0, srcEndpoint: b.source.endpoint, srcPrefix: b.source.prefix, dstEndpoint: b.destination.endpoint, dstPrefix: b.destination.prefix, mode: b.mode, compare: b.compare, include: b.include?.length ? JSON.stringify(b.include) : null, exclude: b.exclude?.length ? JSON.stringify(b.exclude) : null, concurrency: b.concurrency, verify: b.verify ? 1 : 0, bwLimitMbps: b.bwLimitMbps, maxDeletePct: b.maxDeletePct, everyMinutes: b.everyMinutes, enabled: b.enabled ? 1 : 0, nextRunAt: b.everyMinutes ? Math.floor(Date.now() / 1000) + b.everyMinutes * 60 : null, createdBy: actorOf(c) };
      mrepo.insertJob(j);
      repo.writeAudit({ actor: actorOf(c), action: "mover.job.create", target: b.name, outcome: "ok", detail: `${b.mode}${b.everyMinutes ? `, every ${b.everyMinutes} min` : ""}` });
      return c.json(jobView(mrepo.getJob(j.id)!), 201);
    } catch (e) { return err(c, e); }
  });
  api.patch("/api/mover/jobs/:id", async (c) => {
    const j = mrepo.getJob(c.req.param("id")); if (!j) return c.json({ error: "no such job" }, 404);
    const b = z.object({ enabled: z.boolean().optional(), everyMinutes: z.number().int().min(5).max(60 * 24 * 31).nullable().optional(), name: name.optional(), bwLimitMbps: z.number().int().min(1).max(10_000).nullable().optional(), maxDeletePct: z.number().int().min(0).max(100).optional() }).parse(await c.req.json());
    mrepo.updateJob(j.id, { ...(b.name ? { name: b.name } : {}), ...(b.bwLimitMbps !== undefined ? { bwLimitMbps: b.bwLimitMbps } : {}), ...(b.maxDeletePct !== undefined ? { maxDeletePct: b.maxDeletePct } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled ? 1 : 0 } : {}), ...(b.everyMinutes !== undefined ? { everyMinutes: b.everyMinutes, nextRunAt: b.everyMinutes ? Math.floor(Date.now() / 1000) + b.everyMinutes * 60 : null } : {}) });
    repo.writeAudit({ actor: actorOf(c), action: "mover.job.update", target: j.name, outcome: "ok", detail: Object.keys(b).join(", ") });
    return c.json(jobView(mrepo.getJob(j.id)!));
  });
  api.delete("/api/mover/jobs/:id", (c) => {
    const j = mrepo.getJob(c.req.param("id")); if (!j) return c.json({ error: "no such job" }, 404);
    mrepo.deleteJob(j.id);
    repo.writeAudit({ actor: actorOf(c), action: "mover.job.remove", target: j.name, outcome: "ok" });
    return c.json({ ok: true });
  });
  api.post("/api/mover/jobs/:id/run", async (c) => {
    const j = mrepo.getJob(c.req.param("id")); if (!j) return c.json({ error: "no such job" }, 404);
    const dry = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";
    try { const r = runJob(j, actorOf(c), dry); return c.json(runView(c.req.query("wait") ? await waitRun(r.id, 240_000) : r), 202); }
    catch (e) { return err(c, e); }
  });

  // ---- runs ----
  api.get("/api/mover/runs", (c) => c.json(mrepo.listRuns(c.req.query("job") || undefined, Math.min(Number(c.req.query("limit") ?? 50), 200)).map(runView)));
  api.get("/api/mover/runs/:id", async (c) => {
    const r = mrepo.getRun(c.req.param("id")); if (!r) return c.json({ error: "no such run" }, 404);
    const t = Number(c.req.query("wait") ?? 0);
    return c.json(runView(t ? await waitRun(r.id, Math.min(t, 240) * 1000) : r));
  });
  api.post("/api/mover/runs/:id/cancel", (c) => c.json({ ok: cancelRun(c.req.param("id")) }));

  // ---- application backup and restore ----
  api.post("/api/apps/:name/backup", async (c) => {
    const app = repo.getApp(c.req.param("name")); if (!app) return c.json({ error: "no such application" }, 404);
    const b = BackupIn.parse(await c.req.json());
    try {
      const dstPrefix = (b.prefix ?? `celld/${app.name}`).replace(/^\/+/, "");
      resolveSide(b.endpoint, dstPrefix);
      if (b.consistent) stopDuringCopy(app); // throws for apps whose nodes FleetIQ doesn't run
      const jobName = `Back up ${app.name} → ${mrepo.getEndpoint(b.endpoint)?.name ?? b.endpoint}`;
      let job = mrepo.listJobs().find((j) => j.kind === "app-backup" && j.app === app.name && j.dstEndpoint === b.endpoint && j.dstPrefix === dstPrefix);
      const fields = { consistent: b.consistent ? 1 : 0, everyMinutes: b.everyMinutes, nextRunAt: b.everyMinutes ? Math.floor(Date.now() / 1000) + b.everyMinutes * 60 : null };
      if (job) mrepo.updateJob(job.id, fields);
      else {
        // copy, never mirror: a backup must survive the source being emptied, and celld's data objects are append-only.
        job = { id: id("job"), name: jobName, kind: "app-backup", app: app.name, srcEndpoint: FLEET_ENDPOINT, srcPrefix: app.prefix, dstEndpoint: b.endpoint, dstPrefix, mode: "copy", compare: "quick", include: null, exclude: null, concurrency: 8, verify: 1, enabled: 1, createdBy: actorOf(c), ...fields } as any;
        mrepo.insertJob(job as any);
        repo.writeAudit({ actor: actorOf(c), action: "mover.job.create", target: jobName, outcome: "ok", detail: `${b.consistent ? "consistent" : "live"}${b.everyMinutes ? `, every ${b.everyMinutes} min` : ""}` });
      }
      const fresh = mrepo.getJob(job!.id)!;
      const run = b.runNow ? runJob(fresh, actorOf(c)) : null;
      return c.json({ job: jobView(fresh), run: run ? runView(run) : null }, 202);
    } catch (e) { return err(c, e); }
  });
  // ---- app data between this server and a cloud target (D1, KV, Durable Objects) ----
  api.post("/api/apps/:name/migrate-data", async (c) => {
    const app = repo.getApp(c.req.param("name")); if (!app) return c.json({ error: "no such application" }, 404);
    const b = z.object({
      from: z.string().min(1), to: z.string().min(1),
      parts: z.array(z.enum(["d1", "kv", "do"])).min(1).default(["d1", "kv", "do"]),
      mode: z.enum(["replace", "merge"]).default("replace"), dryRun: z.boolean().default(false),
    }).parse(await c.req.json());
    try {
      const r = await migrateData(app, b, actorOf(c));
      return c.json(runView(c.req.query("wait") ? await waitRun(r.id, 240_000) : r), 202);
    } catch (e) { return err(c, e); }
  });
  api.post("/api/mover/restore", async (c) => {
    const b = RestoreIn.parse(await c.req.json());
    try { const r = await restoreApp({ ...b, actor: actorOf(c) }); return c.json(runView(r), 202); }
    catch (e) { return err(c, e); }
  });
}
