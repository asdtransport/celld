import type { Hono } from "hono";
import * as bucket from "../adapters/bucket";
import { lbConfig, lbUpstreams } from "../adapters/caddy";
import { containerAction, containerLogs, listContainers } from "../adapters/docker";
import { frpcCreateTunnel, frpcDeleteTunnel, frpcStatus, frpsInfo, frpsProxies } from "../adapters/frp";
import { probe } from "../adapters/http";
import { config } from "../config";
import { ContainerAction, RouteUpsert, TunnelCreate } from "../contract";
import * as repo from "../lib/repo";
import { fleetOf } from "../services/fleet";
import { syncLb } from "../services/network";
import { audited, failure } from "./util";

type Hop = { id: string; label: string; status: "ok" | "degraded" | "down" | "off"; detail: string; ms?: number };

export function platformRoutes(api: Hono) {
  api.get("/api/me", (c) => { const i = c.get("identity" as never) as any; return c.json({ ...i, authMode: config.authMode }); });

  // The request path, hop by hop, measured now.
  api.get("/api/overview", async (c) => {
    const apps = repo.listApps();
    const containers = await listContainers().catch(() => null);
    const [edge, tunnels, upstreams, fleets, bucketCheck] = await Promise.all([
      config.edgeUrl ? probe(`${config.edgeUrl.replace(/\/$/, "")}/api/health`) : Promise.resolve(null),
      config.frpcApi ? frpcStatus().catch((e) => ({ error: e.message })) : Promise.resolve(null),
      lbUpstreams().catch((e) => ({ error: e.message })),
      Promise.all(apps.map((a) => fleetOf(a, { containers: containers ?? [] }).then((f) => ({ app: a.name, ...f })).catch((e) => ({ app: a.name, error: e.message })))),
      (async () => { const t0 = performance.now(); try { await bucket.list("__fleetiq_probe__/"); return { ok: true, ms: Math.round(performance.now() - t0) }; } catch (e: any) { return { ok: false, error: e.message, ms: 0 }; } })(),
    ]);
    const hops: Hop[] = [];
    hops.push(edge
      ? { id: "edge", label: "Edge", status: edge.ok && edge.status === 200 ? "ok" : edge.status ? "degraded" : "down", detail: edge.status ? `HTTP ${edge.status} from ${new URL(config.edgeUrl).host}` : edge.error ?? "unreachable", ms: edge.ms }
      : { id: "edge", label: "Edge", status: "off", detail: "EDGE_URL not set" });
    if (tunnels === null) hops.push({ id: "tunnel", label: "Tunnel", status: "off", detail: "Not used: the edge reaches the load balancer directly" });
    else if ("error" in tunnels) hops.push({ id: "tunnel", label: "Tunnel", status: "down", detail: tunnels.error });
    else {
      const up = tunnels.filter((t) => t.status === "running").length;
      hops.push({ id: "tunnel", label: "Tunnel", status: up === tunnels.length && up > 0 ? "ok" : up ? "degraded" : "down", detail: `${up} of ${tunnels.length} tunnels running` });
    }
    if ("error" in (upstreams as any)) hops.push({ id: "lb", label: "Load balancer", status: "down", detail: (upstreams as any).error });
    else {
      const u = upstreams as { address: string; fails: number }[];
      const bad = u.filter((x) => x.fails > 0).length;
      hops.push({ id: "lb", label: "Load balancer", status: !u.length ? "degraded" : bad ? "degraded" : "ok", detail: u.length ? `${u.length - bad} of ${u.length} upstreams passing` : "no upstreams — add a route" });
    }
    // Healthy = every app has what it needs: its desired count (managed) or at least one node (adopted).
    const live = fleets.reduce((n, f: any) => n + (f.live ?? 0), 0);
    const short = apps.filter((a, i) => { const l = (fleets[i] as any).live ?? 0; return a.managed ? l < a.desiredNodes : l === 0; });
    hops.push({ id: "nodes", label: "Nodes", status: !apps.length ? "off" : live === 0 ? "down" : short.length ? "degraded" : "ok",
      detail: !apps.length ? "no applications yet" : short.length ? `${short.map((a) => a.name).join(", ")} below the wanted node count` : `${live} live across ${apps.length} application${apps.length === 1 ? "" : "s"}` });
    hops.push({ id: "bucket", label: "Bucket", status: bucketCheck.ok ? "ok" : "down", detail: bucketCheck.ok ? `${config.bucket} answered` : bucketCheck.error!, ms: bucketCheck.ms });
    return c.json({
      hops, apps: fleets.map((f: any, i) => ({ app: f.app, version: f.version ?? null, live: f.live ?? 0, managed: !!apps[i]!.managed, desired: apps[i]!.desiredNodes, error: f.error })),
      containers: containers ? { running: containers.filter((x) => x.state === "running").length, total: containers.length } : null,
      activity: repo.listAudit(8), deployments: repo.listDeployments(undefined, 6),
    });
  });

  // ---- Routes (LB) ----
  api.get("/api/routes", async (c) => {
    const [ups, cfg] = await Promise.all([lbUpstreams().catch((e) => ({ error: e.message })), lbConfig().catch(() => null)]);
    const sync = await syncLbPreview();
    return c.json({ routes: repo.listRoutes(), upstreams: ups, managedByFleetIQ: !!(cfg as any)?.apps?.http?.servers?.lb, targets: sync });
  });
  api.put("/api/routes", async (c) => {
    const r = RouteUpsert.parse(await c.req.json());
    if (!repo.getApp(r.app)) return c.json({ error: `no application named ${r.app}` }, 404);
    try {
      const out = await audited(c, "route.set", r.host, async () => { repo.upsertRoute(r.host.toLowerCase(), r.app); return syncLb(); }, () => `→ ${r.app}`);
      if (!out.pushed && out.error) return c.json({ error: `saved, but the load balancer rejected the config: ${out.error}` }, 502);
      return c.json(out);
    } catch (e) { return failure(c, e); }
  });
  api.delete("/api/routes", async (c) => {
    const host = c.req.query("host"); if (!host) return c.json({ error: "host is required" }, 400);
    if (repo.listRoutes().length === 1) return c.json({ error: "this is the last route; removing it would leave the load balancer serving nothing" }, 409);
    try { const out = await audited(c, "route.remove", host, async () => { repo.deleteRoute(host); return syncLb(); }); return c.json(out); }
    catch (e) { return failure(c, e); }
  });

  // ---- Tunnels (frp) ----
  api.get("/api/tunnels", async (c) => {
    const [client, server, proxies] = await Promise.all([
      config.frpcApi ? frpcStatus().catch((e) => ({ error: e.message })) : null,
      config.frpsApi ? frpsInfo().catch((e) => ({ error: e.message })) : null,
      config.frpsApi ? frpsProxies().catch(() => null) : null,
    ]);
    return c.json({ client, server, serverProxies: proxies, defaults: { localHost: config.frpLocalHost, localPort: config.frpLocalPort } });
  });
  api.post("/api/tunnels", async (c) => {
    const t = TunnelCreate.parse(await c.req.json());
    try { const r = await audited(c, "tunnel.create", t.name, () => frpcCreateTunnel(t.name, t.localHost, t.localPort, t.remotePort), () => `${t.localHost}:${t.localPort} → edge :${t.remotePort}`); return c.json(r, 201); }
    catch (e) { return failure(c, e); }
  });
  api.delete("/api/tunnels/:name", async (c) => {
    try { await audited(c, "tunnel.remove", c.req.param("name"), () => frpcDeleteTunnel(c.req.param("name"))); return c.json({ ok: true }); }
    catch (e) { return failure(c, e); }
  });

  // ---- Edge certificate check ----
  // The edge asks before it gets an HTTPS certificate for a hostname it hasn't seen (Caddy on-demand
  // TLS). Only hostnames with a route qualify, so adding a route is all a new app needs.
  api.get("/api/edge/allow", (c) => {
    const host = (c.req.query("domain") ?? "").toLowerCase();
    const ok = /^[a-z0-9.-]{1,253}$/.test(host) && repo.listRoutes().some((r) => r.host.toLowerCase() === host);
    return ok ? c.text("ok") : c.text("no route for this hostname", 404);
  });

  // ---- Containers (stack + managed nodes) ----
  const NO_STOP = new Set(["fleetiq", "edge"]);
  api.get("/api/containers", async (c) => { try { return c.json(await listContainers()); } catch (e) { return failure(c, e); } });
  api.post("/api/containers/:id/:action", async (c) => {
    const action = ContainerAction.parse(c.req.param("action"));
    // Stopping the console or the edge from the console would lock everyone out; refuse it here too.
    if (action === "stop") {
      const id = c.req.param("id");
      const target = (await listContainers().catch(() => [])).find((x: any) => x.id === id || x.id.startsWith(id) || x.name === id);
      if (target && NO_STOP.has(target.service ?? "")) return c.json({ error: `stopping ${target.name} would cut off this console; stop it from the server instead` }, 400);
    }
    try { const r = await audited(c, `container.${action}`, c.req.param("id"), () => containerAction(c.req.param("id"), action), (x) => x.name); return c.json({ ok: true, name: r.name }); }
    catch (e) { return failure(c, e); }
  });
  api.get("/api/containers/:id/logs", async (c) => {
    try { return c.json({ logs: await containerLogs(c.req.param("id"), Math.min(Number(c.req.query("tail") ?? 200), 2000)) }); } catch (e) { return failure(c, e); }
  });

  api.get("/api/audit", (c) => c.json(repo.listAudit(Math.min(Number(c.req.query("limit") ?? 100), 500))));
}

async function syncLbPreview() {
  const { upstreamsOf } = await import("../services/fleet");
  const containers = await listContainers().catch(() => []);
  return Promise.all(repo.listRoutes().map(async (r) => {
    const app = repo.getApp(r.app);
    return { host: r.host, app: r.app, upstreams: app ? await upstreamsOf(app, containers) : [], healthPath: app?.healthPath ?? "/" };
  }));
}
