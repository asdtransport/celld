import { mkdir, readdir, rm, stat, symlink, unlink, writeFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as bucket from "../adapters/bucket";
import * as celld from "../adapters/celld";
import { run } from "../adapters/exec";
import { type ReloadResult, reloadNode } from "../adapters/nodes";
import { config } from "../config";
import { runBuilder } from "../adapters/docker";
import { SourceError } from "./source";
import type { App } from "../db/schema";
import * as repo from "../lib/repo";

const appDir = (app: string) => resolve(config.dataDir, "apps", app);
export const projectDir = (app: string) => join(appDir(app), "project");
const locks = new Set<string>();

// Nudge every live node to adopt the pointer now, and write each node's answer into the log.
export async function reloadFleet(app: App, log: string[]): Promise<ReloadResult[]> {
  const leases = (await bucket.nodeLeases(app.prefix).catch(() => [])).filter((l) => l.expires_ms > Date.now());
  const results = await Promise.all(leases.map((l) => reloadNode(l.addr)));
  for (const r of results) log.push(`Node ${r.addr}: ${r.outcome}${r.version ? ` ${r.version}` : ""}${r.error ? ` (${r.error})` : ""}`);
  if (!results.length) log.push("No live nodes to reload; nodes pick the version up when they start.");
  return results;
}
async function waitForNodes(app: App, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const leases = (await bucket.nodeLeases(app.prefix).catch(() => [])).filter((l) => l.expires_ms > Date.now());
    if (leases.length) { await Bun.sleep(3_000); return true; }
    await Bun.sleep(3_000);
  }
  return false;
}
const reloadSummary = (rs: ReloadResult[]) => {
  const bad = rs.filter((r) => r.outcome === "failed" || r.outcome === "unreachable");
  return bad.length ? `${bad.length} of ${rs.length} nodes did not adopt it` : null;
};

export class DeployError extends Error { constructor(m: string, public status = 400) { super(m); } }

// Wrangler configs are JSONC: drop comments (outside strings) and trailing commas, then parse.
export function parseJsonc(text: string): any {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n ?? ""; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i = text.indexOf("*/", i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// An app that gates on the edge (AUTH_MODE "edge") needs the edge's public key. Leave the var as ""
// in the project and FleetIQ fills in this server's key, so one archive works on any server.
// Any var declared as "" in the project is filled by FleetIQ (edge key, migrate secret).
export function fillVar(text: string, name: string, value: string): { text: string; filled: boolean } {
  if (!value) return { text, filled: false };
  const re = new RegExp(`("${name}"\\s*:\\s*)""`);
  return re.test(text) ? { text: text.replace(re, `$1"${value}"`), filled: true } : { text, filled: false };
}
export function fillEdgeKey(text: string, key: string): { text: string; filled: boolean } {
  if (!key) return { text, filled: false };
  const re = /("AUTH_PUBLIC_KEY_B64"\s*:\s*)""/;
  return re.test(text) ? { text: text.replace(re, `$1"${key}"`), filled: true } : { text, filled: false };
}

// D1 databases that ship migrations, from the project's config.
export function d1WithMigrations(cfg: any): string[] {
  return (Array.isArray(cfg?.d1_databases) ? cfg.d1_databases : [])
    .filter((d: any) => d?.migrations_dir && (d.database_name || d.binding))
    .map((d: any) => String(d.database_name || d.binding));
}

// Archive entries must stay inside the release dir: no absolute paths, no "..", no links or devices.
export function checkArchiveListing(verbose: string): string | null {
  for (const line of verbose.split("\n").filter(Boolean)) {
    const type = line[0];
    const path = line.split(/\s+/).slice(5).join(" ");
    if (type !== "-" && type !== "d") return `archive contains a link or special file: ${path}`;
    if (path.startsWith("/") || path.split("/").includes("..")) return `archive path escapes the project: ${path}`;
  }
  return null;
}

async function findProjectRoot(dir: string, depth = 0): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && /^wrangler\.jsonc?$/.test(e.name))) return dir;
  if (depth >= 2) return null;
  for (const e of entries.filter((e) => e.isDirectory() && e.name !== "node_modules")) {
    const found = await findProjectRoot(join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

// The `name` in the config must match the application: it selects the deploy prefix in the bucket.
export function configName(text: string): string | null {
  return /"name"\s*:\s*"([^"]+)"/.exec(text.replace(/^\s*\/\/.*$/gm, ""))?.[1] ?? null;
}

interface DeployCtx { id: string; releaseDir: string; previous: string | null }
const newId = () => `dep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const deploying = (app: string) => locks.has(app);

async function begin(app: App, source: string, actor: string): Promise<DeployCtx> {
  if (locks.has(app.name)) throw new DeployError(`a deployment for ${app.name} is already running`, 409);
  locks.add(app.name);
  try {
    const id = newId();
    const releaseDir = join(appDir(app.name), "releases", id);
    await mkdir(releaseDir, { recursive: true });
    const previous = (await bucket.fleetPointer(app.prefix).catch(() => null))?.value.version ?? null;
    repo.startDeployment({ id, app: app.name, kind: "deploy", source, actor, previousVersion: previous });
    return { id, releaseDir, previous };
  } catch (e) { locks.delete(app.name); throw e; }
}

function fail(app: App, ctx: DeployCtx, log: string[], actor: string, e: any): DeployError {
  log.push(e instanceof celld.CelldError || e instanceof DeployError || e instanceof SourceError ? e.message : `unexpected: ${e.message}`);
  repo.finishDeployment(ctx.id, { status: "failed", version: null, log: log.join("\n") });
  repo.writeAudit({ actor, action: "deploy", target: app.name, outcome: "failed", detail: String(e.message).slice(0, 300) });
  return e instanceof DeployError ? new DeployError(e.message, e.status) : new DeployError(e.message, e instanceof SourceError ? e.status : 422);
}

// Validate, extract and deploy one archive that is already in the release dir.
async function deployArchive(app: App, ctx: DeployCtx, archive: string, log: string[], actor: string) {
  const { id, releaseDir, previous } = ctx;
  const listing = await run(["tar", "-tvzf", archive], { timeoutMs: 30_000 });
  if (listing.code !== 0) throw new DeployError("the upload is not a readable .tar.gz archive");
  const bad = checkArchiveListing(listing.stdout);
  if (bad) throw new DeployError(bad);
  const src = join(releaseDir, "src");
  await mkdir(src);
  const x = await run(["tar", "-xzf", archive, "-C", src, "--no-same-owner", "--no-same-permissions"], { timeoutMs: 60_000 });
  if (x.code !== 0) throw new DeployError(`extract failed: ${x.stderr.slice(0, 300)}`);
  const root = await findProjectRoot(src);
  if (!root) throw new DeployError("no wrangler.jsonc or wrangler.json found in the archive");
  const cfgFile = (await readdir(root)).find((n) => /^wrangler\.jsonc?$/.test(n))!;
  const name = configName(await Bun.file(join(root, cfgFile)).text());
  if (name !== app.name) throw new DeployError(`wrangler name is "${name}" but this application is "${app.name}" — rename one so they match`);
  log.push(`Project ${root.slice(releaseDir.length + 1)} (${cfgFile})`, `Deploying to ${config.bucket}/${app.prefix}`);
  const cfgPath = join(root, cfgFile);
  const edge = fillEdgeKey(await Bun.file(cfgPath).text(), config.authPublicKeyB64);
  const mig = /"FLEETIQ_MIGRATE_TOKEN"\s*:\s*""/.test(edge.text) ? fillVar(edge.text, "FLEETIQ_MIGRATE_TOKEN", repo.migrateToken(app.name)) : { text: edge.text, filled: false };
  if (edge.filled || mig.filled) await Bun.write(cfgPath, mig.text);
  if (edge.filled) log.push("Filled AUTH_PUBLIC_KEY_B64 with this server's edge key");
  if (mig.filled) log.push("Filled FLEETIQ_MIGRATE_TOKEN (data moves enabled)");
  let cfg: any = null;
  try { cfg = parseJsonc(mig.text); } catch (e: any) { throw new DeployError(`${cfgFile} is not valid JSONC: ${e.message}`); }
  const { version, output } = await celld.deploy(app.prefix, root);
  log.push(output);
  repo.setDeploymentLog(id, log.join("\n"));
  const nodes = await reloadFleet(app, log);
  let migrateWarn: string | null = null;
  const dbs = d1WithMigrations(cfg);
  // A first deploy has no nodes yet: they start once a version exists. Give them a minute.
  let live = nodes.some((n) => n.outcome !== "unreachable");
  if (dbs.length && !live) {
    log.push("Waiting for nodes to start before applying D1 migrations");
    repo.setDeploymentLog(id, log.join("\n"));
    live = await waitForNodes(app, 90_000);
  }
  if (dbs.length && live) {
    for (const db of dbs) {
      try { log.push(`D1 ${db} migrations:`, await celld.d1Migrations(app.prefix, db, root, true)); }
      catch (e: any) { migrateWarn = `D1 migrations for ${db} failed`; log.push(`D1 ${db} migrations failed: ${e.message}`); }
    }
  } else if (dbs.length) {
    migrateWarn = "D1 migrations were not applied because no node is running; apply them from Data explorer once nodes start";
    log.push(migrateWarn);
  }
  // Keep the last successful project for D1 commands (database identity comes from its config).
  await unlink(projectDir(app.name)).catch(() => {});
  await symlink(root, projectDir(app.name));
  repo.finishDeployment(id, { status: "succeeded", version, log: log.join("\n") });
  const warn = [reloadSummary(nodes), migrateWarn].filter(Boolean).join("; ") || null;
  repo.writeAudit({ actor, action: "deploy", target: app.name, outcome: "ok", detail: `${previous ?? "none"} → ${version}${warn ? `; ${warn}` : ""}` });
  await pruneReleases(app.name, 5);
  return { ...repo.getDeployment(id)!, nodes, warning: warn };
}

// Upload of a ready archive (the console's Deploy drawer, the CLI, workiq-pack output). Synchronous.
export async function deployUpload(app: App, file: File, actor: string) {
  if (!/\.(tar\.gz|tgz)$/i.test(file.name)) throw new DeployError("upload a .tar.gz of the project directory (wrangler.jsonc at its root)");
  if (file.size > config.maxUploadBytes) throw new DeployError(`upload is larger than ${config.maxUploadBytes >> 20} MB`, 413);
  const ctx = await begin(app, file.name, actor);
  const log: string[] = [];
  try {
    const archive = join(ctx.releaseDir, "upload.tgz");
    await Bun.write(archive, file);
    return await deployArchive(app, ctx, archive, log, actor);
  } catch (e: any) { throw fail(app, ctx, log, actor, e); }
  finally { locks.delete(app.name); }
}

// Build from source in a builder container, then deploy. Returns at once with the running
// deployment; follow it at GET /api/deployments/:id (its log fills in as the build runs).
export async function deployFromSource(app: App, opts: {
  label: string; fetch: () => Promise<{ tgz: Uint8Array; commit: string | null; label: string }>;
  path: string; checks: boolean; onCommit?: (sha: string) => void;
  // Report progress somewhere outside (GitHub commit statuses); returns a log line or "".
  report?: (state: "pending" | "success" | "failure", sha: string, description: string) => Promise<string>;
}, actor: string) {
  const ctx = await begin(app, opts.label, actor);
  let sha: string | null = null;
  const report = async (state: "pending" | "success" | "failure", d: string) => { if (opts.report && sha) { const line = await opts.report(state, sha, d).catch(() => ""); if (line) log.push(line); } };
  const log: string[] = [];
  const flush = (extra = "") => repo.setDeploymentLog(ctx.id, log.join("\n") + (extra ? `\n${extra}` : ""));
  const job = (async () => {
    try {
      log.push(`Fetching ${opts.label}`); flush();
      const src = await opts.fetch();
      log.push(`Source ${src.label} (${(src.tgz.length / 1024 / 1024).toFixed(1)} MB)`);
      if (src.commit) { sha = src.commit; opts.onCommit?.(src.commit); repo.updateDeploymentSource(ctx.id, src.label); await report("pending", `Building and deploying ${app.name}`); }
      log.push(`Building in a throwaway container (${config.builderImage}${opts.checks ? "" : ", checks skipped"})`); flush();
      const files = [{ name: "src.tgz", data: src.tgz }];
      if (config.builderCaFile) files.push({ name: "ca.pem", data: new Uint8Array(await Bun.file(config.builderCaFile).arrayBuffer()) });
      const b = await runBuilder({
        image: config.builderImage, files, timeoutMs: config.buildTimeoutMs, memoryMb: config.builderMemoryMb,
        env: [`APP=${app.name}`, `SUBPATH=${opts.path.replace(/^\/+|\/+$/g, "")}`, `CHECKS=${opts.checks ? 1 : 0}`],
        onLog: (t) => flush(t.trim()),
      });
      log.push(b.logs.trim());
      if (b.exitCode !== 0 || !b.output) throw new DeployError(`build failed (exit ${b.exitCode})`);
      const archive = join(ctx.releaseDir, "build.tgz");
      await Bun.write(archive, b.output);
      log.push(`Built archive ${(b.output.length / 1024 / 1024).toFixed(1)} MB`);
      const done = await deployArchive(app, ctx, archive, log, actor);
      await report("success", `${app.name} ${done.version ?? ""} is live${done.warning ? ` (${done.warning})` : ""}`);
      if (sha && opts.report) repo.setDeploymentLog(ctx.id, log.join("\n"));
    } catch (e: any) { await report("failure", String(e.message ?? "deploy failed")); fail(app, ctx, log, actor, e); }
    finally { locks.delete(app.name); }
  })();
  void job;
  return repo.getDeployment(ctx.id)!;
}

async function pruneReleases(app: string, keep: number) {
  const dir = join(appDir(app), "releases");
  const current = await readlink(projectDir(app)).catch(() => "");
  const all = (await readdir(dir)).sort().reverse();
  for (const d of all.slice(keep)) if (!current.includes(d)) await rm(join(dir, d), { recursive: true, force: true });
}

// D1 needs a project dir. Without an uploaded project (adopted apps), synthesize a minimal config
// from the deployed manifest so database identities match what the Worker uses.
export async function ensureProjectDir(app: App): Promise<string> {
  const p = projectDir(app.name);
  if (await stat(join(p, "wrangler.jsonc")).catch(() => stat(join(p, "wrangler.json"))).catch(() => null)) return p;
  const pointer = await bucket.fleetPointer(app.prefix);
  if (!pointer) throw new DeployError(`${app.name} has no deployment yet`, 404);
  const m = await bucket.manifest(app.prefix, pointer.value.script_name ?? app.name, pointer.value.version);
  const b = bucket.bindingsOf(m);
  const dir = join(appDir(app.name), "synth");
  await mkdir(join(dir, "migrations"), { recursive: true });
  await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({
    name: app.name, compatibility_date: "2026-01-01",
    d1_databases: b.d1.map((d) => ({ binding: d.binding, database_name: d.name, database_id: d.id })),
  }, null, 2));
  return dir;
}

// Rollback = what `celld deploy` does after uploading, aimed at an existing version:
//   1. move each queue's consumer attachment to the target deployment (it pins an exact version),
//   2. move the named pointer, 3. move the fleet-wide pointer last.
// Every write is conditional (If-Match / If-None-Match), so a concurrent deploy makes this fail, not clobber.
export async function rollback(app: App, target: string, actor: string) {
  if (locks.has(app.name)) throw new DeployError(`a deployment for ${app.name} is already running`, 409);
  if (!/^[0-9a-f]{16}$/.test(target)) throw new DeployError("not a version id");
  locks.add(app.name);
  try {
    const fleet = await bucket.fleetPointer(app.prefix);
    if (!fleet) throw new DeployError("no current deployment to roll back from", 404);
    const script = fleet.value.script_name ?? app.name;
    if (fleet.value.version === target) throw new DeployError(`${target} is already live`);
    const [cur, next] = await Promise.all([bucket.manifest(app.prefix, script, fleet.value.version), bucket.manifest(app.prefix, script, target)]);
    if (!next) throw new DeployError(`version ${target} is not in the bucket`, 404);
    const named = await bucket.getJson<bucket.DeployPointer>(`${app.prefix}/deploy/${script}/current.json`);
    if (!named?.etag || !fleet.etag) throw new DeployError("the bucket did not return ETags; cannot roll back safely", 500);
    const targetPrefix = `deploy/${script}/${target}`;
    const pointer = { script_name: script, version: target, prefix: targetPrefix, rollout: { percent: 100 } };

    // Plan queue attachments before writing anything.
    const queuesOf = (m: any) => new Set<string>((m?.queue_consumers ?? []).map((c: any) => String(c.queue)));
    const desired = queuesOf(next); const previous = queuesOf(cur);
    const plan: { key: string; etag: string | null; value: any; queue: string }[] = [];
    for (const queue of new Set([...desired, ...previous])) {
      const key = `${app.prefix}/deploy/queues/${queue}/consumer.json`;
      const existing = await bucket.getJson<any>(key);
      const owner = existing?.value?.consumer ?? null;
      if (desired.has(queue)) {
        if (owner && owner.script_name !== script) throw new DeployError(`queue ${queue} is consumed by ${owner.script_name}; remove that consumer before rolling back ${script}`, 409);
        if (owner?.version === target) continue;
        plan.push({ key, etag: existing?.etag ?? null, queue, value: { schema_version: 1, queue, consumer: { script_name: script, version: target, prefix: targetPrefix } } });
      } else if (owner?.script_name === script) {
        plan.push({ key, etag: existing?.etag ?? null, queue, value: { schema_version: 1, queue } });
      }
    }

    const id = `dep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    repo.startDeployment({ id, app: app.name, kind: "rollback", source: target, actor, previousVersion: fleet.value.version });
    const log: string[] = [];
    try {
      for (const p of plan) { await bucket.putJsonIfMatch(p.key, p.value, p.etag); log.push(`Queue ${p.queue}: consumer ${p.value.consumer ? `→ ${target}` : "released"}`); }
      await bucket.putJsonIfMatch(`${app.prefix}/deploy/${script}/current.json`, pointer, named.etag);
      await bucket.putJsonIfMatch(`${app.prefix}/deploy/current.json`, pointer, fleet.etag);
    } catch (e: any) {
      log.push(e.message);
      repo.finishDeployment(id, { status: "failed", version: null, log: log.join("\n") });
      repo.writeAudit({ actor, action: "rollback", target: app.name, outcome: "failed", detail: e.message });
      throw new DeployError(e.message, e.status === 412 ? 409 : 502);
    }
    log.push(`Pointers moved ${fleet.value.version} → ${target}.`);
    const nodes = await reloadFleet(app, log);
    const warn = reloadSummary(nodes);
    repo.finishDeployment(id, { status: "succeeded", version: target, log: log.join("\n") });
    repo.writeAudit({ actor, action: "rollback", target: app.name, outcome: "ok", detail: `${fleet.value.version} → ${target}${warn ? `; ${warn}` : ""}` });
    return { ...repo.getDeployment(id)!, nodes, warning: warn };
  } finally {
    locks.delete(app.name);
  }
}
