import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { DDL } from "./db/ddl";
import { setDb } from "./db/runtime";
import * as repo from "./lib/repo";
const sqlite = new Database(process.env.APP_DB ?? "local/app.db");
sqlite.exec(DDL);
setDb(drizzle(sqlite));
const fixtures = [
  { name: "Sample one", note: "seeded fixture" },
  { name: "Sample two", note: "edit src/seed.ts for your data" },
];
for (const f of fixtures) repo.createItem(f);
console.log(`seeded ${fixtures.length} items`);
