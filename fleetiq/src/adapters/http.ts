// Small fetch helpers: unix-socket JSON (Docker, Caddy admin) and timeouts for HTTP probes.
export class UpstreamError extends Error { constructor(m: string, public status = 0) { super(m); } }

export async function unixJson<T = any>(sock: string, path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
  const r = await fetch(`http://localhost${path}`, { ...init, unix: sock, signal: AbortSignal.timeout(timeoutMs) } as any)
    .catch((e) => { throw new UpstreamError(`${sock}: ${e.message}`); });
  const text = await r.text();
  if (!r.ok) throw new UpstreamError(`${path}: ${r.status} ${text.slice(0, 300)}`, r.status);
  return (text ? JSON.parse(text) : null) as T;
}
export async function unixText(sock: string, path: string, timeoutMs = 8000): Promise<string> {
  const r = await fetch(`http://localhost${path}`, { unix: sock, signal: AbortSignal.timeout(timeoutMs) } as any);
  if (!r.ok) throw new UpstreamError(`${path}: ${r.status}`, r.status);
  return Buffer.from(await r.arrayBuffer()).toString("binary");
}
export async function probe(url: string, timeoutMs = 4000): Promise<{ ok: boolean; status: number; ms: number; error?: string; body?: string }> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), tls: { rejectUnauthorized: process.env.EDGE_TLS_INSECURE !== "1" } } as any);
    const body = await r.text();
    return { ok: r.status < 500, status: r.status, ms: Math.round(performance.now() - t0), body: body.slice(0, 500) };
  } catch (e: any) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - t0), error: e.message };
  }
}
export const basic = (u: string, p: string) => ({ authorization: `Basic ${btoa(`${u}:${p}`)}` });
