import { mkdir, readdir, rm, stat, symlink, unlink, writeFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as bucket from "../adapters/bucket";
import * as celld from "../adapters/celld";
import { run } from "../adapters/exec";
import { type ReloadResult, reloadNode } from "../adapters/nodes";
import { config } from "../config";
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
const reloadSummary = (rs: ReloadResult[]) => {
  const bad = rs.filter((r) => r.outcome === "failed" || r.outcome === "unreachable");
  return bad.length ? `${bad.length} of ${rs.length} nodes did not adopt it` : null;
};

export class DeployError extends Error { constructor(m: string, public status = 400) { super(m); } }

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

export async function deployUpload(app: App, file: File, actor: string) {
  if (locks.has(app.name)) throw new DeployError(`a deployment for ${app.name} is already running`, 409);
  if (!/\.(tar\.gz|tgz)$/i.test(file.name)) throw new DeployError("upload a .tar.gz of the project directory (wrangler.jsonc at its root)");
  if (file.size > config.maxUploadBytes) throw new DeployError(`upload is larger than ${config.maxUploadBytes >> 20} MB`, 413);
  locks.add(app.name);
  const id = `dep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const releaseDir = join(appDir(app.name), "releases", id);
  const previous = (await bucket.fleetPointer(app.prefix).catch(() => null))?.value.version ?? null;
  repo.startDeployment({ id, app: app.name, kind: "deploy", source: file.name, actor, previousVersion: previous });
  const log: string[] = [];
  try {
    await mkdir(releaseDir, { recursive: true });
    const archive = join(releaseDir, "upload.tgz");
    await Bun.write(archive, file);
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
    const { version, output } = await celld.deploy(app.prefix, root);
    log.push(output);
    const nodes = await reloadFleet(app, log);
    // Keep the last successful project for D1 commands (database identity comes from its config).
    await unlink(projectDir(app.name)).catch(() => {});
    await symlink(root, projectDir(app.name));
    repo.finishDeployment(id, { status: "succeeded", version, log: log.join("\n") });
    const warn = reloadSummary(nodes);
    repo.writeAudit({ actor, action: "deploy", target: app.name, outcome: "ok", detail: `${previous ?? "none"} → ${version}${warn ? `; ${warn}` : ""}` });
    await pruneReleases(app.name, 5);
    return { ...repo.getDeployment(id)!, nodes, warning: warn };
  } catch (e: any) {
    log.push(e instanceof celld.CelldError || e instanceof DeployError ? e.message : `unexpected: ${e.message}`);
    repo.finishDeployment(id, { status: "failed", version: null, log: log.join("\n") });
    repo.writeAudit({ actor, action: "deploy", target: app.name, outcome: "failed", detail: e.message.slice(0, 300) });
    if (e instanceof DeployError) throw new DeployError(e.message, e.status);
    throw new DeployError(e.message, 422);
  } finally {
    locks.delete(app.name);
  }
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
