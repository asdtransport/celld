import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareOf } from "../cloudflare/deploy";
import * as trepo from "../cloudflare/repo";
import type { App } from "../db/schema";
import * as repo from "../lib/repo";
import * as mrepo from "../mover/repo";
import { MoverError } from "../mover/types";
import { parseJsonc, projectDir } from "../services/deploy";
import { type Side, celldSide, cloudflareSide, lit, qid } from "./sides";

// Move an app's data between this server (celld) and its Cloudflare deployment, either direction:
// D1 tables (schema created if missing), KV entries (byte-exact via base64), Durable Object tables
// (through the app's own /__fleetiq/data point). Tracked as a data mover run with a log and counts.
export type Part = "d1" | "kv" | "do";
export interface MigrateOpts { from: string; to: string; parts: Part[]; mode: "replace" | "merge"; dryRun: boolean }
const INTERNAL = "name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '_litestream*' AND name <> 'd1_migrations'";
const busy = new Set<string>();

async function sideFor(app: App, which: string, cfg: any, dir: string): Promise<Side> {
  const migrate = repo.migrateToken(app.name);
  if (which === "celld") return celldSide(app, dir, cfg, migrate);
  const t = trepo.getTarget(which); if (!t) throw new MoverError(`no target ${which}`, 404);
  const l = trepo.getLink(app.name, t.id); if (!l) throw new MoverError(`${app.name} isn't linked to ${t.name}`, 404);
  return cloudflareSide(app, cloudflareOf(t), cfg, { url: l.url, resources: l.resources ? JSON.parse(l.resources) : {} }, migrate);
}

export async function migrateData(app: App, opts: MigrateOpts, actor: string) {
  if (opts.from === opts.to) throw new MoverError("from and to are the same place");
  if (busy.has(app.name)) throw new MoverError(`a data move for ${app.name} is already running`, 409);
  const dir = projectDir(app.name);
  const cfgFile = (await readdir(dir).catch(() => [] as string[])).find((n) => /^wrangler\.jsonc?$/.test(n));
  if (!cfgFile) throw new MoverError(`${app.name} has no project on this server; deploy it here first so FleetIQ knows its bindings`, 409);
  const cfg = parseJsonc(await Bun.file(join(dir, cfgFile)).text());
  const [src, dst] = await Promise.all([sideFor(app, opts.from, cfg, dir), sideFor(app, opts.to, cfg, dir)]);
  const id = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const label = `${opts.dryRun ? "Plan" : "Move"} ${app.name} data: ${src.label} → ${dst.label}`;
  mrepo.startRun({ id, job: null, label, dryRun: opts.dryRun ? 1 : 0, actor });
  busy.add(app.name);
  const lines: string[] = []; const stats: any = { parts: {} as Record<string, any> };
  const log = (s: string) => { lines.push(`${new Date().toISOString().slice(11, 19)} ${s}`); mrepo.setRun(id, { log: lines.join("\n"), stats: JSON.stringify(stats) }); };
  void (async () => {
    let ok = true;
    try {
      log(`${label} (${opts.mode}${opts.dryRun ? ", dry run" : ""}): ${opts.parts.join(", ")}`);
      mrepo.setRun(id, { status: "running" });
      if (opts.parts.includes("d1")) for (const d of cfg.d1_databases ?? []) ok = (await moveD1(src, dst, d.binding, opts, log, stats)) && ok;
      if (opts.parts.includes("kv")) for (const k of cfg.kv_namespaces ?? []) ok = (await moveKv(src, dst, k.id, opts, log, stats)) && ok;
      if (opts.parts.includes("do")) ok = (await moveDo(src, dst, opts, log, stats)) && ok;
    } catch (e: any) { ok = false; log(`✗ ${e.message}`); }
    finally {
      mrepo.finishRun(id, { status: opts.dryRun && ok ? "planned" : ok ? "succeeded" : "failed", stats: JSON.stringify(stats), log: lines.join("\n") });
      repo.writeAudit({ actor, action: "data.move", target: app.name, outcome: ok ? "ok" : "failed", detail: `${opts.from} → ${opts.to}, ${opts.parts.join("+")}, ${opts.mode}${opts.dryRun ? ", dry run" : ""}` });
      busy.delete(app.name);
    }
  })();
  return mrepo.getRun(id)!;
}

export async function moveD1(src: Side, dst: Side, binding: string, o: MigrateOpts, log: (s: string) => void, stats: any) {
  const sdb = src.d1Name(binding); const ddb = dst.d1Name(binding);
  const tables = await src.d1(sdb, `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND ${INTERNAL} ORDER BY name`);
  const there = new Set((await dst.d1(ddb, `SELECT name FROM sqlite_master WHERE type = 'table' AND ${INTERNAL}`)).map((r) => String(r.name)));
  const res: any[] = []; let ok = true;
  for (const t of tables) {
    const name = String(t.name); const q = qid(name);
    const n = Number((await src.d1(sdb, `SELECT count(*) AS n FROM ${q}`))[0]?.n ?? 0);
    const before = there.has(name) ? Number((await dst.d1(ddb, `SELECT count(*) AS n FROM ${q}`))[0]?.n ?? 0) : null;
    if (o.dryRun) { res.push({ table: name, source: n, destination: before, action: before === null ? "create + copy" : o.mode === "replace" ? "replace" : "upsert" }); log(`D1 ${sdb}.${name}: ${n} rows → ${ddb} (${before === null ? "table will be created" : `${before} rows there`})`); continue; }
    const batch: string[] = []; let size = 0;
    const flush = async () => { if (batch.length) { await dst.d1Batch(ddb, batch.splice(0)); size = 0; } };
    const push = async (s: string) => { batch.push(s); size += s.length; if (size > 80_000) await flush(); };
    if (before === null) await push(String(t.sql));
    if (o.mode === "replace" && before !== null) await push(`DELETE FROM ${q}`);
    for (let off = 0; off < n; off += 500) {
      const rows = await src.d1(sdb, `SELECT * FROM ${q} LIMIT 500 OFFSET ${off}`);
      for (const r of rows) { const cols = Object.keys(r); await push(`INSERT OR REPLACE INTO ${q} (${cols.map(qid).join(", ")}) VALUES (${cols.map((c) => lit(r[c])).join(", ")})`); }
    }
    await flush();
    const after = Number((await dst.d1(ddb, `SELECT count(*) AS n FROM ${q}`))[0]?.n ?? 0);
    const good = o.mode === "replace" ? after === n : after >= n;
    ok = ok && good;
    res.push({ table: name, source: n, destination: after, ok: good });
    log(`${good ? "✔" : "✗"} D1 ${sdb}.${name}: ${n} rows → ${ddb} now has ${after}`);
  }
  if (!tables.length) log(`D1 ${sdb}: no tables with data`);
  stats.parts[`d1:${binding}`] = res;
  return ok;
}

export async function moveKv(src: Side, dst: Side, nsId: string, o: MigrateOpts, log: (s: string) => void, stats: any) {
  const sns = src.kvName(nsId); const dns = dst.kvName(nsId);
  const entries = await src.kvExport(sns);
  const dkeys = await dst.kvKeys(dns);
  const extra = o.mode === "replace" ? dkeys.filter((k) => !entries.some((e) => e.key === k)) : [];
  if (o.dryRun) { stats.parts[`kv:${nsId}`] = { source: entries.length, destination: dkeys.length, delete: extra.length }; log(`KV ${sns}: ${entries.length} keys → ${dns} (${dkeys.length} there${extra.length ? `, ${extra.length} would be deleted` : ""})`); return true; }
  await dst.kvImport(dns, entries);
  await dst.kvDelete(dns, extra);
  const after = await dst.kvKeys(dns);
  const good = entries.every((e) => after.includes(e.key)) && (o.mode !== "replace" || after.length === entries.length);
  stats.parts[`kv:${nsId}`] = { source: entries.length, destination: after.length, deleted: extra.length, ok: good };
  log(`${good ? "✔" : "✗"} KV ${sns}: ${entries.length} keys → ${dns} now has ${after.length}${extra.length ? ` (deleted ${extra.length})` : ""}`);
  return good;
}

export async function moveDo(src: Side, dst: Side, o: MigrateOpts, log: (s: string) => void, stats: any) {
  const dump = await src.doExport();
  const counts = Object.fromEntries(dump.tables.map((t) => [t.name, t.rows.length]));
  if (o.dryRun) { stats.parts.do = { source: counts }; log(`Durable Object: ${dump.tables.map((t) => `${t.name} ${t.rows.length} rows`).join(", ") || "no tables"} would be ${o.mode === "replace" ? "replaced" : "merged"} on the destination`); return true; }
  const r = await dst.doImport(dump, o.mode);
  const good = Object.entries(counts).every(([t, n]) => (o.mode === "replace" ? r.counts[t] === n : (r.counts[t] ?? 0) >= n));
  stats.parts.do = { source: counts, destination: r.counts, ok: good };
  log(`${good ? "✔" : "✗"} Durable Object: ${Object.entries(counts).map(([t, n]) => `${t} ${n} → ${r.counts[t]}`).join(", ") || "no tables"}`);
  return good;
}
