const tables: string[] = [
  `CREATE TABLE IF NOT EXISTS apps (name TEXT PRIMARY KEY, description TEXT, prefix TEXT NOT NULL, managed INTEGER NOT NULL DEFAULT 1, desired_nodes INTEGER NOT NULL DEFAULT 2, node_image TEXT, health_path TEXT NOT NULL DEFAULT '/', created_by TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));`,
  `CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, app TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, version TEXT, previous_version TEXT, source TEXT, log TEXT, actor TEXT, started_at INTEGER NOT NULL DEFAULT (unixepoch()), finished_at INTEGER);`,
  `CREATE INDEX IF NOT EXISTS deployments_app ON deployments(app, started_at);`,
  `CREATE TABLE IF NOT EXISTS routes (host TEXT PRIMARY KEY, app TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL DEFAULT (unixepoch()), actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT);`,
  `CREATE TABLE IF NOT EXISTS api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);`,
  `CREATE TABLE IF NOT EXISTS app_sources (app TEXT PRIMARY KEY, repo TEXT NOT NULL, ref TEXT NOT NULL DEFAULT 'main', path TEXT NOT NULL DEFAULT '', token TEXT, auto_deploy INTEGER NOT NULL DEFAULT 0, webhook_secret TEXT NOT NULL, checks INTEGER NOT NULL DEFAULT 1, last_commit TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));`,
];
export const DDL = tables.join("\n");
