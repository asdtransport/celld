import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app";
import { config } from "./config";
import { cvss3, severityOf } from "./compliance/intel";
import { inventory, parseBunLock, parsePackageLock, parsePnpmLock, parseYarnLock } from "./compliance/inventory";
import { addWaiver, evaluate, licenseBlocked, PolicySchema, setPolicy } from "./compliance/policy";
import { configChecks, type ScanFindings, sbom } from "./compliance/scan";
import { entropy, scanText } from "./compliance/secrets";
import * as repo from "./lib/repo";
import { mintToken } from "./lib/tokens";
import { freshDb } from "./test/setup";

beforeEach(() => { freshDb(); config.authMode = "edge"; });

const BUN_LOCK = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "app", "dependencies": { "hono": "^4" }, "devDependencies": { "wrangler": "^3" } } },
  "packages": {
    "hono": ["hono@4.6.0", "", {}, "sha512-x"],
    "wrangler": ["wrangler@3.0.0", "", { "dependencies": { "esbuild": "0.17.19" } }, "sha512-y"],
    "esbuild": ["esbuild@0.17.19", "", {}, "sha512-z"],
    "wrangler/zod": ["zod@3.22.0", "", {}, "sha512-w"],
    "local": ["local@workspace:packages/local", "", {}],
  },
}`;

test("lockfiles: bun (runtime vs dev by reachability), npm, yarn, pnpm", () => {
  const b = parseBunLock(BUN_LOCK);
  const by = Object.fromEntries(b.packages.map((p) => [`${p.name}@${p.version}`, p.dev]));
  expect(by).toEqual({ "hono@4.6.0": false, "wrangler@3.0.0": true, "esbuild@0.17.19": true, "zod@3.22.0": true });
  const n = parsePackageLock(JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { a: "1" } }, "node_modules/a": { version: "1.0.0", license: "MIT" }, "node_modules/a/node_modules/@s/b": { version: "2.0.0", dev: true } } }));
  expect(n.packages).toEqual([{ name: "a", version: "1.0.0", license: "MIT", dev: false }, { name: "@s/b", version: "2.0.0", license: null, dev: true }]);
  expect(parseYarnLock(`"lodash@^4.17.0", lodash@^4.17.20:\n  version "4.17.21"\n  resolved "x"\n\n"@babel/core@^7":\n  version "7.24.0"\n`).packages).toEqual([{ name: "lodash", version: "4.17.21" }, { name: "@babel/core", version: "7.24.0" }]);
  expect(parsePnpmLock(`lockfileVersion: '9.0'\n\npackages:\n\n  hono@4.6.0:\n    resolution: {}\n\n  '@types/node@20.1.0':\n    resolution: {}\n`).packages).toEqual([{ name: "hono", version: "4.6.0" }, { name: "@types/node", version: "20.1.0" }]);
});

test("inventory: lockfiles in sub-folders count as build tooling; missing lockfiles are reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "inv-"));
  writeFileSync(join(root, "bun.lock"), BUN_LOCK); writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { hono: "4" } }));
  mkdirSync(join(root, "web")); writeFileSync(join(root, "web/bun.lock"), BUN_LOCK.replace('"hono": ["hono@4.6.0"', '"astro": ["astro@5.0.0"').replace('"hono": "^4"', '"astro": "^5"'));
  mkdirSync(join(root, "tools")); writeFileSync(join(root, "tools/package.json"), JSON.stringify({ dependencies: { left: "1" } }));
  mkdirSync(join(root, "node_modules/hono"), { recursive: true }); writeFileSync(join(root, "node_modules/hono/package.json"), JSON.stringify({ name: "hono", version: "4.6.0", license: "MIT" }));
  const inv = await inventory(root);
  const p = (n: string) => inv.packages.find((x) => x.name === n)!;
  expect(p("hono")).toMatchObject({ dev: false, build: false, direct: true, license: "MIT", purl: "pkg:npm/hono@4.6.0" });
  expect(p("astro")).toMatchObject({ build: true, dev: false });
  expect(inv.missingLockfiles).toEqual(["tools/package.json"]);
  expect(inv.files).not.toContain("node_modules/hono/package.json");
});

test("secrets: real-looking keys are found and masked; placeholders, env refs and allow-listed lines are not", () => {
  const aws = "AKIA" + "IOSFODNN7REALKEY";
  const gh = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const src = [
    `const id = "${aws}";`,
    `token: "${gh}",`,
    `const password = "changeme-please-123";`,
    `const apiKey = process.env.API_KEY;`,
    `const client_secret = "x9Fq2LmZ7vR3tY8wK1pN6bH4";`,
    `const dbUrl = "postgres://app:S3cr3tP4ss@db.internal:5432/app";`,
    `const ok = "${aws}"; // fleetiq:allow-secret`,
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const f = scanText(src, "src/config.ts");
  expect(f.map((x) => `${x.rule}:${x.line}`)).toEqual(["aws-access-key:1", "github-token:2", "generic-secret:5", "database-url:6", "private-key:8"]);
  expect(f[0]!.preview).toBe("AKIA…EY (20 chars)"); expect(JSON.stringify(f)).not.toContain(aws);
  expect(scanText(`const client_secret = "x9Fq2LmZ7vR3tY8wK1pN6bH4";`, "test/fixtures/a.ts")).toEqual([]);
  expect(entropy("aaaaaaaaaaaa")).toBe(0);
});

test("config checks: secrets in wrangler vars, no sign-in, FleetIQ-filled vars are fine", async () => {
  const root = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(root, "wrangler.jsonc"), `{ "name": "a", "compatibility_date": "2026-01-01", // c\n "vars": { "STRIPE_API_KEY": "sk_test_abcdefgh", "FLEETIQ_MIGRATE_TOKEN": "filled-by-fleetiq-123", "AUTH_PUBLIC_KEY_B64": "MFkwEwYHKoZIzj0C", "AUTH_MODE": "none" } }`);
  const c = await configChecks(root, ["wrangler.jsonc"]);
  expect(c.map((x) => x.rule)).toEqual(["config-secret-var", "config-no-auth"]);
  expect(c[0]!.message).toContain("STRIPE_API_KEY");
});

test("severity from labels or CVSS vectors; license expressions", () => {
  expect(severityOf({ database_specific: { severity: "MODERATE" } })).toBe("moderate");
  expect(cvss3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
  expect(severityOf({ severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] })).toBe("critical");
  expect(licenseBlocked("AGPL-3.0-only", ["AGPL-3.0"])).toBe("AGPL-3.0");
  expect(licenseBlocked("MIT OR AGPL-3.0", ["AGPL-3.0"])).toBeNull();
  expect(licenseBlocked("(MIT AND AGPL-3.0-or-later)", ["AGPL-3.0"])).toBe("AGPL-3.0");
  expect(licenseBlocked("GPL-3.0", ["AGPL-3.0"])).toBeNull();
});

const findings = (over: Partial<ScanFindings> = {}): ScanFindings => ({
  packages: [{ name: "hono", version: "4.0.0", direct: true, dev: false, build: false, license: "MIT", lockfile: "bun.lock", purl: "pkg:npm/hono@4.0.0" }],
  lockfiles: ["bun.lock"], missingLockfiles: [], vulns: [], vulnError: null, secrets: [], config: [], filesScanned: 3, ...over,
});
const vuln = (sev: any, extra: any = {}) => ({ id: `GHSA-${sev}`, aliases: [`CVE-1-${sev}`], summary: "x", severity: sev, package: "hono", version: "4.0.0", fixed: "4.1.0", direct: true, dev: false, build: false, url: "", ...extra });

test("gate: thresholds, tooling, secrets, licenses, sources, warn mode and waivers", () => {
  const p = PolicySchema.parse({});
  expect(evaluate(findings(), "a", { sourceKind: "git" }, p, []).decision).toBe("passed");
  expect(evaluate(findings({ vulns: [vuln("high")] }), "a", { sourceKind: "git" }, p, []).decision).toBe("passed");
  const crit = evaluate(findings({ vulns: [vuln("critical")] }), "a", { sourceKind: "git" }, p, []);
  expect(crit.decision).toBe("blocked"); expect(crit.reasons[0]!.message).toContain("1 critical"); expect(crit.reasons[0]!.message).toContain("fixed in a newer version");
  // Build tooling: visible, not blocking.
  const tool = evaluate(findings({ vulns: [vuln("critical", { build: true })] }), "a", { sourceKind: "git" }, p, []);
  expect(tool.decision).toBe("warned"); expect(tool.reasons[0]!.rule).toBe("vulnerabilities-tooling");
  expect(evaluate(findings({ vulns: [vuln("high")] }), "a", { sourceKind: "git" }, { ...p, vulnSeverity: "high" }, []).decision).toBe("blocked");
  expect(evaluate(findings({ vulns: [vuln("critical")] }), "a", { sourceKind: "git" }, { ...p, enforce: false }, []).decision).toBe("warned");
  const sec = { rule: "aws-access-key", title: "AWS access key ID", severity: "high" as const, file: "a.ts", line: 3, preview: "AKIA…", fingerprint: "fp1" };
  expect(evaluate(findings({ secrets: [sec] }), "a", { sourceKind: "git" }, p, []).decision).toBe("blocked");
  expect(evaluate(findings({ packages: [{ ...findings().packages[0]!, license: "AGPL-3.0" }] }), "a", { sourceKind: "git" }, p, []).decision).toBe("blocked");
  expect(evaluate(findings({ missingLockfiles: ["package.json"] }), "a", { sourceKind: "git" }, p, []).reasons[0]!.rule).toBe("lockfile");
  expect(evaluate(findings(), "a", { sourceKind: "upload" }, { ...p, requireGitSource: true }, []).decision).toBe("blocked");
  expect(evaluate(findings(), "a", { sourceKind: "git", branch: "feature" }, { ...p, allowedBranches: ["main"] }, []).decision).toBe("blocked");
  // Waivers by advisory id or alias, by secret fingerprint, scoped to an app.
  const w = (kind: string, ref: string, app = "*") => ({ id: "w", app, kind, ref, reason: "r", expiresAt: null, createdBy: "t", createdAt: 0, revokedAt: null, revokedBy: null });
  const waived = evaluate(findings({ vulns: [vuln("critical")] }), "a", { sourceKind: "git" }, p, [w("vuln", "CVE-1-critical")]);
  expect(waived.decision).toBe("passed"); expect(waived.waived).toBe(1);
  expect(evaluate(findings({ secrets: [sec] }), "a", { sourceKind: "git" }, p, [w("secret", "fp1")]).decision).toBe("passed");
  expect(evaluate(findings({ vulns: [vuln("critical")] }), "a", { sourceKind: "git" }, p, [w("vuln", "GHSA-critical", "b")].filter((x) => x.app === "*" || x.app === "a")).decision).toBe("blocked");
});

test("SBOM is CycloneDX 1.5 with purls, licenses and vulnerabilities", () => {
  const b = sbom("app", "abc", findings({ vulns: [vuln("high")], packages: [{ ...findings().packages[0]!, name: "@scope/pkg", purl: "pkg:npm/%40scope/pkg@4.0.0" }] })) as any;
  expect(b.bomFormat).toBe("CycloneDX"); expect(b.specVersion).toBe("1.5");
  expect(b.components[0]).toMatchObject({ group: "@scope", name: "pkg", purl: "pkg:npm/%40scope/pkg@4.0.0", licenses: [{ license: { id: "MIT" } }] });
  expect(b.vulnerabilities[0].recommendation).toContain("4.1.0");
});

test("deploys are gated: a secret blocks an upload with the reason in the log; a waiver lets it through", async () => {
  config.dataDir = mkdtempSync(join(tmpdir(), "fiq-"));
  const app = buildApp();
  const h = { authorization: `Bearer ${mintToken({ name: "ci", role: "operator", createdBy: "t" }).secret}` };
  repo.createApp({ name: "shop", prefix: "shop", description: null, managed: 0, desiredNodes: 0, nodeImage: null, healthPath: "/", createdBy: "t" });
  const proj = mkdtempSync(join(tmpdir(), "proj-"));
  writeFileSync(join(proj, "wrangler.jsonc"), `{ "name": "shop", "main": "index.js" }`);
  writeFileSync(join(proj, "index.js"), `const key = "AKIA${"IOSFODNN7REALKEY"}";\nexport default { fetch() { return new Response("ok") } }`);
  const tgz = join(proj, "..", `shop-${Date.now()}.tgz`);
  expect(Bun.spawnSync(["tar", "czf", tgz, "-C", proj, "."]).exitCode).toBe(0);
  const upload = async () => { const fd = new FormData(); fd.set("bundle", new File([await Bun.file(tgz).arrayBuffer()], "shop.tgz")); return app.request("/api/apps/shop/deploy", { method: "POST", headers: h, body: fd }); };
  const r = await upload();
  const body = (await r.json()) as any;
  expect(r.status).toBe(422); expect(body.error).toContain("blocked by policy"); expect(body.error).toContain("AWS access key ID in index.js:1");
  const dep = repo.listDeployments("shop", 1)[0]!;
  expect(dep.log).toContain("Policy: blocked");
  const scans = (await (await app.request("/api/compliance/scans?app=shop", { headers: h })).json()) as any[];
  expect(scans[0].status).toBe("blocked");
  const full = (await (await app.request(`/api/compliance/scans/${scans[0].id}`, { headers: h })).json()) as any;
  const fp = full.findings.secrets[0].fingerprint;
  expect(repo.listAudit(5).some((a) => a.action === "policy.block")).toBe(true);
  // A waiver needs a reason; then the gate passes and the deploy goes on to celld (which isn't here).
  expect((await app.request("/api/compliance/waivers", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ app: "shop", kind: "secret", ref: fp, reason: "short" }) })).status).toBe(400);
  expect((await app.request("/api/compliance/waivers", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ app: "shop", kind: "secret", ref: fp, reason: "AWS's documented example key, used in a test fixture" }) })).status).toBe(201);
  const r2 = await upload(); const b2 = (await r2.json()) as any;
  expect(String(b2.error ?? "")).not.toContain("blocked by policy");
  const posture = (await (await app.request("/api/compliance", { headers: h })).json()) as any;
  expect(posture.controls.map((c: any) => c.id)).toContain("change-mgmt");
  expect(posture.policy.enforce).toBe(true);
  // Evidence: JSON with an integrity hash; HTML report.
  const ev = (await (await app.request("/api/compliance/evidence?days=7", { headers: h })).json()) as any;
  expect(ev.integrity.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(ev.changes.some((c: any) => c.blockedByPolicy)).toBe(true);
  expect(ev.waivers[0].reason).toContain("documented example");
  expect(ev.access.tokens[0].hash).toBeUndefined();
  const html = await (await app.request("/api/compliance/evidence?days=7&format=html", { headers: h })).text();
  expect(html).toContain("Compliance evidence"); expect(html).toContain(ev.integrity.digest.slice(0, 8).length ? "Integrity" : "");
  // Policy changes are audited and validated.
  expect((await app.request("/api/compliance/policy", { method: "PUT", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ vulnSeverity: "high", requireGitSource: true }) })).status).toBe(200);
  expect(repo.listAudit(3).find((a) => a.action === "policy.update")!.detail).toContain('vulnSeverity: "critical" → "high"');
  expect((await app.request("/api/compliance/policy", { method: "PUT", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ vulnSeverity: "extreme" }) })).status).toBe(400);
  void addWaiver; void setPolicy;
});

test("viewer tokens can read compliance but not change policy or waivers", async () => {
  const app = buildApp();
  const v = { authorization: `Bearer ${mintToken({ name: "auditor", role: "viewer", createdBy: "t" }).secret}`, "content-type": "application/json" };
  expect((await app.request("/api/compliance", { headers: v })).status).toBe(200);
  expect((await app.request("/api/compliance/policy", { method: "PUT", headers: v, body: JSON.stringify({ enforce: false }) })).status).toBe(403);
  expect((await app.request("/api/compliance/waivers", { method: "POST", headers: v, body: JSON.stringify({ kind: "rule", ref: "lockfile", reason: "a long enough reason" }) })).status).toBe(403);
});
