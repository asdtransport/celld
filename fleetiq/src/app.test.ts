import { beforeEach, expect, test } from "bun:test";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { buildApp } from "./app";
import { resetAuthKey } from "./auth";
import { config } from "./config";
import * as repo from "./lib/repo";
import { freshDb } from "./test/setup";

beforeEach(() => { freshDb(); config.authMode = "none"; config.authPublicKeyB64 = ""; resetAuthKey(); });
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("health is open; everything else needs an identity", async () => {
  config.authMode = "edge";
  const app = buildApp();
  expect((await app.request("/api/health")).status).toBe(200);
  const r = await app.request("/api/apps");
  expect(r.status).toBe(401);
  expect(((await r.json()) as any).error).toBe("sign in required");
});

async function edgeAuth(roles: string[]) {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  config.authMode = "edge";
  config.authPublicKeyB64 = (await exportSPKI(publicKey)).replace(/-----[^-]+-----|\s/g, "");
  const tok = await new SignJWT({ email: "derek@example.com", roles }).setProtectedHeader({ alg: "ES256" }).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  return { cookie: `AUTHP_SESSION_ID=x; AUTHP_ACCESS_TOKEN=${tok}` };
}

test("viewer can read but not mutate; the denial is audited", async () => {
  const app = buildApp();
  const h = await edgeAuth(["authp/user"]);
  expect((await app.request("/api/apps", { headers: h })).status).toBe(200);
  const r = await app.request("/api/apps", { ...json("POST", { name: "demo" }), headers: { ...h, "content-type": "application/json" } });
  expect(r.status).toBe(403);
  expect(repo.listAudit()[0]).toMatchObject({ outcome: "denied", actor: "derek@example.com" });
});

test("operator can create; names follow the Worker rule", async () => {
  const app = buildApp();
  const h = await edgeAuth(["authp/admin"]);
  const ok = await app.request("/api/apps", { ...json("POST", { name: "status-board", managed: true, desiredNodes: 2 }), headers: { ...h, "content-type": "application/json" } });
  expect(ok.status).toBe(201);
  const bad = await app.request("/api/apps", { ...json("POST", { name: "Bad_Name" }), headers: { ...h, "content-type": "application/json" } });
  expect(bad.status).toBe(400);
  const dup = await app.request("/api/apps", { ...json("POST", { name: "status-board" }), headers: { ...h, "content-type": "application/json" } });
  expect(dup.status).toBe(409);
});

test("a token without a console role is refused", async () => {
  const app = buildApp();
  const h = await edgeAuth(["someone/else"]);
  expect((await app.request("/api/apps", { headers: h })).status).toBe(401);
});

test("the last route cannot be removed", async () => {
  const app = buildApp();
  repo.createApp({ name: "a", prefix: "a", description: null, managed: 0, desiredNodes: 0, nodeImage: null, healthPath: "/", createdBy: "t" });
  repo.upsertRoute("*", "a");
  const r = await app.request("/api/routes?host=*", { method: "DELETE" });
  expect(r.status).toBe(409);
});

test("an app with routes cannot be removed", async () => {
  const app = buildApp();
  repo.createApp({ name: "a", prefix: "a", description: null, managed: 0, desiredNodes: 0, nodeImage: null, healthPath: "/", createdBy: "t" });
  repo.upsertRoute("a.example.com", "a");
  expect((await app.request("/api/apps/a", { method: "DELETE" })).status).toBe(409);
});

test("unmanaged apps cannot be scaled from the console", async () => {
  const app = buildApp();
  repo.createApp({ name: "a", prefix: "a", description: null, managed: 0, desiredNodes: 0, nodeImage: null, healthPath: "/", createdBy: "t" });
  const r = await app.request("/api/apps/a/scale", json("POST", { nodes: 3 }));
  expect(r.status).toBe(409);
});
