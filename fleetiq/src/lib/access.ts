import { type JWTPayload, createRemoteJWKSet, importSPKI, jwtVerify } from "jose";
// Same token rules as the apps: caddy-security ES256 token from Bearer or AUTHP_ACCESS_TOKEN / access_token cookie.
export class AccessError extends Error {}
export const EDGE_COOKIE_NAMES = ["AUTHP_ACCESS_TOKEN", "access_token"];

export function extractEdgeToken(req: Request, cookieNames: string[] = EDGE_COOKIE_NAMES): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  const jar = new Map<string, string>();
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const n of cookieNames) { const v = jar.get(n); if (v) return decodeURIComponent(v); }
  return null;
}
export async function importEdgeKey(b64: string): Promise<CryptoKey> {
  const body = b64.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return importSPKI(`-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`, "ES256");
}
export async function verifyEdgeToken(token: string, key: unknown): Promise<JWTPayload> {
  try { return (await jwtVerify(token, key as never, { algorithms: ["ES256"], requiredClaims: ["exp"] })).payload; }
  catch { throw new AccessError("invalid edge token"); }
}
export const jwks = (url: string) => createRemoteJWKSet(new URL(url));
