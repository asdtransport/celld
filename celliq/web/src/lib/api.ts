// Client-side API helper. Same-origin in production (celld / Workers); localhost:8787 under `astro dev`.
export const API =
  typeof location !== "undefined" && location.port === "4321" ? "http://localhost:8787" : "";
export async function apiGet<T>(path: string, fallback: T): Promise<T> {
  try { const r = await fetch(`${API}${path}`, { credentials: "include" }); return r.ok ? ((await r.json()) as T) : fallback; }
  catch { return fallback; }
}
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
export const fmtDate = (unix?: number) => (unix ? new Date(unix * 1000).toLocaleString() : "—");
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
