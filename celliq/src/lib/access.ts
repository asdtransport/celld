import { type JWTPayload, importSPKI, jwtVerify } from "jose";
export class AccessError extends Error {}

// Verify a Cloudflare Access assertion. `key` is a remote JWKS resolver in prod,
// or a public key in tests. Throws AccessError on any failure.
export async function verifyAccessToken(token: string, key: unknown, aud: string): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, key as never, { audience: aud });
    return payload;
  } catch {
    throw new AccessError("invalid Access token");
  }
}

// ---- Open-source edge (Caddy + caddy-security) ------------------------------------------------
// The portal issues an ES256 JWT as a cookie (browsers) or accepts it as `Authorization: Bearer`
// (API clients). caddy-security 1.4.x names the cookie AUTHP_ACCESS_TOKEN (observed); older
// releases and its docs use access_token. ES256 only: celld's WebCrypto verifies P-256/SHA-256.
export const EDGE_COOKIE_NAMES = ["AUTHP_ACCESS_TOKEN", "access_token"];

export function extractEdgeToken(req: Request, cookieNames: string | string[] = EDGE_COOKIE_NAMES): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  const jar = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const name of ([] as string[]).concat(cookieNames)) {
    const v = jar.get(name);
    if (v) return decodeURIComponent(v);
  }
  return null;
}

// AUTH_PUBLIC_KEY_B64 is the body of the SPKI PEM (base64 DER, one line) so it fits in a Wrangler var.
export async function importEdgeKey(b64: string): Promise<CryptoKey> {
  const body = b64.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const pem = `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
  return importSPKI(pem, "ES256");
}

export async function verifyEdgeToken(token: string, key: unknown, allowedRoles: string[] = []): Promise<JWTPayload> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key as never, { algorithms: ["ES256"], requiredClaims: ["exp"] }));
  } catch {
    throw new AccessError("invalid edge token");
  }
  if (allowedRoles.length) {
    const roles = ([] as unknown[]).concat((payload as any).roles ?? (payload as any).role ?? []).map(String);
    if (!roles.some((r) => allowedRoles.includes(r))) throw new AccessError("role not allowed");
  }
  return payload;
}
