import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { actorOf } from "../auth";
import { run } from "../adapters/exec";
import { config } from "../config";
import { getDb } from "../db/runtime";
import { evidenceExports } from "../db/schema";
import * as repo from "../lib/repo";
import { evidence, evidenceHtml, posture } from "../compliance/controls";
import { PolicySchema, WaiverIn, addWaiver, getPolicy, listWaivers, revokeWaiver, setPolicy } from "../compliance/policy";
import { getScan, listScans, projectRootIn, reevaluate, runScan, setScanVersion } from "../compliance/scan";
import { projectDir } from "../services/deploy";
import { SourceError, fetchSource } from "../services/source";
import { requireApp } from "./util";

const scanView = (s: NonNullable<ReturnType<typeof getScan>>, full = false) => ({
  id: s.id, app: s.app, deployment: s.deployment, version: s.version, trigger: s.trigger, source: s.source, sourceKind: s.sourceKind, commit: s.commitSha,
  status: s.status, actor: s.actor, createdAt: s.createdAt,
  summary: s.summary ? JSON.parse(s.summary) : null, gate: s.gate ? JSON.parse(s.gate) : null,
  ...(full ? { findings: s.findings ? JSON.parse(s.findings) : null, now: reevaluate(s) } : {}),
});

const busy = new Set<string>();

export function complianceRoutes(api: Hono) {
  api.get("/api/compliance", (c) => c.json({ ...posture(), waivers: listWaivers().length }));

  api.get("/api/compliance/policy", (c) => c.json(getPolicy()));
  api.put("/api/compliance/policy", async (c) => {
    const b = PolicySchema.partial().parse(await c.req.json());
    const before = getPolicy();
    const next = setPolicy(b, actorOf(c));
    const changed = Object.keys(b).filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify((next as any)[k]));
    repo.writeAudit({ actor: actorOf(c), action: "policy.update", target: "compliance policy", outcome: "ok", detail: changed.map((k) => `${k}: ${JSON.stringify((before as any)[k])} → ${JSON.stringify((next as any)[k])}`).join("; ").slice(0, 900) || "no change" });
    return c.json(next);
  });

  api.get("/api/compliance/scans", (c) => c.json(listScans(c.req.query("app") || undefined, Math.min(Number(c.req.query("limit") ?? 50), 200)).map((s) => scanView(s))));
  api.get("/api/compliance/scans/:id", (c) => { const s = getScan(c.req.param("id")); return s ? c.json(scanView(s, true)) : c.json({ error: "no such scan" }, 404); });
  api.get("/api/compliance/scans/:id/sbom", (c) => {
    const s = getScan(c.req.param("id")); if (!s?.sbom) return c.json({ error: "no SBOM for this scan" }, 404);
    return new Response(s.sbom, { headers: { "content-type": "application/vnd.cyclonedx+json", "content-disposition": `attachment; filename="${s.app}-${(s.commitSha ?? s.version ?? s.id).slice(0, 12)}.cdx.json"` } });
  });

  // Scan without deploying: the Git source (default when set) or the project running here.
  api.post("/api/apps/:name/scan", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    // multipart with a `source` .tar.gz = scan that (the CLI's `fleetiq scan`, CI pre-checks)
    const form = (c.req.header("content-type") ?? "").includes("multipart/form-data") ? await c.req.formData().catch(() => null) : null;
    const upload = form?.get("source");
    const b = form ? { from: "upload" as const, ref: undefined } : z.object({ from: z.enum(["git", "current"]).optional(), ref: z.string().trim().max(200).optional() }).parse(await c.req.json().catch(() => ({})));
    const src = repo.getSource(app.name);
    const from = b.from ?? (src ? "git" : "current");
    if (form && !(upload instanceof File)) return c.json({ error: "attach the project as a .tar.gz in the `source` field" }, 400);
    if (busy.has(app.name)) return c.json({ error: `a scan of ${app.name} is already running` }, 409);
    busy.add(app.name);
    const tmp = join(config.dataDir, "tmp", `scan-${Date.now().toString(36)}`);
    try {
      let root: string; let label: string; let commit: string | null = null;
      if (from === "upload") {
        const f = upload as File;
        if (f.size > config.maxUploadBytes) return c.json({ error: "upload too large" }, 413);
        await mkdir(join(tmp, "x"), { recursive: true });
        await Bun.write(join(tmp, "src.tgz"), f);
        const x = await run(["tar", "-xzf", join(tmp, "src.tgz"), "-C", join(tmp, "x"), "--no-same-owner", "--no-same-permissions"], { timeoutMs: 60_000 });
        if (x.code !== 0) return c.json({ error: "could not read the uploaded archive" }, 400);
        root = await projectRootIn(join(tmp, "x"), String(form?.get("path") ?? "")); label = `${String(form?.get("label") ?? "") || f.name} (upload)`;
      } else if (from === "git") {
        if (!src) return c.json({ error: `${app.name} has no Git source; scan the current project instead` }, 400);
        const s = await fetchSource(src, b.ref);
        await mkdir(tmp, { recursive: true });
        await Bun.write(join(tmp, "src.tgz"), s.tgz);
        await mkdir(join(tmp, "x"));
        const x = await run(["tar", "-xzf", join(tmp, "src.tgz"), "-C", join(tmp, "x"), "--no-same-owner", "--no-same-permissions"], { timeoutMs: 60_000 });
        if (x.code !== 0) return c.json({ error: "could not read the source archive" }, 502);
        root = await projectRootIn(join(tmp, "x"), src.path); label = s.label; commit = s.commit;
      } else {
        root = await realpath(projectDir(app.name)).catch(() => "");
        if (!root || !(await stat(root).catch(() => null))) return c.json({ error: `${app.name} has no project on this server yet` }, 409);
        label = "the project running here";
      }
      const r = await runScan(root, { app: app.name, trigger: "manual", ctx: { sourceKind: from === "git" ? "git" : from === "upload" ? "upload" : "current", branch: from === "git" ? b.ref ?? src?.ref ?? null : null }, source: label, commit, actor: actorOf(c) });
      if (from === "current") {
        const live = repo.listDeployments(app.name, 20).find((d) => d.status === "succeeded" && (d.kind === "deploy" || d.kind === "rollback"));
        if (live?.version) setScanVersion(r.scan.id, live.version); // the scan describes the running version
      }
      repo.writeAudit({ actor: actorOf(c), action: "scan", target: app.name, outcome: "ok", detail: `${r.gate.decision}: ${r.summary.vulns.critical} critical, ${r.summary.vulns.high} high, ${r.summary.secrets} secrets` });
      return c.json(scanView(getScan(r.scan.id)!, true), 201);
    } catch (e: any) {
      if (e instanceof SourceError) return c.json({ error: e.message }, e.status as any);
      throw e;
    } finally { busy.delete(app.name); await rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  });

  api.get("/api/compliance/waivers", (c) => c.json(listWaivers(c.req.query("all") === "1")));
  api.post("/api/compliance/waivers", async (c) => {
    const w = addWaiver(WaiverIn.parse(await c.req.json()), actorOf(c));
    repo.writeAudit({ actor: actorOf(c), action: "waiver.create", target: `${w.app}: ${w.kind} ${w.ref}`, outcome: "ok", detail: `${w.reason.slice(0, 300)} (until ${new Date((w.expiresAt ?? 0) * 1000).toISOString().slice(0, 10)})` });
    return c.json(w, 201);
  });
  api.delete("/api/compliance/waivers/:id", (c) => {
    const ok = revokeWaiver(c.req.param("id"), actorOf(c));
    if (!ok) return c.json({ error: "no such active waiver" }, 404);
    repo.writeAudit({ actor: actorOf(c), action: "waiver.revoke", target: c.req.param("id"), outcome: "ok" });
    return c.json({ ok: true });
  });

  // Evidence for an audit period: JSON (machine-readable, hashed) or a printable report.
  api.get("/api/compliance/evidence", (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 90), 1), 730);
    const to = c.req.query("to") ? Math.floor(Date.parse(c.req.query("to")!) / 1000) : Math.floor(Date.now() / 1000);
    const from = c.req.query("from") ? Math.floor(Date.parse(c.req.query("from")!) / 1000) : to - days * 86_400;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return c.json({ error: "bad period" }, 400);
    const e = evidence(from, to);
    const format = c.req.query("format") === "html" ? "html" : "json";
    const id = `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    getDb().insert(evidenceExports).values({ id, periodFrom: from, periodTo: to, sha256: e.integrity.digest, format, createdBy: actorOf(c) }).run();
    repo.writeAudit({ actor: actorOf(c), action: "evidence.export", target: `${e.period.from.slice(0, 10)} to ${e.period.to.slice(0, 10)}`, outcome: "ok", detail: `${format}, sha256 ${e.integrity.digest.slice(0, 16)}…` });
    const name = `fleetiq-evidence-${e.period.from.slice(0, 10)}-to-${e.period.to.slice(0, 10)}`;
    if (format === "html") return new Response(evidenceHtml(e), { headers: { "content-type": "text/html; charset=utf-8", ...(c.req.query("download") ? { "content-disposition": `attachment; filename="${name}.html"` } : {}) } });
    return new Response(JSON.stringify(e, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${name}.json"` } });
  });
  api.get("/api/compliance/exports", (c) => c.json(getDb().select().from(evidenceExports).all().sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)));
}
