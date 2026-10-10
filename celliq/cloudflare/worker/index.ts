import { drizzle } from "drizzle-orm/durable-sqlite";
import { buildApp } from "../../src/app";
import { DDL } from "../../src/db/ddl";
import { setDb } from "../../src/db/runtime";
import { AccessError, verifyAccess } from "./access";

// Data layer lives in the DO: SQLite-in-DO is synchronous, so the sync repo runs verbatim.
// On celld this DO is a "cell": leased to one node, LTX-replicated, restored from the bucket.
export class AppData {
  private app;
  constructor(private ctx: any, private env: any) {
    setDb(drizzle(ctx.storage));
    ctx.storage.sql.exec(DDL);
    this.app = buildApp({ buildSha: env.BUILD_SHA, allowedOrigins: env.ALLOWED_ORIGINS?.split(",") });
  }
  fetch(req: Request) { return this.app.fetch(req); }
}

// Front door shared by both runtimes: Access gate -> /api/* to the data DO, /* to the Astro ASSETS build.
// No `email` handler: celld does not run Email Workers (see docs/celld.md).
export default {
  async fetch(req: Request, env: any) {
    const u = new URL(req.url);
    if (u.pathname.startsWith("/api/")) {
      // Liveness/runtime probes stay outside the gate so a load balancer can check them.
      if (u.pathname === "/api/runtime") return Response.json({ runtime: env.RUNTIME ?? "workers", environment: env.ENVIRONMENT });
      if (u.pathname !== "/api/health") {
        try { await verifyAccess(req, env); }
        catch (e) { if (e instanceof AccessError) return new Response("forbidden", { status: 403 }); throw e; }
      }
      const stub = env.APP.get(env.APP.idFromName("singleton"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
  // Queue -> Workflow ingest (decouples external push from processing). celld runs Queues as cells.
  async queue(batch: any, _env: any) { for (const m of batch.messages ?? []) m.ack?.(); },
  // Cron sweeps — celld runs exactly one invocation per occurrence across the fleet.
  async scheduled(_event: any, _env: any) {},
};
