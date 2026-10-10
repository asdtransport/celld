import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { exportTables, importTables, migrateAllowed } from "./portable";

// The DO's ctx.storage.sql, backed by bun:sqlite for the test.
const sqlOf = (db: Database) => ({ exec: (q: string, ...raw: any[]) => { const b = raw.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)); const st = db.prepare(q); const rows = /^\s*(SELECT|PRAGMA)/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows as any[] }; } });

test("export then import round-trips tables, blobs and schema; replace vs merge", () => {
  const a = new Database(":memory:"); const sa = sqlOf(a);
  sa.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, n INTEGER, b BLOB)");
  sa.exec("INSERT INTO items VALUES (?, ?, ?, ?)", "1", "one", 1, new Uint8Array([0, 255, 7]));
  sa.exec("INSERT INTO items VALUES (?, ?, ?, ?)", "2", "two's", null, null);
  sa.exec("CREATE TABLE _cf_KV (k TEXT)"); // platform table: never exported
  const dump = JSON.parse(JSON.stringify(exportTables(sa)));
  expect(dump.tables.map((t: any) => t.name)).toEqual(["items"]);
  const b = new Database(":memory:"); const sb = sqlOf(b);
  sb.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, n INTEGER, b BLOB)");
  sb.exec("INSERT INTO items VALUES ('9', 'stale', 0, NULL)");
  expect(importTables(sb, dump, "replace").counts).toEqual({ items: 2 });
  expect(b.prepare("SELECT name FROM items ORDER BY id").all().map((r: any) => r.name)).toEqual(["one", "two's"]);
  expect([...(b.prepare("SELECT b FROM items WHERE id = '1'").get() as any).b]).toEqual([0, 255, 7]);
  const c = new Database(":memory:"); const sc = sqlOf(c);       // table missing on the destination: created from the schema
  sc.exec("CREATE TABLE other (x)"); sc.exec("INSERT INTO other VALUES (1)");
  importTables(sc, dump, "merge");
  expect((c.prepare("SELECT count(*) AS n FROM items").get() as any).n).toBe(2);
  expect(() => importTables(sc, { tables: [{ name: "x; DROP TABLE other", sql: "", rows: [] }] }, "merge")).toThrow();
});

test("the migrate secret must match exactly and be long enough", () => {
  const env = { FLEETIQ_MIGRATE_TOKEN: "s".repeat(32) };
  const req = (h?: string) => new Request("https://x/__fleetiq/data", { headers: h ? { "x-fleetiq-migrate": h } : {} });
  expect(migrateAllowed(req("s".repeat(32)), env)).toBe(true);
  expect(migrateAllowed(req("s".repeat(31) + "t"), env)).toBe(false);
  expect(migrateAllowed(req(), env)).toBe(false);
  expect(migrateAllowed(req(""), { FLEETIQ_MIGRATE_TOKEN: "" })).toBe(false);
});
