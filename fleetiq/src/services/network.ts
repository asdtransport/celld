import { lbLoad, renderLbConfig, type RouteTarget } from "../adapters/caddy";
import { listContainers } from "../adapters/docker";
import { config } from "../config";
import * as repo from "../lib/repo";
import { upstreamsOf } from "./fleet";

// Render the LB from the routes table and push it. Called on route edits, scaling, and on a timer
// (so new lease addresses of unmanaged fleets are picked up).
export async function syncLb(): Promise<{ pushed: boolean; targets: RouteTarget[]; error?: string }> {
  const routes = repo.listRoutes();
  if (!routes.length) return { pushed: false, targets: [] };
  const containers = await listContainers().catch(() => []);
  const targets: RouteTarget[] = [];
  for (const r of routes) {
    const app = repo.getApp(r.app);
    if (!app) continue;
    targets.push({ host: r.host, app: app.name, upstreams: await upstreamsOf(app, containers), healthPath: app.healthPath || "/" });
  }
  try { await lbLoad(renderLbConfig(targets)); return { pushed: true, targets }; }
  catch (e: any) { return { pushed: false, targets, error: e.message }; }
}

let lastSig = "";
export function startLbReconciler(intervalMs = 15_000) {
  const tick = async () => {
    const routes = repo.listRoutes();
    if (!routes.length) return;
    const containers = await listContainers().catch(() => []);
    const sig = JSON.stringify(await Promise.all(routes.map(async (r) => {
      const app = repo.getApp(r.app); return [r.host, app ? await upstreamsOf(app, containers) : []];
    })));
    if (sig !== lastSig) { const res = await syncLb(); if (res.pushed) lastSig = sig; }
  };
  setTimeout(tick, 2000);
  return setInterval(tick, intervalMs);
}
export const lbListen = () => config.lbListen;
