import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/runtime";
import { type MoverEndpoint, type MoverJob, type MoverRun, moverEndpoints, moverJobs, moverRuns } from "../db/schema";

const now = () => Math.floor(Date.now() / 1000);
export const listEndpoints = (): MoverEndpoint[] => getDb().select().from(moverEndpoints).orderBy(moverEndpoints.name).all();
export const getEndpoint = (id: string) => getDb().select().from(moverEndpoints).where(eq(moverEndpoints.id, id)).get();
export const endpointByName = (name: string) => getDb().select().from(moverEndpoints).where(eq(moverEndpoints.name, name)).get();
export const insertEndpoint = (e: Omit<MoverEndpoint, "createdAt">) => getDb().insert(moverEndpoints).values(e).run();
export const updateEndpoint = (id: string, patch: Partial<Pick<MoverEndpoint, "name" | "config" | "prefix">>) => getDb().update(moverEndpoints).set(patch).where(eq(moverEndpoints.id, id)).run();
export const deleteEndpoint = (id: string) => getDb().delete(moverEndpoints).where(eq(moverEndpoints.id, id)).run();

export const listJobs = (): MoverJob[] => getDb().select().from(moverJobs).orderBy(moverJobs.name).all();
export const getJob = (id: string) => getDb().select().from(moverJobs).where(eq(moverJobs.id, id)).get();
export const insertJob = (j: Omit<MoverJob, "createdAt">) => getDb().insert(moverJobs).values(j).run();
export const updateJob = (id: string, patch: Partial<MoverJob>) => getDb().update(moverJobs).set(patch).where(eq(moverJobs.id, id)).run();
export const deleteJob = (id: string) => getDb().delete(moverJobs).where(eq(moverJobs.id, id)).run();

export const startRun = (r: Pick<MoverRun, "id" | "job" | "label" | "dryRun" | "actor">) => getDb().insert(moverRuns).values({ ...r, status: "planning", log: "" }).run();
export const setRun = (id: string, patch: Partial<Pick<MoverRun, "status" | "stats" | "log">>) => getDb().update(moverRuns).set(patch).where(eq(moverRuns.id, id)).run();
export const finishRun = (id: string, patch: Pick<MoverRun, "status" | "stats" | "log">) => getDb().update(moverRuns).set({ ...patch, finishedAt: now() }).where(eq(moverRuns.id, id)).run();
export const getRun = (id: string) => getDb().select().from(moverRuns).where(eq(moverRuns.id, id)).get();
export const listRuns = (job?: string, limit = 50): MoverRun[] => {
  const q = getDb().select().from(moverRuns);
  return (job ? q.where(eq(moverRuns.job, job)) : q).orderBy(desc(moverRuns.startedAt), desc(moverRuns.id)).limit(limit).all();
};
export const lastRun = (job: string) => listRuns(job, 1)[0] ?? null;
