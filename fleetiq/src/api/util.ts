import type { Context } from "hono";
import { BucketError } from "../adapters/bucket";
import { CelldError } from "../adapters/celld";
import { UpstreamError } from "../adapters/http";
import { actorOf } from "../auth";
import * as repo from "../lib/repo";
import { DeployError } from "../services/deploy";
import { ZodError } from "zod";

// Turn adapter failures into plain, actionable API errors (the UI shows `error` verbatim).
export function failure(c: Context, e: unknown) {
  if (e instanceof ZodError) throw e;
  if (e instanceof DeployError) return c.json({ error: e.message }, e.status as any);
  if (e instanceof CelldError) return c.json({ error: e.message, source: "celld" }, 502);
  if (e instanceof BucketError) return c.json({ error: `fleet bucket: ${e.message}`, source: "bucket" }, 502);
  if (e instanceof UpstreamError) return c.json({ error: e.message, source: "upstream" }, e.status === 404 ? 404 : 502);
  console.error(e);
  return c.json({ error: "internal error" }, 500);
}

export async function audited<T>(c: Context, action: string, target: string, fn: () => Promise<T>, detail?: (r: T) => string) {
  try {
    const r = await fn();
    repo.writeAudit({ actor: actorOf(c), action, target, outcome: "ok", detail: detail?.(r) });
    return r;
  } catch (e: any) {
    if (!(e instanceof ZodError) && !(e instanceof DeployError)) repo.writeAudit({ actor: actorOf(c), action, target, outcome: "failed", detail: String(e.message).slice(0, 300) });
    throw e;
  }
}

export function requireApp(c: Context) {
  const app = repo.getApp(c.req.param("name")!);
  if (!app) return { app: null, res: c.json({ error: `no application named ${c.req.param("name")}` }, 404) };
  return { app, res: null };
}
