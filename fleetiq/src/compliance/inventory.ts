import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseJsonc } from "../services/deploy";

// What a project is made of: every npm package pinned by its lockfiles (the dependency scan, SBOM
// and license check all start here), plus the text files the secrets scan reads.

export interface Pkg {
  name: string; version: string;
  direct: boolean;
  dev: boolean;                       // only needed to develop or test (devDependencies and what they pull in)
  build: boolean;                     // pinned by a lockfile in a sub-folder (web/, docs/): build tooling, not the Worker
  license: string | null;
  lockfile: string;                   // which lockfile pinned it (relative path)
  purl: string;                       // pkg:npm/%40scope/name@1.2.3
}
export interface Inventory { packages: Pkg[]; lockfiles: string[]; manifests: string[]; missingLockfiles: string[]; files: string[] }

const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", ".wrangler", ".celld", ".astro", ".next", ".turbo", ".cache", "coverage"]);
export const purlOf = (name: string, version: string) => `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;

// Walk the project once: lockfiles and package.json files anywhere, every other file for the secrets scan.
export async function walk(root: string, maxFiles = 20_000): Promise<{ files: string[] }> {
  const files: string[] = [];
  const go = async (dir: string) => {
    if (files.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await go(p); }
      else if (e.isFile()) files.push(relative(root, p));
    }
  };
  await go(root);
  return { files: files.sort() };
}

// bun.lock (text format): packages: { "<key>": ["name@version", registry, { dependencies, … }, integrity] }.
// Keys are install paths ("hono", "miniflare/zod" for a nested copy). A package is runtime if the
// workspace's dependencies reach it; anything reached only from devDependencies is dev.
export function parseBunLock(text: string): { packages: { name: string; version: string; dev: boolean }[]; direct: Set<string>; dev: Set<string> } {
  const lock = parseJsonc(text);
  const direct = new Set<string>(); const dev = new Set<string>(); const prodRoots = new Set<string>();
  for (const ws of Object.values<any>(lock.workspaces ?? {})) {
    for (const n of [...Object.keys(ws.dependencies ?? {}), ...Object.keys(ws.optionalDependencies ?? {}), ...Object.keys(ws.peerDependencies ?? {})]) { direct.add(n); prodRoots.add(n); }
    for (const n of Object.keys(ws.devDependencies ?? {})) { direct.add(n); if (!prodRoots.has(n)) dev.add(n); }
  }
  const entries = lock.packages ?? {};
  const resolve = (from: string, dep: string): string | null => {
    if (from && entries[`${from}/${dep}`]) return `${from}/${dep}`;
    for (let i = from.lastIndexOf("/"); i > 0; i = from.lastIndexOf("/", i - 1)) if (entries[`${from.slice(0, i)}/${dep}`]) return `${from.slice(0, i)}/${dep}`;
    return entries[dep] ? dep : null;
  };
  const prod = new Set<string>(); const queue: string[] = [];
  for (const r of prodRoots) { const k = resolve("", r); if (k && !prod.has(k)) { prod.add(k); queue.push(k); } }
  while (queue.length) {
    const k = queue.pop()!; const meta = Array.isArray(entries[k]) ? entries[k][2] ?? {} : {};
    for (const d of [...Object.keys(meta.dependencies ?? {}), ...Object.keys(meta.optionalDependencies ?? {}), ...Object.keys(meta.peerDependencies ?? {})]) {
      const t = resolve(k, d); if (t && !prod.has(t)) { prod.add(t); queue.push(t); }
    }
  }
  const out: { name: string; version: string; dev: boolean }[] = [];
  for (const [key, v] of Object.entries<any>(entries)) {
    const id = Array.isArray(v) ? String(v[0] ?? "") : "";
    const at = id.lastIndexOf("@");
    if (at <= 0) continue;
    const name = id.slice(0, at); const version = id.slice(at + 1);
    // workspace:, file:, link:, git and tarball URLs aren't registry packages.
    if (!/^\d+\.\d+\.\d+/.test(version)) continue;
    out.push({ name, version, dev: !prod.has(key) });
  }
  return { packages: out, direct, dev };
}

// package-lock.json v2/v3: packages: { "node_modules/a/node_modules/b": { version, license, dev } }
export function parsePackageLock(text: string) {
  const lock = JSON.parse(text);
  const root = lock.packages?.[""] ?? {};
  const direct = new Set<string>([...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {})]);
  const out: { name: string; version: string; license: string | null; dev: boolean }[] = [];
  for (const [path, v] of Object.entries<any>(lock.packages ?? {})) {
    if (!path || v.link || !v.version) continue;
    const name = v.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!/^\d+\.\d+\.\d+/.test(v.version)) continue;
    out.push({ name, version: v.version, license: typeof v.license === "string" ? v.license : null, dev: !!v.dev });
  }
  // v1 lockfiles: dependencies tree
  if (!lock.packages && lock.dependencies) {
    const visit = (deps: Record<string, any>) => { for (const [name, v] of Object.entries<any>(deps)) { if (v.version && /^\d/.test(v.version)) out.push({ name, version: v.version, license: null, dev: !!v.dev }); if (v.dependencies) visit(v.dependencies); } };
    visit(lock.dependencies);
    for (const n of Object.keys(lock.dependencies)) direct.add(n);
  }
  return { packages: out, direct };
}

// yarn.lock v1: `"name@^1", name@^1.2:\n  version "1.2.3"`
export function parseYarnLock(text: string) {
  const out: { name: string; version: string }[] = [];
  for (const block of text.split(/\n(?=\S)/)) {
    const head = block.split("\n")[0]!.replace(/:$/, "");
    const first = head.split(",")[0]!.trim().replace(/^"|"$/g, "");
    const at = first.lastIndexOf("@");
    const v = /\n\s+version:?\s+"?([^"\n]+)"?/.exec(block)?.[1];
    if (at > 0 && v && /^\d/.test(v)) out.push({ name: first.slice(0, at), version: v });
  }
  return { packages: out };
}

// pnpm-lock.yaml: keys like "  /name@1.2.3:" (v6) or "  name@1.2.3:" under packages: (v9)
export function parsePnpmLock(text: string) {
  const out: { name: string; version: string }[] = [];
  const sec = text.split(/\n(?=\S)/).find((b) => b.startsWith("packages:")) ?? "";
  for (const m of sec.matchAll(/^ {2}'?\/?((?:@[^/@\s]+\/)?[^@\s/']+)[@/](\d+\.\d+\.\d+[^:('\s]*)/gm)) out.push({ name: m[1]!, version: m[2]! });
  return { packages: out };
}

export async function inventory(root: string): Promise<Inventory> {
  const { files } = await walk(root);
  const lockNames = new Set(["bun.lock", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);
  const lockfiles = files.filter((f) => lockNames.has(f.split("/").pop()!));
  const manifests = files.filter((f) => f.split("/").pop() === "package.json");
  const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
  const lockDirs = new Set(lockfiles.map(dirOf));
  // A package.json with dependencies but no lockfile beside it (or above it, for workspaces).
  const missingLockfiles: string[] = [];
  for (const m of manifests) {
    const d = dirOf(m);
    // Covered by a lockfile beside it, or by a workspace root above it that lists workspaces.
    let covered = lockDirs.has(d);
    for (let p = d; !covered && p; ) {
      p = dirOf(p);
      if (lockDirs.has(p)) { try { const rootPkg = JSON.parse(await Bun.file(join(root, p, "package.json")).text()); covered = !!rootPkg.workspaces; } catch {} break; }
    }
    if (covered) continue;
    try { const j = JSON.parse(await Bun.file(join(root, m)).text()); if (Object.keys(j.dependencies ?? {}).length || Object.keys(j.devDependencies ?? {}).length) missingLockfiles.push(m); } catch {}
  }
  const byKey = new Map<string, Pkg>();
  const add = (p: { name: string; version: string; license?: string | null; dev?: boolean }, lockfile: string, direct: Set<string>) => {
    const k = `${p.name}@${p.version}`;
    const prev = byKey.get(k);
    const isDirect = direct.has(p.name); const isDev = !!p.dev; const isBuild = dirOf(lockfile) !== "";
    // The same version in several lockfiles takes the most important role it has anywhere.
    if (prev) {
      prev.direct ||= isDirect; prev.license ??= p.license ?? null;
      const runtime = (x: { dev: boolean; build: boolean }) => !x.dev && !x.build;
      if (runtime(prev)) return;
      if (!isDev && !isBuild) { prev.dev = false; prev.build = false; prev.lockfile = lockfile; return; }
      // Not runtime anywhere: "build" if some build folder needs it to build, else "dev".
      if (!isDev && isBuild) { prev.dev = false; prev.build = true; }
      return;
    }
    byKey.set(k, { name: p.name, version: p.version, direct: isDirect, dev: isDev, build: isBuild, license: p.license ?? null, lockfile, purl: purlOf(p.name, p.version) });
  };
  for (const lf of lockfiles) {
    const text = await Bun.file(join(root, lf)).text().catch(() => "");
    const base = lf.split("/").pop()!;
    try {
      if (base === "bun.lock") { const r = parseBunLock(text); for (const p of r.packages) add(p, lf, r.direct); }
      else if (base === "package-lock.json" || base === "npm-shrinkwrap.json") { const r = parsePackageLock(text); for (const p of r.packages) add(p, lf, r.direct); }
      else if (base === "yarn.lock") { for (const p of parseYarnLock(text).packages) add(p, lf, new Set()); }
      else if (base === "pnpm-lock.yaml") { for (const p of parsePnpmLock(text).packages) add(p, lf, new Set()); }
    } catch { /* an unreadable lockfile shows up as zero packages from it */ }
  }
  // Installed packages (deploy archives carry production node_modules): exact versions and licenses.
  for (const nm of await installedPackages(root)) {
    const k = `${nm.name}@${nm.version}`;
    const prev = byKey.get(k);
    // Installed in the archive = it ships with the app, whatever the lockfile said.
    if (prev) { prev.license ??= nm.license; if (nm.top) { prev.dev = false; prev.build = false; } }
    else byKey.set(k, { name: nm.name, version: nm.version, direct: false, dev: false, build: !nm.top, license: nm.license, lockfile: "node_modules", purl: purlOf(nm.name, nm.version) });
  }
  return { packages: [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)), lockfiles, manifests, missingLockfiles, files };
}

export function licenseOf(j: any): string | null {
  if (typeof j?.license === "string") return j.license;
  if (j?.license?.type) return String(j.license.type);
  if (Array.isArray(j?.licenses)) return j.licenses.map((l: any) => (typeof l === "string" ? l : l?.type)).filter(Boolean).join(" OR ") || null;
  return null;
}

async function installedPackages(root: string) {
  const out: { name: string; version: string; license: string | null; top: boolean }[] = [];
  const visit = async (nm: string, depth: number, top = true) => {
    if (depth > 6) return;
    const entries = await readdir(nm, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dirs = e.name.startsWith("@") ? (await readdir(join(nm, e.name), { withFileTypes: true }).catch(() => [])).filter((x) => x.isDirectory()).map((x) => join(e.name, x.name)) : [e.name];
      for (const d of dirs) {
        const pj = join(nm, d, "package.json");
        if (!(await stat(pj).catch(() => null))) continue;
        try { const j = JSON.parse(await Bun.file(pj).text()); if (j.name && j.version) out.push({ name: j.name, version: j.version, license: licenseOf(j), top }); } catch {}
        await visit(join(nm, d, "node_modules"), depth + 1, top);
      }
    }
  };
  // node_modules at the root and next to any package.json one level down (web/, worker/).
  await visit(join(root, "node_modules"), 0);
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await visit(join(root, e.name, "node_modules"), 0, false);
  return out;
}
