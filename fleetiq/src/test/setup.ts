import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySchema } from "../db/ddl";
import { setDb } from "../db/runtime";
// Fresh in-memory db per test — the same DDL + schema the app uses.
export function freshDb() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  setDb(drizzle(sqlite));
}

// Scans in tests never reach the internet: advisory and license lookups fail fast (and are reported
// as "unchecked"); compliance tests that need answers stub fetch.
import { config } from "../config";
config.osvApi = "http://127.0.0.1:9";
config.npmRegistry = "http://127.0.0.1:9";
