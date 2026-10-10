// FleetIQ data portability for Durable Objects. Durable Object storage has no export API on Cloudflare,
// so the app carries its own: every table in the object's SQLite as JSON, and back again.
// FleetIQ calls it at /__fleetiq/data with the per-app secret in `x-fleetiq-migrate` to move an app's
// data between celld and Cloudflare. Without FLEETIQ_MIGRATE_TOKEN set, the path does not exist.

type Sql = { exec: (q: string, ...b: unknown[]) => { toArray(): any[] } };
const SKIP = "name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '_litestream*'";
const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const enc = (v: unknown) => (v instanceof ArrayBuffer ? { $b64: b64(new Uint8Array(v)) } : ArrayBuffer.isView(v) ? { $b64: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } : v);
const dec = (v: any) => (v && typeof v === "object" && typeof v.$b64 === "string" ? Uint8Array.from(atob(v.$b64), (c) => c.charCodeAt(0)).buffer : v);

export function exportTables(sql: Sql) {
  const tables = sql.exec(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND ${SKIP} ORDER BY name`).toArray();
  return { format: "fleetiq-do-v1", tables: tables.map((t) => ({ name: t.name, sql: t.sql, rows: sql.exec(`SELECT * FROM ${q(t.name)}`).toArray().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, enc(v)]))) })) };
}

// mode replace: each imported table ends up exactly as exported. merge: rows are upserted by primary key.
export function importTables(sql: Sql, data: { tables: { name: string; sql: string; rows: Record<string, unknown>[] }[] }, mode: "replace" | "merge") {
  const have = new Set(sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND ${SKIP}`).toArray().map((r) => r.name));
  const counts: Record<string, number> = {};
  for (const t of data.tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.name)) throw new Error(`refusing table name ${t.name}`);
    if (!have.has(t.name)) { if (!/^CREATE TABLE/i.test(t.sql)) throw new Error(`bad schema for ${t.name}`); sql.exec(t.sql); }
    if (mode === "replace") sql.exec(`DELETE FROM ${q(t.name)}`);
    for (const r of t.rows) {
      const cols = Object.keys(r);
      sql.exec(`INSERT OR REPLACE INTO ${q(t.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => dec(r[c])));
    }
    counts[t.name] = (sql.exec(`SELECT count(*) AS n FROM ${q(t.name)}`).toArray()[0] as any).n;
  }
  return { ok: true, counts };
}

export async function handlePortable(req: Request, sql: Sql): Promise<Response> {
  if (req.method === "GET") return Response.json(exportTables(sql));
  if (req.method === "POST") {
    const mode = new URL(req.url).searchParams.get("mode") === "merge" ? "merge" : "replace";
    try { return Response.json(importTables(sql, await req.json(), mode)); }
    catch (e: any) { return Response.json({ ok: false, error: e.message }, { status: 400 }); }
  }
  return new Response("method not allowed", { status: 405 });
}

// Constant-time check of the migrate secret, done in the front door before anything reaches the object.
export function migrateAllowed(req: Request, env: any): boolean {
  const want = String(env.FLEETIQ_MIGRATE_TOKEN ?? ""); const got = req.headers.get("x-fleetiq-migrate") ?? "";
  if (want.length < 24 || got.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}
