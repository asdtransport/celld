import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/runtime";
import { type ApiToken, type App, type AppSource, type Deployment, type Route, apiTokens, appSources, apps, audit, deployments, routes } from "../db/schema";
// Synchronous, driver-blind repo (house rule).

export const listApps = (): App[] => getDb().select().from(apps).orderBy(apps.name).all();
export const getApp = (name: string): App | undefined => getDb().select().from(apps).where(eq(apps.name, name)).get();
export const createApp = (a: Omit<App, "createdAt">): App => {
  getDb().insert(apps).values(a).run();
  return getApp(a.name)!;
};
export const updateApp = (name: string, patch: Partial<Pick<App, "description" | "desiredNodes" | "nodeImage" | "healthPath">>) => {
  getDb().update(apps).set(patch).where(eq(apps.name, name)).run();
  return getApp(name);
};
export const deleteApp = (name: string) => getDb().delete(apps).where(eq(apps.name, name)).run();

export const startDeployment = (d: Pick<Deployment, "id" | "app" | "kind" | "source" | "actor" | "previousVersion">) => {
  getDb().insert(deployments).values({ ...d, status: "running", log: "" }).run();
};
export const finishDeployment = (id: string, patch: Pick<Deployment, "status" | "version" | "log">) =>
  getDb().update(deployments).set({ ...patch, finishedAt: Math.floor(Date.now() / 1000) }).where(eq(deployments.id, id)).run();
export const listDeployments = (app?: string, limit = 50): Deployment[] => {
  const q = getDb().select().from(deployments);
  return (app ? q.where(eq(deployments.app, app)) : q).orderBy(desc(deployments.startedAt), desc(deployments.id)).limit(limit).all();
};
export const updateDeploymentSource = (id: string, source: string) => getDb().update(deployments).set({ source }).where(eq(deployments.id, id)).run();
export const setDeploymentLog = (id: string, log: string) => getDb().update(deployments).set({ log }).where(eq(deployments.id, id)).run();
export const getDeployment = (id: string) => getDb().select().from(deployments).where(eq(deployments.id, id)).get();

export const listRoutes = (): Route[] => getDb().select().from(routes).orderBy(routes.host).all();
export const upsertRoute = (host: string, app: string) =>
  getDb().insert(routes).values({ host, app }).onConflictDoUpdate({ target: routes.host, set: { app } }).run();
export const deleteRoute = (host: string) => getDb().delete(routes).where(eq(routes.host, host)).run();

export const writeAudit = (e: { actor: string; action: string; target: string; outcome: "ok" | "denied" | "failed"; detail?: string }) =>
  getDb().insert(audit).values(e).run();
export const listAudit = (limit = 100) => getDb().select().from(audit).orderBy(desc(audit.id)).limit(limit).all();

// ---- API tokens ----
export const insertToken = (t: Omit<ApiToken, "createdAt" | "lastUsedAt" | "revokedAt">) => getDb().insert(apiTokens).values(t).run();
export const tokenByHash = (hash: string): ApiToken | undefined => getDb().select().from(apiTokens).where(eq(apiTokens.hash, hash)).get();
export const listTokens = (): ApiToken[] => getDb().select().from(apiTokens).orderBy(desc(apiTokens.createdAt)).all();
export const getToken = (id: string): ApiToken | undefined => getDb().select().from(apiTokens).where(eq(apiTokens.id, id)).get();
export const revokeToken = (id: string) => getDb().update(apiTokens).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(apiTokens.id, id)).run();
export const touchToken = (id: string) => getDb().update(apiTokens).set({ lastUsedAt: Math.floor(Date.now() / 1000) }).where(eq(apiTokens.id, id)).run();

// ---- Git sources ----
export const getSource = (app: string): AppSource | undefined => getDb().select().from(appSources).where(eq(appSources.app, app)).get();
export const putSource = (s: Omit<AppSource, "updatedAt" | "lastCommit"> & { lastCommit?: string | null }) =>
  getDb().insert(appSources).values({ ...s, updatedAt: Math.floor(Date.now() / 1000) })
    .onConflictDoUpdate({ target: appSources.app, set: { repo: s.repo, ref: s.ref, path: s.path, token: s.token, autoDeploy: s.autoDeploy, webhookSecret: s.webhookSecret, checks: s.checks, updatedAt: Math.floor(Date.now() / 1000) } }).run();
export const setSourceCommit = (app: string, commit: string) => getDb().update(appSources).set({ lastCommit: commit }).where(eq(appSources.app, app)).run();
export const deleteSource = (app: string) => getDb().delete(appSources).where(eq(appSources.app, app)).run();
