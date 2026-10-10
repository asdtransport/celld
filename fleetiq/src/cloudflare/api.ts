// Cloudflare REST client for the steps the workiq-cloudflare-deploy skill does by script:
// preflight, provision D1 / KV / R2 / Queues, and an Access app (+ health bypass). Every ensure* is
// idempotent: it finds by name first and only creates what is missing.

export class CloudflareError extends Error { constructor(m: string, public status = 502) { super(m); } }
export interface CfCreds { accountId: string; apiToken: string }

export const cfApiBase = () => (process.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");

export class Cloudflare {
  constructor(private c: CfCreds) {
    if (!/^[0-9a-f]{32}$/i.test(c.accountId)) throw new CloudflareError("account ID should be 32 hex characters (dashboard → Workers & Pages → Account details)", 400);
    if (!c.apiToken) throw new CloudflareError("API token is required", 400);
  }
  private acct(path = "") { return `/accounts/${this.c.accountId}${path}`; }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; result: T; errors: { code?: number; message: string }[] }> {
    const r = await fetch(cfApiBase() + path, {
      method, headers: { authorization: `Bearer ${this.c.apiToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    }).catch((e) => { throw new CloudflareError(`Cloudflare API unreachable: ${e.message}`); });
    const j: any = await r.json().catch(() => ({}));
    return { ok: r.ok && j.success !== false, status: r.status, result: j.result as T, errors: j.errors ?? (r.ok ? [] : [{ message: `HTTP ${r.status}` }]) };
  }
  private async must<T = any>(method: string, path: string, body: unknown, what: string): Promise<T> {
    const r = await this.call<T>(method, path, body);
    if (!r.ok) throw new CloudflareError(`${what}: ${r.errors.map((e) => `${e.message}${e.code ? ` (${e.code})` : ""}`).join("; ") || `HTTP ${r.status}`}`, r.status === 403 || r.status === 401 ? 403 : 502);
    return r.result;
  }

  // ---- preflight ----
  // Verify against the account endpoint: /user/tokens/verify rejects valid account-scoped (cfat_) tokens.
  async preflight() {
    const checks: { check: string; ok: boolean; detail: string }[] = [];
    const acct = await this.call(`GET`, this.acct());
    checks.push({ check: "account", ok: acct.ok, detail: acct.ok ? `${acct.result?.name}` : acct.errors.map((e) => e.message).join("; ") });
    if (!acct.ok) return { ok: false, account: null, checks, zones: [], teamDomain: null, workersDev: null };
    const [zones, org, sub, scripts, d1, kv, r2, queues] = await Promise.all([
      this.call<any[]>("GET", `/zones?per_page=50&account.id=${this.c.accountId}`),
      this.call("GET", this.acct("/access/organizations")),
      this.call("GET", this.acct("/workers/subdomain")),
      this.call("GET", this.acct("/workers/scripts")),
      this.call("GET", this.acct("/d1/database?per_page=1")),
      this.call("GET", this.acct("/storage/kv/namespaces?per_page=1")),
      this.call("GET", this.acct("/r2/buckets")),
      this.call("GET", this.acct("/queues")),
    ]);
    const perm = (name: string, r: { ok: boolean; errors: any[] }, need: string) => checks.push({ check: name, ok: r.ok, detail: r.ok ? "token can read" : `${r.errors.map((e: any) => e.message).join("; ")} — give the token ${need}` });
    perm("Workers scripts", scripts, "Workers Scripts: Edit");
    perm("D1", d1, "D1: Edit");
    perm("KV", kv, "Workers KV Storage: Edit");
    perm("R2", r2, "Workers R2 Storage: Edit (and enable R2 on the account)");
    checks.push({ check: "Queues", ok: queues.ok, detail: queues.ok ? "token can read" : "Queues need Workers Paid and the Queues: Edit permission; apps without queues don't need them" });
    checks.push({ check: "Access", ok: org.ok, detail: org.ok ? `team domain ${org.result?.auth_domain}` : "no Zero Trust organization, or the token lacks Access: Apps and Policies: Edit; Access gating won't be available" });
    checks.push({ check: "Zones", ok: zones.ok, detail: zones.ok ? `${zones.result?.length ?? 0} zones for custom domains` : "token can't list zones (Zone: Read); you can still deploy to workers.dev" });
    const required = ["account", "Workers scripts", "D1", "KV"];
    return {
      ok: checks.filter((c) => required.includes(c.check)).every((c) => c.ok),
      account: acct.result?.name ?? null, checks,
      zones: zones.ok ? (zones.result ?? []).map((z: any) => z.name) : [],
      teamDomain: org.ok ? org.result?.auth_domain ?? null : null,
      workersDev: sub.ok && sub.result?.subdomain ? `${sub.result.subdomain}.workers.dev` : null,
    };
  }

  // ---- resources ----
  async ensureD1(name: string): Promise<{ id: string; created: boolean }> {
    const found = (await this.must<any[]>("GET", this.acct(`/d1/database?name=${encodeURIComponent(name)}`), undefined, "list D1")).find((d) => d.name === name);
    if (found) return { id: found.uuid, created: false };
    const r = await this.must<any>("POST", this.acct("/d1/database"), { name }, `create D1 ${name}`);
    return { id: r.uuid, created: true };
  }
  async ensureKv(title: string): Promise<{ id: string; created: boolean }> {
    for (let page = 1; page < 50; page++) {
      const r = await this.call<any[]>("GET", this.acct(`/storage/kv/namespaces?per_page=100&page=${page}`));
      if (!r.ok) throw new CloudflareError(`list KV: ${r.errors.map((e) => e.message).join("; ")}`);
      const f = (r.result ?? []).find((n) => n.title === title);
      if (f) return { id: f.id, created: false };
      if ((r.result ?? []).length < 100) break;
    }
    const r = await this.must<any>("POST", this.acct("/storage/kv/namespaces"), { title }, `create KV ${title}`);
    return { id: r.id, created: true };
  }
  async ensureR2(name: string): Promise<{ name: string; created: boolean }> {
    const res = await this.must<any>("GET", this.acct("/r2/buckets"), undefined, "list R2");
    if ((res?.buckets ?? []).some((b: any) => b.name === name)) return { name, created: false };
    await this.must("POST", this.acct("/r2/buckets"), { name }, `create R2 bucket ${name}`);
    return { name, created: true };
  }
  async ensureQueue(name: string): Promise<{ id: string; created: boolean }> {
    const list = await this.must<any[]>("GET", this.acct("/queues"), undefined, "list Queues (needs Workers Paid)");
    const f = (list ?? []).find((q) => q.queue_name === name);
    if (f) return { id: f.queue_id, created: false };
    const r = await this.must<any>("POST", this.acct("/queues"), { queue_name: name }, `create queue ${name}`);
    return { id: r.queue_id, created: true };
  }

  // ---- Access ----
  async teamDomain(): Promise<string | null> {
    const r = await this.call("GET", this.acct("/access/organizations"));
    return r.ok ? r.result?.auth_domain ?? null : null;
  }
  private async ensureAccessApp(domain: string, name: string, session: string) {
    const apps = await this.must<any[]>("GET", this.acct("/access/apps"), undefined, "list Access apps");
    const f = (apps ?? []).find((a) => a.domain === domain);
    if (f) return { app: f, created: false };
    const app = await this.must<any>("POST", this.acct("/access/apps"), { name, domain, type: "self_hosted", session_duration: session, app_launcher_visible: true, auto_redirect_to_identity: false }, `create Access app for ${domain}`);
    return { app, created: true };
  }
  private async ensurePolicy(appId: string, body: { name: string; decision: string; include: unknown[] }) {
    const pols = await this.must<any[]>("GET", this.acct(`/access/apps/${appId}/policies`), undefined, "list Access policies");
    const f = (pols ?? []).find((p) => p.name === body.name);
    if (f) {
      // Keep the allow list in step with FleetIQ's settings.
      if (JSON.stringify(f.include) !== JSON.stringify(body.include)) await this.must("PUT", this.acct(`/access/apps/${appId}/policies/${f.id}`), { ...body, precedence: f.precedence ?? 1 }, "update Access policy");
      return false;
    }
    await this.must("POST", this.acct(`/access/apps/${appId}/policies`), body, `create Access policy ${body.name}`);
    return true;
  }
  // Gate a hostname: allow these emails (or email domains like @lockstep.com), bypass the health path.
  async ensureAccess(opts: { hostname: string; name: string; allow: string[]; healthPath?: string; session?: string }) {
    const include = opts.allow.map((a) => (a.startsWith("@") ? { email_domain: { domain: a.slice(1) } } : { email: { email: a } }));
    if (!include.length) throw new CloudflareError("Access needs at least one allowed email or @domain", 400);
    const main = await this.ensureAccessApp(opts.hostname, opts.name, opts.session ?? "24h");
    await this.ensurePolicy(main.app.id, { name: "FleetIQ allow", decision: "allow", include });
    if (opts.healthPath) {
      // Access matches the most specific path first, so this bypass wins on the health path only.
      const h = await this.ensureAccessApp(`${opts.hostname}${opts.healthPath}`, `${opts.name} health`, opts.session ?? "24h");
      await this.ensurePolicy(h.app.id, { name: "Public health check", decision: "bypass", include: [{ everyone: {} }] });
    }
    return { appId: main.app.id as string, aud: main.app.aud as string, created: main.created, teamDomain: await this.teamDomain() };
  }

  async workerVersion(script: string): Promise<string | null> {
    const r = await this.call<any>("GET", this.acct(`/workers/scripts/${encodeURIComponent(script)}/deployments`));
    return r.ok ? r.result?.deployments?.[0]?.versions?.[0]?.version_id ?? null : null;
  }
}
