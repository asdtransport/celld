import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runBuilder } from "../adapters/docker";
import { run } from "../adapters/exec";
import { config } from "../config";
import type { App, AppTarget, Target } from "../db/schema";
import * as repo from "../lib/repo";
import { DeployError, parseJsonc, projectDir } from "../services/deploy";
import { fetchSource } from "../services/source";
import { Cloudflare, CloudflareError } from "./api";
import { type CfResourceIds, resourceNeeds, toCloudflareConfig } from "./config";
import * as trepo from "./repo";

// Deploy an app to Cloudflare: the workiq-cloudflare-deploy skill's steps as one tracked job.
//   1 source: the exact project running on celld now, or a fresh build from Git
//   2 provision D1 / KV / R2 / Queues (idempotent)        3 Access app + health bypass -> AUD
//   4 config: celld wrangler -> Cloudflare wrangler       5 wrangler deploy + D1 migrations (builder)
//   6 verify from outside: health 200, gate 302 to the team domain
const locks = new Set<string>();
const credsOf = (t: Target) => JSON.parse(t.config) as { accountId: string; apiToken: string };
export const cloudflareOf = (t: Target) => new Cloudflare(credsOf(t));

async function findRoot(dir: string, depth = 0): Promise<string | null> {
  const es = await readdir(dir, { withFileTypes: true });
  if (es.some((e) => e.isFile() && /^wrangler\.jsonc?$/.test(e.name))) return dir;
  if (depth >= 2) return null;
  for (const e of es.filter((e) => e.isDirectory() && e.name !== "node_modules")) { const f = await findRoot(join(dir, e.name), depth + 1); if (f) return f; }
  return null;
}

export async function planCloudflare(app: App, link: AppTarget, target: Target) {
  const dir = projectDir(app.name);
  const cfgFile = (await readdir(dir).catch(() => [] as string[])).find((n) => /^wrangler\.jsonc?$/.test(n));
  if (!cfgFile) throw new DeployError(`${app.name} has no project on this server yet; deploy it here first, or deploy to Cloudflare from Git`, 409);
  const cfg = parseJsonc(await Bun.file(join(dir, cfgFile)).text());
  const need = resourceNeeds(app.name, cfg);
  const ids: CfResourceIds = { d1: Object.fromEntries(need.d1.map((d) => [d.name, "<d1-id>"])), kv: Object.fromEntries(need.kv.map((k) => [k.name, "<kv-id>"])) };
  const accountId = credsOf(target).accountId;
  return { need, config: toCloudflareConfig(cfg, { app: app.name, workerName: link.workerName, accountId, hostname: link.hostname, access: link.access ? { aud: link.accessAud ?? "<aud>", teamDomain: "<team>.cloudflareaccess.com" } : null }, ids) };
}

export async function deployToCloudflare(app: App, link: AppTarget, target: Target, opts: { from: "current" | "git"; ref?: string; dryRun?: boolean }, actor: string) {
  const key = `${app.name}:${target.id}`;
  if (locks.has(key)) throw new DeployError(`a Cloudflare deploy of ${app.name} is already running`, 409);
  if (link.access && !link.hostname) throw new DeployError("Cloudflare Access needs a custom hostname on one of the account's zones; set one, or turn Access off for a public workers.dev deploy", 400);
  const cf = cloudflareOf(target);
  locks.add(key);
  const id = `dep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  repo.startDeployment({ id, app: app.name, kind: "cloudflare", source: `Cloudflare ${target.name}${link.hostname ? ` → ${link.hostname}` : ""}${opts.dryRun ? " (dry run)" : ""}`, actor, previousVersion: link.lastVersion });
  const log: string[] = [];
  const flush = (extra = "") => repo.setDeploymentLog(id, log.join("\n") + (extra ? `\n${extra}` : ""));
  const say = (s: string) => { log.push(s); flush(); };
  const work = join(config.dataDir, "apps", app.name, "cloudflare", id);
  void (async () => {
    let version: string | null = null;
    try {
      await mkdir(work, { recursive: true });
      // 1. source
      let root: string;
      if (opts.from === "current") {
        root = resolve(projectDir(app.name));
        if (!(await stat(join(root)).catch(() => null))) throw new DeployError(`${app.name} has no project on this server yet; deploy it here first, or deploy from Git`, 409);
        say(`Source: the project running on celld now (${(await repo.listDeployments(app.name, 10)).find((d) => d.status === "succeeded" && d.kind === "deploy")?.version ?? "current"})`);
      } else {
        const src = repo.getSource(app.name);
        if (!src) throw new DeployError(`set ${app.name}'s Git source first`, 400);
        say(`Source: ${src.repo}@${opts.ref ?? src.ref}`);
        const s = await fetchSource(src, opts.ref);
        say(`Building ${s.label} in a throwaway container`);
        const files = [{ name: "src.tgz", data: s.tgz }];
        if (config.builderCaFile) files.push({ name: "ca.pem", data: new Uint8Array(await Bun.file(config.builderCaFile).arrayBuffer()) });
        const b = await runBuilder({ image: config.builderImage, files, timeoutMs: config.buildTimeoutMs, memoryMb: config.builderMemoryMb, env: [`APP=${app.name}`, `SUBPATH=${src.path}`, `CHECKS=${src.checks ? 1 : 0}`], onLog: (t) => flush(t.trim()) });
        log.push(b.logs.trim());
        if (b.exitCode !== 0 || !b.output) throw new DeployError(`build failed (exit ${b.exitCode})`);
        await Bun.write(join(work, "build.tgz"), b.output);
        await mkdir(join(work, "src"));
        const x = await run(["tar", "-xzf", join(work, "build.tgz"), "-C", join(work, "src"), "--no-same-owner"], { timeoutMs: 60_000 });
        if (x.code !== 0) throw new DeployError(`extract failed: ${x.stderr.slice(0, 200)}`);
        const r = await findRoot(join(work, "src")); if (!r) throw new DeployError("no wrangler.jsonc in the build");
        root = r;
      }
      const cfgFile = (await readdir(root)).find((n) => /^wrangler\.jsonc?$/.test(n));
      if (!cfgFile) throw new DeployError("no wrangler.jsonc in the project");
      const cfg = parseJsonc(await Bun.file(join(root, cfgFile)).text());

      // 2. resources
      const need = resourceNeeds(app.name, cfg);
      const ids: CfResourceIds = { d1: {}, kv: {} };
      const made: Record<string, any> = link.resources ? JSON.parse(link.resources) : {};
      if (!opts.dryRun) {
        for (const d of need.d1) { const r = await cf.ensureD1(d.name); ids.d1[d.name] = r.id; say(`D1 ${d.name}: ${r.created ? "created" : "exists"} ${r.id}`); }
        for (const k of need.kv) { const r = await cf.ensureKv(k.name); ids.kv[k.name] = r.id; say(`KV ${k.name}: ${r.created ? "created" : "exists"} ${r.id}`); }
        for (const b of need.r2) { const r = await cf.ensureR2(b.name); say(`R2 ${b.name}: ${r.created ? "created" : "exists"}`); }
        for (const q of need.queues) { const r = await cf.ensureQueue(q); say(`Queue ${q}: ${r.created ? "created" : "exists"}`); }
        Object.assign(made, { d1: ids.d1, kv: ids.kv, r2: need.r2.map((b) => b.name), queues: need.queues });
      } else {
        for (const d of need.d1) ids.d1[d.name] = "00000000-0000-0000-0000-000000000000";
        for (const k of need.kv) ids.kv[k.name] = "0".repeat(32);
        say(`Dry run: would provision D1 ${need.d1.map((d) => d.name).join(", ") || "none"}; KV ${need.kv.map((k) => k.name).join(", ") || "none"}; R2 ${need.r2.map((b) => b.name).join(", ") || "none"}; queues ${need.queues.join(", ") || "none"}`);
      }

      // 3. Access
      let access: { aud: string; teamDomain: string } | null = null;
      if (link.access && link.hostname) {
        const allow = JSON.parse(link.allow ?? "[]") as string[];
        if (opts.dryRun) { access = { aud: "0".repeat(64), teamDomain: "team.cloudflareaccess.com" }; say(`Dry run: would gate ${link.hostname} with Access for ${allow.join(", ")}, bypassing ${link.healthPath}`); }
        else {
          const a = await cf.ensureAccess({ hostname: link.hostname, name: `${app.name} (FleetIQ)`, allow, healthPath: link.healthPath });
          if (!a.teamDomain) throw new DeployError("this account has no Zero Trust team domain; set up Zero Trust, or turn Access off");
          access = { aud: a.aud, teamDomain: a.teamDomain };
          trepo.setLinkState(app.name, target.id, { accessAud: a.aud });
          made.accessAppId = a.appId;
          // FleetIQ's own way through Access, for moving data in and out of the app.
          if (/"FLEETIQ_MIGRATE_TOKEN"/.test(JSON.stringify(cfg.vars ?? {}))) {
            const st = await cf.ensureServiceToken(`fleetiq-${link.workerName}`, made.serviceToken ?? null);
            await cf.allowServiceToken(a.appId, st.id);
            made.serviceToken = { id: st.id, clientId: st.clientId, clientSecret: st.clientSecret };
            trepo.setLinkState(app.name, target.id, { resources: JSON.stringify(made) });
            say(`Access service token for FleetIQ: ${st.created ? "created" : "ready"}`);
          }
          say(`Access: ${a.created ? "created" : "found"} the app for ${link.hostname} (AUD ${a.aud.slice(0, 12)}…), allowing ${allow.join(", ")}; ${link.healthPath} bypassed`);
        }
      } else say(link.hostname ? `No Access gate on ${link.hostname}: the app is public` : "No custom hostname: deploying to workers.dev without Access (public)");

      // 4. config
      const cfCfg = toCloudflareConfig(cfg, { app: app.name, workerName: link.workerName, accountId: credsOf(target).accountId, hostname: link.hostname, access }, ids);
      await Bun.write(join(work, "wrangler.cloudflare.json"), JSON.stringify(cfCfg, null, 2));
      say(`Config: worker ${cfCfg.name}${link.hostname ? `, custom domain ${link.hostname}` : ", workers.dev"}, AUTH_MODE ${cfCfg.vars?.AUTH_MODE ?? "(app has no AUTH_MODE)"}`);

      // 5. wrangler in a builder container
      const tgz = join(work, "project.tgz");
      const t = await run(["tar", "-czf", tgz, "-C", root, "--exclude", "./.wrangler", "."], { timeoutMs: 120_000 });
      if (t.code !== 0) throw new DeployError(`packing the project failed: ${t.stderr.slice(0, 200)}`);
      const files = [{ name: "project.tgz", data: new Uint8Array(await Bun.file(tgz).arrayBuffer()) }, { name: "wrangler.cloudflare.json", data: new TextEncoder().encode(JSON.stringify(cfCfg, null, 2)) }];
      if (config.builderCaFile) files.push({ name: "ca.pem", data: new Uint8Array(await Bun.file(config.builderCaFile).arrayBuffer()) });
      const { accountId, apiToken } = credsOf(target);
      say(opts.dryRun ? "Running wrangler deploy --dry-run" : "Running wrangler deploy");
      const b = await runBuilder({
        image: config.builderImage, script: "cf-deploy.sh", outPath: null, files, timeoutMs: config.buildTimeoutMs, memoryMb: config.builderMemoryMb,
        env: [`CLOUDFLARE_API_TOKEN=${apiToken}`, `CLOUDFLARE_ACCOUNT_ID=${accountId}`, `D1_MIGRATE=${need.d1.filter((d) => d.migrations).map((d) => d.name).join(" ")}`, `DRY_RUN=${opts.dryRun ? 1 : 0}`, ...(process.env.WRANGLER_PKG ? [`WRANGLER_PKG=${process.env.WRANGLER_PKG}`] : [])],
        onLog: (txt) => flush(txt.replaceAll(apiToken, "***").trim()),
      });
      log.push(b.logs.replaceAll(apiToken, "***").trim());
      if (b.exitCode !== 0) throw new DeployError(`wrangler failed (exit ${b.exitCode})`);
      if (opts.dryRun) {
        log.push("Dry run passed: Cloudflare accepted the config shape and the Worker bundled.");
        repo.finishDeployment(id, { status: "succeeded", version: null, log: log.join("\n") });
        repo.writeAudit({ actor, action: "cloudflare.deploy", target: app.name, outcome: "ok", detail: `dry run, ${target.name}` });
        return;
      }
      version = /Current Version ID:\s*([0-9a-f-]{8,})/i.exec(b.logs)?.[1] ?? null;
      if (/"FLEETIQ_MIGRATE_TOKEN"/.test(JSON.stringify(cfg.vars ?? {}))) {
        await cf.putSecret(link.workerName, "FLEETIQ_MIGRATE_TOKEN", repo.migrateToken(app.name));
        say("Set the FLEETIQ_MIGRATE_TOKEN secret (data moves enabled)");
      }
      const devUrl = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(b.logs)?.[0] ?? null;
      const url = link.hostname ? `https://${link.hostname}` : devUrl;
      trepo.setLinkState(app.name, target.id, { resources: JSON.stringify(made), url, lastVersion: version, lastDeployAt: Math.floor(Date.now() / 1000) });

      // 6. verify from outside
      if (url) say(await verifyLive(url, link.healthPath, access?.teamDomain ?? null));
      repo.finishDeployment(id, { status: "succeeded", version, log: log.join("\n") });
      repo.writeAudit({ actor, action: "cloudflare.deploy", target: app.name, outcome: "ok", detail: `${target.name}: ${version ?? "deployed"}${url ? ` at ${url}` : ""}` });
    } catch (e: any) {
      log.push(e instanceof DeployError || e instanceof CloudflareError ? `✗ ${e.message}` : `✗ unexpected: ${e.message}`);
      repo.finishDeployment(id, { status: "failed", version, log: log.join("\n") });
      repo.writeAudit({ actor, action: "cloudflare.deploy", target: app.name, outcome: "failed", detail: String(e.message).slice(0, 300) });
    } finally {
      locks.delete(key);
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return repo.getDeployment(id)!;
}

// Gate + origin, the way the skill's cf-verify.sh does it. DNS, certificates and Access policies take
// a little while to appear, so retry for up to ~90 s before calling it.
export async function verifyLive(url: string, healthPath: string, teamDomain: string | null): Promise<string> {
  const lines: string[] = [];
  const until = Date.now() + 90_000;
  let health: Response | null = null; let body = "";
  while (Date.now() < until) {
    health = await fetch(url + healthPath, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
    body = health ? await health.text().catch(() => "") : "";
    if (health?.status === 200) break;
    await Bun.sleep(5000);
  }
  lines.push(health?.status === 200 && /"ok"\s*:\s*true/.test(body) ? `Verify: ${healthPath} 200 ${body.slice(0, 80)}` : `Verify: ${healthPath} answered ${health?.status ?? "nothing"} ${body.slice(0, 80)} (DNS or certificate may still be propagating)`);
  if (teamDomain) {
    const g = await fetch(url + "/", { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const loc = g?.headers.get("location") ?? "";
    lines.push(g && (g.status === 302 || g.status === 303) && loc.includes(teamDomain) ? `Verify: / redirects to ${teamDomain} sign-in (the gate is on)` : `Verify: / answered ${g?.status ?? "nothing"}${loc ? ` → ${loc.slice(0, 80)}` : ""}; expected a redirect to ${teamDomain}`);
  }
  return lines.join("\n");
}
