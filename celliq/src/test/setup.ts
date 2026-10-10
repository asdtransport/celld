import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { DDL } from "../db/ddl";
import { setDb } from "../db/runtime";
// Fresh in-memory db per test — the same DDL + schema the app uses.
export function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(DDL);
  setDb(drizzle(sqlite));
}
