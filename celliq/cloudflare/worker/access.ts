import { createRemoteJWKSet } from "jose";
import { AccessError, extractEdgeToken, importEdgeKey, verifyAccessToken, verifyEdgeToken } from "../../src/lib/access";
export { AccessError };

// One gate, three modes (AUTH_MODE):
//   access — Cloudflare Access (Workers edge, or celld behind cloudflared): Cf-Access-Jwt-Assertion vs team JWKS.
//   edge   — open-source edge (Caddy + caddy-security): ES256 AUTHP_ACCESS_TOKEN cookie / Bearer vs
//            AUTH_PUBLIC_KEY_B64 (preferred, no network) or AUTH_JWKS_URL; roles from AUTH_ALLOWED_ROLES.
//   none   — no gate (private network / dev only).
let accessJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let edgeKey: unknown = null;

export async function verifyAccess(req: Request, env: any): Promise<void> {
  if (env.ENVIRONMENT !== "production" || env.AUTH_MODE === "none") return;

  if (env.AUTH_MODE === "edge") {
    const token = extractEdgeToken(req, env.AUTH_COOKIE_NAME ? [env.AUTH_COOKIE_NAME] : undefined);
    if (!token) throw new AccessError("missing edge token");
    if (!edgeKey) {
      if (env.AUTH_PUBLIC_KEY_B64) edgeKey = await importEdgeKey(env.AUTH_PUBLIC_KEY_B64);
      else if (env.AUTH_JWKS_URL) edgeKey = createRemoteJWKSet(new URL(env.AUTH_JWKS_URL));
      else throw new AccessError("edge auth not configured");
    }
    const roles = String(env.AUTH_ALLOWED_ROLES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    await verifyEdgeToken(token, edgeKey, roles);
    return;
  }

  // default: Cloudflare Access
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AccessError("missing Access assertion");
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) throw new AccessError("Access not configured");
  if (!accessJwks) accessJwks = createRemoteJWKSet(new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
  await verifyAccessToken(token, accessJwks, env.ACCESS_AUD);
}
