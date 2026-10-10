import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as celld from "../adapters/celld";
import type { Cloudflare } from "../cloudflare/api";
import { cfName } from "../cloudflare/config";
import type { App } from "../db/schema";
import { upstreamsOf } from "../services/fleet";

// One side of a data move: this server's celld fleet, or the app's Cloudflare deployment.
// Both expose the same three stores so the engine never cares which way data flows.
export type Row = Record<string, unknown>;
export interface Table { name: string; sql: string }
export interface KvEntry { key: string; value: string; base64?: boolean; expiration?: number; metadata?: unknown }
export interface DoDump { format: string; tables: { name: string; sql: string; rows: Row[] }[] }
export interface Side {
  label: string;
  d1Name(binding: string): string;                       // database as this side names it
  d1(db: string, sql: string): Promise<Row[]>;            // one statement, rows back
  d1Batch(db: string, statements: string[]): Promise<void>; // many statements, no rows
  kvExport(ns: string): Promise<KvEntry[]>;
  kvImport(ns: string, entries: KvEntry[]): Promise<void>;
  kvDelete(ns: string, keys: string[]): Promise<void>;
  kvKeys(ns: string): Promise<string[]>;
  kvName(nsId: string): string;
  doExport(): Promise<DoDump>;
  doImport(dump: DoDump, mode: "replace" | "merge"): Promise<{ counts: Record<string, number> }>;
}

// SQL literal for a value read from either side (D1 returns blobs as byte arrays).
export function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return `X'${Buffer.from(v as number[]).toString("hex")}'`;
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}
export const qid = (n: string) => `"${n.replace(/"/g, '""')}"`;

async function doCall(url: string, headers: Record<string, string>, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as any) }, redirect: "manual", signal: AbortSignal.timeout(120_000) });
  const text = await r.text();
  if (r.status === 404) throw new Error("the app has no data export point (/__fleetiq/data) or the migrate secret doesn't match; redeploy it with FLEETIQ_MIGRATE_TOKEN declared as \"\"");
  if (r.status >= 300 && r.status < 400) throw new Error(`Access redirected the request (${r.status}); the FleetIQ service token isn't allowed on this app yet, redeploy to Cloudflare once`);
  if (!r.ok) throw new Error(`data export point answered ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export function celldSide(app: App, projectDir: string, cfg: any, migrate: string): Side {
  const p = app.prefix;
  const nameOf = (binding: string) => (cfg?.d1_databases ?? []).find((d: any) => d.binding === binding)?.database_name ?? binding;
  const node = async () => {
    const ups = await upstreamsOf(app);
    if (!ups.length) throw new Error(`${app.name} has no running nodes on this server`);
    return `http://${ups[0]}`;
  };
  const hdr = { "x-fleetiq-migrate": migrate };
  return {
    label: `celld (${app.name} on this server)`,
    d1Name: nameOf,
    d1: async (db, sql) => (await celld.d1Execute(p, db, sql, projectDir)).rows as Row[],
    d1Batch: async (db, statements) => {
      const dir = await mkdtemp(join(tmpdir(), "fiq-d1-"));
      try { const f = join(dir, "batch.sql"); await Bun.write(f, statements.join(";\n") + ";\n"); await celld.d1ExecFile(p, db, f, projectDir); }
      finally { await rm(dir, { recursive: true, force: true }); }
    },
    kvName: (id) => id,
    kvExport: async (ns) => {
      const dir = await mkdtemp(join(tmpdir(), "fiq-kv-"));
      try { const f = join(dir, "kv.json"); await celld.kvBulkGet(p, ns, f); return JSON.parse(await Bun.file(f).text() || "[]"); }
      finally { await rm(dir, { recursive: true, force: true }); }
    },
    kvImport: async (ns, entries) => {
      if (!entries.length) return;
      const dir = await mkdtemp(join(tmpdir(), "fiq-kv-"));
      try { const f = join(dir, "kv.json"); await Bun.write(f, JSON.stringify(entries)); await celld.kvBulkPut(p, ns, f); }
      finally { await rm(dir, { recursive: true, force: true }); }
    },
    kvDelete: async (ns, keys) => {
      if (!keys.length) return;
      const dir = await mkdtemp(join(tmpdir(), "fiq-kv-"));
      try { const f = join(dir, "keys.json"); await Bun.write(f, JSON.stringify(keys)); await celld.kvBulkDelete(p, ns, f); }
      finally { await rm(dir, { recursive: true, force: true }); }
    },
    kvKeys: async function (ns) { return (await this.kvExport(ns)).map((e) => e.key); },
    doExport: async () => doCall(`${await node()}/__fleetiq/data`, hdr),
    doImport: async (dump, mode) => doCall(`${await node()}/__fleetiq/data?mode=${mode}`, hdr, { method: "POST", body: JSON.stringify(dump), headers: { "content-type": "application/json" } }),
  };
}

export function cloudflareSide(app: App, cf: Cloudflare, cfg: any, link: { url: string | null; resources: any }, migrate: string): Side {
  const res = link.resources ?? {};
  const nameOf = (binding: string) => cfName(app.name, (cfg?.d1_databases ?? []).find((d: any) => d.binding === binding)?.database_name ?? binding);
  const idOf = (db: string) => { const id = res.d1?.[db]; if (!id) throw new Error(`no Cloudflare D1 ${db} for this app; deploy it to Cloudflare first`); return id; };
  const kvId = (name: string) => { const id = res.kv?.[name]; if (!id) throw new Error(`no Cloudflare KV ${name}; deploy to Cloudflare first`); return id; };
  const hdr: Record<string, string> = { "x-fleetiq-migrate": migrate };
  if (res.serviceToken?.clientId) { hdr["cf-access-client-id"] = res.serviceToken.clientId; hdr["cf-access-client-secret"] = res.serviceToken.clientSecret; }
  const base = () => { if (!link.url) throw new Error("not deployed to Cloudflare yet"); return link.url.replace(/\/+$/, ""); };
  return {
    label: `Cloudflare (${link.url ?? "not deployed"})`,
    d1Name: nameOf,
    d1: async (db, sql) => (await cf.d1Query(idOf(db), sql)) as Row[],
    d1Batch: async (db, statements) => { await cf.d1Query(idOf(db), statements.join(";\n")); },
    kvName: (id) => cfName(app.name, id),
    kvExport: async (ns) => {
      const id = kvId(ns); const keys = await cf.kvKeys(id); const out: KvEntry[] = [];
      for (const k of keys) {
        const v = await cf.kvValue(id, k.name);
        out.push({ key: k.name, value: Buffer.from(v).toString("base64"), base64: true, ...(k.expiration ? { expiration: k.expiration } : {}), ...(k.metadata ? { metadata: k.metadata } : {}) });
      }
      return out;
    },
    kvImport: async (ns, entries) => { if (entries.length) await cf.kvBulkPut(kvId(ns), entries); },
    kvDelete: async (ns, keys) => { if (keys.length) await cf.kvBulkDelete(kvId(ns), keys); },
    kvKeys: async (ns) => (await cf.kvKeys(kvId(ns))).map((k) => k.name),
    doExport: async () => doCall(`${base()}/__fleetiq/data`, hdr),
    doImport: async (dump, mode) => doCall(`${base()}/__fleetiq/data?mode=${mode}`, hdr, { method: "POST", body: JSON.stringify(dump), headers: { "content-type": "application/json" } }),
  };
}
