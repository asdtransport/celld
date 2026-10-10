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
