// Client helpers shared by every page. Same-origin API; the edge session cookie rides along.
export const API = typeof location !== "undefined" && location.port === "4321" ? "http://localhost:8787" : "";

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const r = await fetch(`${API}${path}`, {
    credentials: "include", ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await r.text();
  const body = text ? safeJson(text) : null;
  if (r.status === 401) { signInRequired(body?.error); throw new ApiError(body?.error ?? "Sign in required", 401); }
  if (!r.ok) {
    const issues = body?.issues?.map((i: any) => `${i.path?.join(".") || "input"}: ${i.message}`).join("; ");
    throw new ApiError(issues || body?.error || `Request failed (${r.status})`, r.status);
  }
  return body as T;
}
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return { error: t.slice(0, 200) }; } };

function signInRequired(reason?: string) {
  const main = document.getElementById("main");
  if (!main || main.dataset.signin) return;
  main.dataset.signin = "1";
  main.innerHTML = `<div class="panel" style="max-width:520px;margin-top:40px"><div class="panel-body">
    <h1 style="font-size:22px;margin-bottom:6px">Sign in to manage the fleet</h1>
    <p style="color:var(--ink-2);margin:0 0 16px">${esc(reason ?? "Your session has ended.")}</p>
    <a class="btn primary" href="/auth/?redirect_url=${encodeURIComponent(location.href)}">Sign in</a></div></div>`;
}

// ---------- formatting ----------
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function ago(input: number | string | null | undefined): string {
  if (input == null || input === "") return "—";
  const ms = typeof input === "number" ? (input < 1e12 ? input * 1000 : input) : Date.parse(input);
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
export const when = (input: number | string | null | undefined) => {
  if (input == null) return "";
  const ms = typeof input === "number" ? (input < 1e12 ? input * 1000 : input) : Date.parse(input);
  return new Date(ms).toLocaleString();
};
export function bytes(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
export const short = (v: string | null | undefined, n = 7) => (v ? v.slice(0, n) : "—");
export const statusClass = (s: string) => (["ok", "running", "succeeded", "healthy"].includes(s) ? "ok" : ["degraded", "warn", "paused", "restarting"].includes(s) ? "warn" : ["off", "exited", "created"].includes(s) ? "off" : "bad");
export const qs = (k: string) => new URLSearchParams(location.search).get(k);
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

// Audit action ids -> plain words for people.
const ACTIONS: Record<string, string> = {
  "app.adopt": "Adopted", "app.create": "Created application", "app.update": "Changed settings of", "app.remove": "Removed application",
  "app.scale": "Scaled", deploy: "Deployed", rollback: "Rolled back", "route.set": "Routed", "route.remove": "Removed route",
  "tunnel.create": "Added tunnel", "tunnel.remove": "Removed tunnel", "kv.put": "Wrote KV key", "kv.delete": "Deleted KV key",
  "d1.execute": "Ran SQL on", "d1.migrate": "Migrated", "queue.pause": "Paused queue", "queue.resume": "Resumed queue",
  "queue.purge": "Purged queue", "queue.redrive": "Retried dead letters of", "r2.put": "Uploaded to", "r2.delete": "Deleted from R2",
  "container.restart": "Restarted", "container.start": "Started", "container.stop": "Stopped",
  "token.create": "Created API token", "token.revoke": "Revoked API token", "source.set": "Set Git source of", "source.remove": "Removed Git source of",
  "source.rotate-secret": "Rotated webhook secret of", webhook: "Webhook for",
  "mover.run": "Copied", "mover.endpoint.create": "Added endpoint", "mover.endpoint.update": "Changed endpoint", "mover.endpoint.remove": "Removed endpoint",
  "target.create": "Added deploy target", "target.update": "Changed deploy target", "target.remove": "Removed deploy target",
  "target.link": "Set Cloudflare target of", "target.unlink": "Unlinked Cloudflare target of", "cloudflare.deploy": "Deployed to Cloudflare:",
  "data.move": "Moved data of", "platform.update": "Started platform update to", "source.webhook": "Registered GitHub webhook for",
  "mover.job.create": "Saved job", "mover.job.update": "Changed job", "mover.job.remove": "Removed job",
};
const VERBS: Record<string, string> = {
  deploy: "deploy", rollback: "roll back", "app.scale": "scale", "app.create": "create", "route.set": "route", "route.remove": "remove the route", "tunnel.create": "add tunnel",
  "tunnel.remove": "remove tunnel", "kv.put": "write KV key", "kv.delete": "delete KV key", "d1.execute": "run SQL on", "d1.migrate": "migrate", "r2.put": "upload to", "r2.delete": "delete from R2",
  "queue.purge": "purge", "queue.pause": "pause", "queue.resume": "resume", "container.restart": "restart", "container.start": "start", "container.stop": "stop", webhook: "accept the webhook for", "mover.run": "copy", "cloudflare.deploy": "deploy to Cloudflare", "data.move": "move data of", "platform.update": "update the platform to",
};
// One line for an audit entry: "Deployed board", "Couldn't deploy board", "Refused: POST /api/apps".
export const auditLine = (e: { action: string; target: string; outcome: string }) =>
  e.outcome === "ok" ? `${actionLabel(e.action)} ${e.target}` : e.outcome === "denied" ? `Refused: ${e.action}` : `Couldn’t ${VERBS[e.action] ?? e.action} ${e.target}`;
export const actionLabel = (a: string) => ACTIONS[a] ?? (a.startsWith("POST ") || a.startsWith("PUT ") || a.startsWith("DELETE ") || a.startsWith("PATCH ") ? "Tried" : a);

// ---------- feedback ----------
export function toast(message: string, kind: "ok" | "bad" = "ok") {
  const host = document.getElementById("toasts"); if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${kind === "bad" ? "bad" : ""}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  host.append(el);
  setTimeout(() => el.remove(), kind === "bad" ? 9000 : 4500);
}

// Destructive actions confirm in plain words; the riskiest also require typing the target's name.
export function confirmAction(opts: { title: string; text: string; ok: string; typed?: string }): Promise<boolean> {
  const d = document.getElementById("confirm") as HTMLDialogElement;
  $("#confirm-title", d).textContent = opts.title;
  $("#confirm-text", d).textContent = opts.text;
  const okBtn = $<HTMLButtonElement>("#confirm-ok", d); okBtn.textContent = opts.ok;
  const typedWrap = $("#confirm-typed", d); const input = typedWrap.querySelector("input")!;
  typedWrap.hidden = !opts.typed; input.value = "";
  if (opts.typed) { $("#confirm-typed-label", d).textContent = `Type ${opts.typed} to confirm`; okBtn.disabled = true; input.oninput = () => { okBtn.disabled = input.value !== opts.typed; }; }
  else okBtn.disabled = false;
  d.showModal();
  (opts.typed ? input : $<HTMLButtonElement>('button[value="cancel"]', d)).focus();
  return new Promise((res) => { d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }); });
}

// Run an async action with a busy button and a toast either way.
export async function act(btn: HTMLButtonElement | null, fn: () => Promise<unknown>, done: string) {
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  try { await fn(); toast(done); return true; }
  catch (e: any) { toast(e.message ?? String(e), "bad"); return false; }
  finally { if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); } }
}

export function errorPanel(el: HTMLElement, e: any, retry?: () => void) {
  el.innerHTML = `<div class="empty"><strong>Couldn’t load this</strong>${esc(e?.message ?? e)}${retry ? `<div style="margin-top:12px"><button class="btn sm" type="button">Try again</button></div>` : ""}</div>`;
  if (retry) el.querySelector("button")!.addEventListener("click", retry);
}

export interface Me { sub: string; email: string | null; name: string | null; roles: string[]; canOperate: boolean; authMode: string; via?: string }
let mePromise: Promise<Me> | null = null;
export const me = () => (mePromise ??= api<Me>("/api/me"));

// Hide operator-only controls for viewers instead of letting them fail.
export async function gateOperatorControls(root: ParentNode = document) {
  const m = await me().catch(() => null);
  if (m && !m.canOperate) root.querySelectorAll<HTMLElement>("[data-operator]").forEach((el) => { el.hidden = true; });
}
