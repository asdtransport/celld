import { beforeEach, expect, test } from "bun:test";
import { buildApp } from "./app";
import { freshDb } from "./test/setup";

beforeEach(() => freshDb());

test("POST then GET /api/items", async () => {
  const app = buildApp();
  const created = await app.request("/api/items", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
  });
  expect(created.status).toBe(201);
  const list = await (await app.request("/api/items")).json();
  expect(list).toHaveLength(1);
});

test("Zod rejects empty body with 400", async () => {
  const app = buildApp();
  const r = await app.request("/api/items", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  expect(r.status).toBe(400);
});

test("body limit -> 413", async () => {
  const app = buildApp({ maxBodyBytes: 50 });
  const r = await app.request("/api/items", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(500) }),
  });
  expect(r.status).toBe(413);
});

test("rate limit -> 429", async () => {
  const app = buildApp({ rateLimit: { max: 2, windowMs: 60_000 } });
  await app.request("/api/items");
  await app.request("/api/items");
  const r = await app.request("/api/items");
  expect(r.status).toBe(429);
});

test("health reports db + build version", async () => {
  const app = buildApp({ buildSha: "abc123" });
  const j = (await (await app.request("/api/health")).json()) as any;
  expect(j.version).toBe("abc123");
  expect(j.db).toBe("ok");
});
