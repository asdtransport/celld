import type { Context, MiddlewareHandler } from "hono";
import { config } from "./config";
import { writeAudit } from "./lib/repo";
import { AccessError, extractEdgeToken, importEdgeKey, jwks, verifyEdgeToken } from "./lib/access";

export interface Identity { sub: string; email: string | null; name: string | null; roles: string[]; canOperate: boolean }
let key: unknown = null;
export const resetAuthKey = () => { key = null; }; // tests rotate keys

export async function identify(req: Request): Promise<Identity> {
  if (config.authMode === "none") return { sub: "local", email: null, name: "Local operator", roles: ["local"], canOperate: true };
  const token = extractEdgeToken(req);
  if (!token) throw new AccessError("sign in required");
  if (!key) {
    if (config.authPublicKeyB64) key = await importEdgeKey(config.authPublicKeyB64);
    else if (config.authJwksUrl) key = jwks(config.authJwksUrl);
    else throw new AccessError("AUTH_PUBLIC_KEY_B64 or AUTH_JWKS_URL is not set");
  }
  const p: any = await verifyEdgeToken(token, key);
  const roles: string[] = ([] as any[]).concat(p.roles ?? []).map(String);
  if (!roles.some((r) => config.viewerRoles.includes(r))) throw new AccessError("your role does not include console access");
  return { sub: String(p.sub ?? ""), email: p.email ?? null, name: p.name ?? null, roles, canOperate: roles.some((r) => config.operatorRoles.includes(r)) };
}

export const actorOf = (c: Context) => { const i = c.get("identity") as Identity | undefined; return i?.email ?? i?.sub ?? "unknown"; };

// Every /api route except health and the edge's certificate check requires a viewer;
// mutating methods require an operator. /api/edge/allow only answers whether a hostname is routed.
const OPEN = new Set(["/api/health", "/api/edge/allow"]);
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  if (OPEN.has(c.req.path) && (c.req.method === "GET" || c.req.method === "HEAD")) return next();
  let id: Identity;
  try { id = await identify(c.req.raw); }
  catch (e) { return c.json({ error: e instanceof AccessError ? e.message : "authentication failed" }, 401); }
  c.set("identity", id);
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !id.canOperate) {
    writeAudit({ actor: id.email ?? id.sub, action: `${c.req.method} ${c.req.path}`, target: c.req.path, outcome: "denied", detail: "viewer role" });
    return c.json({ error: "this action needs the operator role" }, 403);
  }
  return next();
};
