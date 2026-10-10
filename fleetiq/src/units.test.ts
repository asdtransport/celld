import { describe, expect, test } from "bun:test";
import { renderLbConfig } from "./adapters/caddy";
import { parseJsonl } from "./adapters/celld";
import { demuxLogs, nodeSpec } from "./adapters/docker";
import { cleanError } from "./adapters/exec";
import { parseState } from "./adapters/nodes";
import { bindingsOf } from "./adapters/bucket";
import { checkArchiveListing, configName, d1WithMigrations, fillEdgeKey, parseJsonc } from "./services/deploy";

test("archive listing: plain files and dirs pass; links, absolute and .. paths are refused", () => {
  expect(checkArchiveListing("drwxr-xr-x u/g 0 2026-10-09 19:00 app/\n-rw-r--r-- u/g 12 2026-10-09 19:00 app/wrangler.jsonc")).toBeNull();
  expect(checkArchiveListing("lrwxrwxrwx u/g 0 2026-10-09 19:00 app/x -> /etc/passwd")).toContain("link");
  expect(checkArchiveListing("-rw-r--r-- u/g 1 2026-10-09 19:00 ../evil")).toContain("escapes");
  expect(checkArchiveListing("-rw-r--r-- u/g 1 2026-10-09 19:00 /etc/cron.d/x")).toContain("escapes");
});

test("config name is read from jsonc with comments", () => {
  expect(configName('// app\n{\n  // the name\n  "name": "status-board",\n  "main": "x.js" }')).toBe("status-board");
});

test("LB config: host routes before the default, empty fleets answer 503, unknown hosts 404", () => {
  const cfg: any = renderLbConfig([
    { host: "*", app: "celliq", upstreams: ["node-a:8787", "node-b:8787"], healthPath: "/api/health" },
    { host: "board.example.com", app: "board", upstreams: [], healthPath: "/" },
  ]);
  const routes = cfg.apps.http.servers.lb.routes;
  expect(routes[0].match[0].host).toEqual(["board.example.com"]);
  expect(routes[0].handle[0]).toMatchObject({ handler: "static_response", status_code: 503 });
  expect(routes[1].match).toBeUndefined();
  expect(routes[1].handle[0].upstreams).toEqual([{ dial: "node-a:8787" }, { dial: "node-b:8787" }]);
  expect(routes[1].handle[0].health_checks.active.uri).toBe("/api/health");
  expect(routes.at(-1).handle[0].status_code).toBe(404);
  expect(cfg.admin.listen.startsWith("unix/")).toBe(true);
});

test("docker log frames are demultiplexed", () => {
  const frame = (stream: number, s: string) => { const b = new TextEncoder().encode(s); const h = new Uint8Array(8); h[0] = stream; new DataView(h.buffer).setUint32(4, b.length); return [...h, ...b]; };
  expect(demuxLogs(new Uint8Array([...frame(1, "out\n"), ...frame(2, "err\n")]))).toBe("out\nerr\n");
  expect(demuxLogs(new TextEncoder().encode("tty plain"))).toBe("tty plain");
});

test("node spec: private listeners, advertise by container name, labels for ownership", () => {
  const s = nodeSpec("board", "board", 2, "ghcr.io/denoland/celld:0.6.2");
  expect(s.name).toBe("fleetiq-board-node-2");
  expect(s.body.Cmd).toContain("fleetiq-board-node-2:8788");
  expect(s.body.Labels).toMatchObject({ "fleetiq.app": "board", "fleetiq.role": "node" });
  expect((s.body as any).HostConfig.PortBindings).toBeUndefined();
});

test("celld helpers: jsonl parse, backtraces stripped", () => {
  expect(parseJsonl('noise\n{"a":1}\n\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
  expect(cleanError("Error: bucket gone\n\nStack backtrace:\n  0: x")).toBe("Error: bucket gone");
});

test("node /state is read defensively", () => {
  const s = parseState({ owned_cells: 3, deployment: { version: "abc", cells: { "AppData:1": 1 } }, node_load: { resident_cells: 2, rss_bytes: 10, cpu_percent_x100: 250, pressured: false } });
  expect(s).toMatchObject({ version: "abc", owned: 3, resident: 2, cpuPercent: 2.5, cells: ["AppData:1"] });
  expect(parseState({}).version).toBeNull();
});

test("bindings are grouped from the deployed manifest", () => {
  const b = bindingsOf({ crons: ["0 * * * *"], queue_consumers: [{ queue: "q" }], raw_metadata: { bindings: [
    { type: "kv", name: "KV", id: "app-kv" }, { type: "d1", name: "DB", database_name: "app", database_id: "app" },
    { type: "durable_object_namespace", name: "APP", class_name: "AppData" }, { type: "plain_text", name: "MODE", text: "x" },
    { type: "plain_text", name: "FLEETIQ_MIGRATE_TOKEN", text: "s3cret" }, { type: "plain_text", name: "AUTH_PUBLIC_KEY_B64", text: "MFkw" },
  ] } });
  expect(b.vars[1]!.value).toBe("(hidden)"); expect(b.vars[2]!.value).toBe("MFkw");
  expect(b.kv[0]!.id).toBe("app-kv"); expect(b.d1[0]!.name).toBe("app"); expect(b.durableObjects[0]!.className).toBe("AppData");
  expect(b.consumers).toEqual(["q"]); expect(b.crons).toHaveLength(1); expect(b.vars[0]!.name).toBe("MODE");
});

describe("deploy config helpers", () => {
  const cfgText = `{
    // comment with "quotes" and a url http://x
    "name": "worklog", /* block */
    "vars": { "AUTH_MODE": "edge", "AUTH_PUBLIC_KEY_B64": "", "NOTE": "a // not a comment" },
    "d1_databases": [
      { "binding": "DB", "database_name": "worklog", "database_id": "worklog", "migrations_dir": "cloudflare/migrations" },
      { "binding": "CACHE", "database_name": "cache", "database_id": "cache" },
    ],
  }`;
  test("parses JSONC with comments, trailing commas and slashes in strings", () => {
    const c = parseJsonc(cfgText);
    expect(c.name).toBe("worklog");
    expect(c.vars.NOTE).toBe("a // not a comment");
  });
  test("fills an empty edge key only", () => {
    const r = fillEdgeKey(cfgText, "MFkw");
    expect(r.filled).toBe(true);
    expect(parseJsonc(r.text).vars.AUTH_PUBLIC_KEY_B64).toBe("MFkw");
    expect(fillEdgeKey(r.text, "OTHER").filled).toBe(false);
    expect(fillEdgeKey(cfgText, "").filled).toBe(false);
  });
  test("lists only D1 databases with migrations", () => {
    expect(d1WithMigrations(parseJsonc(cfgText))).toEqual(["worklog"]);
    expect(d1WithMigrations({})).toEqual([]);
  });
});
