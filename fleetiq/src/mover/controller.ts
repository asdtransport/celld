import type { App, MoverJob } from "../db/schema";
import * as repo from "../lib/repo";
import { fleetOf, scaleNodes } from "../services/fleet";
import { syncLb } from "../services/network";
import { type Compare, execute, normPrefix, plan, type SyncSpec } from "./engine";
import { connectorFor } from "./providers";
import * as mrepo from "./repo";
import { type Connector, MoverError, joinKey } from "./types";

// The mover controller: resolves endpoints to connectors, runs plans and copies as tracked runs with
// live progress, applies the app-aware steps (stop nodes for a consistent copy, restore into a fleet),
// and fires scheduled jobs.

export const FLEET_ENDPOINT = "fleet";
const active = new Map<string, AbortController>();
const busyJobs = new Set<string>();
const rid = () => `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function resolveSide(endpointId: string, prefix: string): { conn: Connector; prefix: string; label: string } {
  if (endpointId === FLEET_ENDPOINT) {
    const conn = connectorFor("fleet", {});
    return { conn, prefix: normPrefix(prefix), label: `${conn.label}/${normPrefix(prefix)}` };
  }
  const e = mrepo.getEndpoint(endpointId) ?? mrepo.endpointByName(endpointId);
  if (!e) throw new MoverError(`no endpoint ${endpointId}`, 404);
  const conn = connectorFor(e.provider, JSON.parse(e.config), `${e.name}`);
  const full = normPrefix(joinKey(e.prefix, prefix));
  return { conn, prefix: full, label: `${e.name}:/${full}` };
}

export interface RunRequest {
  label: string; job?: MoverJob | null; dryRun?: boolean; actor: string;
  src: { endpoint: string; prefix: string }; dst: { endpoint: string; prefix: string };
  mode: "copy" | "mirror"; compare: Compare; include?: string[]; exclude?: string[]; concurrency?: number; verify?: boolean;
  before?: (log: (s: string) => void) => Promise<void>; after?: (log: (s: string) => void, ok: boolean) => Promise<void>;
}

export function startRun(req: RunRequest) {
  if (req.job && busyJobs.has(req.job.id)) throw new MoverError(`${req.job.name} is already running`, 409);
  const src = resolveSide(req.src.endpoint, req.src.prefix);
  const dst = resolveSide(req.dst.endpoint, req.dst.prefix);
  if (req.src.endpoint === req.dst.endpoint && (src.prefix.startsWith(dst.prefix) || dst.prefix.startsWith(src.prefix)))
    throw new MoverError("source and destination overlap; pick prefixes that don't contain each other");
  const id = rid();
  mrepo.startRun({ id, job: req.job?.id ?? null, label: req.label, dryRun: req.dryRun ? 1 : 0, actor: req.actor });
  if (req.job) busyJobs.add(req.job.id);
  const ac = new AbortController(); active.set(id, ac);
  const lines: string[] = [];
  let stats: any = {};
  const log = (s: string) => { lines.push(`${new Date().toISOString().slice(11, 19)} ${s}`); mrepo.setRun(id, { log: lines.join("\n") }); };
  const spec: SyncSpec = { src: src.conn, srcPrefix: src.prefix, dst: dst.conn, dstPrefix: dst.prefix, mode: req.mode, compare: req.compare, include: req.include, exclude: req.exclude };
  void (async () => {
    let ok = false; let beforeDone = false;
    try {
      log(`${req.dryRun ? "Planning" : "Syncing"} ${src.label} → ${dst.label} (${req.mode}, compare ${req.compare})`);
      if (req.before && !req.dryRun) { await req.before(log); beforeDone = true; }
      const p = await plan(spec, (side, n) => log(`Listed ${n} objects on the ${side}`));
      stats = { plan: { copy: p.copy.length, new: p.copy.filter((i) => i.reason === "new").length, changed: p.copy.filter((i) => i.reason === "changed").length, remove: p.remove.length, same: p.same, bytes: p.bytes, srcCount: p.srcCount, dstCount: p.dstCount } };
      log(`Plan: ${p.copy.length} to copy (${(p.bytes / 1048576).toFixed(1)} MB), ${p.remove.length} to delete, ${p.same} already in sync`);
      if (req.dryRun) {
        stats.sample = { copy: p.copy.slice(0, 50), remove: p.remove.slice(0, 50) };
        mrepo.finishRun(id, { status: "planned", stats: JSON.stringify(stats), log: lines.join("\n") }); ok = true; return;
      }
      mrepo.setRun(id, { status: "running", stats: JSON.stringify(stats) });
      let last = 0;
      const r = await execute(spec, p, {
        concurrency: req.concurrency ?? 8, verify: req.verify ?? true, signal: ac.signal,
        onProgress: (pr) => { if (Date.now() - last > 1500) { last = Date.now(); mrepo.setRun(id, { stats: JSON.stringify({ ...stats, progress: pr }) }); } },
      });
      stats.result = { copied: r.done, bytes: r.bytes, failed: r.failed, removed: r.removed, ms: r.ms, verified: r.verified, errors: r.errors.slice(0, 20) };
      log(`Copied ${r.done} objects (${(r.bytes / 1048576).toFixed(1)} MB) in ${(r.ms / 1000).toFixed(1)} s${r.removed ? `, deleted ${r.removed}` : ""}${r.failed ? `, ${r.failed} failed` : ""}`);
      for (const e of r.errors.slice(0, 10)) log(`  ✗ ${e.key}: ${e.error}`);
      if (r.verified) log(`${r.verified.ok ? "Verified" : "Verify failed"}: ${r.verified.detail}`);
      ok = !ac.signal.aborted && r.failed === 0 && (!r.verified || r.verified.ok);
      if (ac.signal.aborted) log("Cancelled");
    } catch (e: any) {
      log(`✗ ${e.message}`);
    } finally {
      if (req.after && beforeDone) { try { await req.after(log, ok); } catch (e: any) { log(`✗ after-step: ${e.message}`); ok = false; } }
      const cur = mrepo.getRun(id)!;
      if (cur.status !== "planned") {
        mrepo.finishRun(id, { status: ac.signal.aborted ? "cancelled" : ok ? "succeeded" : "failed", stats: JSON.stringify(stats), log: lines.join("\n") });
        repo.writeAudit({ actor: req.actor, action: "mover.run", target: req.label, outcome: ok ? "ok" : "failed", detail: stats.result ? `${stats.result.copied} copied, ${stats.result.removed} deleted, ${stats.result.failed} failed` : lines.at(-1)?.slice(9, 300) });
      }
      active.delete(id); if (req.job) busyJobs.delete(req.job.id);
    }
  })();
  return mrepo.getRun(id)!;
}

export function cancelRun(id: string) { const ac = active.get(id); if (!ac) return false; ac.abort(); return true; }

// ---- jobs ----
const parseList = (s: string | null) => (s ? (JSON.parse(s) as string[]) : undefined);
export function runJob(job: MoverJob, actor: string, dryRun = false) {
  const base: RunRequest = {
    label: job.name, job, dryRun, actor,
    src: { endpoint: job.srcEndpoint, prefix: job.srcPrefix }, dst: { endpoint: job.dstEndpoint, prefix: job.dstPrefix },
    mode: job.mode as "copy" | "mirror", compare: job.compare as Compare, include: parseList(job.include), exclude: parseList(job.exclude),
    concurrency: job.concurrency, verify: !!job.verify,
  };
  if (job.kind === "app-backup" && job.consistent) {
    const app = repo.getApp(job.app ?? "");
    if (!app) throw new MoverError(`application ${job.app} no longer exists`, 404);
    return startRun({ ...base, ...stopDuringCopy(app) });
  }
  return startRun(base);
}

// Consistent copy of a managed app: stop its nodes (each hands off with a final snapshot), copy, start them again.
export function stopDuringCopy(app: App): Pick<RunRequest, "before" | "after"> {
  if (!app.managed) throw new MoverError(`${app.name}'s nodes run outside FleetIQ; stop them yourself and run a live copy, or turn off "consistent"`, 409);
  const want = app.desiredNodes;
  return {
    before: async (log) => { log(`Stopping ${app.name}'s ${want} nodes for a consistent copy (the app is offline until they restart)`); await scaleNodes(app, 0); await syncLb().catch(() => {}); log("Nodes stopped"); },
    after: async (log) => { log(`Starting ${want} nodes again`); await scaleNodes(app, want); await syncLb().catch(() => {}); log("Nodes started"); },
  };
}

// Restore an app's fleet data from an endpoint into this server's bucket, then start nodes.
export async function restoreApp(opts: { endpoint: string; prefix: string; app: string; nodes: number; healthPath: string; actor: string; dryRun?: boolean }) {
  let app = repo.getApp(opts.app);
  if (app && !app.managed) {
    const f = await fleetOf(app).catch(() => null);
    if (f?.live) throw new MoverError(`${app.name} has ${f.live} live nodes run outside FleetIQ; stop them before restoring over it`, 409);
  }
  const created = !app;
  if (!app && !opts.dryRun) {
    app = repo.createApp({ name: opts.app, prefix: opts.app, description: "Restored with the data mover", managed: 1, desiredNodes: opts.nodes, nodeImage: null, healthPath: opts.healthPath, createdBy: opts.actor });
    repo.writeAudit({ actor: opts.actor, action: "app.create", target: opts.app, outcome: "ok", detail: "for a restore" });
  }
  const target = app ?? { name: opts.app, prefix: opts.app } as App;
  const want = app?.managed ? (created ? opts.nodes : app.desiredNodes || opts.nodes) : 0;
  return startRun({
    label: `restore ${target.name}`, actor: opts.actor, dryRun: opts.dryRun,
    src: { endpoint: opts.endpoint, prefix: opts.prefix }, dst: { endpoint: FLEET_ENDPOINT, prefix: target.prefix },
    mode: "mirror", compare: "quick", verify: true,
    before: async (log) => {
      if (app?.managed) { log(`Stopping ${app.name}'s nodes before overwriting its data`); await scaleNodes(app, 0); }
      log(created ? `Created application ${target.name}` : `Restoring over ${target.name}'s data (an exact copy of the backup)`);
    },
    after: async (log, ok) => {
      if (!app?.managed) return;
      if (!ok) log("The copy didn't finish cleanly; starting nodes anyway so you can inspect the app");
      log(`Starting ${want} nodes`); repo.updateApp(app.name, { desiredNodes: want }); await scaleNodes(app, want); await syncLb().catch(() => {});
    },
  });
}

// ---- schedule ----
export function scheduleTick(now = Math.floor(Date.now() / 1000)) {
  for (const j of mrepo.listJobs()) {
    if (!j.enabled || !j.everyMinutes || busyJobs.has(j.id)) continue;
    if (j.nextRunAt && j.nextRunAt > now) continue;
    mrepo.updateJob(j.id, { nextRunAt: now + j.everyMinutes * 60 });
    if (!j.nextRunAt) continue; // first sight of a new schedule: just arm it
    try { runJob(j, "schedule"); } catch (e: any) { repo.writeAudit({ actor: "schedule", action: "mover.run", target: j.name, outcome: "failed", detail: e.message }); }
  }
}
export function startScheduler() { return setInterval(() => { try { scheduleTick(); } catch (e) { console.error("mover schedule", e); } }, 60_000); }
