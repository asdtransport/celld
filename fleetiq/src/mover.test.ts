import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import { config } from "./config";
import { mintToken } from "./lib/tokens";
import { execute, filterFn, plan, same } from "./mover/engine";
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
  expect(r2.failed).toBe(25); expect(d2.objs.has("d/keep")).toBe(true);
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
