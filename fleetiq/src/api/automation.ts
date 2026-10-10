import type { Context, Hono } from "hono";
import { z } from "zod";
import { containerLogs, listContainers } from "../adapters/docker";
import { type Identity, actorOf } from "../auth";
import { config } from "../config";
import * as repo from "../lib/repo";
import { mintToken, publicToken } from "../lib/tokens";
import { DeployError, deployFromSource, deploying } from "../services/deploy";
import { fleetOf } from "../services/fleet";
import { SourceError, fetchSource, validRepo, verifyGithubSignature } from "../services/source";
import { failure, requireApp } from "./util";

const TokenCreate = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.enum(["viewer", "operator"]).default("operator"),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
});
const SourcePut = z.object({
  repo: z.string().trim().max(300).refine(validRepo, "owner/repo on GitHub, or an https URL to a .tar.gz"),
  ref: z.string().trim().min(1).max(200).default("main"),
  path: z.string().trim().max(300).regex(/^[A-Za-z0-9_./-]*$/, "a folder path inside the repo").refine((p) => !p.split("/").includes(".."), "no .. in the path").default(""),
  token: z.string().max(400).optional(),          // omitted = keep; "" = clear
  autoDeploy: z.boolean().default(false),
  checks: z.boolean().default(true),
});
const GitDeploy = z.object({
  ref: z.string().trim().min(1).max(200).optional(),
  path: z.string().trim().max(300).regex(/^[A-Za-z0-9_./-]*$/).optional(),
  checks: z.boolean().optional(),
  repo: z.string().trim().max(300).refine(validRepo).optional(),   // one-off: deploy from a repo without saving it
});

const identity = (c: Context) => c.get("identity" as never) as Identity;
const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
const consoleUrl = (c: Context) => config.publicUrl || new URL(c.req.url).origin.replace(/^http:/, c.req.header("x-forwarded-proto") === "https" ? "https:" : "http:");

const sourceView = (c: Context, app: string) => {
  const s = repo.getSource(app); if (!s) return null;
  const { token, ...rest } = s;
  return { ...rest, hasToken: !!token, autoDeploy: !!s.autoDeploy, checks: !!s.checks, webhookUrl: `${consoleUrl(c)}/hooks/github/${app}` };
};

// Wait for a running deployment (API callers that prefer one blocking call). Capped by `maxMs`.
async function waitFor(id: string, maxMs: number) {
  const until = Date.now() + maxMs;
  for (;;) {
    const d = repo.getDeployment(id)!;
    if (d.status !== "running" || Date.now() > until) return d;
    await Bun.sleep(1500);
  }
}

export function automationRoutes(api: Hono) {
  // ---- API tokens ----
  api.get("/api/tokens", (c) => {
    if (!identity(c).canOperate) return c.json({ error: "this needs the operator role" }, 403);
    return c.json(repo.listTokens().map(publicToken));
  });
  api.post("/api/tokens", async (c) => {
    // Tokens are minted by people, never by other tokens, so a leaked token can't multiply itself.
    if (identity(c).via === "token") return c.json({ error: "sign in to the console to create API tokens; a token can't create tokens" }, 403);
    const b = TokenCreate.parse(await c.req.json());
    const t = mintToken({ name: b.name, role: b.role, createdBy: actorOf(c), expiresInDays: b.expiresInDays });
    repo.writeAudit({ actor: actorOf(c), action: "token.create", target: t.id, outcome: "ok", detail: `${b.name}, ${b.role}, ${b.expiresInDays ? `${b.expiresInDays} days` : "no expiry"}` });
    return c.json({ ...publicToken(repo.getToken(t.id)!), token: t.secret, note: "Copy this token now. FleetIQ stores only its hash and can't show it again." }, 201);
  });
  api.delete("/api/tokens/:id", (c) => {
    const t = repo.getToken(c.req.param("id"));
    if (!t) return c.json({ error: "no such token" }, 404);
    repo.revokeToken(t.id);
    repo.writeAudit({ actor: actorOf(c), action: "token.revoke", target: t.id, outcome: "ok", detail: t.name });
    return c.json({ ok: true });
  });

  // ---- Git source per application ----
  api.get("/api/apps/:name/source", (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const v = sourceView(c, app.name);
    if (v && !identity(c).canOperate) return c.json({ ...v, webhookSecret: undefined });
    return c.json(v);
  });
  api.put("/api/apps/:name/source", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const b = SourcePut.parse(await c.req.json());
    const prev = repo.getSource(app.name);
    const token = b.token === undefined ? prev?.token ?? null : b.token || null;
    repo.putSource({ app: app.name, repo: b.repo, ref: b.ref, path: b.path.replace(/^\/+|\/+$/g, ""), token, autoDeploy: b.autoDeploy ? 1 : 0, checks: b.checks ? 1 : 0, webhookSecret: prev?.webhookSecret ?? randomSecret() });
    repo.writeAudit({ actor: actorOf(c), action: "source.set", target: app.name, outcome: "ok", detail: `${b.repo}@${b.ref}${b.path ? ` /${b.path}` : ""}${b.autoDeploy ? ", deploy on push" : ""}` });
    return c.json(sourceView(c, app.name));
  });
  api.post("/api/apps/:name/source/rotate-secret", (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const s = repo.getSource(app.name); if (!s) return c.json({ error: "set a Git source first" }, 404);
    repo.putSource({ ...s, webhookSecret: randomSecret() });
    repo.writeAudit({ actor: actorOf(c), action: "source.rotate-secret", target: app.name, outcome: "ok" });
    return c.json(sourceView(c, app.name));
  });
  api.delete("/api/apps/:name/source", (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    repo.deleteSource(app.name);
    repo.writeAudit({ actor: actorOf(c), action: "source.remove", target: app.name, outcome: "ok" });
    return c.json({ ok: true });
  });

  // ---- Deploy from Git / from an unbuilt source archive ----
  api.post("/api/apps/:name/deploy/git", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const b = GitDeploy.parse(await c.req.json().catch(() => ({})));
    const saved = repo.getSource(app.name);
    const src = b.repo ? { repo: b.repo, ref: b.ref ?? "main", path: b.path ?? "", token: null, checks: 1 } : saved;
    if (!src) return c.json({ error: `set ${app.name}'s Git source first (PUT /api/apps/${app.name}/source), or pass repo` }, 400);
    const ref = b.ref ?? src.ref;
    try {
      const d = await deployFromSource(app, {
        label: `${src.repo}@${ref}`, path: b.path ?? src.path, checks: b.checks ?? !!src.checks,
        fetch: () => fetchSource(src, ref),
        onCommit: (sha) => { if (!b.repo) repo.setSourceCommit(app.name, sha); },
      }, actorOf(c));
      return c.json(c.req.query("wait") ? await waitFor(d.id, 240_000) : d, 202);
    } catch (e) { return failure(c, e); }
  });
  api.post("/api/apps/:name/deploy/source", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("source");
    if (!(file instanceof File)) return c.json({ error: "attach the project source as a .tar.gz in the `source` field (node_modules not needed)" }, 400);
    if (file.size > config.maxUploadBytes) return c.json({ error: `upload is larger than ${config.maxUploadBytes >> 20} MB` }, 413);
    const data = new Uint8Array(await file.arrayBuffer());
    try {
      const d = await deployFromSource(app, {
        label: `${file.name} (source upload)`, path: String(form?.get("path") ?? ""), checks: String(form?.get("checks") ?? "true") !== "false",
        fetch: async () => ({ tgz: data, commit: null, label: file.name }),
      }, actorOf(c));
      return c.json(c.req.query("wait") ? await waitFor(d.id, 240_000) : d, 202);
    } catch (e) { return failure(c, e); }
  });
  api.get("/api/deployments/:id/wait", async (c) => {
    const d = repo.getDeployment(c.req.param("id")); if (!d) return c.json({ error: "not found" }, 404);
    return c.json(await waitFor(d.id, Math.min(Number(c.req.query("timeout") ?? 60), 240) * 1000));
  });

  // ---- Everything at a glance, for scripts and assistants ----
  api.get("/api/system", async (c) => {
    const containers = await listContainers().catch(() => []);
    const apps = await Promise.all(repo.listApps().map(async (a) => {
      const f = await fleetOf(a, { containers }).catch(() => null);
      return { name: a.name, managed: !!a.managed, desiredNodes: a.desiredNodes, liveNodes: f?.live ?? 0, version: f?.version ?? null, deploying: deploying(a.name), source: repo.getSource(a.name)?.repo ?? null, routes: repo.listRoutes().filter((r) => r.app === a.name).map((r) => r.host) };
    }));
    return c.json({
      fleetiq: { build: process.env.BUILD_SHA ?? "dev", consoleUrl: consoleUrl(c), authMode: config.authMode },
      bucket: { url: config.bucket, endpoint: config.s3Endpoint || "aws" },
      edge: { url: config.edgeUrl || null }, builder: { image: config.builderImage, memoryMb: config.builderMemoryMb, timeoutMin: config.buildTimeoutMs / 60_000, githubToken: !!config.githubToken },
      nodeImage: config.nodeImage, apps, containers: containers.map((x) => ({ name: x.name, state: x.state, app: x.app ?? x.project })),
      you: identity(c),
    });
  });
  api.get("/api/nodes", async (c) => {
    const containers = await listContainers().catch(() => []);
    try { return c.json(await Promise.all(repo.listApps().map(async (a) => ({ app: a.name, ...(await fleetOf(a, { containers, withState: c.req.query("state") === "1" })) })))); }
    catch (e) { return failure(c, e); }
  });
  api.get("/api/apps/:name/logs", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const tail = Math.min(Number(c.req.query("tail") ?? 100), 1000);
    const cs = (await listContainers().catch(() => [])).filter((x) => app.managed ? x.app === app.name && x.role === "node" : !x.app && /^node/.test(x.service ?? ""));
    if (!cs.length) return c.json({ error: `no node containers for ${app.name} on this host` }, 404);
    const out = await Promise.all(cs.map(async (x) => ({ container: x.name, state: x.state, logs: await containerLogs(x.name, tail).catch((e) => `(${e.message})`) })));
    return c.json(out);
  });
}

// GitHub push webhook: lives outside /api so it needs no session; the HMAC signature is the auth.
export function hookRoutes(app: Hono) {
  app.post("/hooks/github/:app", async (c) => {
    const name = c.req.param("app");
    const a = repo.getApp(name); const src = repo.getSource(name);
    if (!a || !src) return c.json({ error: "unknown application" }, 404);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (!(await verifyGithubSignature(src.webhookSecret, body, c.req.header("x-hub-signature-256") ?? null))) {
      repo.writeAudit({ actor: "github", action: "webhook", target: name, outcome: "denied", detail: "bad signature" });
      return c.json({ error: "bad signature" }, 401);
    }
    const event = c.req.header("x-github-event");
    if (event === "ping") return c.json({ ok: true, pong: true });
    if (event !== "push") return c.json({ ok: true, ignored: `event ${event}` });
    let p: any; try { p = JSON.parse(new TextDecoder().decode(body)); } catch { return c.json({ error: "bad JSON" }, 400); }
    if (p.ref !== `refs/heads/${src.ref}`) return c.json({ ok: true, ignored: `push to ${p.ref}, watching refs/heads/${src.ref}` });
    if (!src.autoDeploy) return c.json({ ok: true, ignored: "deploy on push is off for this application" });
    const sha = String(p.after ?? "");
    try {
      const d = await deployFromSource(a, {
        label: `${src.repo}@${sha.slice(0, 7)} (push)`, path: src.path, checks: !!src.checks,
        fetch: () => fetchSource(src, sha || src.ref), onCommit: (s) => repo.setSourceCommit(name, s),
      }, `github push by ${String(p.pusher?.name ?? "unknown").slice(0, 60)}`);
      return c.json({ ok: true, deployment: d.id }, 202);
    } catch (e: any) {
      if (e instanceof DeployError || e instanceof SourceError) return c.json({ error: e.message }, e.status as any);
      return c.json({ error: "internal" }, 500);
    }
  });
}
