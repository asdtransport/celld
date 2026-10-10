import type { Context, Hono } from "hono";
import { z } from "zod";
import { actorOf } from "../auth";
import { Cloudflare, CloudflareError } from "../cloudflare/api";
import { cloudflareOf, deployToCloudflare, planCloudflare, verifyLive } from "../cloudflare/deploy";
import * as trepo from "../cloudflare/repo";
import * as repo from "../lib/repo";
import { DeployError } from "../services/deploy";
import { SourceError } from "../services/source";

const TargetIn = z.object({
  name: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/),
  provider: z.literal("cloudflare").default("cloudflare"),
  accountId: z.string().trim().regex(/^[0-9a-f]{32}$/i, "32 hex characters"),
  apiToken: z.string().trim().min(20),
});
const LinkIn = z.object({
  workerName: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
  hostname: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "a hostname such as app.example.com").nullable().default(null),
  access: z.boolean().default(true),
  allow: z.array(z.string().trim().regex(/^([^@\s]+@[^@\s]+\.[^@\s]+|@[^@\s]+\.[^@\s]+)$/, "an email, or @domain.com for everyone at a domain")).max(50).default([]),
  healthPath: z.string().startsWith("/").default("/api/health"),
});
const DeployIn = z.object({ from: z.enum(["current", "git"]).default("current"), ref: z.string().max(200).optional(), dryRun: z.boolean().default(false) });

const tid = () => `tgt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const targetView = (t: NonNullable<ReturnType<typeof trepo.getTarget>>) => {
  const c = JSON.parse(t.config);
  return { id: t.id, name: t.name, provider: t.provider, accountId: c.accountId, apiToken: c.apiToken ? `••••${String(c.apiToken).slice(-4)}` : "", apps: trepo.linksForTarget(t.id).map((l) => l.app), createdBy: t.createdBy, createdAt: t.createdAt };
};
const linkView = (l: NonNullable<ReturnType<typeof trepo.getLink>>) => ({ ...l, access: !!l.access, allow: l.allow ? JSON.parse(l.allow) : [], resources: l.resources ? JSON.parse(l.resources) : null, targetName: trepo.getTarget(l.target)?.name ?? l.target });
function err(c: Context, e: unknown) {
  if (e instanceof CloudflareError || e instanceof DeployError || e instanceof SourceError) return c.json({ error: e.message }, e.status as any);
  throw e;
}

export function targetRoutes(api: Hono) {
  api.get("/api/targets", (c) => c.json(trepo.listTargets().map(targetView)));
  api.post("/api/targets", async (c) => {
    const b = TargetIn.parse(await c.req.json());
    if (trepo.getTarget(b.name)) return c.json({ error: `a target named ${b.name} exists` }, 409);
    try {
      const pre = await new Cloudflare({ accountId: b.accountId, apiToken: b.apiToken }).preflight();
      if (!pre.account) return c.json({ error: `Cloudflare refused the token for this account: ${pre.checks[0]?.detail}`, preflight: pre }, 400);
      const t = { id: tid(), name: b.name, provider: "cloudflare", config: JSON.stringify({ accountId: b.accountId, apiToken: b.apiToken }), createdBy: actorOf(c) };
      trepo.insertTarget(t);
      repo.writeAudit({ actor: actorOf(c), action: "target.create", target: b.name, outcome: "ok", detail: `Cloudflare ${pre.account}` });
      return c.json({ ...targetView(trepo.getTarget(t.id)!), preflight: pre }, 201);
    } catch (e) { return err(c, e); }
  });
  api.post("/api/targets/:id/preflight", async (c) => {
    const t = trepo.getTarget(c.req.param("id")); if (!t) return c.json({ error: "no such target" }, 404);
    try { return c.json(await cloudflareOf(t).preflight()); } catch (e) { return err(c, e); }
  });
  api.patch("/api/targets/:id", async (c) => {
    const t = trepo.getTarget(c.req.param("id")); if (!t) return c.json({ error: "no such target" }, 404);
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), apiToken: z.string().trim().min(20).optional() }).parse(await c.req.json());
    const cfg = JSON.parse(t.config); if (b.apiToken) cfg.apiToken = b.apiToken;
    trepo.updateTarget(t.id, { name: b.name ?? t.name, config: JSON.stringify(cfg) });
    repo.writeAudit({ actor: actorOf(c), action: "target.update", target: t.name, outcome: "ok", detail: b.apiToken ? "token replaced" : "renamed" });
    return c.json(targetView(trepo.getTarget(t.id)!));
  });
  api.delete("/api/targets/:id", (c) => {
    const t = trepo.getTarget(c.req.param("id")); if (!t) return c.json({ error: "no such target" }, 404);
    const used = trepo.linksForTarget(t.id); if (used.length) return c.json({ error: `used by ${used.map((l) => l.app).join(", ")}; unlink those apps first` }, 409);
    trepo.deleteTarget(t.id);
    repo.writeAudit({ actor: actorOf(c), action: "target.remove", target: t.name, outcome: "ok", detail: "Cloudflare resources were not touched" });
    return c.json({ ok: true });
  });

  // ---- per application ----
  api.get("/api/apps/:name/targets", (c) => c.json(trepo.linksForApp(c.req.param("name")).map(linkView)));
  api.put("/api/apps/:name/targets/:target", async (c) => {
    const app = repo.getApp(c.req.param("name")); if (!app) return c.json({ error: "no such application" }, 404);
    const t = trepo.getTarget(c.req.param("target")); if (!t) return c.json({ error: "no such target" }, 404);
    const b = LinkIn.parse(await c.req.json());
    if (b.access && !b.hostname) return c.json({ error: "Access needs a custom hostname on one of the account's zones; add one, or set access to false for a public workers.dev deploy" }, 400);
    if (b.access && !b.allow.length) return c.json({ error: "list who Access lets in: emails, or @domain.com" }, 400);
    trepo.putLink({ app: app.name, target: t.id, workerName: b.workerName ?? app.name, hostname: b.hostname, access: b.access ? 1 : 0, allow: JSON.stringify(b.allow), healthPath: b.healthPath });
    repo.writeAudit({ actor: actorOf(c), action: "target.link", target: app.name, outcome: "ok", detail: `${t.name}${b.hostname ? ` → ${b.hostname}` : " → workers.dev"}${b.access ? ", Access" : ", public"}` });
    return c.json(linkView(trepo.getLink(app.name, t.id)!));
  });
  api.delete("/api/apps/:name/targets/:target", (c) => {
    const t = trepo.getTarget(c.req.param("target")); if (!t) return c.json({ error: "no such target" }, 404);
    trepo.deleteLink(c.req.param("name"), t.id);
    repo.writeAudit({ actor: actorOf(c), action: "target.unlink", target: c.req.param("name"), outcome: "ok", detail: `${t.name}; the Worker on Cloudflare keeps running` });
    return c.json({ ok: true });
  });
  api.get("/api/apps/:name/targets/:target/plan", async (c) => {
    const app = repo.getApp(c.req.param("name")); const t = trepo.getTarget(c.req.param("target"));
    const l = app && t ? trepo.getLink(app.name, t.id) : null; if (!app || !t || !l) return c.json({ error: "link the application to this target first" }, 404);
    try { return c.json(await planCloudflare(app, l, t)); } catch (e) { return err(c, e); }
  });
  api.post("/api/apps/:name/targets/:target/deploy", async (c) => {
    const app = repo.getApp(c.req.param("name")); const t = trepo.getTarget(c.req.param("target"));
    const l = app && t ? trepo.getLink(app.name, t.id) : null; if (!app || !t || !l) return c.json({ error: "link the application to this target first" }, 404);
    const b = DeployIn.parse(await c.req.json().catch(() => ({})));
    try { return c.json(await deployToCloudflare(app, l, t, b, actorOf(c)), 202); } catch (e) { return err(c, e); }
  });
  api.post("/api/apps/:name/targets/:target/verify", async (c) => {
    const app = repo.getApp(c.req.param("name")); const t = trepo.getTarget(c.req.param("target"));
    const l = app && t ? trepo.getLink(app.name, t.id) : null; if (!app || !t || !l) return c.json({ error: "link the application to this target first" }, 404);
    if (!l.url) return c.json({ error: "not deployed to this target yet" }, 409);
    const team = l.access ? await cloudflareOf(t).teamDomain().catch(() => null) : null;
    return c.json({ url: l.url, result: await verifyLive(l.url, l.healthPath, team) });
  });
}
