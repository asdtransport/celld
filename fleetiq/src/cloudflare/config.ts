// celld wrangler config → Cloudflare wrangler config. The celld config is the source of truth (it's
// what the app runs on here); Cloudflare needs the account, real resource IDs, a route, and Access vars.

export interface CfResourceNeeds { d1: { binding: string; name: string; migrations: boolean }[]; kv: { binding: string; name: string }[]; r2: { binding: string; name: string }[]; queues: string[] }
export interface CfResourceIds { d1: Record<string, string>; kv: Record<string, string> }  // by Cloudflare name
export interface CfTargetSettings { app: string; workerName: string; accountId: string; hostname: string | null; access: { aud: string; teamDomain: string } | null }

// Names are account-wide on Cloudflare, so resources carry the app name unless they already do.
export const cfName = (app: string, name: string) => {
  const n = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (n === app || n.startsWith(`${app}-`) ? n : `${app}-${n}`).slice(0, 63);
};

export function resourceNeeds(app: string, cfg: any): CfResourceNeeds {
  const queues = new Set<string>();
  for (const p of cfg?.queues?.producers ?? []) if (p?.queue) queues.add(cfName(app, p.queue));
  for (const c of cfg?.queues?.consumers ?? []) if (c?.queue) queues.add(cfName(app, c.queue));
  return {
    d1: (cfg?.d1_databases ?? []).map((d: any) => ({ binding: d.binding, name: cfName(app, d.database_name ?? d.binding), migrations: !!d.migrations_dir })),
    kv: (cfg?.kv_namespaces ?? []).map((k: any) => ({ binding: k.binding, name: cfName(app, k.id ?? k.binding) })),
    r2: (cfg?.r2_buckets ?? []).map((b: any) => ({ binding: b.binding, name: cfName(app, b.bucket_name ?? b.binding) })),
    queues: [...queues],
  };
}

export function toCloudflareConfig(cfg: any, t: CfTargetSettings, ids: CfResourceIds): any {
  const out: any = structuredClone(cfg);
  out.name = t.workerName;
  out.account_id = t.accountId;
  if (t.hostname) { out.routes = [{ pattern: t.hostname, custom_domain: true }]; out.workers_dev = false; }
  else { delete out.routes; out.workers_dev = true; }
  out.observability = { enabled: true };
  const vars = { ...(cfg.vars ?? {}) };
  if ("RUNTIME" in vars) vars.RUNTIME = "cloudflare";
  if ("ENVIRONMENT" in vars) vars.ENVIRONMENT = "production"; // anything else and verifyAccess() gates nothing
  if ("AUTH_MODE" in vars) vars.AUTH_MODE = t.access ? "access" : "none";
  if (t.access) { vars.ACCESS_AUD = t.access.aud; vars.ACCESS_TEAM_DOMAIN = t.access.teamDomain; }
  if ("AUTH_PUBLIC_KEY_B64" in vars) vars.AUTH_PUBLIC_KEY_B64 = "";
  out.vars = vars;
  const need = resourceNeeds(t.app, cfg);
  if (out.d1_databases) out.d1_databases = out.d1_databases.map((d: any, i: number) => {
    const name = need.d1[i]!.name; const id = ids.d1[name];
    if (!id) throw new Error(`no Cloudflare D1 id for ${name}`);
    return { ...d, database_name: name, database_id: id };
  });
  if (out.kv_namespaces) out.kv_namespaces = out.kv_namespaces.map((k: any, i: number) => {
    const id = ids.kv[need.kv[i]!.name]; if (!id) throw new Error(`no Cloudflare KV id for ${need.kv[i]!.name}`);
    return { ...k, id };
  });
  if (out.r2_buckets) out.r2_buckets = out.r2_buckets.map((b: any, i: number) => ({ ...b, bucket_name: need.r2[i]!.name }));
  if (out.queues) {
    if (out.queues.producers) out.queues.producers = out.queues.producers.map((p: any) => ({ ...p, queue: cfName(t.app, p.queue) }));
    if (out.queues.consumers) out.queues.consumers = out.queues.consumers.map((c: any) => ({ ...c, queue: cfName(t.app, c.queue), ...(c.dead_letter_queue ? { dead_letter_queue: cfName(t.app, c.dead_letter_queue) } : {}) }));
  }
  return out;
}
