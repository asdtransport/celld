import { config } from "../config";
import type { AppSource } from "../db/schema";

export class SourceError extends Error { constructor(m: string, public status = 400) { super(m); } }

// "owner/repo" (GitHub) or a direct https URL to a .tar.gz.
export const isGithubRepo = (repo: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
export const validRepo = (repo: string) => isGithubRepo(repo) || /^https:\/\/\S+$/.test(repo);

function ghHeaders(token: string | null | undefined, accept = "application/vnd.github+json") {
  const h: Record<string, string> = { accept, "user-agent": "fleetiq", "x-github-api-version": "2022-11-28" };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// Resolve a ref to a commit, then download exactly that commit (so the log names what was built).
export async function fetchSource(src: Pick<AppSource, "repo" | "ref" | "token">, ref?: string): Promise<{ tgz: Uint8Array; commit: string | null; label: string }> {
  const want = ref || src.ref || "main";
  if (!isGithubRepo(src.repo)) {
    const r = await fetch(src.repo, { signal: AbortSignal.timeout(120_000) }).catch((e) => { throw new SourceError(`download failed: ${e.message}`, 502); });
    if (!r.ok) throw new SourceError(`download ${src.repo}: HTTP ${r.status}`, 502);
    return { tgz: new Uint8Array(await r.arrayBuffer()), commit: null, label: src.repo };
  }
  const base = `${config.githubApi}/repos/${src.repo}`;
  let token = src.token || config.githubToken || null;
  const resolve = () => fetch(`${base}/commits/${encodeURIComponent(want)}`, { headers: ghHeaders(token, "application/vnd.github.sha"), signal: AbortSignal.timeout(30_000) })
    .catch((e) => { throw new SourceError(`GitHub unreachable: ${e.message}`, 502); });
  let c = await resolve();
  // A stale server-wide token shouldn't break public repos: retry once without it.
  if ((c.status === 401 || c.status === 403) && token && !src.token) { token = null; c = await resolve(); }
  if (c.status === 404 || c.status === 422) throw new SourceError(`GitHub has no ref "${want}" in ${src.repo}, or the repo is private and no token is set`, 404);
  if (c.status === 401 || c.status === 403) throw new SourceError(`GitHub refused access to ${src.repo} (HTTP ${c.status}); check the token`, 403);
  if (!c.ok) throw new SourceError(`GitHub ${c.status} resolving ${want}`, 502);
  const commit = (await c.text()).trim();
  const t = await fetch(`${base}/tarball/${commit}`, { headers: ghHeaders(token), redirect: "follow", signal: AbortSignal.timeout(180_000) })
    .catch((e) => { throw new SourceError(`download failed: ${e.message}`, 502); });
  if (!t.ok) throw new SourceError(`GitHub ${t.status} downloading ${src.repo}@${commit.slice(0, 7)}`, 502);
  return { tgz: new Uint8Array(await t.arrayBuffer()), commit, label: `${src.repo}@${commit.slice(0, 7)}${/^[0-9a-f]{7,40}$/.test(want) ? "" : ` (${want})`}` };
}

// GitHub signs webhook bodies with HMAC-SHA256 of the shared secret.
export async function verifyGithubSignature(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Buffer.from(await crypto.subtle.sign("HMAC", key, body)).toString("hex");
  const given = header.slice(7);
  if (given.length !== mac.length) return false;
  let diff = 0; for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
