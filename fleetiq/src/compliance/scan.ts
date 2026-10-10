import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/runtime";
import { type Scan, scans } from "../db/schema";
import { parseJsonc } from "../services/deploy";
import { fillLicenses, type Vuln, vulnerabilities } from "./intel";
import { inventory, type Pkg } from "./inventory";
import { evaluate, type GateContext, type GateResult, getPolicy, licenseBlocked } from "./policy";
import { scanSecrets, type SecretFinding } from "./secrets";

// One scan = inventory → vulnerabilities → licenses → secrets → config checks → SBOM → gate.
// Every deploy runs one before anything goes live; "Scan now" runs one without deploying.

export interface ConfigFinding { rule: string; severity: "high" | "moderate" | "low"; message: string; file: string }
export interface ScanFindings {
  packages: Pkg[]; lockfiles: string[]; missingLockfiles: string[];
  vulns: Vuln[]; vulnError: string | null;
  secrets: SecretFinding[]; config: ConfigFinding[];
  filesScanned: number;
}
export interface ScanSummary {
  packages: number; direct: number; lockfiles: string[];
  vulns: Record<"critical" | "high" | "moderate" | "low" | "unknown", number>; fixable: number;
  secrets: number; config: number; licensesUnknown: number; licensesBlocked: number;
  filesScanned: number; ms: number; vulnError: string | null;
}

const SECRET_VAR = /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY/i;
// Vars FleetIQ fills in on the server it deploys to (never in the repo).
const FILLED_BY_FLEETIQ = new Set(["FLEETIQ_MIGRATE_TOKEN", "AUTH_PUBLIC_KEY_B64"]);

// Wrangler config: secrets in plain vars end up readable by anyone who can read the deploy.
export async function configChecks(root: string, files: string[]): Promise<ConfigFinding[]> {
  const out: ConfigFinding[] = [];
  for (const f of files.filter((x) => /(^|\/)wrangler\.jsonc?$/.test(x))) {
    let cfg: any; try { cfg = parseJsonc(await Bun.file(join(root, f)).text()); } catch { out.push({ rule: "config-invalid", severity: "moderate", message: `${f} is not valid JSONC`, file: f }); continue; }
    const envs = [{ name: "", vars: cfg.vars ?? {} }, ...Object.entries<any>(cfg.env ?? {}).map(([n, e]) => ({ name: n, vars: e?.vars ?? {} }))];
    for (const e of envs) for (const [k, v] of Object.entries<any>(e.vars)) {
      if (typeof v === "string" && v.length >= 8 && SECRET_VAR.test(k) && !/PUBLIC/i.test(k) && !FILLED_BY_FLEETIQ.has(k)) {
        out.push({ rule: "config-secret-var", severity: "high", file: f, message: `${f}: ${e.name ? `env ${e.name} ` : ""}var ${k} holds a secret in plain text; make it a Worker secret (wrangler secret put ${k}) and leave the var empty` });
      }
    }
    const mode = cfg.vars?.AUTH_MODE;
    if (mode === "none") out.push({ rule: "config-no-auth", severity: "moderate", file: f, message: `${f}: AUTH_MODE is "none": anyone who can reach the app can use it` });
    const cd = Date.parse(cfg.compatibility_date ?? "");
    if (cd && Date.now() - cd > 548 * 86_400_000) out.push({ rule: "config-old-compat", severity: "low", file: f, message: `${f}: compatibility_date ${cfg.compatibility_date} is over 18 months old` });
  }
  return out;
}

export function sbom(app: string, version: string | null, f: Pick<ScanFindings, "packages" | "vulns">) {
  const comp = (p: Pkg) => {
    const scoped = p.name.startsWith("@") ? p.name.split("/") : null;
    return {
      type: "library", "bom-ref": p.purl, ...(scoped ? { group: scoped[0], name: scoped[1] } : { name: p.name }), version: p.version, purl: p.purl,
      ...(p.license ? { licenses: [/\s(OR|AND)\s/i.test(p.license) ? { expression: p.license } : { license: { id: p.license } }] } : {}),
      scope: p.dev ? "excluded" : "required",
    };
  };
  return {
    bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
    metadata: { timestamp: new Date().toISOString(), tools: { components: [{ type: "application", name: "FleetIQ" }] }, component: { type: "application", name: app, ...(version ? { version } : {}), "bom-ref": `app:${app}` } },
    components: f.packages.map(comp),
    vulnerabilities: f.vulns.map((v) => ({
      id: v.id, source: { name: "OSV", url: v.url }, ratings: [{ severity: v.severity === "moderate" ? "medium" : v.severity }],
      description: v.summary, affects: [{ ref: f.packages.find((p) => p.name === v.package && p.version === v.version)?.purl ?? `${v.package}@${v.version}` }],
      ...(v.fixed ? { recommendation: `Upgrade ${v.package} to ${v.fixed} or later` } : {}),
    })),
  };
}

export async function scanDir(root: string): Promise<ScanFindings> {
  const inv = await inventory(root);
  const [vr, , sec, cfg] = await Promise.all([
    vulnerabilities(inv.packages),
    fillLicenses(inv.packages),
    scanSecrets(root, inv.files),
    configChecks(root, inv.files),
  ]);
  return { packages: inv.packages, lockfiles: inv.lockfiles, missingLockfiles: inv.missingLockfiles, vulns: vr.vulns, vulnError: vr.error, secrets: sec.findings, config: cfg, filesScanned: sec.scanned };
}

export function summarize(f: ScanFindings, ms: number, blocked: string[] = getPolicy().blockedLicenses): ScanSummary {
  const n = (s: string) => f.vulns.filter((v) => v.severity === s).length;
  return {
    packages: f.packages.length, direct: f.packages.filter((p) => p.direct).length, lockfiles: f.lockfiles,
    vulns: { critical: n("critical"), high: n("high"), moderate: n("moderate"), low: n("low"), unknown: n("unknown") }, fixable: f.vulns.filter((v) => v.fixed).length,
    secrets: f.secrets.length, config: f.config.length,
    licensesUnknown: f.packages.filter((p) => !p.license).length,
    licensesBlocked: f.packages.filter((p) => licenseBlocked(p.license, blocked)).length,
    filesScanned: f.filesScanned, ms, vulnError: f.vulnError,
  };
}

// The scanned project root inside an extracted archive or source tree: where wrangler.jsonc is,
// or the folder itself.
export async function projectRootIn(dir: string, sub = ""): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  // GitHub tarballs wrap everything in one "<owner>-<repo>-<sha>/" folder.
  const base = entries.length === 1 && entries[0]!.isDirectory() ? join(dir, entries[0]!.name) : dir;
  return sub ? join(base, sub.replace(/^\/+|\/+$/g, "")) : base;
}

export interface ScanRun { scan: Scan; findings: ScanFindings; summary: ScanSummary; gate: GateResult }
export async function runScan(root: string, meta: { app: string; trigger: "deploy" | "manual" | "cloudflare"; ctx: GateContext; deployment?: string | null; source?: string | null; commit?: string | null; actor: string }): Promise<ScanRun> {
  const t0 = Date.now();
  const id = `scan_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let findings: ScanFindings;
  try { findings = await scanDir(root); }
  catch (e: any) {
    getDb().insert(scans).values({ id, app: meta.app, deployment: meta.deployment ?? null, trigger: meta.trigger, source: meta.source ?? null, sourceKind: meta.ctx.sourceKind, commitSha: meta.commit ?? null, status: "error", summary: JSON.stringify({ error: e.message }), actor: meta.actor }).run();
    throw e;
  }
  const summary = summarize(findings, Date.now() - t0);
  const gate = evaluate(findings, meta.app, meta.ctx);
  getDb().insert(scans).values({
    id, app: meta.app, deployment: meta.deployment ?? null, trigger: meta.trigger, source: meta.source ?? null, sourceKind: meta.ctx.sourceKind, commitSha: meta.commit ?? null,
    status: gate.decision, summary: JSON.stringify(summary), findings: JSON.stringify(findings), sbom: JSON.stringify(sbom(meta.app, meta.commit?.slice(0, 12) ?? null, findings)),
    gate: JSON.stringify({ decision: gate.decision, reasons: gate.reasons, waived: gate.waived }), actor: meta.actor,
  }).run();
  return { scan: getScan(id)!, findings, summary, gate };
}

// One line per scan for deploy logs.
export function scanLines(r: ScanRun): string[] {
  const s = r.summary; const v = s.vulns;
  const lines = [
    `Scan: ${s.packages} packages from ${s.lockfiles.length ? s.lockfiles.join(", ") : "no lockfile"}; vulnerabilities ${v.critical} critical, ${v.high} high, ${v.moderate} moderate, ${v.low} low${s.fixable ? ` (${s.fixable} fixable)` : ""}; secrets ${s.secrets}; ${s.filesScanned} files read (${(s.ms / 1000).toFixed(1)} s)`,
  ];
  if (s.vulnError) lines.push(`  ! ${s.vulnError}`);
  for (const reason of r.gate.reasons) lines.push(`  ${reason.blocking ? "✗" : "!"} ${reason.message}`);
  lines.push(r.gate.decision === "blocked" ? `Policy: blocked. Fix the findings, or record a waiver in Compliance (scan ${r.scan.id}).`
    : r.gate.decision === "warned" ? `Policy: passed with warnings${r.gate.policy.enforce ? "" : " (policy is in warn-only mode)"}`
    : `Policy: passed${r.gate.waived ? ` (${r.gate.waived} waived)` : ""}`);
  return lines;
}

export const getScan = (id: string) => getDb().select().from(scans).where(eq(scans.id, id)).get();
export const setScanVersion = (id: string, version: string | null, deployment?: string) => getDb().update(scans).set({ version, ...(deployment ? { deployment } : {}) }).where(eq(scans.id, id)).run();
export const listScans = (app?: string, limit = 50): Scan[] => {
  const q = getDb().select().from(scans);
  return (app ? q.where(eq(scans.app, app)) : q).orderBy(desc(scans.createdAt), desc(scans.id)).limit(limit).all();
};
export const scanForVersion = (app: string, version: string) => getDb().select().from(scans).where(and(eq(scans.app, app), eq(scans.version, version))).orderBy(desc(scans.createdAt)).get();
export const latestScan = (app: string) => listScans(app, 1)[0] ?? null;

// Re-check a stored scan against today's policy and waivers (policies change; waivers expire).
export function reevaluate(s: Scan, ctx?: GateContext): GateResult | null {
  if (!s.findings) return null;
  return evaluate(JSON.parse(s.findings), s.app, ctx ?? { sourceKind: (s.sourceKind as any) ?? "upload" });
}
