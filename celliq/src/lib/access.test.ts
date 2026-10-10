import { expect, test } from "bun:test";
import { SignJWT, generateKeyPair } from "jose";
import { verifyAccessToken } from "./access";

async function mint(aud: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setAudience(aud).setIssuedAt().setExpirationTime("2h").sign(privateKey);
  return { token, publicKey };
}

test("valid Access token verifies", async () => {
  const { token, publicKey } = await mint("aud-123");
  const payload = await verifyAccessToken(token, publicKey, "aud-123");
  expect(payload.aud).toBe("aud-123");
});

test("wrong audience is rejected", async () => {
  const { token, publicKey } = await mint("aud-123");
  await expect(verifyAccessToken(token, publicKey, "other")).rejects.toThrow();
});

// ---- open-source edge (caddy-security) tokens ----
import { exportSPKI, generateKeyPair as gen } from "jose";
import { AccessError, extractEdgeToken, importEdgeKey, verifyEdgeToken } from "./access";

async function edgeMint(claims: Record<string, unknown>, alg = "ES256", exp: string | number = "1h") {
  const { publicKey, privateKey } = await gen(alg);
  const token = await new SignJWT(claims).setProtectedHeader({ alg }).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  const b64 = (await exportSPKI(publicKey)).replace(/-----[^-]+-----|\s/g, "");
  return { token, publicKey, b64 };
}

test("edge token from bearer header wins over cookie", () => {
  const r = new Request("http://x/api", { headers: { authorization: "Bearer abc", cookie: "a=1; access_token=def" } });
  expect(extractEdgeToken(r)).toBe("abc");
  expect(extractEdgeToken(new Request("http://x", { headers: { cookie: "a=1; access_token=def" } }))).toBe("def");
  expect(extractEdgeToken(new Request("http://x"))).toBeNull();
  expect(extractEdgeToken(new Request("http://x", { headers: { cookie: "AUTHP_SESSION_ID=s; AUTHP_ACCESS_TOKEN=ghi" } }))).toBe("ghi");
});

test("ES256 edge token verifies via one-line SPKI var, roles enforced", async () => {
  const { token, b64 } = await edgeMint({ email: "a@b.c", roles: ["authp/user"] });
  const key = await importEdgeKey(b64);
  expect((await verifyEdgeToken(token, key, ["authp/user"])).email).toBe("a@b.c");
  await expect(verifyEdgeToken(token, key, ["authp/admin"])).rejects.toBeInstanceOf(AccessError);
});

test("edge token: wrong key, expired, and non-ES256 are rejected", async () => {
  const a = await edgeMint({ roles: ["authp/user"] });
  const b = await edgeMint({ roles: ["authp/user"] });
  await expect(verifyEdgeToken(a.token, b.publicKey)).rejects.toBeInstanceOf(AccessError);
  const old = await edgeMint({}, "ES256", Math.floor(Date.now() / 1000) - 60);
  await expect(verifyEdgeToken(old.token, old.publicKey)).rejects.toBeInstanceOf(AccessError);
  const es512 = await edgeMint({}, "ES512");
  await expect(verifyEdgeToken(es512.token, es512.publicKey)).rejects.toBeInstanceOf(AccessError);
});
