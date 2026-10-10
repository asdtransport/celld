// Node operator API (internal listener). /state is alpha in celld — read defensively.
export interface NodeState {
  version: string | null; owned: number; resident: number; rssBytes: number; cpuPercent: number;
  capacityWaiting: number; pressured: boolean; draining: boolean; cells: string[]; websockets: number;
}
export function parseState(s: any): NodeState {
  const load = s?.node_load ?? {};
  return {
    version: s?.deployment?.version ?? null,
    owned: Number(s?.owned_cells ?? load.owned_cells ?? 0),
    resident: Number(load.resident_cells ?? s?.occupied ?? 0),
    rssBytes: Number(load.rss_bytes ?? 0),
    cpuPercent: Number(load.cpu_percent_x100 ?? 0) / 100,
    capacityWaiting: Number(s?.capacity_waiting ?? 0),
    pressured: !!load.pressured, draining: !!load.draining,
    cells: Object.keys(s?.deployment?.cells ?? {}),
    websockets: Number(load.host_websockets ?? 0),
  };
}
export async function nodeState(addr: string): Promise<NodeState | { error: string }> {
  try {
    const r = await fetch(`http://${addr}/state`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return parseState(await r.json());
  } catch (e: any) { return { error: e.message }; }
}

// POST /reload on the internal listener: adopt the pointer's deployment now (forced, so a version that
// failed earlier is retried). Returns each node's outcome: adopted | unchanged | failed | unreachable.
export interface ReloadResult { addr: string; outcome: string; version?: string; error?: string }
export async function reloadNode(addr: string): Promise<ReloadResult> {
  try {
    const r = await fetch(`http://${addr}/reload`, { method: "POST", signal: AbortSignal.timeout(60_000) });
    const j: any = await r.json().catch(() => ({}));
    return { addr, outcome: j.outcome ?? (r.ok ? "adopted" : "failed"), version: j.version, error: j.error };
  } catch (e: any) { return { addr, outcome: "unreachable", error: e.message }; }
}
