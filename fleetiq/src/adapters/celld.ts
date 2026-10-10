import { appBucketUrl, config } from "../config";
import { type ExecResult, cleanError, run } from "./exec";

export class CelldError extends Error {
  constructor(message: string, public result?: ExecResult) { super(message); }
}

// Every celld command takes the same storage flags; the app's prefix selects its fleet.
export function storageArgs(prefix: string): string[] {
  const a = ["--bucket", appBucketUrl(prefix)];
  if (config.s3Endpoint) a.push("--endpoint", config.s3Endpoint);
  if (config.region) a.push("--region", config.region);
  return a;
}

// Diagnose and other commands bind listeners; keep them on loopback so they never clash with a node.
const quietEnv = { CELLD_ADDR: "127.0.0.1:0", CELLD_INTERNAL_ADDR: "127.0.0.1:0" };

async function celld(args: string[], opts: { cwd?: string; timeoutMs?: number; allowFail?: boolean } = {}) {
  const r = await run([config.celld, ...args], { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 30_000, env: quietEnv });
  if (r.timedOut) throw new CelldError(`celld ${args[0]} timed out`, r);
  if (r.code !== 0 && !opts.allowFail) throw new CelldError(cleanError(r.stderr) || `celld ${args[0]} exited ${r.code}`, r);
  return r;
}

export const parseJsonl = <T = any>(s: string): T[] =>
  s.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as T);

export interface DiagnoseCheck { check: string; detail: string; verdict: "ok" | "fail" | "warn" | string }
export async function diagnose(prefix: string): Promise<DiagnoseCheck[]> {
  const r = await celld(["diagnose", ...storageArgs(prefix), "--json", "--read-only"], { allowFail: true, timeoutMs: 45_000 });
  const checks = parseJsonl<DiagnoseCheck>(r.stdout);
  if (!checks.length && r.code !== 0) throw new CelldError(cleanError(r.stderr), r);
  return checks;
}

export interface CellRow { class: string; id: string; reserved: boolean; scope: string }
export async function listCells(prefix: string): Promise<CellRow[]> {
  return parseJsonl<CellRow>((await celld(["cell", "list", ...storageArgs(prefix), "--all", "--json"])).stdout);
}

// ---- KV ----
export async function kvList(prefix: string, ns: string, opts: { after?: string } = {}) {
  const a = ["kv", "list", ns, ...storageArgs(prefix), "--json"];
  if (opts.after) a.push("--after", opts.after);
  const r = await celld(a);
  const next = /--after\s+(\S+)/.exec(r.stderr)?.[1]?.replace(/^['"]|['"]$/g, "");
  return { keys: parseJsonl<{ name: string; expiration: number | null; metadata: unknown }>(r.stdout), next: next ?? null };
}
export const kvGet = async (prefix: string, ns: string, key: string) => (await celld(["kv", "get", ns, key, ...storageArgs(prefix)])).stdout;
export const kvPut = async (prefix: string, ns: string, key: string, value: string) => { await celld(["kv", "put", ns, key, value, ...storageArgs(prefix)]); };
export const kvDelete = async (prefix: string, ns: string, key: string) => { await celld(["kv", "delete", ns, key, ...storageArgs(prefix)]); };
export async function kvInfo(prefix: string, ns: string) {
  const out = (await celld(["kv", "info", ns, ...storageArgs(prefix)])).stdout;
  return Object.fromEntries(out.split("\n").map((l) => l.split(":").map((x) => x.trim())).filter((p) => p.length === 2 && p[0]).map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : v]));
}

// ---- Queues ----
export const queueInfo = async (prefix: string, q: string) => JSON.parse((await celld(["queue", "info", q, ...storageArgs(prefix)])).stdout);
export const queuePeek = async (prefix: string, q: string) => JSON.parse((await celld(["queue", "peek", q, ...storageArgs(prefix)])).stdout);
export async function queueAction(prefix: string, q: string, action: "pause" | "resume" | "purge" | "redrive") {
  return (await celld(["queue", action, q, ...storageArgs(prefix)])).stdout.trim() || (await Promise.resolve("done"));
}

// ---- D1 (needs the project dir: database identity comes from wrangler) ----
export async function d1Execute(prefix: string, db: string, sql: string, projectDir: string) {
  const r = await celld(["d1", "execute", db, "--command", sql, projectDir, ...storageArgs(prefix), "--json"], { timeoutMs: 60_000 });
  return { rows: parseJsonl(r.stdout), message: cleanError(r.stderr).split("\n")[0] ?? "" };
}
export async function d1Migrations(prefix: string, db: string, projectDir: string, apply = false) {
  const r = await celld(["d1", "migrations", apply ? "apply" : "list", db, projectDir, ...storageArgs(prefix)], { timeoutMs: 120_000 });
  return (r.stdout + "\n" + r.stderr).replace(/\x1b\[[0-9;]*m/g, "").trim();
}

// ---- R2 ----
export async function r2List(prefix: string, bucket: string, opts: { after?: string } = {}) {
  const a = ["r2", "list", bucket, ...storageArgs(prefix), "--json"];
  if (opts.after) a.push("--after", opts.after);
  const r = await celld(a);
  return parseJsonl<{ key: string; size?: number; uploaded?: string }>(r.stdout);
}
export async function r2Delete(prefix: string, bucket: string, key: string) { await celld(["r2", "delete", bucket, key, ...storageArgs(prefix)]); }
export async function r2Put(prefix: string, bucket: string, key: string, path: string, contentType?: string) {
  const a = ["r2", "put", bucket, key, "--path", path, ...storageArgs(prefix)];
  if (contentType) a.push("--content-type", contentType);
  await celld(a, { timeoutMs: 300_000 });
}

// ---- Deploy ----
export async function deploy(prefix: string, projectDir: string): Promise<{ version: string | null; output: string }> {
  const r = await run([config.celld, "deploy", projectDir, ...storageArgs(prefix)], { timeoutMs: 300_000, env: { ...quietEnv } });
  const output = (r.stdout + "\n" + r.stderr).replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (r.code !== 0 || r.timedOut) throw new CelldError(cleanError(r.stderr) || "celld deploy failed", r);
  return { version: /Current Version ID:\s*([0-9a-f]+)/.exec(output)?.[1] ?? null, output };
}
