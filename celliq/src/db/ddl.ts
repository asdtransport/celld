const tables: string[] = [
  `CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));`,
  // workiq:ddl
];
export const DDL = tables.join("\n");
