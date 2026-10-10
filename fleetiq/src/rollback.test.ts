import { beforeEach, expect, mock, test } from "bun:test";
import { freshDb } from "./test/setup";

// Fake bucket: two versions; v2 is live. Records pointer writes in order.
const writes: { key: string; etag: string | null; version?: string; value?: any }[] = [];
let consumers: Record<string, string[]> = {};
let attachments: Record<string, any> = {};
mock.module("./adapters/bucket", () => ({
  fleetPointer: async () => ({ value: { script_name: "app", version: "bbbbbbbbbbbbbbbb", prefix: "deploy/app/bbbbbbbbbbbbbbbb", rollout: { percent: 100 } }, etag: '"fleet-etag"' }),
  getJson: async (key: string) => key.includes("/queues/")
    ? (attachments[key] ? { value: attachments[key], etag: '"q-etag"' } : null)
    : { value: {}, etag: '"named-etag"' },
  manifest: async (_p: string, _s: string, v: string) => (v in consumers ? { queue_consumers: consumers[v]!.map((queue) => ({ queue })) } : null),
  nodeLeases: async () => [],
  putJsonIfMatch: async (key: string, value: any, etag: string | null) => { writes.push({ key, etag, version: value.version, value }); },
}));
const { rollback, DeployError } = await import("./services/deploy");
const repo = await import("./lib/repo");
const app = { name: "app", prefix: "app" } as any;

const JOBS = "app/deploy/queues/jobs/consumer.json";
beforeEach(() => {
  freshDb(); writes.length = 0;
  consumers = { bbbbbbbbbbbbbbbb: ["jobs"], aaaaaaaaaaaaaaaa: ["jobs"] };
  attachments = { [JOBS]: { schema_version: 1, queue: "jobs", consumer: { script_name: "app", version: "bbbbbbbbbbbbbbbb", prefix: "deploy/app/bbbbbbbbbbbbbbbb" } } };
});

test("rollback moves queue attachments, then the named pointer, then the fleet pointer, all conditional", async () => {
  const d = await rollback(app, "aaaaaaaaaaaaaaaa", "derek");
  expect(d.status).toBe("succeeded");
  expect(writes.map((w) => w.key)).toEqual([JOBS, "app/deploy/app/current.json", "app/deploy/current.json"]);
  expect(writes.map((w) => w.etag)).toEqual(['"q-etag"', '"named-etag"', '"fleet-etag"']);
  expect(writes[0]!.value.consumer.version).toBe("aaaaaaaaaaaaaaaa");
  expect(repo.listAudit()[0]).toMatchObject({ action: "rollback", outcome: "ok" });
});

test("a queue the target no longer consumes is released; a new one is claimed with If-None-Match", async () => {
  consumers.aaaaaaaaaaaaaaaa = ["audit"];
  await rollback(app, "aaaaaaaaaaaaaaaa", "derek");
  const keys = writes.map((w) => w.key);
  expect(keys).toContain(JOBS);
  expect(writes.find((w) => w.key.includes("/audit/"))!.etag).toBeNull();
});

test("rollback refuses to take a queue another script consumes", async () => {
  attachments[JOBS].consumer.script_name = "other";
  await expect(rollback(app, "aaaaaaaaaaaaaaaa", "derek")).rejects.toBeInstanceOf(DeployError);
  expect(writes).toHaveLength(0);
});

test("rollback to the live or a missing version is refused", async () => {
  await expect(rollback(app, "bbbbbbbbbbbbbbbb", "d")).rejects.toThrow("already live");
  await expect(rollback(app, "cccccccccccccccc", "d")).rejects.toThrow("not in the bucket");
  expect(writes).toHaveLength(0);
});
