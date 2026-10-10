import * as repo from "./repo";

// API tokens: "fiq_" + 32 random bytes (base64url). Shown once; only the SHA-256 is stored.
export const TOKEN_PREFIX = "fiq_";
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const hashToken = (secret: string) => new Bun.CryptoHasher("sha256").update(secret).digest("hex");

export function mintToken(opts: { name: string; role: "viewer" | "operator"; createdBy: string; expiresInDays?: number | null }) {
  const secret = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = `tok_${b64url(crypto.getRandomValues(new Uint8Array(6)))}`;
  const expiresAt = opts.expiresInDays ? Math.floor(Date.now() / 1000) + opts.expiresInDays * 86400 : null;
  repo.insertToken({ id, name: opts.name, hash: hashToken(secret), role: opts.role, createdBy: opts.createdBy, expiresAt });
  return { id, secret, expiresAt };
}

export type TokenCheck = { ok: true; token: NonNullable<ReturnType<typeof repo.tokenByHash>> } | { ok: false; reason: string };
export function checkToken(secret: string): TokenCheck {
  if (!secret.startsWith(TOKEN_PREFIX)) return { ok: false, reason: "not an API token" };
  const t = repo.tokenByHash(hashToken(secret));
  if (!t) return { ok: false, reason: "unknown API token" };
  if (t.revokedAt) return { ok: false, reason: "this API token was revoked" };
  if (t.expiresAt && t.expiresAt < Date.now() / 1000) return { ok: false, reason: "this API token has expired" };
  // Write last-used at most once a minute per token.
  if (!t.lastUsedAt || Date.now() / 1000 - t.lastUsedAt > 60) repo.touchToken(t.id);
  return { ok: true, token: t };
}

export const publicToken = (t: NonNullable<ReturnType<typeof repo.getToken>>) => {
  const { hash: _h, ...rest } = t;
  return { ...rest, active: !t.revokedAt && (!t.expiresAt || t.expiresAt > Date.now() / 1000) };
};
