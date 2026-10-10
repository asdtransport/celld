import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import { Cloudflare } from "./cloudflare/api";
import { cfName, resourceNeeds, toCloudflareConfig } from "./cloudflare/config";
import { config } from "./config";
import * as repo from "./lib/repo";
import { mintToken } from "./lib/tokens";
import { parseJsonc } from "./services/deploy";
import { freshDb } from "./test/setup";

const ACC = "0123456789abcdef0123456789abcdef";
// A small fake of the Cloudflare v4 API: enough state to prove idempotency.
const st = { d1: [] as any[], kv: [] as any[], r2: [] as any[], queues: [] as any[], apps: [] as any[], policies: {} as Record<string, any[]>, calls: [] as string[] };
const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
let srv: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  srv = Bun.serve({ port: 0, async fetch(req) {
    const u = new URL(req.url); const p = u.pathname.replace("/client/v4", ""); const m = req.method;
    st.calls.push(`${m} ${p}`);
    if (req.headers.get("authorization") !== "Bearer good-token-xxxxxxxxxxxxxxxx") return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    const body: any = m === "GET" ? null : await req.json().catch(() => null);
    const a = `/accounts/${ACC}`;
    if (p === a) return ok({ id: ACC, name: "Lockstep test" });
    if (p === "/zones") return ok([{ name: "example.com" }]);
    if (p === `${a}/access/organizations`) return ok({ auth_domain: "lockstep.cloudflareaccess.com" });
    if (p === `${a}/workers/subdomain`) return ok({ subdomain: "lockstep" });
    if (p === `${a}/workers/scripts`) return ok([]);
    if (p === `${a}/d1/database`) { if (m === "POST") { const d = { uuid: crypto.randomUUID(), name: body.name }; st.d1.push(d); return ok(d); } return ok(st.d1.filter((d) => !u.searchParams.get("name") || d.name === u.searchParams.get("name"))); }
    if (p === `${a}/storage/kv/namespaces`) { if (m === "POST") { const n = { id: crypto.randomUUID().replace(/-/g, ""), title: body.title }; st.kv.push(n); return ok(n); } return ok(st.kv); }
    if (p === `${a}/r2/buckets`) { if (m === "POST") { st.r2.push({ name: body.name }); return ok({}); } return ok({ buckets: st.r2 }); }
    if (p === `${a}/queues`) { if (m === "POST") { const q = { queue_id: crypto.randomUUID(), queue_name: body.queue_name }; st.queues.push(q); return ok(q); } return ok(st.queues); }
    if (p === `${a}/access/apps`) { if (m === "POST") { const x = { id: crypto.randomUUID(), aud: "a".repeat(64), ...body }; st.apps.push(x); return ok(x); } return ok(st.apps); }
    const pm = /^\/accounts\/[0-9a-f]+\/access\/apps\/([^/]+)\/policies(?:\/([^/]+))?$/.exec(p);
    if (pm) { const list = (st.policies[pm[1]!] ??= []); if (m === "POST") { list.push({ id: crypto.randomUUID(), ...body }); return ok(list.at(-1)); } if (m === "PUT") { Object.assign(list.find((x) => x.id === pm[2])!, body); return ok({}); } return ok(list); }
    return Response.json({ success: false, errors: [{ message: `fake has no ${m} ${p}` }] }, { status: 404 });
  } });
  process.env.CF_API_BASE = `http://localhost:${srv.port}/client/v4`;
});
afterAll(() => { srv.stop(true); delete process.env.CF_API_BASE; });

const celliqCfg = parseJsonc(await Bun.file(join(import.meta.dir, "test/celliq.wrangler.jsonc")).text()); // CellIQ's celld config, as a fixture

test("config: celld wrangler becomes a Cloudflare wrangler with real ids, route, Access vars", () => {
  expect(cfName("worklog", "celliq-kv")).toBe("worklog-celliq-kv");
  expect(cfName("celliq", "celliq-kv")).toBe("celliq-kv");
  const need = resourceNeeds("worklog", celliqCfg);
  expect(need.d1).toEqual([{ binding: "DB", name: "worklog-celliq", migrations: true }]);
  expect(need.queues).toEqual(["worklog-celliq-ingest"]);
  const out = toCloudflareConfig(celliqCfg, { app: "worklog", workerName: "worklog", accountId: ACC, hostname: "worklog.example.com", access: { aud: "abc", teamDomain: "t.cloudflareaccess.com" } }, { d1: { "worklog-celliq": "uuid-1" }, kv: { "worklog-celliq-kv": "kv-1" } });
  expect(out).toMatchObject({ name: "worklog", account_id: ACC, routes: [{ pattern: "worklog.example.com", custom_domain: true }], workers_dev: false, observability: { enabled: true } });
  expect(out.vars).toMatchObject({ RUNTIME: "cloudflare", ENVIRONMENT: "production", AUTH_MODE: "access", ACCESS_AUD: "abc", ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", AUTH_PUBLIC_KEY_B64: "" });
  expect(out.d1_databases[0]).toMatchObject({ database_name: "worklog-celliq", database_id: "uuid-1", migrations_dir: "cloudflare/migrations" });
  expect(out.kv_namespaces[0].id).toBe("kv-1");
  expect(out.r2_buckets[0].bucket_name).toBe("worklog-celliq-artifacts");
  expect(out.queues.consumers[0].queue).toBe("worklog-celliq-ingest");
  expect(out.durable_objects).toEqual(celliqCfg.durable_objects);
  const pub = toCloudflareConfig(celliqCfg, { app: "worklog", workerName: "worklog", accountId: ACC, hostname: null, access: null }, { d1: { "worklog-celliq": "u" }, kv: { "worklog-celliq-kv": "k" } });
  expect(pub.workers_dev).toBe(true); expect(pub.routes).toBeUndefined(); expect(pub.vars.AUTH_MODE).toBe("none");
});

test("client: preflight, idempotent provisioning, Access with health bypass", async () => {
  expect((await new Cloudflare({ accountId: ACC, apiToken: "bad-token-xxxxxxxxxxxxxxxxx" }).preflight()).ok).toBe(false);
  const cf = new Cloudflare({ accountId: ACC, apiToken: "good-token-xxxxxxxxxxxxxxxx" });
  const pre = await cf.preflight();
  expect(pre).toMatchObject({ ok: true, account: "Lockstep test", zones: ["example.com"], teamDomain: "lockstep.cloudflareaccess.com", workersDev: "lockstep.workers.dev" });
  const d = await cf.ensureD1("worklog-celliq"); expect(d.created).toBe(true);
  expect(await cf.ensureD1("worklog-celliq")).toEqual({ id: d.id, created: false });
  expect((await cf.ensureKv("worklog-celliq-kv")).created).toBe(true); expect((await cf.ensureKv("worklog-celliq-kv")).created).toBe(false);
  expect((await cf.ensureR2("worklog-celliq-artifacts")).created).toBe(true); expect((await cf.ensureR2("worklog-celliq-artifacts")).created).toBe(false);
  expect((await cf.ensureQueue("worklog-celliq-ingest")).created).toBe(true); expect((await cf.ensureQueue("worklog-celliq-ingest")).created).toBe(false);
  const a = await cf.ensureAccess({ hostname: "worklog.example.com", name: "worklog", allow: ["derek@example.com", "@lockstep.com"], healthPath: "/api/health" });
  expect(a).toMatchObject({ created: true, aud: "a".repeat(64), teamDomain: "lockstep.cloudflareaccess.com" });
  expect(st.apps.map((x) => x.domain)).toEqual(["worklog.example.com", "worklog.example.com/api/health"]);
  const main = st.policies[st.apps[0].id]!; const health = st.policies[st.apps[1].id]!;
  expect(main[0].include).toEqual([{ email: { email: "derek@example.com" } }, { email_domain: { domain: "lockstep.com" } }]);
  expect(health[0]).toMatchObject({ decision: "bypass", include: [{ everyone: {} }] });
  const again = await cf.ensureAccess({ hostname: "worklog.example.com", name: "worklog", allow: ["derek@example.com"], healthPath: "/api/health" });
  expect(again.created).toBe(false); expect(st.apps.length).toBe(2);
  expect(main[0].include).toEqual([{ email: { email: "derek@example.com" } }]); // allow list kept in step
});

beforeEach(() => { freshDb(); config.authMode = "edge"; });
test("API: add target (preflight), link app, plan; tokens never come back", async () => {
  config.dataDir = mkdtempSync(join(tmpdir(), "fiq-cf-"));
  const app = buildApp();
  const h = { authorization: `Bearer ${mintToken({ name: "t", role: "operator", createdBy: "t" }).secret}`, "content-type": "application/json" };
  const req = (m: string, p: string, b?: unknown) => app.request(p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  expect((await req("POST", "/api/targets", { name: "lockstep", accountId: ACC, apiToken: "bad-token-xxxxxxxxxxxxxxxxx" })).status).toBe(400);
  const t = (await (await req("POST", "/api/targets", { name: "lockstep", accountId: ACC, apiToken: "good-token-xxxxxxxxxxxxxxxx" })).json()) as any;
  expect(t.apiToken).toBe("••••xxxx"); expect(t.preflight.ok).toBe(true);
  repo.createApp({ name: "worklog", prefix: "worklog", description: null, managed: 1, desiredNodes: 2, nodeImage: null, healthPath: "/api/health", createdBy: "t" });
  expect((await req("PUT", "/api/apps/worklog/targets/lockstep", { hostname: "worklog.example.com", access: true })).status).toBe(400); // nobody allowed
  expect((await req("PUT", "/api/apps/worklog/targets/lockstep", { access: true, allow: ["derek@example.com"] })).status).toBe(400); // Access needs a hostname
  const l = (await (await req("PUT", "/api/apps/worklog/targets/lockstep", { hostname: "worklog.example.com", allow: ["derek@example.com"] })).json()) as any;
  expect(l).toMatchObject({ workerName: "worklog", hostname: "worklog.example.com", access: true, allow: ["derek@example.com"], targetName: "lockstep" });
  expect((await req("GET", "/api/apps/worklog/targets/lockstep/plan")).status).toBe(409); // nothing deployed here yet
  const dir = join(config.dataDir, "apps/worklog/project"); mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "wrangler.jsonc"), JSON.stringify({ ...celliqCfg, name: "worklog" }));
  const plan = (await (await req("GET", "/api/apps/worklog/targets/lockstep/plan")).json()) as any;
  expect(plan.config.routes[0].pattern).toBe("worklog.example.com");
  expect(plan.need.d1[0].name).toBe("worklog-celliq");
  expect(JSON.stringify(await (await req("GET", "/api/targets")).json())).not.toContain("good-token");
  expect((await req("DELETE", "/api/targets/lockstep")).status).toBe(409);
});
