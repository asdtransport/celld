import { and, eq } from "drizzle-orm";
import { getDb } from "../db/runtime";
import { type AppTarget, type Target, appTargets, targets } from "../db/schema";

export const listTargets = (): Target[] => getDb().select().from(targets).orderBy(targets.name).all();
export const getTarget = (idOrName: string) => getDb().select().from(targets).where(eq(targets.id, idOrName)).get() ?? getDb().select().from(targets).where(eq(targets.name, idOrName)).get();
export const insertTarget = (t: Omit<Target, "createdAt">) => getDb().insert(targets).values(t).run();
export const updateTarget = (id: string, patch: Partial<Pick<Target, "name" | "config">>) => getDb().update(targets).set(patch).where(eq(targets.id, id)).run();
export const deleteTarget = (id: string) => getDb().delete(targets).where(eq(targets.id, id)).run();

export const linksForApp = (app: string): AppTarget[] => getDb().select().from(appTargets).where(eq(appTargets.app, app)).all();
export const linksForTarget = (target: string): AppTarget[] => getDb().select().from(appTargets).where(eq(appTargets.target, target)).all();
export const getLink = (app: string, target: string) => getDb().select().from(appTargets).where(and(eq(appTargets.app, app), eq(appTargets.target, target))).get();
export const putLink = (l: Omit<AppTarget, "updatedAt" | "resources" | "accessAud" | "url" | "lastVersion" | "lastDeployAt">) =>
  getDb().insert(appTargets).values({ ...l, updatedAt: Math.floor(Date.now() / 1000) })
    .onConflictDoUpdate({ target: [appTargets.app, appTargets.target], set: { workerName: l.workerName, hostname: l.hostname, access: l.access, allow: l.allow, healthPath: l.healthPath, updatedAt: Math.floor(Date.now() / 1000) } }).run();
export const setLinkState = (app: string, target: string, patch: Partial<Pick<AppTarget, "resources" | "accessAud" | "url" | "lastVersion" | "lastDeployAt">>) =>
  getDb().update(appTargets).set(patch).where(and(eq(appTargets.app, app), eq(appTargets.target, target))).run();
export const deleteLink = (app: string, target: string) => getDb().delete(appTargets).where(and(eq(appTargets.app, app), eq(appTargets.target, target))).run();
