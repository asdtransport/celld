import { eq } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/runtime";
import { intelCache } from "../db/schema";
import type { Pkg } from "./inventory";
import { licenseOf } from "./inventory";

// Outside knowledge about packages: known vulnerabilities (OSV.dev, which carries GitHub's advisory
// database for npm) and licenses (the npm registry). Answers are cached in FleetIQ's database:
// a version's license never changes; advisories are re-checked daily.

export type Severity = "critical" | "high" | "moderate" | "low" | "unknown";
export const SEVERITIES: Severity[] = ["critical", "high", "moderate", "low", "unknown"];
export const sevRank = (s: string) => ({ critical: 4, high: 3, moderate: 2, medium: 2, low: 1 } as Record<string, number>)[s.toLowerCase()] ?? 0;

export interface Vuln {
  id: string; aliases: string[]; summary: string; severity: Severity;
  package: string; version: string; fixed: string | null; direct: boolean; dev: boolean; build: boolean;
  url: string;
}

const now = () => Math.floor(Date.now() / 1000);
function cacheGet<T>(key: string, maxAgeSec: number | null): T | undefined {
  const r = getDb().select().from(intelCache).where(eq(intelCache.key, key)).get();
  if (!r || (maxAgeSec != null && now() - r.fetchedAt > maxAgeSec)) return undefined;
  return JSON.parse(r.value) as T;
}
const cachePut = (key: string, v: unknown) => getDb().insert(intelCache).values({ key, value: JSON.stringify(v), fetchedAt: now() }).onConflictDoUpdate({ target: intelCache.key, set: { value: JSON.stringify(v), fetchedAt: now() } }).run();

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>, deadline: number) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && Date.now() < deadline) await fn(items[i++]!).catch(() => {}); }));
}

// CVSS v3 base score from a vector, for advisories that carry no severity label.
export function cvss3(vector: string): number | null {
  const m = Object.fromEntries(vector.split("/").slice(1).map((p) => p.split(":") as [string, string]));
  const W: Record<string, Record<string, number>> = { AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 }, C: { H: 0.56, L: 0.22, N: 0 }, I: { H: 0.56, L: 0.22, N: 0 }, A: { H: 0.56, L: 0.22, N: 0 } };
  if (!m.AV || !m.AC || !m.PR || !m.UI || !m.S || !m.C) return null;
  const changed = m.S === "C";
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR as "N"] ?? 0.85;
  const iss = 1 - (1 - W.C![m.C]!) * (1 - W.I![m.I ?? "N"]!) * (1 - W.A![m.A ?? "N"]!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const expl = 8.22 * W.AV![m.AV]! * W.AC![m.AC]! * pr * W.UI![m.UI]!;
  if (impact <= 0) return 0;
  const up = (x: number) => Math.ceil(x * 10) / 10;
  return up(Math.min(changed ? 1.08 * (impact + expl) : impact + expl, 10));
}
const fromScore = (s: number): Severity => (s >= 9 ? "critical" : s >= 7 ? "high" : s >= 4 ? "moderate" : s > 0 ? "low" : "unknown");

export function severityOf(osv: any): Severity {
  const label = String(osv?.database_specific?.severity ?? "").toLowerCase();
  if (label === "critical" || label === "high" || label === "low") return label;
  if (label === "moderate" || label === "medium") return "moderate";
  const v = (osv?.severity ?? []).find((s: any) => String(s.type).startsWith("CVSS_V3"))?.score;
  const sc = v ? cvss3(v) : null;
  return sc != null ? fromScore(sc) : "unknown";
}
export function fixedIn(osv: any, name: string): string | null {
  for (const a of osv?.affected ?? []) {
    if (a?.package?.name !== name) continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) return String(e.fixed);
  }
  return null;
}

export async function vulnerabilities(pkgs: Pkg[], opts: { timeoutMs?: number } = {}): Promise<{ vulns: Vuln[]; checked: number; error: string | null }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const ids = new Map<string, string[]>(); // pkg@ver -> vuln ids
  const todo: Pkg[] = [];
  for (const p of pkgs) { const c = cacheGet<string[]>(`osv:q:${p.name}@${p.version}`, 86_400); if (c) ids.set(`${p.name}@${p.version}`, c); else todo.push(p); }
  let error: string | null = null;
  for (let i = 0; i < todo.length && Date.now() < deadline; i += 500) {
    const batch = todo.slice(i, i + 500);
    try {
      const r = await fetch(`${config.osvApi}/v1/querybatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queries: batch.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })) }), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as any;
      batch.forEach((p, j) => { const v = (data.results?.[j]?.vulns ?? []).map((x: any) => String(x.id)); ids.set(`${p.name}@${p.version}`, v); cachePut(`osv:q:${p.name}@${p.version}`, v); });
    } catch (e: any) { error = `vulnerability database unreachable (${e.message})`; break; }
  }
  const unique = [...new Set([...ids.values()].flat())];
  const details = new Map<string, any>();
  const need = unique.filter((id) => { const c = cacheGet<any>(`osv:v:${id}`, 7 * 86_400); if (c) details.set(id, c); return !c; });
  await pool(need, 8, async (id) => {
    const r = await fetch(`${config.osvApi}/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return;
    const d = (await r.json()) as any;
    const slim = { id: d.id, aliases: d.aliases ?? [], summary: d.summary ?? (d.details ?? "").slice(0, 200), database_specific: { severity: d.database_specific?.severity }, severity: d.severity, affected: (d.affected ?? []).map((a: any) => ({ package: a.package, ranges: a.ranges })), withdrawn: d.withdrawn ?? null };
    details.set(id, slim); cachePut(`osv:v:${id}`, slim);
  }, deadline);
  const vulns: Vuln[] = [];
  for (const p of pkgs) {
    for (const id of ids.get(`${p.name}@${p.version}`) ?? []) {
      const d = details.get(id);
      if (d?.withdrawn) continue;
      vulns.push({
        id, aliases: d?.aliases ?? [], summary: d?.summary ?? "(details not fetched)", severity: d ? severityOf(d) : "unknown",
        package: p.name, version: p.version, fixed: d ? fixedIn(d, p.name) : null, direct: p.direct, dev: p.dev, build: p.build,
        url: id.startsWith("GHSA-") ? `https://github.com/advisories/${id}` : `https://osv.dev/vulnerability/${id}`,
      });
    }
  }
  if (!error && todo.length && Date.now() >= deadline) error = "vulnerability lookup timed out; some packages were not checked";
  vulns.sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.package.localeCompare(b.package));
  return { vulns, checked: pkgs.length - (error ? todo.length : 0), error };
}

// Fill in licenses the lockfiles didn't carry, from the npm registry (cached forever per version).
export async function fillLicenses(pkgs: Pkg[], opts: { timeoutMs?: number } = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  const todo: Pkg[] = [];
  for (const p of pkgs) {
    if (p.license) continue;
    const c = cacheGet<string | null>(`lic:${p.name}@${p.version}`, null);
    if (c !== undefined) p.license = c; else todo.push(p);
  }
  await pool(todo, 16, async (p) => {
    const r = await fetch(`${config.npmRegistry}/${p.name.replace("/", "%2f")}/${encodeURIComponent(p.version)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return;
    const lic = licenseOf(await r.json());
    p.license = lic; cachePut(`lic:${p.name}@${p.version}`, lic);
  }, deadline);
  return { looked: todo.length, unknown: pkgs.filter((p) => !p.license).length };
}
