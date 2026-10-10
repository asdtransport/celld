import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/runtime";
import { settings, type Waiver, waivers } from "../db/schema";
import { type Severity, sevRank, type Vuln } from "./intel";
import type { ScanFindings } from "./scan";

// Policy gates: rules every deploy is checked against before it goes live. "enforce" blocks a
// deploy that breaks a rule; "warn" lets it through and records the warning (useful while a team
// cleans up). Waivers are recorded exceptions for one finding, with a reason and an expiry.

export const PolicySchema = z.object({
  enforce: z.boolean().default(true),
  vulnSeverity: z.enum(["off", "critical", "high", "moderate", "low"]).default("critical"),
  vulnIncludeDev: z.boolean().default(false),          // also block on dev-only packages (test and type tooling)
  vulnIncludeBuild: z.boolean().default(false),        // also block on build tooling in sub-folders (web/, docs/)
  failIfUnchecked: z.boolean().default(false),         // block when the advisory database can't be reached
  secrets: z.boolean().default(true),
  blockedLicenses: z.array(z.string().trim().min(1).max(60)).max(50).default(["AGPL-1.0", "AGPL-3.0", "SSPL-1.0", "BUSL-1.1"]),
  requireLockfile: z.boolean().default(true),
  requireGitSource: z.boolean().default(false),        // no uploads from laptops: everything comes from a repo
  allowedBranches: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  requireChecks: z.boolean().default(false),           // type check and tests must run in the build
  configChecks: z.boolean().default(true),             // secrets in wrangler vars block the deploy
  waiverMaxDays: z.number().int().min(1).max(365).default(90),
});
export type Policy = z.infer<typeof PolicySchema>;
const KEY = "compliance.policy";

export function getPolicy(): Policy {
  const r = getDb().select().from(settings).where(eq(settings.key, KEY)).get();
  return PolicySchema.parse(r ? JSON.parse(r.value) : {});
}
export function getPolicyMeta() { const r = getDb().select().from(settings).where(eq(settings.key, KEY)).get(); return r ? { updatedBy: r.updatedBy, updatedAt: r.updatedAt } : null; }
export function setPolicy(p: Partial<Policy>, actor: string): Policy {
  const next = PolicySchema.parse({ ...getPolicy(), ...p });
  const value = JSON.stringify(next);
  getDb().insert(settings).values({ key: KEY, value, updatedBy: actor }).onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: actor, updatedAt: Math.floor(Date.now() / 1000) } }).run();
  return next;
}

// ---- waivers ----
export const WaiverIn = z.object({
  app: z.string().trim().min(1).max(80).default("*"),
  kind: z.enum(["vuln", "secret", "license", "rule"]),
  ref: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(10, "say why (at least 10 characters): auditors read this").max(1000),
  days: z.number().int().min(1).max(365).optional(),
});
export const listWaivers = (all = false): Waiver[] => {
  const q = getDb().select().from(waivers);
  return (all ? q : q.where(isNull(waivers.revokedAt))).orderBy(desc(waivers.createdAt)).all();
};
export function addWaiver(w: z.infer<typeof WaiverIn>, actor: string): Waiver {
  const max = getPolicy().waiverMaxDays;
  const days = Math.min(w.days ?? max, max);
  const id = `wv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  getDb().insert(waivers).values({ id, app: w.app, kind: w.kind, ref: w.ref, reason: w.reason, expiresAt: Math.floor(Date.now() / 1000) + days * 86_400, createdBy: actor }).run();
  return getDb().select().from(waivers).where(eq(waivers.id, id)).get()!;
}
export function revokeWaiver(id: string, actor: string) {
  return (getDb().update(waivers).set({ revokedAt: Math.floor(Date.now() / 1000), revokedBy: actor }).where(and(eq(waivers.id, id), isNull(waivers.revokedAt))).run() as unknown as { changes: number }).changes > 0;
}
export function activeWaivers(app: string, at = Math.floor(Date.now() / 1000)) {
  return listWaivers().filter((w) => (w.app === "*" || w.app === app) && (!w.expiresAt || w.expiresAt > at));
}

// ---- the gate ----
export interface GateContext { sourceKind: "git" | "upload" | "current"; branch?: string | null; checks?: boolean | null }
export interface GateReason { rule: string; message: string; blocking: boolean; waived?: string[] }
export interface GateResult { decision: "passed" | "warned" | "blocked"; reasons: GateReason[]; policy: Policy; waived: number }

const normLic = (x: string) => x.trim().toUpperCase().replace(/-(ONLY|OR-LATER)$/, "").replace(/\+$/, "");
// "MIT OR AGPL-3.0" is fine (you may choose MIT); "MIT AND AGPL-3.0" is not. Returns the blocked id or null.
export function licenseBlocked(lic: string | null, blocked: string[]): string | null {
  if (!lic) return null;
  const bad = new Set(blocked.map(normLic));
  const options = lic.replace(/[()]/g, " ").split(/\s+OR\s+/i);
  let first: string | null = null;
  for (const o of options) {
    const hit = o.split(/\s+AND\s+/i).map(normLic).find((p) => bad.has(p));
    if (!hit) return null;
    first ??= hit;
  }
  return first;
}

export function evaluate(f: ScanFindings, app: string, ctx: GateContext, policy = getPolicy(), waiverList = activeWaivers(app)): GateResult {
  const reasons: GateReason[] = [];
  let waivedCount = 0;
  // A waiver matches by kind (or "rule" for a whole rule) and any of the finding's ids.
  const waived = (kind: string, refs: string[]) => waiverList.find((w) => (w.kind === kind || w.kind === "rule") && refs.some((r) => r.toLowerCase() === w.ref.toLowerCase()));
  const block = policy.enforce;

  // Vulnerabilities at or above the threshold.
  if (policy.vulnSeverity !== "off") {
    const min = sevRank(policy.vulnSeverity);
    const counts = (v: Vuln) => (policy.vulnIncludeDev || !v.dev) && (policy.vulnIncludeBuild || !v.build);
    const hits = f.vulns.filter((v) => sevRank(v.severity) >= min && counts(v));
    // Tooling advisories don't block (they never run in the app) but stay visible.
    const tooling = f.vulns.filter((v) => sevRank(v.severity) >= min && !counts(v));
    if (tooling.length) reasons.push({ rule: "vulnerabilities-tooling", blocking: false, message: `${tooling.length} advisor${tooling.length > 1 ? "ies" : "y"} at ${policy.vulnSeverity} or above in build or dev tooling (not shipped in the Worker): ${[...new Set(tooling.slice(0, 4).map((v) => `${v.package}@${v.version}`))].join(", ")}` });
    const open = hits.filter((v) => { const w = waived("vuln", [v.id, ...v.aliases, `${v.package}@${v.version}`]); if (w) waivedCount++; return !w; });
    if (open.length) {
      const by = (s: Severity) => open.filter((v) => v.severity === s).length;
      const parts = (["critical", "high", "moderate", "low"] as Severity[]).filter((s) => by(s)).map((s) => `${by(s)} ${s}`);
      const fixable = open.filter((v) => v.fixed).length;
      reasons.push({ rule: "vulnerabilities", blocking: block, message: `${open.length} vulnerable package${open.length > 1 ? "s" : ""} at ${policy.vulnSeverity} or above (${parts.join(", ")})${fixable ? `; ${fixable} fixed in a newer version` : ""}: ${[...new Set(open.slice(0, 5).map((v) => `${v.package}@${v.version}`))].join(", ")}` });
    }
    if (f.vulnError) reasons.push({ rule: "vulnerabilities-unchecked", blocking: block && policy.failIfUnchecked, message: f.vulnError });
  }
  // Secrets in source or config.
  if (policy.secrets) {
    const open = f.secrets.filter((s) => { const w = waived("secret", [s.fingerprint, s.rule]); if (w) waivedCount++; return !w; });
    if (open.length) reasons.push({ rule: "secrets", blocking: block, message: `${open.length} secret${open.length > 1 ? "s" : ""} in the code: ${open.slice(0, 3).map((s) => `${s.title} in ${s.file}:${s.line}`).join("; ")}` });
  }
  if (policy.configChecks) {
    for (const c of f.config.filter((c) => c.severity === "high")) {
      if (waived("rule", [c.rule])) { waivedCount++; continue; }
      reasons.push({ rule: c.rule, blocking: block, message: c.message });
    }
  }
  // Licenses.
  if (policy.blockedLicenses.length) {
    const hits = f.packages.map((p) => ({ p, b: licenseBlocked(p.license, policy.blockedLicenses) })).filter((x) => x.b && !x.p.dev && !x.p.build);
    const open = hits.filter(({ p, b }) => { const w = waived("license", [b!, `${p.name}@${p.version}`, p.name]); if (w) waivedCount++; return !w; });
    if (open.length) reasons.push({ rule: "licenses", blocking: block, message: `${open.length} package${open.length > 1 ? "s" : ""} under a blocked license: ${open.slice(0, 5).map(({ p }) => `${p.name}@${p.version} (${p.license})`).join(", ")}` });
  }
  if (policy.requireLockfile && f.missingLockfiles.length && !waived("rule", ["lockfile"])) reasons.push({ rule: "lockfile", blocking: block, message: `no lockfile for ${f.missingLockfiles.join(", ")}: versions aren't pinned, so the scan can't see what will be installed` });
  if (policy.requireGitSource && ctx.sourceKind === "upload" && !waived("rule", ["git-source"])) reasons.push({ rule: "git-source", blocking: block, message: "this deploy is an upload; policy requires deploys to come from a Git source" });
  if (policy.allowedBranches.length && ctx.sourceKind === "git" && ctx.branch && !policy.allowedBranches.includes(ctx.branch)) reasons.push({ rule: "branch", blocking: block, message: `branch ${ctx.branch} is not one of ${policy.allowedBranches.join(", ")}` });
  if (policy.requireChecks && ctx.checks === false && !waived("rule", ["checks"])) reasons.push({ rule: "checks", blocking: block, message: "the build skipped the type check and tests; policy requires them" });

  const decision = reasons.some((r) => r.blocking) ? "blocked" : reasons.length ? "warned" : "passed";
  return { decision, reasons, policy, waived: waivedCount };
}
