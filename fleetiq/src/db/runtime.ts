import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
// Driver-blind handle. The core never imports bun:sqlite or D1/DO directly —
// each entrypoint registers the right synchronous SQLite driver via setDb().
type DB = BaseSQLiteDatabase<"sync", unknown>;
let _db: DB | null = null;
export const setDb = (db: DB) => { _db = db; };
export const getDb = (): DB => {
  if (!_db) throw new Error("db not registered — call setDb() in your entrypoint");
  return _db;
};
