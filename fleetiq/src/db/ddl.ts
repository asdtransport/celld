const tables: string[] = [
  `CREATE TABLE IF NOT EXISTS apps (name TEXT PRIMARY KEY, description TEXT, prefix TEXT NOT NULL, managed INTEGER NOT NULL DEFAULT 1, desired_nodes INTEGER NOT NULL DEFAULT 2, node_image TEXT, health_path TEXT NOT NULL DEFAULT '/', created_by TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));`,
  `CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, app TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, version TEXT, previous_version TEXT, source TEXT, log TEXT, actor TEXT, started_at INTEGER NOT NULL DEFAULT (unixepoch()), finished_at INTEGER);`,
  `CREATE INDEX IF NOT EXISTS deployments_app ON deployments(app, started_at);`,
  `CREATE TABLE IF NOT EXISTS routes (host TEXT PRIMARY KEY, app TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL DEFAULT (unixepoch()), actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT);`,
];
export const DDL = tables.join("\n");
