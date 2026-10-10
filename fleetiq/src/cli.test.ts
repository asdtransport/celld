import { beforeEach, expect, test } from "bun:test";
import { buildApp } from "./app";
import { config } from "./config";
import * as repo from "./lib/repo";
import { mintToken } from "./lib/tokens";
import { freshDb } from "./test/setup";

beforeEach(() => { freshDb(); config.authMode = "edge"; config.publicUrl = "https://console.example.com"; config.appDomain = "example.com"; });

test("the console serves the CLI and its installers without sign-in", async () => {
  const app = buildApp();
  const sh = await app.request("/cli/install.sh");
  expect(sh.status).toBe(200);
  const text = await sh.text();
  expect(text).toContain('URL="https://console.example.com"'); expect(text).toContain("fleetiq login --url");
  expect(await (await app.request("/cli/install.ps1")).text()).toContain("fleetiq.cmd");
  const js = await (await app.request("/cli/fleetiq.mjs")).text();
  expect(js.startsWith("#!/usr/bin/env node")).toBe(true); expect(js).toContain("fleetiq-cli/");
});

test("previews: a separate app with its own address, idempotent, listed, removable", async () => {
  const app = buildApp();
  const h = { authorization: `Bearer ${mintToken({ name: "cli", role: "operator", createdBy: "t" }).secret}`, "content-type": "application/json" };
  repo.createApp({ name: "shop", prefix: "shop", description: null, managed: 1, desiredNodes: 2, nodeImage: null, healthPath: "/api/health", createdBy: "t" });
  const a = (await (await app.request("/api/apps/shop/preview", { method: "POST", headers: h, body: JSON.stringify({ alias: "Feature X!" }) })).json()) as any;
  expect(a).toMatchObject({ app: "shop-feature-x", previewOf: "shop", created: true, url: "https://shop-feature-x.example.com" });
  expect(repo.getApp("shop-feature-x")).toMatchObject({ desiredNodes: 1, healthPath: "/api/health", managed: 1 });
  expect(repo.listRoutes().find((r) => r.app === "shop-feature-x")?.host).toBe("shop-feature-x.example.com");
  const again = (await (await app.request("/api/apps/shop/preview", { method: "POST", headers: h, body: JSON.stringify({ alias: "feature-x" }) })).json()) as any;
  expect(again.created).toBe(false);
  // A real app with the preview's name is never taken over.
  repo.createApp({ name: "shop-preview", prefix: "shop-preview", description: "someone else's", managed: 1, desiredNodes: 1, nodeImage: null, healthPath: "/", createdBy: "t" });
  expect((await app.request("/api/apps/shop/preview", { method: "POST", headers: h, body: "{}" })).status).toBe(409);
  const list = (await (await app.request("/api/apps/shop/previews", { headers: h })).json()) as any[];
  expect(list.map((p) => p.app)).toEqual(["shop-feature-x"]);
  expect((await app.request("/api/apps/shop/preview?alias=feature-x", { method: "DELETE", headers: h })).status).toBe(200);
  expect(repo.getApp("shop-feature-x")).toBeUndefined(); expect(repo.listRoutes().some((r) => r.app === "shop-feature-x")).toBe(false);
  expect((await app.request("/api/apps/shop/preview", { method: "DELETE", headers: h })).status).toBe(404);
});
