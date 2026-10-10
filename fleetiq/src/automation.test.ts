import { beforeEach, expect, test } from "bun:test";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { OPS, mcpTools, openapi } from "./api/catalog";
import { buildApp } from "./app";
import { resetAuthKey } from "./auth";
import { config } from "./config";
import * as repo from "./lib/repo";
import { mintToken } from "./lib/tokens";
import { verifyGithubSignature } from "./services/source";
import { extractSingleFromTar, makeTar } from "./adapters/docker";
import { freshDb } from "./test/setup";

beforeEach(() => { freshDb(); config.authMode = "edge"; config.authPublicKeyB64 = ""; resetAuthKey(); });
const J = (method: string, body: unknown, h: Record<string, string> = {}) => ({ method, headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });

async function session(roles: string[]) {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  config.authPublicKeyB64 = (await exportSPKI(publicKey)).replace(/-----[^-]+-----|\s/g, "");
  const tok = await new SignJWT({ email: "derek@example.com", roles }).setProtectedHeader({ alg: "ES256" }).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  return { cookie: `AUTHP_ACCESS_TOKEN=${tok}` };
}

test("a person mints a token once; the token works, is audited by name, and can't mint more", async () => {
  const app = buildApp();
  const h = await session(["authp/admin"]);
  const r = await app.request("/api/tokens", J("POST", { name: "claude chat", role: "operator", expiresInDays: 30 }, h));
  expect(r.status).toBe(201);
  const t = (await r.json()) as any;
  expect(t.token).toStartWith("fiq_");
  expect(JSON.stringify(repo.listTokens())).not.toContain(t.token);           // only the hash is stored
  const bearer = { authorization: `Bearer ${t.token}` };
  expect((await app.request("/api/apps", { headers: bearer })).status).toBe(200);
  expect((await app.request("/api/apps", J("POST", { name: "notes" }, bearer))).status).toBe(201);
  expect(repo.listAudit()[0]).toMatchObject({ action: "app.create", actor: "claude chat (API token)" });
  expect((await app.request("/api/tokens", J("POST", { name: "more" }, bearer))).status).toBe(403);
  expect((await app.request(`/api/tokens/${t.id}`, { method: "DELETE", headers: h })).status).toBe(200);
  const after = await app.request("/api/apps", { headers: bearer });
  expect(after.status).toBe(401);
  expect(((await after.json()) as any).error).toContain("revoked");
});

test("viewer tokens read but can't change; expired and unknown tokens are refused", async () => {
  const app = buildApp();
  const v = mintToken({ name: "dash", role: "viewer", createdBy: "t" });
  expect((await app.request("/api/apps", { headers: { authorization: `Bearer ${v.secret}` } })).status).toBe(200);
  expect((await app.request("/api/apps", J("POST", { name: "x" }, { authorization: `Bearer ${v.secret}` }))).status).toBe(403);
  const e = mintToken({ name: "old", role: "operator", createdBy: "t", expiresInDays: 1 });
  const { getDb } = await import("./db/runtime"); const { apiTokens } = await import("./db/schema"); const { eq } = await import("drizzle-orm");
  getDb().update(apiTokens).set({ expiresAt: 1 }).where(eq(apiTokens.id, e.id)).run();
  expect((await app.request("/api/apps", { headers: { authorization: `Bearer ${e.secret}` } })).status).toBe(401);
  expect((await app.request("/api/apps", { headers: { authorization: "Bearer fiq_nope" } })).status).toBe(401);
});

test("Git source: token is write-only, path is validated, webhook secret is generated", async () => {
  const app = buildApp();
  const op = { authorization: `Bearer ${mintToken({ name: "ci", role: "operator", createdBy: "t" }).secret}` };
  await app.request("/api/apps", J("POST", { name: "notes" }, op));
  const put = await app.request("/api/apps/notes/source", J("PUT", { repo: "asdtransport/celld", ref: "celld-stack", path: "celliq", token: "ghp_secret", autoDeploy: true }, op));
  expect(put.status).toBe(200);
  const s = (await put.json()) as any;
  expect(s).toMatchObject({ repo: "asdtransport/celld", ref: "celld-stack", path: "celliq", hasToken: true, autoDeploy: true });
  expect(JSON.stringify(s)).not.toContain("ghp_secret");
  expect(s.webhookSecret.length).toBeGreaterThan(20);
  expect(s.webhookUrl).toEndWith("/hooks/github/notes");
  expect((await app.request("/api/apps/notes/source", J("PUT", { repo: "x/y", path: "../etc" }, op))).status).toBe(400);
  expect((await app.request("/api/apps/notes/source", J("PUT", { repo: "not a repo" }, op))).status).toBe(400);
  // keeping the token when omitted, clearing with ""
  await app.request("/api/apps/notes/source", J("PUT", { repo: "asdtransport/celld" }, op));
  expect(repo.getSource("notes")!.token).toBe("ghp_secret");
  await app.request("/api/apps/notes/source", J("PUT", { repo: "asdtransport/celld", token: "" }, op));
  expect(repo.getSource("notes")!.token).toBeNull();
});

test("webhook: bad signature refused and audited; other branches and pings ignored", async () => {
  const app = buildApp();
  repo.createApp({ name: "notes", prefix: "notes", description: null, managed: 1, desiredNodes: 2, nodeImage: null, healthPath: "/", createdBy: "t" });
  repo.putSource({ app: "notes", repo: "o/r", ref: "main", path: "", token: null, autoDeploy: 1, checks: 1, webhookSecret: "s3cret" });
  const sign = async (body: string) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `sha256=${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex")}`;
  };
  const body = JSON.stringify({ ref: "refs/heads/feature", after: "abc" });
  expect((await app.request("/hooks/github/notes", { method: "POST", headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=00" }, body })).status).toBe(401);
  expect(repo.listAudit()[0]).toMatchObject({ actor: "github", outcome: "denied" });
  const ig = await app.request("/hooks/github/notes", { method: "POST", headers: { "x-github-event": "push", "x-hub-signature-256": await sign(body) }, body });
  expect(((await ig.json()) as any).ignored).toContain("refs/heads/feature");
  const ping = await app.request("/hooks/github/notes", { method: "POST", headers: { "x-github-event": "ping", "x-hub-signature-256": await sign("{}") }, body: "{}" });
  expect(((await ping.json()) as any).pong).toBe(true);
  expect(await verifyGithubSignature("s3cret", new TextEncoder().encode("{}"), await sign("{}"))).toBe(true);
});

test("MCP: initialize, list tools, call a tool with the caller's token; URL-token form works", async () => {
  const app = buildApp();
  const tok = mintToken({ name: "claude", role: "operator", createdBy: "t" }).secret;
  const rpc = (body: unknown, path = "/mcp", h: Record<string, string> = { authorization: `Bearer ${tok}` }) => app.request(path, J("POST", body, h));
  expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "/mcp", {})).status).toBe(401);
  const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as any;
  expect(init.result.serverInfo.name).toBe("fleetiq");
  const list = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
  expect(list.result.tools.map((t: any) => t.name)).toContain("deploy_from_git");
  const create = (await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_app", arguments: { name: "notes", managed: false } } })).json()) as any;
  expect(create.result.isError).toBe(false);
  expect(repo.getApp("notes")).toBeTruthy();
  const viaUrl = (await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "api_request", arguments: { method: "GET", path: "/api/apps" } } }, `/mcp/t/${tok}`, {})).json()) as any;
  expect(viaUrl.result.content[0].text).toContain("notes");
  expect(((await (await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status))).toBe(202);
});

test("every catalog operation maps to a real route", async () => {
  const app = buildApp();
  const tok = mintToken({ name: "t", role: "viewer", createdBy: "t" }).secret;
  for (const op of OPS) {
    const path = op.path.replace(/\{[^}]+\}/g, "x");
    const r = await app.request(path, { method: op.method, headers: { authorization: `Bearer ${tok}` } });
    // Downstream calls may fail here (no Docker, no bucket), but Hono's own "404 Not Found" means no route.
    const text = await r.text();
    expect(`${op.tool} ${r.status} ${text}`).not.toBe(`${op.tool} 404 404 Not Found`);
  }
  const doc = openapi("https://console.example") as any;
  expect(Object.keys(doc.paths).length).toBeGreaterThan(30);
  expect(mcpTools().length).toBe(OPS.length + 1);
});

test("tar helpers round-trip a file", async () => {
  const data = new TextEncoder().encode("hello world");
  const t = await makeTar([{ name: "in/src.tgz", data }]);
  expect(t.length % 512).toBe(0);
  expect(new TextDecoder().decode(extractSingleFromTar(t)!)).toBe("hello world");
});

test("fetchSource resolves the ref to a commit, downloads that commit, and retries public repos without a stale server token", async () => {
  const { fetchSource } = await import("./services/source");
  const seen: { path: string; auth: string | null }[] = [];
  const srv = Bun.serve({ port: 0, fetch(req) {
    const u = new URL(req.url); const auth = req.headers.get("authorization"); seen.push({ path: u.pathname, auth });
    if (auth === "Bearer stale") return new Response("bad creds", { status: 401 });
    if (u.pathname === "/repos/o/r/commits/main") return new Response("0123456789abcdef0123456789abcdef01234567\n");
    if (u.pathname === "/repos/o/r/commits/nope") return new Response("{}", { status: 404 });
    if (u.pathname === "/repos/o/r/tarball/0123456789abcdef0123456789abcdef01234567") return new Response(new Uint8Array([31, 139, 8]));
    return new Response("?", { status: 500 });
  } });
  const prev = { api: config.githubApi, tok: config.githubToken };
  config.githubApi = `http://localhost:${srv.port}`; config.githubToken = "stale";
  try {
    const r = await fetchSource({ repo: "o/r", ref: "main", token: null });
    expect(r.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(r.label).toBe("o/r@0123456 (main)");
    expect(r.tgz.length).toBe(3);
    expect(seen.filter((x) => x.path.includes("tarball"))[0]!.auth).toBeNull();
    await expect(fetchSource({ repo: "o/r", ref: "nope", token: null })).rejects.toThrow('no ref "nope"');
    // A per-app token is never dropped silently.
    await expect(fetchSource({ repo: "o/r", ref: "main", token: "stale" })).rejects.toThrow("refused access");
  } finally { config.githubApi = prev.api; config.githubToken = prev.tok; srv.stop(true); }
});

test("GitHub write side: webhook created then updated, statuses reported, form payloads accepted", async () => {
  const { ensureWebhook, commitStatus } = await import("./services/github");
  const hooks: any[] = []; const statuses: any[] = [];
  const gh = Bun.serve({ port: 0, async fetch(req) {
    const u = new URL(req.url);
    if (req.headers.get("authorization") !== "Bearer ghp_good") return Response.json({ message: "Not Found" }, { status: 404 });
    if (u.pathname === "/repos/o/r/hooks" && req.method === "GET") return Response.json(hooks);
    if (u.pathname === "/repos/o/r/hooks" && req.method === "POST") { const h = { id: hooks.length + 1, ...((await req.json()) as object) }; hooks.push(h); return Response.json(h, { status: 201 }); }
    const m = /^\/repos\/o\/r\/hooks\/(\d+)$/.exec(u.pathname);
    if (m && req.method === "PATCH") { Object.assign(hooks.find((h) => h.id === Number(m[1]))!, (await req.json()) as object); return Response.json({}); }
    if (u.pathname.startsWith("/repos/o/r/statuses/")) { statuses.push({ sha: u.pathname.split("/").pop(), ...((await req.json()) as object) }); return Response.json({}, { status: 201 }); }
    return Response.json({ message: "?" }, { status: 500 });
  } });
  const prev = config.githubApi; const prevTok = config.githubToken; config.githubApi = `http://localhost:${gh.port}`; config.githubToken = "";
  try {
    const src = { repo: "o/r", token: "ghp_good" };
    expect((await ensureWebhook(src, "https://c/hooks/github/a", "s1")).action).toBe("created");
    expect((await ensureWebhook(src, "https://c/hooks/github/a", "s2")).action).toBe("updated");
    expect(hooks).toHaveLength(1); expect(hooks[0].config).toMatchObject({ content_type: "json", secret: "s2" }); expect(hooks[0].events).toEqual(["push"]);
    await expect(ensureWebhook({ repo: "o/r", token: "bad" }, "u", "s")).rejects.toThrow("Webhooks: read and write");
    const sha = "a".repeat(40);
    expect(await commitStatus(src, sha, "success", "notes is live", "https://c/app?name=notes", "fleetiq/notes")).toContain("marked aaaaaaa success");
    expect(statuses[0]).toMatchObject({ sha, state: "success", context: "fleetiq/notes" });
    expect(await commitStatus({ repo: "o/r", token: null }, sha, "pending", "x", "", "c")).toContain("no token");
  } finally { config.githubApi = prev; config.githubToken = prevTok; gh.stop(true); }
  // A form-encoded webhook (content type left at the GitHub default) is still understood.
  const app = buildApp();
  repo.createApp({ name: "notes", prefix: "notes", description: null, managed: 1, desiredNodes: 2, nodeImage: null, healthPath: "/", createdBy: "t" });
  repo.putSource({ app: "notes", repo: "o/r", ref: "main", path: "", token: null, autoDeploy: 1, checks: 1, webhookSecret: "s3cret" });
  const body = `payload=${encodeURIComponent(JSON.stringify({ ref: "refs/heads/other", after: "x" }))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = `sha256=${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex")}`;
  const r = await app.request("/hooks/github/notes", { method: "POST", headers: { "x-github-event": "push", "x-hub-signature-256": sig, "content-type": "application/x-www-form-urlencoded" }, body });
  expect(((await r.json()) as any).ignored).toContain("refs/heads/other");
  expect((await app.request("/hooks/github/notes")).status).toBe(405);
});
