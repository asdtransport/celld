import * as bucket from "../adapters/bucket";
import { type ContainerSummary, listContainers } from "../adapters/docker";
import { type NodeState, nodeState } from "../adapters/nodes";
import type { App } from "../db/schema";

export interface FleetNode {
  id: string; addr: string; fresh: boolean; expiresInMs: number; ensemble: string[];
  state: NodeState | { error: string } | null; container: ContainerSummary | null;
}

export async function fleetOf(app: App, opts: { withState?: boolean; containers?: ContainerSummary[] } = {}) {
  const now = Date.now();
  const [pointer, leases, containers] = await Promise.all([
    bucket.fleetPointer(app.prefix).catch(() => null),
    bucket.nodeLeases(app.prefix).catch(() => [] as bucket.NodeLease[]),
    opts.containers ? Promise.resolve(opts.containers) : listContainers().catch(() => [] as ContainerSummary[]),
  ]);
  const mine = containers.filter((c) => c.app === app.name);
  // Leases expired for more than 5 minutes belong to nodes that left (scale-down, replaced); drop them.
  const recent = leases.filter((l) => now - l.expires_ms < 5 * 60_000);
  const nodes: FleetNode[] = await Promise.all(recent.map(async (l) => {
    const fresh = l.expires_ms > now;
    const host = l.addr.split(":")[0];
    return {
      id: l.node, addr: l.addr, fresh, expiresInMs: l.expires_ms - now, ensemble: l.log?.ensemble ?? [],
      state: opts.withState && fresh ? await nodeState(l.addr) : null,
      container: mine.find((c) => c.name === host) ?? containers.find((c) => c.service === host || c.name.endsWith(`-${host}-1`)) ?? null,
    };
  }));
  nodes.sort((a, b) => Number(b.fresh) - Number(a.fresh) || a.addr.localeCompare(b.addr));
  return {
    version: pointer?.value.version ?? null, script: pointer?.value.script_name ?? app.name,
    nodes, live: nodes.filter((n) => n.fresh).length, managedContainers: mine,
  };
}

// Upstream dial addresses for the LB: managed containers by name, otherwise the lease host on the worker port.
export async function upstreamsOf(app: App, containers?: ContainerSummary[]): Promise<string[]> {
  if (app.managed) {
    const cs = (containers ?? await listContainers().catch(() => [])).filter((c) => c.app === app.name && c.role === "node" && c.state === "running");
    return cs.map((c) => `${c.name}:8787`).sort();
  }
  const leases = await bucket.nodeLeases(app.prefix).catch(() => []);
  return [...new Set(leases.filter((l) => l.expires_ms > Date.now()).map((l) => `${l.addr.split(":")[0]}:8787`))].sort();
}
