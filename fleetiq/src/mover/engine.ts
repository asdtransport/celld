import type { Connector, ObjInfo } from "./types";

// rsync for object stores: list both sides, decide per key, then copy with a bounded worker pool.
//   quick    — same size and the destination copy is newer than the source (rsync's default)
//   checksum — same MD5 when both sides expose one, else falls back to quick
//   size     — same size is enough
// mode copy never deletes; mirror also deletes destination keys the source doesn't have.
export type Compare = "quick" | "checksum" | "size";
export interface SyncSpec {
  src: Connector; srcPrefix: string; dst: Connector; dstPrefix: string;
  mode: "copy" | "mirror"; compare: Compare; include?: string[]; exclude?: string[];
}
export interface PlanItem { rel: string; size: number; reason: "new" | "changed" }
export interface Plan { copy: PlanItem[]; remove: string[]; same: number; srcCount: number; dstCount: number; bytes: number }
export interface Progress { done: number; total: number; bytes: number; totalBytes: number; failed: number; removed: number; current?: string }
export interface RunResult extends Progress { errors: { key: string; error: string }[]; ms: number; verified?: { ok: boolean; detail: string } }

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

export async function plan(spec: SyncSpec, onListed?: (side: "source" | "destination", n: number) => void): Promise<Plan> {
  const sp = normPrefix(spec.srcPrefix); const dp = normPrefix(spec.dstPrefix);
  const keep = filterFn(spec.include, spec.exclude);
  const src = new Map<string, ObjInfo>(); const dst = new Map<string, ObjInfo>();
  for await (const o of spec.src.list(sp)) { const rel = o.key.slice(sp.length); if (rel && !rel.endsWith("/") && keep(rel)) src.set(rel, o); if (src.size % 5000 === 0) onListed?.("source", src.size); }
  onListed?.("source", src.size);
  for await (const o of spec.dst.list(dp)) { const rel = o.key.slice(dp.length); if (rel && !rel.endsWith("/") && keep(rel)) dst.set(rel, o); }
  onListed?.("destination", dst.size);
  const out: Plan = { copy: [], remove: [], same: 0, srcCount: src.size, dstCount: dst.size, bytes: 0 };
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

export async function execute(spec: SyncSpec, p: Plan, opts: { concurrency?: number; retries?: number; signal?: AbortSignal; onProgress?: (pr: Progress) => void; verify?: boolean } = {}): Promise<RunResult> {
  const t0 = Date.now();
  const sp = normPrefix(spec.srcPrefix); const dp = normPrefix(spec.dstPrefix);
  const pr: RunResult = { done: 0, total: p.copy.length, bytes: 0, totalBytes: p.bytes, failed: 0, removed: 0, errors: [], ms: 0 };
  const retries = opts.retries ?? 3;
  let i = 0;
  const one = async (item: PlanItem) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await spec.src.get(sp + item.rel);
        if (!data) throw new Error("source object disappeared");
        await spec.dst.put(dp + item.rel, data);
        pr.done++; pr.bytes += item.size; return;
      } catch (e: any) {
        if (attempt >= retries || opts.signal?.aborted) { pr.failed++; pr.errors.push({ key: item.rel, error: String(e.message).slice(0, 300) }); return; }
        await Bun.sleep(500 * 2 ** attempt);
      }
    }
  };
  const worker = async () => {
    while (i < p.copy.length && !opts.signal?.aborted) {
      const item = p.copy[i++]!; pr.current = item.rel;
      await one(item); opts.onProgress?.(pr);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 8, 32)) }, worker));
  // Deletes only after every copy succeeded, so a failed mirror never leaves the destination emptier.
  if (spec.mode === "mirror" && !pr.failed && !opts.signal?.aborted) {
    for (const rel of p.remove) {
      try { await spec.dst.delete(dp + rel); pr.removed++; } catch (e: any) { pr.errors.push({ key: rel, error: `delete: ${e.message}` }); }
      if (pr.removed % 50 === 0) opts.onProgress?.(pr);
    }
  }
  if (opts.verify && !pr.failed && !opts.signal?.aborted) {
    // Check what this run wrote (a live source may gain objects meanwhile; the next run copies those).
    const have = new Map<string, number>();
    for await (const o of spec.dst.list(dp)) have.set(o.key.slice(dp.length), o.size);
    const bad = p.copy.filter((i) => have.get(i.rel) !== i.size);
    const lingering = spec.mode === "mirror" ? p.remove.filter((k) => have.has(k)).length : 0;
    const after = await plan({ ...spec, compare: "size" }).catch(() => null);
    const drift = after ? after.copy.length : 0;
    pr.verified = {
      ok: bad.length === 0 && lingering === 0,
      detail: bad.length ? `${bad.length} copied objects are missing or the wrong size (first: ${bad[0]!.rel})`
        : lingering ? `${lingering} objects that should have been deleted are still there`
        : `all ${p.copy.length} copied objects are present at the right size${drift ? `; the source changed during the copy (${drift} newer objects), the next run picks them up` : ""}`,
    };
  }
  pr.current = undefined; pr.ms = Date.now() - t0;
  opts.onProgress?.(pr);
  return pr;
}
