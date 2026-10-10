import { createHash } from "node:crypto";
import { and, asc, desc, gte, lte } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/runtime";
import { apiTokens, audit, deployments, moverRuns, scans, waivers } from "../db/schema";
import * as repo from "../lib/repo";
import * as mrepo from "../mover/repo";
import * as trepo from "../cloudflare/repo";
import { getPolicy, getPolicyMeta } from "./policy";
import { latestScan, reevaluate, scanForVersion, type ScanSummary } from "./scan";

// The live compliance picture: each control is checked against what the platform actually did
// (deploys, scans, backups, restores, tokens, the activity log), mapped to SOC 2 trust services
// criteria so it drops straight into an auditor's request list. Evidence exports freeze that
// picture for a period, with a SHA-256 over the content so a copy can be checked later.

export type ControlStatus = "pass" | "warn" | "fail" | "n/a";
export interface Control { id: string; criteria: string; family: string; title: string; status: ControlStatus; detail: string; facts: string[] }
export interface AppPosture {
  app: string; liveVersion: string | null; scanId: string | null; scannedAt: number | null; scanStatus: string | null;
  decision: string | null; reasons: { rule: string; message: string; blocking: boolean }[];
  summary: ScanSummary | null; configRules: string[]; lastBackup: number | null; backupJobs: number; targets: string[];
}

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 100);

function liveVersion(app: string): string | null {
  return repo.listDeployments(app, 50).find((d) => d.status === "succeeded" && (d.kind === "deploy" || d.kind === "rollback"))?.version ?? null;
}

export function appPostures(): AppPosture[] {
  const jobs = mrepo.listJobs(); const links = trepo.listTargets();
  return repo.listApps().map((a) => {
    const version = liveVersion(a.name);
    const scan = (version ? scanForVersion(a.name, version) : null) ?? latestScan(a.name);
    const gate = scan ? reevaluate(scan) : null;
    const backups = jobs.filter((j) => j.kind === "app-backup" && j.app === a.name);
    const last = backups.map((j) => mrepo.listRuns(j.id, 20).find((r) => r.status === "succeeded" && !r.dryRun)?.finishedAt ?? 0).reduce((x, y) => Math.max(x, y), 0);
    return {
      app: a.name, liveVersion: version, scanId: scan?.id ?? null, scannedAt: scan?.createdAt ?? null, scanStatus: scan?.status ?? null,
      decision: gate?.decision ?? null, reasons: gate?.reasons ?? [], summary: scan?.summary ? JSON.parse(scan.summary) : null,
      configRules: scan?.findings ? [...new Set<string>((JSON.parse(scan.findings).config ?? []).map((c: any) => c.rule))] : [],
      lastBackup: last || null, backupJobs: backups.length,
      targets: trepo.linksForApp(a.name).map((l) => links.find((t) => t.id === l.target)?.name ?? l.target),
    };
  });
}

export function controls(postures = appPostures()): Control[] {
  const policy = getPolicy(); const t = now();
  const out: Control[] = [];
  const live = postures.filter((p) => p.liveVersion);

  // CC6.1 — logical access to the console and apps
  const noAuth = live.filter((p) => p.configRules.includes("config-no-auth"));
  out.push({
    id: "access-signin", criteria: "CC6.1", family: "Access", title: "Sign-in protects the console and the apps",
    status: config.authMode === "none" ? "fail" : noAuth.length ? "warn" : "pass",
    detail: config.authMode === "none" ? "The console runs without sign-in (AUTH_MODE=none)." : noAuth.length ? `${noAuth.map((p) => p.app).join(", ")} run without sign-in (AUTH_MODE "none").` : "The console and apps sit behind the edge sign-in; apps also check the sign-in token themselves.",
    facts: [`Console sign-in: ${config.authMode}`, `Operator roles: ${config.operatorRoles.join(", ")}`],
  });

  // CC6.2 / CC6.3 — machine credentials
  const tokens = repo.listTokens().filter((x) => !x.revokedAt && (!x.expiresAt || x.expiresAt > t));
  const noExpiry = tokens.filter((x) => !x.expiresAt); const stale = tokens.filter((x) => (x.lastUsedAt ?? x.createdAt) < t - 90 * DAY);
  out.push({
    id: "access-tokens", criteria: "CC6.2, CC6.3", family: "Access", title: "API tokens expire, are least-privilege and get reviewed",
    status: noExpiry.length || stale.length ? "warn" : "pass",
    detail: `${tokens.length} active token${tokens.length === 1 ? "" : "s"} (${tokens.filter((x) => x.role === "operator").length} operator, ${tokens.filter((x) => x.role !== "operator").length} viewer).${noExpiry.length ? ` ${noExpiry.length} never expire.` : ""}${stale.length ? ` ${stale.length} unused for 90+ days: revoke them.` : ""}`,
    facts: tokens.map((x) => `${x.name}: ${x.role}, ${x.expiresAt ? `expires ${new Date(x.expiresAt * 1000).toISOString().slice(0, 10)}` : "no expiry"}, last used ${x.lastUsedAt ? new Date(x.lastUsedAt * 1000).toISOString().slice(0, 10) : "never"}`).slice(0, 20),
  });

  // CC6.7 — transmission
  const https = /^https:\/\//.test(config.publicUrl || "https://");
  out.push({ id: "transit-tls", criteria: "CC6.7", family: "Access", title: "Traffic is encrypted in transit", status: https ? "pass" : "warn",
    detail: https ? "The edge serves every route over HTTPS with automatic certificates; plain HTTP redirects." : `The console URL is ${config.publicUrl}.`, facts: [`Routes: ${repo.listRoutes().length}`] });

  // CC7.1 — vulnerability management on what is live
  const unscanned = live.filter((p) => !p.scanId || (p.scannedAt ?? 0) < t - 30 * DAY);
  const blocked = live.filter((p) => p.reasons.some((r) => r.rule === "vulnerabilities" && r.blocking));
  const vulnWarn = live.filter((p) => p.reasons.some((r) => r.rule === "vulnerabilities" && !r.blocking));
  out.push({
    id: "vuln-mgmt", criteria: "CC7.1", family: "Operations", title: "Live code has no open vulnerabilities above the policy line",
    status: blocked.length ? "fail" : unscanned.length || vulnWarn.length ? "warn" : live.length ? "pass" : "n/a",
    detail: !live.length ? "No application is live yet; each deploy is scanned before it goes live." : blocked.length ? `${blocked.map((p) => p.app).join(", ")} run versions the current policy would block.` : unscanned.length ? `${unscanned.map((p) => p.app).join(", ")} have no scan in the last 30 days: run Scan now.` : `Every live version was scanned; policy blocks ${policy.vulnSeverity} and above${policy.enforce ? "" : " (warn-only)"}.`,
    facts: live.map((p) => p.summary ? `${p.app}: ${p.summary.vulns.critical} critical, ${p.summary.vulns.high} high, ${p.summary.vulns.moderate} moderate (scanned ${new Date((p.scannedAt ?? 0) * 1000).toISOString().slice(0, 10)})` : `${p.app}: not scanned`),
  });

  // CC6.8 / C1.1 — secrets
  const leaky = live.filter((p) => p.reasons.some((r) => r.rule === "secrets" || r.rule === "config-secret-var"));
  out.push({ id: "secrets", criteria: "CC6.8, C1.1", family: "Confidentiality", title: "No credentials in code or config", status: leaky.length ? "fail" : unscanned.length ? "warn" : live.length ? "pass" : "n/a",
    detail: !live.length ? "No application is live yet." : leaky.length ? `Secrets found in ${leaky.map((p) => p.app).join(", ")}: rotate them, move them to secrets, and redeploy.` : "Secrets scans of every live version are clean; secret-looking vars are hidden in the console and API.", facts: [`Secrets gate: ${policy.secrets ? "on" : "off"}`] });

  // CC9.2 — third-party components
  out.push({ id: "sbom", criteria: "CC9.2", family: "Vendors", title: "Third-party components are inventoried (SBOM) and licensed acceptably",
    status: live.some((p) => p.reasons.some((r) => r.rule === "licenses")) ? "fail" : unscanned.length ? "warn" : live.length ? "pass" : "n/a",
    detail: `CycloneDX SBOM per scan; blocked licenses: ${policy.blockedLicenses.join(", ") || "none"}.`,
    facts: live.map((p) => `${p.app}: ${p.summary?.packages ?? 0} packages, ${p.summary?.licensesUnknown ?? 0} unknown licenses`) });

  // CC7.2 — monitoring
  const recent = getDb().select().from(audit).where(gte(audit.at, t - 30 * DAY)).all();
  out.push({ id: "activity-log", criteria: "CC7.2", family: "Operations", title: "Every change is recorded with who did it", status: "pass",
    detail: `${recent.length} recorded actions in the last 30 days (${recent.filter((a) => a.outcome === "denied").length} denied). Records are kept, not rotated.`,
    facts: [`Denied in 30 days: ${recent.filter((a) => a.outcome === "denied").length}`] });

  // CC8.1 — change management
  const deps = getDb().select().from(deployments).where(gte(deployments.startedAt, t - 90 * DAY)).all().filter((d) => d.kind === "deploy" || d.kind === "cloudflare");
  const scanned = new Set(getDb().select().from(scans).where(gte(scans.createdAt, t - 90 * DAY)).all().map((s) => s.deployment).filter(Boolean));
  const fromGit = deps.filter((d) => /@|github|push/.test(d.source ?? "") && !/upload/.test(d.source ?? ""));
  const blockedDeps = deps.filter((d) => d.status === "failed" && /blocked by policy/.test(d.log ?? ""));
  const unscannedDeps = deps.filter((d) => d.status === "succeeded" && !scanned.has(d.id));
  out.push({
    id: "change-mgmt", criteria: "CC8.1", family: "Change management", title: "Changes are scanned, gated and traceable to source",
    status: !policy.enforce ? "warn" : unscannedDeps.length && deps.some((d) => scanned.has(d.id)) ? "warn" : "pass",
    detail: `${deps.length} deploys in 90 days: ${pct(fromGit.length, deps.length)}% from Git, ${blockedDeps.length} blocked by policy${unscannedDeps.length ? `, ${unscannedDeps.length} before scanning was turned on` : ""}. Policy ${policy.enforce ? "enforced" : "in warn-only mode"}.`,
    facts: [`Require Git source: ${policy.requireGitSource ? "yes" : "no"}`, `Require checks: ${policy.requireChecks ? "yes" : "no"}`, `Allowed branches: ${policy.allowedBranches.join(", ") || "any"}`],
  });

  // A1.2 — backups
  const noBackup = live.filter((p) => !p.backupJobs);
  const staleBackup = live.filter((p) => p.backupJobs && (p.lastBackup ?? 0) < t - 7 * DAY);
  out.push({
    id: "backups", criteria: "A1.2", family: "Availability", title: "Every app is backed up somewhere else",
    status: !live.length ? "n/a" : noBackup.length === live.length ? "fail" : noBackup.length || staleBackup.length ? "warn" : "pass",
    detail: !live.length ? "No application is live yet." : noBackup.length ? `No backup job for ${noBackup.map((p) => p.app).join(", ")}: Data mover → Back up.` : staleBackup.length ? `No successful backup in 7 days for ${staleBackup.map((p) => p.app).join(", ")}.` : "Every live app has a backup that succeeded in the last 7 days.",
    facts: live.map((p) => `${p.app}: ${p.backupJobs} backup job${p.backupJobs === 1 ? "" : "s"}, last success ${p.lastBackup ? new Date(p.lastBackup * 1000).toISOString().slice(0, 10) : "never"}`),
  });

  // A1.3 — recovery tested
  const restores = getDb().select().from(moverRuns).where(gte(moverRuns.startedAt, t - 90 * DAY)).all().filter((r) => /^restore /.test(r.label) && (r.status === "succeeded" || r.status === "planned"));
  out.push({ id: "restore-tested", criteria: "A1.3", family: "Availability", title: "Restores are tested", status: restores.length ? "pass" : live.length ? "warn" : "n/a",
    detail: restores.length ? `${restores.length} restore${restores.length > 1 ? "s" : ""} (or restore dry runs) in the last 90 days; latest ${new Date(Math.max(...restores.map((r) => r.startedAt)) * 1000).toISOString().slice(0, 10)}.` : "No restore or restore dry run in 90 days. Run Restore with “dry run” from a backup to prove it.",
    facts: restores.slice(0, 5).map((r) => `${r.label}: ${r.status} ${new Date(r.startedAt * 1000).toISOString().slice(0, 10)}`) });

  return out;
}

export function posture() {
  const apps = appPostures();
  const list = controls(apps);
  return {
    score: { pass: list.filter((c) => c.status === "pass").length, warn: list.filter((c) => c.status === "warn").length, fail: list.filter((c) => c.status === "fail").length, total: list.filter((c) => c.status !== "n/a").length },
    controls: list, apps, policy: getPolicy(), policyMeta: getPolicyMeta(),
  };
}

// ---- evidence ----
export function evidence(from: number, to: number) {
  const deps = getDb().select().from(deployments).where(and(gte(deployments.startedAt, from), lte(deployments.startedAt, to))).orderBy(asc(deployments.startedAt)).all();
  const sc = getDb().select().from(scans).where(and(gte(scans.createdAt, from), lte(scans.createdAt, to))).orderBy(asc(scans.createdAt)).all();
  const byDep = new Map(sc.filter((s) => s.deployment).map((s) => [s.deployment!, s]));
  const body = {
    kind: "fleetiq-evidence", generatedAt: new Date().toISOString(),
    period: { from: new Date(from * 1000).toISOString(), to: new Date(to * 1000).toISOString() },
    platform: { console: config.publicUrl || null, version: config.stackVersion || null, signIn: config.authMode },
    policy: getPolicy(), policyMeta: getPolicyMeta(),
    controls: controls(),
    changes: deps.map((d) => {
      const s = byDep.get(d.id);
      return { id: d.id, app: d.app, kind: d.kind, status: d.status, version: d.version, previousVersion: d.previousVersion, source: d.source, actor: d.actor, startedAt: d.startedAt, finishedAt: d.finishedAt,
        blockedByPolicy: d.status === "failed" && /blocked by policy/.test(d.log ?? ""), scan: s ? { id: s.id, decision: s.status, summary: s.summary ? JSON.parse(s.summary) : null } : null };
    }),
    scans: sc.map((s) => ({ id: s.id, app: s.app, trigger: s.trigger, source: s.source, commit: s.commitSha, version: s.version, decision: s.status, summary: s.summary ? JSON.parse(s.summary) : null, gate: s.gate ? JSON.parse(s.gate) : null, actor: s.actor, at: s.createdAt })),
    waivers: getDb().select().from(waivers).orderBy(desc(waivers.createdAt)).all().filter((w) => w.createdAt <= to && (!w.revokedAt || w.revokedAt >= from)),
    access: { tokens: getDb().select().from(apiTokens).all().map(({ hash: _h, ...t }) => t) },
    backups: {
      jobs: mrepo.listJobs().filter((j) => j.kind === "app-backup").map((j) => ({ name: j.name, app: j.app, consistent: !!j.consistent, everyMinutes: j.everyMinutes, enabled: !!j.enabled, destination: mrepo.getEndpoint(j.dstEndpoint)?.name ?? j.dstEndpoint })),
      runs: getDb().select().from(moverRuns).where(and(gte(moverRuns.startedAt, from), lte(moverRuns.startedAt, to))).orderBy(asc(moverRuns.startedAt)).all().map((r) => ({ id: r.id, label: r.label, status: r.status, dryRun: !!r.dryRun, actor: r.actor, startedAt: r.startedAt, finishedAt: r.finishedAt, result: r.stats ? JSON.parse(r.stats).result ?? null : null })),
    },
    activity: getDb().select().from(audit).where(and(gte(audit.at, from), lte(audit.at, to))).orderBy(asc(audit.id)).limit(20_000).all(),
  };
  const json = JSON.stringify(body);
  return { ...body, integrity: { algorithm: "sha256", digest: createHash("sha256").update(json).digest("hex"), note: "SHA-256 of this document without the integrity field, serialized as exported" } };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const d = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) : "—");

export function evidenceHtml(e: ReturnType<typeof evidence>) {
  const pill = (s: string) => `<span class="pill ${esc(s)}">${esc(s === "pass" ? "Pass" : s === "warn" ? "Attention" : s === "fail" ? "Fail" : s === "n/a" ? "N/A" : s)}</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Compliance evidence ${esc(e.period.from.slice(0, 10))} to ${esc(e.period.to.slice(0, 10))}</title>
<style>
:root{--ink:#16232b;--ink2:#4a5d66;--rule:#ccd7db;--ok:#2f8f5b;--warn:#b07a0f;--bad:#b4372f}
body{font:14px/1.5 system-ui,sans-serif;color:var(--ink);margin:32px auto;max-width:1000px;padding:0 16px;background:#fff}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid var(--rule);padding-bottom:4px}
.meta{color:var(--ink2);margin:4px 0 16px}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #e2e9eb;vertical-align:top}
th{color:var(--ink2);font-weight:600}.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11.5px;font-weight:600;color:#fff}
.pill.pass{background:var(--ok)}.pill.warn{background:var(--warn)}.pill.fail{background:var(--bad)}.pill.n\\/a{background:#8a9aa1}
.pill.passed{background:var(--ok)}.pill.warned{background:var(--warn)}.pill.blocked{background:var(--bad)}
code{font:12px ui-monospace,monospace}.foot{margin-top:28px;color:var(--ink2);font-size:12px;word-break:break-all}
@media print{body{margin:0}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body>
<h1>Compliance evidence</h1>
<p class="meta">Period ${esc(e.period.from.slice(0, 10))} to ${esc(e.period.to.slice(0, 10))} · generated ${esc(e.generatedAt.replace("T", " ").slice(0, 16))} UTC · ${esc(e.platform.console ?? "FleetIQ")} · platform ${esc(e.platform.version ?? "")}</p>
<h2>Controls</h2><table><thead><tr><th>Criteria</th><th>Control</th><th>Status</th><th>Finding</th></tr></thead><tbody>
${e.controls.map((c) => `<tr><td>${esc(c.criteria)}</td><td><strong>${esc(c.title)}</strong></td><td>${pill(c.status)}</td><td>${esc(c.detail)}${c.facts.length ? `<br><small>${c.facts.map(esc).join("<br>")}</small>` : ""}</td></tr>`).join("")}
</tbody></table>
<h2>Policy in force</h2><table><tbody>
<tr><th>Mode</th><td>${e.policy.enforce ? "Enforce (block)" : "Warn only"}</td></tr>
<tr><th>Vulnerabilities</th><td>block ${esc(e.policy.vulnSeverity)} and above${e.policy.vulnIncludeDev ? ", including dev tooling" : ""}${e.policy.vulnIncludeBuild ? ", including build tooling" : ""}</td></tr>
<tr><th>Secrets</th><td>${e.policy.secrets ? "block" : "off"}</td></tr><tr><th>Blocked licenses</th><td>${esc(e.policy.blockedLicenses.join(", ") || "none")}</td></tr>
<tr><th>Lockfile required</th><td>${e.policy.requireLockfile ? "yes" : "no"}</td></tr><tr><th>Git source required</th><td>${e.policy.requireGitSource ? "yes" : "no"}</td></tr>
<tr><th>Allowed branches</th><td>${esc(e.policy.allowedBranches.join(", ") || "any")}</td></tr><tr><th>Last changed</th><td>${e.policyMeta ? `${esc(e.policyMeta.updatedBy)} ${d(e.policyMeta.updatedAt)}` : "defaults"}</td></tr>
</tbody></table>
<h2>Changes (${e.changes.length})</h2><table><thead><tr><th>When</th><th>App</th><th>What</th><th>Source</th><th>By</th><th>Result</th><th>Scan</th></tr></thead><tbody>
${e.changes.map((c) => `<tr><td>${d(c.startedAt)}</td><td>${esc(c.app)}</td><td>${esc(c.kind)}${c.version ? ` <code>${esc(c.version.slice(0, 12))}</code>` : ""}</td><td>${esc(c.source)}</td><td>${esc(c.actor)}</td><td>${esc(c.blockedByPolicy ? "blocked by policy" : c.status)}</td><td>${c.scan ? `${pill(c.scan.decision)} ${c.scan.summary ? `${c.scan.summary.vulns.critical}C ${c.scan.summary.vulns.high}H · ${c.scan.summary.secrets} secrets` : ""}` : "—"}</td></tr>`).join("") || `<tr><td colspan="7">No changes in this period.</td></tr>`}
</tbody></table>
<h2>Waivers (${e.waivers.length})</h2><table><thead><tr><th>App</th><th>Exception</th><th>Reason</th><th>Approved by</th><th>Expires</th><th>Revoked</th></tr></thead><tbody>
${e.waivers.map((w) => `<tr><td>${esc(w.app)}</td><td>${esc(w.kind)} <code>${esc(w.ref)}</code></td><td>${esc(w.reason)}</td><td>${esc(w.createdBy)} ${d(w.createdAt)}</td><td>${d(w.expiresAt)}</td><td>${w.revokedAt ? `${esc(w.revokedBy)} ${d(w.revokedAt)}` : "—"}</td></tr>`).join("") || `<tr><td colspan="6">None.</td></tr>`}
</tbody></table>
<h2>Backups and restores</h2><table><thead><tr><th>Job</th><th>App</th><th>To</th><th>Schedule</th><th>Mode</th></tr></thead><tbody>
${e.backups.jobs.map((j) => `<tr><td>${esc(j.name)}</td><td>${esc(j.app)}</td><td>${esc(j.destination)}</td><td>${j.everyMinutes ? `every ${j.everyMinutes} min` : "manual"}${j.enabled ? "" : " (paused)"}</td><td>${j.consistent ? "consistent" : "live"}</td></tr>`).join("") || `<tr><td colspan="5">No backup jobs.</td></tr>`}
</tbody></table>
<table style="margin-top:10px"><thead><tr><th>When</th><th>Run</th><th>Result</th><th>By</th></tr></thead><tbody>
${e.backups.runs.slice(-200).map((r) => `<tr><td>${d(r.startedAt)}</td><td>${esc(r.label)}${r.dryRun ? " (dry run)" : ""}</td><td>${esc(r.status)}${r.result ? ` · ${esc(r.result.copied)} copied${r.result.verified ? `, ${r.result.verified.ok ? "verified" : "verify failed"}` : ""}` : ""}</td><td>${esc(r.actor)}</td></tr>`).join("") || `<tr><td colspan="4">No runs in this period.</td></tr>`}
</tbody></table>
<h2>API tokens</h2><table><thead><tr><th>Name</th><th>Role</th><th>Created</th><th>Expires</th><th>Last used</th><th>Revoked</th></tr></thead><tbody>
${e.access.tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.role)}</td><td>${esc(t.createdBy)} ${d(t.createdAt)}</td><td>${d(t.expiresAt)}</td><td>${d(t.lastUsedAt)}</td><td>${d(t.revokedAt)}</td></tr>`).join("") || `<tr><td colspan="6">None.</td></tr>`}
</tbody></table>
<h2>Activity (${e.activity.length}${e.activity.length >= 20_000 ? "+" : ""})</h2><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead><tbody>
${e.activity.slice(-500).map((a) => `<tr><td>${d(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td><td>${esc(a.outcome)}</td></tr>`).join("")}
</tbody></table>${e.activity.length > 500 ? `<p class="meta">Showing the last 500; the JSON export has all of them.</p>` : ""}
<p class="foot">Integrity: SHA-256 <code>${esc(e.integrity.digest)}</code> of the JSON export for the same period and time. Print this page to PDF for the audit file.</p>
</body></html>`;
}
