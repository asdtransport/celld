import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// An application = one celld fleet = one prefix in the fleet bucket.
// managed=1: FleetIQ runs its node containers. managed=0: nodes run elsewhere (e.g. compose); FleetIQ observes.
export const apps = sqliteTable("apps", {
  name: text("name").primaryKey(),               // == wrangler `name` == bucket prefix
  description: text("description"),
  prefix: text("prefix").notNull(),
  managed: integer("managed").notNull().default(1),
  desiredNodes: integer("desired_nodes").notNull().default(2),
  nodeImage: text("node_image"),
  healthPath: text("health_path").notNull().default("/"),   // LB active health check path
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export type App = typeof apps.$inferSelect;

export const deployments = sqliteTable("deployments", {
  id: text("id").primaryKey(),
  app: text("app").notNull(),
  kind: text("kind").notNull(),                  // deploy | rollback
  status: text("status").notNull(),              // running | succeeded | failed
  version: text("version"),
  previousVersion: text("previous_version"),
  source: text("source"),                        // uploaded file name
  log: text("log"),
  actor: text("actor"),
  startedAt: integer("started_at").notNull().default(sql`(unixepoch())`),
  finishedAt: integer("finished_at"),
});
export type Deployment = typeof deployments.$inferSelect;

// Host-based routes on the load balancer. The LB config is rendered from this table.
export const routes = sqliteTable("routes", {
  host: text("host").primaryKey(),               // "*" = default route
  app: text("app").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export type Route = typeof routes.$inferSelect;

export const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull().default(sql`(unixepoch())`),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  outcome: text("outcome").notNull(),            // ok | denied | failed
  detail: text("detail"),
});
export type AuditEntry = typeof audit.$inferSelect;

// API tokens for scripts, CI and assistants. Only the SHA-256 of the secret is stored.
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),                   // tok_xxxxxxxx (shown in lists; not secret)
  name: text("name").notNull(),
  hash: text("hash").notNull(),
  role: text("role").notNull(),                  // viewer | operator
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  expiresAt: integer("expires_at"),              // null = never
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
});
export type ApiToken = typeof apiTokens.$inferSelect;

// Where an app's source lives, for Deploy from Git and push-to-deploy.
export const appSources = sqliteTable("app_sources", {
  app: text("app").primaryKey(),
  repo: text("repo").notNull(),                  // owner/name on GitHub, or an https URL to a .tar.gz
  ref: text("ref").notNull().default("main"),
  path: text("path").notNull().default(""),      // project folder inside the repo
  token: text("token"),                          // GitHub token for private repos (write-only over the API)
  autoDeploy: integer("auto_deploy").notNull().default(0),
  webhookSecret: text("webhook_secret").notNull(),
  checks: integer("checks").notNull().default(1), // run type check + tests during the build
  lastCommit: text("last_commit"),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});
export type AppSource = typeof appSources.$inferSelect;

// ---- Data mover ----
// A place data lives (provider + settings incl. secrets, which the API never returns).
export const moverEndpoints = sqliteTable("mover_endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  config: text("config").notNull(),              // JSON
  prefix: text("prefix").notNull().default(""),  // default root inside the bucket/container/folder
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export type MoverEndpoint = typeof moverEndpoints.$inferSelect;

// A saved sync (or app backup), optionally on a schedule.
export const moverJobs = sqliteTable("mover_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("sync"),  // sync | app-backup
  app: text("app"),                              // app-backup: the application
  consistent: integer("consistent").notNull().default(0), // app-backup: stop the app's nodes while copying
  srcEndpoint: text("src_endpoint").notNull(), srcPrefix: text("src_prefix").notNull().default(""),
  dstEndpoint: text("dst_endpoint").notNull(), dstPrefix: text("dst_prefix").notNull().default(""),
  mode: text("mode").notNull().default("copy"),  // copy | mirror
  compare: text("compare").notNull().default("quick"),
  include: text("include"), exclude: text("exclude"),     // JSON string arrays
  concurrency: integer("concurrency").notNull().default(8),
  verify: integer("verify").notNull().default(1),
  everyMinutes: integer("every_minutes"),        // null = manual only
  enabled: integer("enabled").notNull().default(1),
  nextRunAt: integer("next_run_at"),
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export type MoverJob = typeof moverJobs.$inferSelect;

export const moverRuns = sqliteTable("mover_runs", {
  id: text("id").primaryKey(),
  job: text("job"),                              // null for one-off syncs and restores
  label: text("label").notNull(),
  status: text("status").notNull(),              // planning | running | succeeded | failed | cancelled | planned
  dryRun: integer("dry_run").notNull().default(0),
  stats: text("stats"),                          // JSON progress / result
  log: text("log"),
  actor: text("actor"),
  startedAt: integer("started_at").notNull().default(sql`(unixepoch())`),
  finishedAt: integer("finished_at"),
});
export type MoverRun = typeof moverRuns.$inferSelect;

// ---- Deploy targets (other clouds an app can also run on) ----
export const targets = sqliteTable("targets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),          // cloudflare
  config: text("config").notNull(),              // JSON: { accountId, apiToken }
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});
export type Target = typeof targets.$inferSelect;

export const appTargets = sqliteTable("app_targets", {
  app: text("app").notNull(),
  target: text("target").notNull(),
  workerName: text("worker_name").notNull(),
  hostname: text("hostname"),                    // custom domain on a zone in the account; null = workers.dev
  access: integer("access").notNull().default(1), // gate with Cloudflare Access
  allow: text("allow"),                          // JSON: emails or @domains allowed through Access
  healthPath: text("health_path").notNull().default("/api/health"),
  resources: text("resources"),                  // JSON: provisioned ids
  accessAud: text("access_aud"),
  url: text("url"),
  lastVersion: text("last_version"),
  lastDeployAt: integer("last_deploy_at"),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});
export type AppTarget = typeof appTargets.$inferSelect;
