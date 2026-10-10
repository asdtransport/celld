import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import { config } from "./config";
import { mintToken } from "./lib/tokens";
import { deleteGuard, execute, filterFn, limiter, plan, same } from "./mover/engine";
import { AzureBlobConnector, parseConnectionString } from "./mover/azure";
import { s3Hint } from "./mover/s3";
import { LocalConnector } from "./mover/local";
import { redact, validateConfig } from "./mover/providers";
import type { Connector, ObjData, ObjInfo } from "./mover/types";
import { freshDb } from "./test/setup";

class Mem implements Connector {
  kind = "mem"; label = "mem"; objs = new Map<string, { data: Uint8Array; mtime: number; etag?: string }>(); failPut = 0; puts = 0;
  async *list(prefix: string): AsyncIterable<ObjInfo> { for (const [key, o] of [...this.objs].sort()) if (key.startsWith(prefix)) yield { key, size: o.data.length, mtime: o.mtime, etag: o.etag }; }
  async get(key: string): Promise<ObjData | null> { const o = this.objs.get(key); return o ? { body: o.data, size: o.data.length } : null; }
  async put(key: string, d: ObjData) { this.puts++; if (this.failPut-- > 0) throw new Error("flaky"); this.objs.set(key, { data: d.body as Uint8Array, mtime: Date.now() + 1000 }); }
  async delete(key: string) { this.objs.delete(key); }
  async test() { return { list: true, write: true, detail: "" }; }
}
const b = (s: string) => new TextEncoder().encode(s);

test("plan: new, changed (size or newer source), same, mirror deletes, filters", async () => {
  const src = new Mem(); const dst = new Mem();
  src.objs.set("a/1", { data: b("one"), mtime: 1000 }); src.objs.set("a/2", { data: b("two"), mtime: 1000 });
  src.objs.set("a/3", { data: b("three"), mtime: 5000 }); src.objs.set("a/skip.tmp", { data: b("x"), mtime: 1 });
  dst.objs.set("b/2", { data: b("two"), mtime: 2000 });           // same
  dst.objs.set("b/3", { data: b("three"), mtime: 2000 });         // older than source -> changed
  dst.objs.set("b/old", { data: b("gone"), mtime: 2000 });        // only on destination
  const spec = { src, srcPrefix: "a", dst, dstPrefix: "b/", mode: "mirror" as const, compare: "quick" as const, exclude: ["*.tmp"] };
  const p = await plan(spec);
  expect(p.copy.map((i) => `${i.rel}:${i.reason}`).sort()).toEqual(["1:new", "3:changed"]);
  expect(p.same).toBe(1); expect(p.remove).toEqual(["old"]);
  expect((await plan({ ...spec, mode: "copy" })).remove).toEqual([]);
  expect(same({ key: "k", size: 3, etag: "a".repeat(32) }, { key: "k", size: 3, etag: "A".repeat(32) }, "checksum")).toBe(true);
  expect(filterFn(["data/**"], ["**/*.log"])("data/x/y.bin")).toBe(true);
  expect(filterFn(["data/**"], ["**/*.log"])("data/x/y.log")).toBe(false);
});

test("execute: retries flaky writes, deletes only after copies succeed, verifies, and a rerun copies nothing", async () => {
  const src = new Mem(); const dst = new Mem();
  for (let i = 0; i < 25; i++) src.objs.set(`s/k${i}`, { data: b(`v${i}`), mtime: 1000 });
  dst.objs.set("d/stale", { data: b("x"), mtime: 1 });
  dst.failPut = 2;
  const spec = { src, srcPrefix: "s/", dst, dstPrefix: "d/", mode: "mirror" as const, compare: "quick" as const };
  const r = await execute(spec, await plan(spec), { concurrency: 4, verify: true });
  expect(r.done).toBe(25); expect(r.failed).toBe(0); expect(r.removed).toBe(1);
  expect(r.verified?.ok).toBe(true);
  expect(dst.objs.has("d/stale")).toBe(false);
  expect((await plan(spec)).copy.length).toBe(0);
  // A failed copy leaves destination-only objects alone.
  const d2 = new Mem(); d2.objs.set("d/keep", { data: b("k"), mtime: 1 }); d2.failPut = 99;
  const r2 = await execute({ ...spec, dst: d2 }, await plan({ ...spec, dst: d2 }), { retries: 0 });
  // The same error on every object stops the run early instead of hammering the destination.
  expect(r2.failed).toBeLessThan(25); expect(r2.errors.at(-1)!.error).toContain("identical failures"); expect(d2.objs.has("d/keep")).toBe(true);
});

test("local connector round-trips, refuses escaping keys, and skips temp files", async () => {
  const base = mkdtempSync(join(tmpdir(), "mover-"));
  const l = new LocalConnector(base, "bk");
  await l.put("x/y.txt", { body: b("hello"), size: 5 });
  const got = await l.get("x/y.txt");
  expect(new TextDecoder().decode(new Uint8Array(await new Response(got!.body).arrayBuffer()))).toBe("hello");
  const keys: string[] = []; for await (const o of l.list("")) keys.push(o.key);
  expect(keys).toEqual(["x/y.txt"]);
  await expect(l.put("../../etc/passwd", { body: b("no"), size: 2 })).rejects.toThrow("escapes");
  expect(() => new LocalConnector(base, "../up")).toThrow();
});

test("providers: required fields, defaults, and secrets are redacted", () => {
  expect(() => validateConfig("cloudflare-r2", { bucket: "b" })).toThrow("Account ID");
  const cfg = validateConfig("s3-compatible", { endpoint: "https://m", bucket: "b", accessKeyId: "AK", secretAccessKey: "supersecret", junk: "x" });
  expect(cfg.pathStyle).toBe("true"); expect(cfg.junk).toBeUndefined();
  expect(redact("s3-compatible", cfg).secretAccessKey).toBe("••••cret");
  expect(redact("azure-blob", { sasUrl: "https://a.blob.core.windows.net/c?sig=abcd" }).sasUrl).not.toContain("sig=");
});

beforeEach(() => { freshDb(); config.authMode = "edge"; });
test("API: endpoints, test, dry run, sync with wait, saved job, audit — through a token", async () => {
  config.dataDir = mkdtempSync(join(tmpdir(), "fiq-"));
  const app = buildApp();
  const h = { authorization: `Bearer ${mintToken({ name: "mover", role: "operator", createdBy: "t" }).secret}`, "content-type": "application/json" };
  const post = (p: string, body: unknown) => app.request(p, { method: "POST", headers: h, body: JSON.stringify(body) });
  const a = (await (await post("/api/mover/endpoints", { name: "src", provider: "local", config: { folder: "a" } })).json()) as any;
  const z = (await (await post("/api/mover/endpoints", { name: "dst", provider: "local", config: { folder: "z" }, prefix: "copies" })).json()) as any;
  expect(a.id).toStartWith("ep_");
  expect(((await (await post(`/api/mover/endpoints/${a.id}/test`, {})).json()) as any).write).toBe(true);
  const l = new LocalConnector(join(config.dataDir, "mover"), "a");
  for (let i = 0; i < 5; i++) await l.put(`app/f${i}`, { body: b(`data${i}`), size: 5 });
  const dry = (await (await post("/api/mover/sync?wait=1", { source: { endpoint: "src", prefix: "app" }, destination: { endpoint: z.id, prefix: "app" }, dryRun: true })).json()) as any;
  expect(dry.status).toBe("planned"); expect(dry.stats.plan.copy).toBe(5);
  const run = (await (await post("/api/mover/sync?wait=1", { source: { endpoint: "src", prefix: "app" }, destination: { endpoint: z.id, prefix: "app" } })).json()) as any;
  expect(run.status).toBe("succeeded"); expect(run.stats.result.copied).toBe(5); expect(run.stats.result.verified.ok).toBe(true);
  expect(await Bun.file(join(config.dataDir, "mover/z/copies/app/f3")).text()).toBe("data3");
  const job = (await (await post("/api/mover/jobs", { name: "nightly", source: { endpoint: a.id, prefix: "app" }, destination: { endpoint: z.id, prefix: "app" }, mode: "mirror", everyMinutes: 60 })).json()) as any;
  expect(job.nextRunAt).toBeGreaterThan(Date.now() / 1000);
  const again = (await (await post(`/api/mover/jobs/${job.id}/run?wait=1`, {})).json()) as any;
  expect(again.stats.plan.copy).toBe(0);
  expect((await app.request(`/api/mover/endpoints/${a.id}`, { method: "DELETE", headers: h })).status).toBe(409);
  const overlap = await post("/api/mover/sync", { source: { endpoint: "src", prefix: "app" }, destination: { endpoint: "src", prefix: "app/sub" } });
  expect(overlap.status).toBe(400);
  const list = (await (await app.request("/api/mover/endpoints", { headers: h })).json()) as any[];
  expect(list.map((e) => e.name)).toEqual(["dst", "src"]);
});

test("verify passes when a live source gains objects during the copy, and says so", async () => {
  const src = new Mem(); const dst = new Mem();
  for (let i = 0; i < 5; i++) src.objs.set(`s/k${i}`, { data: b(`v${i}`), mtime: 1000 });
  const put = dst.put.bind(dst);
  dst.put = async (k, d) => { src.objs.set(`s/late${dst.puts}`, { data: b("late"), mtime: 2000 }); return put(k, d); };
  const spec = { src, srcPrefix: "s/", dst, dstPrefix: "d/", mode: "copy" as const, compare: "quick" as const };
  const r = await execute(spec, await plan(spec), { verify: true });
  expect(r.verified?.ok).toBe(true);
  expect(r.verified?.detail).toContain("source changed during the copy");
});

test("mirror refuses to wipe most of a destination, and says why", async () => {
  const src = new Mem(); const dst = new Mem();
  src.objs.set("s/only", { data: b("x"), mtime: 1 });
  for (let i = 0; i < 40; i++) dst.objs.set(`d/k${i}`, { data: b("y"), mtime: 1 });
  const spec = { src, srcPrefix: "s/", dst, dstPrefix: "d/", mode: "mirror" as const, compare: "quick" as const };
  const p = await plan(spec);
  expect(deleteGuard(p)).toContain("40 of 40");
  const r = await execute(spec, p, {});
  expect(r.deletesBlocked).toBeTruthy(); expect(r.removed).toBe(0); expect(dst.objs.size).toBe(41);
  const r2 = await execute(spec, await plan(spec), { maxDeletePct: 100 });
  expect(r2.removed).toBe(40);
});

test("checksum compare hashes a local folder; content types come from extensions", async () => {
  const base = mkdtempSync(join(tmpdir(), "mover-"));
  const l = new LocalConnector(base, "f");
  await l.put("a.json", { body: b("{}"), size: 2 }); await l.put("b.bin", { body: b("zz"), size: 2 });
  expect(await l.hash("a.json")).toBe("99914b932bd37a50b983c5e7c90ae93b");
  expect((await l.get("a.json"))!.contentType).toBe("application/json");
  const mem = new Mem();
  mem.objs.set("a.json", { data: b("{}"), mtime: 0, etag: "99914b932bd37a50b983c5e7c90ae93b" });
  mem.objs.set("b.bin", { data: b("zz"), mtime: 0, etag: "0".repeat(32) });
  const p = await plan({ src: mem, srcPrefix: "", dst: l, dstPrefix: "", mode: "copy", compare: "checksum" });
  expect(p.hashed).toBe(2); expect(p.copy.map((i) => i.rel)).toEqual(["b.bin"]); expect(p.same).toBe(1);
  // Streamed writes land intact.
  await l.put("big/s.txt", { body: new Response("streamed body").body!, size: 13 });
  expect(await Bun.file(join(base, "f/big/s.txt")).text()).toBe("streamed body");
});

test("bandwidth limit holds the average rate", async () => {
  const take = limiter(1); const t0 = Date.now();
  for (let i = 0; i < 4; i++) await take(128 * 1024);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(370);
});

test("azure: connection strings, SAS expiry and permission warnings; s3 hints", async () => {
  expect(parseConnectionString("DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=a2V5;EndpointSuffix=core.windows.net").endpoint).toBe("https://acme.blob.core.windows.net");
  expect(parseConnectionString("AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;").endpoint).toBe("http://127.0.0.1:10000/devstoreaccount1");
  expect(() => parseConnectionString("BlobEndpoint=x;SharedAccessSignature=sv=1")).toThrow("SAS");
  expect(() => new AzureBlobConnector({ sasUrl: "https://a.blob.core.windows.net/?sv=1&sig=x" })).toThrow("container");
  const old = new AzureBlobConnector({ sasUrl: "http://127.0.0.1:1/acct/c?sv=1&se=2020-01-01T00:00:00Z&sp=rl&sig=x" });
  const t = await old.test("");
  expect(t.detail).toContain("expired"); expect(t.detail).toContain("lacks a, c, w, d");
  expect(s3Hint("AuthorizationHeaderMalformed", "<Region>eu-west-1</Region>")).toContain("eu-west-1");
  expect(s3Hint("SignatureDoesNotMatch", "")).toContain("secret key");
});
