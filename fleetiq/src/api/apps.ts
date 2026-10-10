import type { Hono } from "hono";
import * as bucket from "../adapters/bucket";
import { diagnose, listCells } from "../adapters/celld";
import { createNode, listContainers, nodeContainerName, removeNode } from "../adapters/docker";
import { actorOf } from "../auth";
import { config } from "../config";
import { AppCreate, AppPatch, Rollback, Scale } from "../contract";
import * as repo from "../lib/repo";
import { deployUpload, rollback } from "../services/deploy";
import { fleetOf } from "../services/fleet";
import { syncLb } from "../services/network";
import { audited, failure, requireApp } from "./util";

export function appRoutes(api: Hono) {
  api.get("/api/apps", async (c) => {
    const containers = await listContainers().catch(() => []);
    const rows = await Promise.all(repo.listApps().map(async (a) => {
      const f = await fleetOf(a, { containers }).catch(() => null);
      const last = repo.listDeployments(a.name, 1)[0] ?? null;
      return { ...a, managed: !!a.managed, version: f?.version ?? null, liveNodes: f?.live ?? 0, totalNodes: f?.nodes.length ?? 0, lastDeployment: last };
    }));
    return c.json(rows);
  });

  api.post("/api/apps", async (c) => {
    const body = AppCreate.parse(await c.req.json());
    if (repo.getApp(body.name)) return c.json({ error: `${body.name} already exists` }, 409);
    const app = repo.createApp({
      name: body.name, prefix: body.name, description: body.description ?? null, managed: body.managed ? 1 : 0,
      desiredNodes: body.desiredNodes, nodeImage: body.nodeImage ?? null, healthPath: body.healthPath, createdBy: actorOf(c),
    });
    repo.writeAudit({ actor: actorOf(c), action: "app.create", target: app.name, outcome: "ok", detail: body.managed ? `managed, ${body.desiredNodes} nodes` : "adopted (nodes run elsewhere)" });
    return c.json(app, 201);
  });

  api.get("/api/apps/:name", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try {
      const fleet = await fleetOf(app, { withState: true });
      const m = fleet.version ? await bucket.manifest(app.prefix, fleet.script, fleet.version) : null;
      return c.json({ app: { ...app, managed: !!app.managed }, fleet, bindings: bucket.bindingsOf(m), routes: repo.listRoutes().filter((r) => r.app === app.name) });
    } catch (e) { return failure(c, e); }
  });

  api.patch("/api/apps/:name", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const patch = AppPatch.parse(await c.req.json());
    const updated = repo.updateApp(app.name, patch);
    repo.writeAudit({ actor: actorOf(c), action: "app.update", target: app.name, outcome: "ok", detail: Object.keys(patch).join(", ") });
    if (patch.healthPath) await syncLb();
    return c.json(updated);
  });

  api.delete("/api/apps/:name", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    if (repo.listRoutes().some((r) => r.app === app.name)) return c.json({ error: "remove this application's routes first" }, 409);
    const nodes = (await listContainers().catch(() => [])).filter((x) => x.app === app.name);
    if (nodes.length) return c.json({ error: `scale ${app.name} to 0 nodes first (${nodes.length} running)` }, 409);
    repo.deleteApp(app.name);
    repo.writeAudit({ actor: actorOf(c), action: "app.remove", target: app.name, outcome: "ok", detail: "registry entry removed; bucket data kept" });
    return c.json({ ok: true });
  });

  api.get("/api/apps/:name/diagnose", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try { return c.json(await diagnose(app.prefix)); } catch (e) { return failure(c, e); }
  });

  api.get("/api/apps/:name/versions", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try {
      const p = await bucket.fleetPointer(app.prefix);
      return c.json(p ? await bucket.versions(app.prefix, p.value.script_name ?? app.name) : []);
    } catch (e) { return failure(c, e); }
  });

  api.get("/api/apps/:name/deployments", (c) => c.json(repo.listDeployments(c.req.param("name"), 30)));
  api.get("/api/deployments/:id", (c) => { const d = repo.getDeployment(c.req.param("id")); return d ? c.json(d) : c.json({ error: "not found" }, 404); });

  api.post("/api/apps/:name/deploy", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("bundle");
    if (!(file instanceof File)) return c.json({ error: "attach the project as a .tar.gz in the `bundle` field" }, 400);
    try { return c.json(await deployUpload(app, file, actorOf(c)), 201); } catch (e) { return failure(c, e); }
  });

  api.post("/api/apps/:name/rollback", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    const { version } = Rollback.parse(await c.req.json());
    try { return c.json(await rollback(app, version, actorOf(c))); } catch (e) { return failure(c, e); }
  });

  // Scale managed fleets: add nodes in index order, remove from the highest index (celld drains on SIGTERM).
  api.post("/api/apps/:name/scale", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    if (!app.managed) return c.json({ error: `${app.name}'s nodes run outside FleetIQ; scale them where they are defined` }, 409);
    const { nodes } = Scale.parse(await c.req.json());
    try {
      const result = await audited(c, "app.scale", app.name, async () => {
        const mine = (await listContainers()).filter((x) => x.app === app.name && x.role === "node");
        const have = new Set(mine.map((x) => x.name));
        const created: string[] = []; const removed: string[] = [];
        for (let i = 1; i <= nodes; i++) if (!have.has(nodeContainerName(app.name, i))) created.push(await createNode(app.name, app.prefix, i, app.nodeImage || config.nodeImage));
        for (const x of mine.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
          const idx = Number(x.name.split("-node-")[1]);
          if (idx > nodes) { await removeNode(x.name); removed.push(x.name); }
        }
        return { created, removed };
      }, (r) => `→ ${nodes} nodes (+${r.created.length} −${r.removed.length})`);
      repo.updateApp(app.name, { desiredNodes: nodes });
      const lb = await syncLb();
      return c.json({ ...result, lb });
    } catch (e) { return failure(c, e); }
  });

  api.get("/api/apps/:name/cells", async (c) => {
    const { app, res } = requireApp(c); if (!app) return res;
    try { return c.json(await listCells(app.prefix)); } catch (e) { return failure(c, e); }
  });
}
