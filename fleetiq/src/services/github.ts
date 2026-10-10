import { config } from "../config";
import type { AppSource } from "../db/schema";
import { isGithubRepo } from "./source";

// The write side of GitHub: register FleetIQ's webhook on the repo and report each build back as a
// commit status (the check mark next to a commit). Needs a token with Webhooks: read/write and
// Commit statuses: read/write on the repo (fine-grained), or admin:repo_hook + repo:status (classic).

export class GithubError extends Error { constructor(m: string, public status = 502) { super(m); } }
const tokenOf = (src: Pick<AppSource, "token">) => src.token || config.githubToken || null;

async function gh<T = any>(src: Pick<AppSource, "repo" | "token">, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const token = tokenOf(src);
  if (!token) throw new GithubError("no GitHub token: add one to the app's Git source (or GITHUB_TOKEN on FleetIQ)", 400);
  const r = await fetch(`${config.githubApi}/repos/${src.repo}${path}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/vnd.github+json", "user-agent": "fleetiq", "x-github-api-version": "2022-11-28", authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => { throw new GithubError(`GitHub unreachable: ${e.message}`); });
  const data = (await r.json().catch(() => ({}))) as T;
  return { ok: r.ok, status: r.status, data };
}
const why = (r: { status: number; data: any }, need: string) =>
  r.status === 404 || r.status === 403 ? `GitHub refused (HTTP ${r.status}); the token needs ${need} on this repo` : `GitHub HTTP ${r.status}: ${r.data?.message ?? ""}`;

// Create the webhook, or bring an existing one for this URL in line (secret, JSON, push only, active).
export async function ensureWebhook(src: Pick<AppSource, "repo" | "token">, url: string, secret: string): Promise<{ id: number; action: "created" | "updated" }> {
  if (!isGithubRepo(src.repo)) throw new GithubError("webhooks need a GitHub repo (owner/name)", 400);
  const cfg = { url, content_type: "json", secret, insecure_ssl: "0" };
  const list = await gh<any[]>(src, "GET", "/hooks?per_page=100");
  if (!list.ok) throw new GithubError(why(list, "Webhooks: read and write"), list.status === 404 || list.status === 403 ? 403 : 502);
  const found = (list.data ?? []).find((h) => h.config?.url === url);
  if (found) {
    const r = await gh(src, "PATCH", `/hooks/${found.id}`, { config: cfg, events: ["push"], active: true });
    if (!r.ok) throw new GithubError(why(r, "Webhooks: read and write"));
    return { id: found.id, action: "updated" };
  }
  const r = await gh<any>(src, "POST", "/hooks", { name: "web", config: cfg, events: ["push"], active: true });
  if (!r.ok) throw new GithubError(why(r, "Webhooks: read and write"));
  return { id: r.data.id, action: "created" };
}

export async function removeWebhook(src: Pick<AppSource, "repo" | "token">, url: string) {
  const list = await gh<any[]>(src, "GET", "/hooks?per_page=100");
  const found = list.ok ? (list.data ?? []).find((h) => h.config?.url === url) : null;
  if (found) await gh(src, "DELETE", `/hooks/${found.id}`);
  return !!found;
}

// Commit status: never fails a deploy; returns a line for the deploy log.
export async function commitStatus(src: Pick<AppSource, "repo" | "token">, sha: string, state: "pending" | "success" | "failure" | "error", description: string, targetUrl: string, context: string): Promise<string> {
  if (!isGithubRepo(src.repo) || !/^[0-9a-f]{40}$/.test(sha)) return "";
  if (!tokenOf(src)) return "GitHub status not reported (no token on the Git source)";
  try {
    const r = await gh(src, "POST", `/statuses/${sha}`, { state, description: description.slice(0, 140), target_url: targetUrl || undefined, context });
    return r.ok ? `GitHub: marked ${sha.slice(0, 7)} ${state}` : `GitHub status not reported: ${why(r, "Commit statuses: read and write")}`;
  } catch (e: any) { return `GitHub status not reported: ${e.message}`; }
}
