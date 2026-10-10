import { config } from "../config";
import { UpstreamError, basic } from "./http";

// frpc admin API at the site (tunnels this site exposes) and, if reachable, frps on the edge.
async function call<T>(baseUrl: string, user: string, pass: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!baseUrl) throw new UpstreamError("not configured", 0);
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { ...basic(user, pass), "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(6000) })
    .catch((e) => { throw new UpstreamError(e.message); });
  const t = await r.text();
  if (!r.ok) throw new UpstreamError(`${path}: ${r.status} ${t.slice(0, 200)}`, r.status);
  return (t ? JSON.parse(t) : null) as T;
}
const frpc = <T>(path: string, init?: RequestInit) => call<T>(config.frpcApi, config.frpcUser, config.frpcPass, path, init);
const frps = <T>(path: string, init?: RequestInit) => call<T>(config.frpsApi, config.frpsUser, config.frpsPass, path, init);

export interface TunnelStatus { name: string; type: string; status: string; err: string; local_addr: string; remote_addr: string; source: string }

export async function frpcStatus(): Promise<TunnelStatus[]> {
  const s = await frpc<Record<string, any[]>>("/api/status");
  return Object.values(s ?? {}).flat().map((p: any) => ({
    name: p.name, type: p.type, status: p.status, err: p.err ?? "", local_addr: p.local_addr ?? "", remote_addr: p.remote_addr ?? "", source: p.source ?? "config",
  }));
}
export const frpcStoreList = () => frpc<{ proxies?: any[] } | any[]>("/api/store/proxies");
export async function frpcCreateTunnel(name: string, localIP: string, localPort: number, remotePort: number) {
  return frpc("/api/store/proxies", { method: "POST", body: JSON.stringify({ name, type: "tcp", tcp: { localIP, localPort, remotePort, transport: { useEncryption: true } } }) });
}
export const frpcDeleteTunnel = (name: string) => frpc(`/api/store/proxies/${encodeURIComponent(name)}`, { method: "DELETE" });
export const frpsInfo = () => frps<any>("/api/serverinfo");
export const frpsProxies = () => frps<any>("/api/proxy/tcp");
