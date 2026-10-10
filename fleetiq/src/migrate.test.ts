import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { moveD1, moveDo, moveKv } from "./migrate/run";
import { type KvEntry, type Side, lit } from "./migrate/sides";

// A fake side: bun:sqlite for D1, a Map for KV, a table dump for the DO.
function fake(label: string) {
  const db = new Database(":memory:"); const kv = new Map<string, KvEntry>(); let doTables: any[] = [];
  const side: Side = {
    label, d1Name: (b) => `${label}-${b}`, kvName: (id) => `${label}-${id}`,
    d1: async (_db, sql) => db.prepare(sql).all() as any[],
    d1Batch: async (_db, st) => { for (const s of st) db.run(s); },
    kvExport: async () => [...kv.values()], kvImport: async (_n, e) => { for (const x of e) kv.set(x.key, x); },
    kvDelete: async (_n, keys) => { for (const k of keys) kv.delete(k); }, kvKeys: async () => [...kv.keys()],
    doExport: async () => ({ format: "fleetiq-do-v1", tables: doTables }),
    doImport: async (d, mode) => { if (mode === "replace") doTables = structuredClone(d.tables); else for (const t of d.tables) { const e = doTables.find((x) => x.name === t.name); if (e) e.rows.push(...t.rows); else doTables.push(t); } return { counts: Object.fromEntries(doTables.map((t) => [t.name, t.rows.length])) }; },
  };
  return { side, db, kv, get doTables() { return doTables; }, set doTables(v) { doTables = v; } };
}
const opts = (o: any = {}) => ({ from: "a", to: "b", parts: ["d1", "kv", "do"] as any, mode: "replace" as const, dryRun: false, ...o });

test("SQL literals cover the D1 value types", () => {
  expect(lit(null)).toBe("NULL"); expect(lit(3.5)).toBe("3.5"); expect(lit(true)).toBe("1");
  expect(lit("it's")).toBe("'it''s'"); expect(lit([0, 255])).toBe("X'00ff'"); expect(lit({ a: 1 })).toBe(`'{"a":1}'`);
});

test("D1: creates missing tables, replaces rows, skips platform tables, verifies counts; dry run changes nothing", async () => {
  const a = fake("a"); const b = fake("b");
  a.db.run("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, n INTEGER, blob BLOB)");
  for (let i = 0; i < 1203; i++) a.db.run("INSERT INTO items VALUES (?, ?, ?, ?)", [`i${i}`, `it's ${i}`, i, i % 2 ? new Uint8Array([i % 256]) : null]);
  a.db.run("CREATE TABLE d1_migrations (id INTEGER)"); a.db.run("INSERT INTO d1_migrations VALUES (1)");
  b.db.run("CREATE TABLE notes (x TEXT)"); b.db.run("INSERT INTO notes VALUES ('keep')");
  const s: any = { parts: {} };
  expect(await moveD1(a.side, b.side, "DB", opts({ dryRun: true }), () => {}, s)).toBe(true);
  expect(s.parts["d1:DB"]).toEqual([{ table: "items", source: 1203, destination: null, action: "create + copy" }]);
  expect(b.db.prepare("SELECT name FROM sqlite_master WHERE name = 'items'").get()).toBeNull();
  expect(await moveD1(a.side, b.side, "DB", opts(), () => {}, s)).toBe(true);
  expect((b.db.prepare("SELECT count(*) AS n FROM items").get() as any).n).toBe(1203);
  expect((b.db.prepare("SELECT name, blob FROM items WHERE id = 'i7'").get() as any)).toMatchObject({ name: "it's 7" });
  expect([...(b.db.prepare("SELECT blob FROM items WHERE id = 'i7'").get() as any).blob]).toEqual([7]);
  expect(b.db.prepare("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'").get()).toBeNull();
  b.db.run("INSERT INTO items VALUES ('extra', 'x', 0, NULL)");
  expect(await moveD1(a.side, b.side, "DB", opts(), () => {}, s)).toBe(true);    // replace removes extras
  expect((b.db.prepare("SELECT count(*) AS n FROM items").get() as any).n).toBe(1203);
});

test("KV: byte-exact entries, replace deletes extras, merge keeps them", async () => {
  const a = fake("a"); const b = fake("b");
  a.kv.set("k1", { key: "k1", value: Buffer.from([0, 1, 2]).toString("base64"), base64: true });
  a.kv.set("k2", { key: "k2", value: "two", metadata: { m: 1 } });
  b.kv.set("old", { key: "old", value: "x" });
  const s: any = { parts: {} };
  expect(await moveKv(a.side, b.side, "ns", opts({ mode: "merge" }), () => {}, s)).toBe(true);
  expect([...b.kv.keys()].sort()).toEqual(["k1", "k2", "old"]);
  expect(await moveKv(a.side, b.side, "ns", opts(), () => {}, s)).toBe(true);
  expect([...b.kv.keys()].sort()).toEqual(["k1", "k2"]);
  expect(b.kv.get("k1")).toMatchObject({ base64: true });
});

test("Durable Object tables move through the app's export point and are counted", async () => {
  const a = fake("a"); const b = fake("b");
  a.doTables = [{ name: "items", sql: "CREATE TABLE items (id)", rows: [{ id: 1 }, { id: 2 }] }];
  b.doTables = [{ name: "items", sql: "", rows: [{ id: 9 }] }];
  const s: any = { parts: {} };
  expect(await moveDo(a.side, b.side, opts(), () => {}, s)).toBe(true);
  expect(s.parts.do).toMatchObject({ source: { items: 2 }, destination: { items: 2 }, ok: true });
  expect(b.doTables[0].rows).toEqual([{ id: 1 }, { id: 2 }]);
});
