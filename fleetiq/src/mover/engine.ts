import type { Connector, ObjInfo } from "./types";

// rsync for object stores: list both sides, decide per key, then copy with a bounded worker pool.
//   quick    — same size and the destination copy is newer than the source (rsync's default)
//   checksum — same MD5; a side whose listing has none (a local folder) is hashed on demand
//   size     — same size is enough
// mode copy never deletes; mirror also deletes destination keys the source doesn't have, but only
// after every copy succeeded and never more than maxDeletePct of the destination (a wrong or
// emptied source must not wipe a backup).
export type Compare = "quick" | "checksum" | "size";
export interface SyncSpec {
  src: Connector; srcPrefix: string; dst: Connector; dstPrefix: string;
  mode: "copy" | "mirror"; compare: Compare; include?: string[]; exclude?: string[];
}
export interface PlanItem { rel: string; size: number; reason: "new" | "changed" }
export interface Plan { copy: PlanItem[]; remove: string[]; same: number; srcCount: number; dstCount: number; bytes: number; hashed?: number }
export interface Progress { done: number; total: number; bytes: number; totalBytes: number; failed: number; removed: number; current?: string; rate?: number; etaSec?: number | null }
export interface RunResult extends Progress { errors: { key: string; error: string }[]; ms: number; verified?: { ok: boolean; detail: string }; deletesBlocked?: string }

export const normPrefix = (p: string) => { const t = (p ?? "").replace(/^\/+/, ""); return t && !t.endsWith("/") ? `${t}/` : t; };
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]")}$`);
export function filterFn(include?: string[], exclude?: string[]) {
  const inc = (include ?? []).filter(Boolean).map(globRe); const exc = (exclude ?? []).filter(Boolean).map(globRe);
  return (rel: string) => (!inc.length || inc.some((r) => r.test(rel))) && !exc.some((r) => r.test(rel));
}
const md5ish = (e?: string | null) => !!e && /^[0-9a-f]{32}$/i.test(e);

export function same(s: ObjInfo, d: ObjInfo, compare: Compare): boolean {
  if (s.size !== d.size) return false;
  if (compare === "size") return true;
  if (compare === "checksum" && md5ish(s.etag) && md5ish(d.etag)) return s.etag!.toLowerCase() === d.etag!.toLowerCase();
  return s.mtime != null && d.mtime != null ? d.mtime >= s.mtime : false;
}

// Fill in MD5s a listing lacked, for same-size pairs only (anything else differs anyway).
async function fillHashes(spec: SyncSpec, sp: string, dp: string, src: Map<string, ObjInfo>, dst: Map<string, ObjInfo>) {
  let n = 0;
  const todo: (() => Promise<void>)[] = [];
  for (const [rel, s] of src) {
    const d = dst.get(rel);
    if (!d || d.size !== s.size) continue;
    if (!md5ish(s.etag) && spec.src.hash) todo.push(async () => { s.etag = await spec.src.hash!(sp + rel); n++; });
    if (!md5ish(d.etag) && spec.dst.hash) todo.push(async () => { d.etag = await spec.dst.hash!(dp + rel); n++; });
  }
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < todo.length) await todo[i++]!().catch(() => {}); }));
  return n;
}

export async function plan(spec: SyncSpec, onListed?: (side: "source" | "destination", n: number) => void): Promise<Plan> {
  const sp = normPrefix(spec.srcPrefix); const dp = normPrefix(spec.dstPrefix);
  const keep = filterFn(spec.include, spec.exclude);
  const src = new Map<string, ObjInfo>(); const dst = new Map<string, ObjInfo>();
  for await (const o of spec.src.list(sp)) { const rel = o.key.slice(sp.length); if (rel && !rel.endsWith("/") && keep(rel)) { src.set(rel, o); if (src.size % 5000 === 0) onListed?.("source", src.size); } }
  onListed?.("source", src.size);
  for await (const o of spec.dst.list(dp)) { const rel = o.key.slice(dp.length); if (rel && !rel.endsWith("/") && keep(rel)) dst.set(rel, o); }
  onListed?.("destination", dst.size);
  const hashed = spec.compare === "checksum" ? await fillHashes(spec, sp, dp, src, dst) : 0;
  const out: Plan = { copy: [], remove: [], same: 0, srcCount: src.size, dstCount: dst.size, bytes: 0, hashed };
  for (const [rel, s] of src) {
    const d = dst.get(rel);
    if (!d) out.copy.push({ rel, size: s.size, reason: "new" });
    else if (!same(s, d, spec.compare)) out.copy.push({ rel, size: s.size, reason: "changed" });
    else out.same++;
  }
  if (spec.mode === "mirror") for (const rel of dst.keys()) if (!src.has(rel)) out.remove.push(rel);
  out.bytes = out.copy.reduce((a, i) => a + i.size, 0);
  return out;
}

// Mirror's guard against wiping a destination: small deletes are always fine; above that, the
// share of the destination being deleted must stay at or under the limit (100 = no limit).
export function deleteGuard(p: Plan, maxDeletePct = 50): string | null {
  if (!p.remove.length || maxDeletePct >= 100 || p.remove.length <= 10) return null;
  const pct = Math.round((p.remove.length / Math.max(1, p.dstCount)) * 100);
  return pct > maxDeletePct
    ? `mirror would delete ${p.remove.length} of ${p.dstCount} objects on the destination (${pct}%), over the ${maxDeletePct}% safety limit. Check the source prefix, or raise the limit for this run.`
    : null;
}

// Shared across workers: keeps the average transfer rate at or under the limit.
export function limiter(mbps?: number | null) {
  if (!mbps || mbps <= 0) return async (_bytes: number) => {};
  const rate = mbps * 1024 * 1024; let free = Date.now();
  return async (bytes: number) => {
    const start = Math.max(free, Date.now()); free = start + (bytes / rate) * 1000;
    const wait = start - Date.now(); if (wait > 0) await Bun.sleep(wait);
  };
}

export interface ExecOpts { concurrency?: number; retries?: number; signal?: AbortSignal; onProgress?: (pr: Progress) => void; verify?: boolean; bwLimitMbps?: number | null; maxDeletePct?: number }

export async function execute(spec: SyncSpec, p: Plan, opts: ExecOpts = {}): Promise<RunResult> {
  const t0 = Date.now();
  const sp = normPrefix(spec.srcPrefix); const dp = normPrefix(spec.dstPrefix);
  const pr: RunResult = { done: 0, total: p.copy.length, bytes: 0, totalBytes: p.bytes, failed: 0, removed: 0, errors: [], ms: 0, rate: 0, etaSec: null };
  const retries = opts.retries ?? 3;
  const take = limiter(opts.bwLimitMbps);
  const tick = () => {
    const s = (Date.now() - t0) / 1000;
    pr.rate = s > 0 ? Math.round(pr.bytes / s) : 0;
    pr.etaSec = pr.rate ? Math.round((pr.totalBytes - pr.bytes) / pr.rate) : null;
  };
  let i = 0;
  const one = async (item: PlanItem) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await take(item.size);
        const data = await spec.src.get(sp + item.rel);
        if (!data) throw Object.assign(new Error("source object disappeared"), { retryable: false });
        await spec.dst.put(dp + item.rel, data);
        pr.done++; pr.bytes += item.size; return;
      } catch (e: any) {
        // Bad keys, a missing bucket or no permission won't fix themselves: fail at once.
        const permanent = e?.retryable === false;
        if (permanent || attempt >= retries || opts.signal?.aborted) { pr.failed++; pr.errors.push({ key: item.rel, error: String(e.message).slice(0, 300) }); return; }
        await Bun.sleep(500 * 2 ** attempt);
      }
    }
  };
  const worker = async () => {
    while (i < p.copy.length && !opts.signal?.aborted) {
      const item = p.copy[i++]!; pr.current = item.rel;
      await one(item); tick(); opts.onProgress?.(pr);
      // The same permanent error on the first objects means every object will fail: stop early.
      if (pr.failed >= 5 && pr.done === 0 && pr.errors.every((e) => e.error === pr.errors[0]!.error)) { i = p.copy.length; pr.errors.push({ key: "(run)", error: `stopped after ${pr.failed} identical failures` }); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 8, 32)) }, worker));
  // Deletes only after every copy succeeded, so a failed mirror never leaves the destination emptier.
  if (spec.mode === "mirror" && p.remove.length && !pr.failed && !opts.signal?.aborted) {
    const blocked = deleteGuard(p, opts.maxDeletePct ?? 50);
    if (blocked) pr.deletesBlocked = blocked;
    else for (const rel of p.remove) {
      try { await spec.dst.delete(dp + rel); pr.removed++; } catch (e: any) { pr.errors.push({ key: rel, error: `delete: ${e.message}` }); }
      if (pr.removed % 50 === 0) opts.onProgress?.(pr);
    }
  }
  if (opts.verify && !pr.failed && !opts.signal?.aborted) {
    // Check what this run wrote (a live source may gain objects meanwhile; the next run copies those).
    const have = new Map<string, number>();
    for await (const o of spec.dst.list(dp)) have.set(o.key.slice(dp.length), o.size);
    const bad = p.copy.filter((i) => have.get(i.rel) !== i.size);
    const lingering = spec.mode === "mirror" && pr.removed ? p.remove.filter((k) => have.has(k)).length : 0;
    const after = await plan({ ...spec, compare: "size" }).catch(() => null);
    const drift = after ? after.copy.length : 0;
    pr.verified = {
      ok: bad.length === 0 && lingering === 0,
      detail: bad.length ? `${bad.length} copied objects are missing or the wrong size (first: ${bad[0]!.rel})`
        : lingering ? `${lingering} objects that should have been deleted are still there`
        : `all ${p.copy.length} copied objects are present at the right size${drift ? `; the source changed during the copy (${drift} newer objects), the next run picks them up` : ""}`,
    };
  }
  tick(); pr.current = undefined; pr.etaSec = 0; pr.ms = Date.now() - t0;
  opts.onProgress?.(pr);
  return pr;
}
