#!/usr/bin/env node
// fleetiq: deploy and run apps on a FleetIQ server from your terminal, the way `netlify` does for sites.
// Runs on Node 18+ or Bun, needs `tar` (macOS, Linux and Windows 10+ have it). No other installs.
//
//   fleetiq login                 save the console address and an API token
//   fleetiq init                  link this folder to an app (creates it, routes it, optionally Git)
//   fleetiq deploy                build and deploy a preview of this folder (own URL, own data)
//   fleetiq deploy --prod         build and deploy to production
//   fleetiq status | open | logs | rollback | scan | previews | apps | whoami
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "2.0.0";

// ---------- output ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: paint("2"), bold: paint("1"), green: paint("32"), red: paint("31"), yellow: paint("33"), cyan: paint("36"), teal: paint("38;5;30") };
const ok = (s: string) => console.log(`${c.green("✔")} ${s}`);
const warn = (s: string) => console.log(`${c.yellow("!")} ${s}`);
const info = (s: string) => console.log(`${c.cyan("›")} ${s}`);
class CliError extends Error { constructor(m: string, public code = 1) { super(m); } }
const fail = (m: string, code = 1): never => { throw new CliError(m, code); };

let spinTimer: ReturnType<typeof setInterval> | null = null; let spinText = "";
function spin(text: string) {
  spinText = text;
  if (!tty || spinTimer || flags.json) return;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; let i = 0;
  spinTimer = setInterval(() => process.stdout.write(`\r\x1b[2K${c.teal(frames[i++ % frames.length]!)} ${spinText}`), 90);
}
function unspin() { if (spinTimer) { clearInterval(spinTimer); spinTimer = null; process.stdout.write("\r\x1b[2K"); } }
const say = (s: string) => { const was = !!spinTimer; unspin(); console.log(s); if (was) spin(spinText); };

// ---------- args ----------
const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {}; const pos: string[] = [];
const SHORT: Record<string, string> = { p: "prod", m: "message", a: "app", d: "dir", o: "open", f: "follow", y: "yes", h: "help", n: "tail" };
const VALUED = new Set(["message", "app", "dir", "url", "token", "alias", "cloudflare", "ref", "tail", "path"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) { const [k, v] = a.slice(2).split("=", 2); if (v !== undefined) flags[k!] = v; else if (VALUED.has(k!) && argv[i + 1] && !argv[i + 1]!.startsWith("-")) flags[k!] = argv[++i]!; else flags[k!] = true; }
  else if (/^-[a-z]$/.test(a)) { const k = SHORT[a[1]!] ?? a[1]!; if (VALUED.has(k) && argv[i + 1] && !argv[i + 1]!.startsWith("-")) flags[k] = argv[++i]!; else flags[k] = true; }
  else pos.push(a);
}
const flag = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
const json = !!flags.json;
// --json: stdout carries only the JSON result; progress and messages go to stderr.
const printJson = (o: unknown): void => { process.stdout.write(`${JSON.stringify(o, null, 2)}\n`); };
if (json) console.log = console.error;

// ---------- config ----------
const CONF_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fleetiq");
const CONF = join(CONF_DIR, "config.json");
const readJson = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
function creds() {
  const saved = readJson(CONF) ?? {};
  const url = String(flag("url") ?? process.env.FLEETIQ_URL ?? saved.url ?? "").replace(/\/+$/, "");
  const token = String(flag("token") ?? process.env.FLEETIQ_TOKEN ?? saved.token ?? "");
  return { url, token };
}
function findUp(name: string, from = process.cwd()): string | null {
  for (let d = resolve(from); ; d = dirname(d)) { if (existsSync(join(d, name))) return join(d, name); if (dirname(d) === d) return null; }
}
const LINK = ".fleetiq.json";
function linked(): { app: string; root: string; url?: string } | null {
  const f = findUp(LINK); if (!f) return null;
  const j = readJson(f); return j?.app ? { app: j.app, root: dirname(f), url: j.url } : null;
}

// ---------- http ----------
async function http<T = any>(method: string, path: string, body?: unknown, opts: { form?: FormData; raw?: boolean; quiet404?: boolean } = {}): Promise<T> {
  const { url, token } = creds();
  if (!url || !token) fail(`not signed in: run ${c.bold("fleetiq login")} (or set FLEETIQ_URL and FLEETIQ_TOKEN)`);
  let r: Response;
  try {
    r = await fetch(url + path, {
      method, headers: { authorization: `Bearer ${token}`, "user-agent": `fleetiq-cli/${VERSION}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch (e: any) { return fail(`can't reach ${url}: ${e.cause?.code ?? e.message}`); }
  if (opts.raw) return r as any;
  const text = await r.text();
  let data: any; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    if (r.status === 401 || r.status === 403 && /token|sign/i.test(String(data?.error))) fail(`the server refused the token (HTTP ${r.status}): run fleetiq login again`);
    const msg = typeof data === "object" && data?.error ? (typeof data.error === "string" ? data.error : JSON.stringify(data.error)) : String(text).slice(0, 300);
    throw Object.assign(new CliError(msg || `HTTP ${r.status}`, r.status === 422 && /blocked by policy/.test(msg) ? 2 : 1), { status: r.status });
  }
  return data as T;
}

// ---------- prompts ----------
function ask(q: string, def = "", hidden = false): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve(def);
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) (rl as any)._writeToOutput = (s: string) => { if (s.includes(q)) process.stdout.write(s); };
    rl.question(`${q}${def ? c.dim(` (${def})`) : ""}: `, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); res(a.trim() || def); });
  });
}
const yes = async (q: string, def = false) => (flags.yes ? true : /^y/i.test(await ask(`${q} ${def ? "[Y/n]" : "[y/N]"}`, def ? "y" : "n")));
function openUrl(u: string) {
  const cmd = platform() === "darwin" ? ["open", u] : platform() === "win32" ? ["cmd", "/c", "start", "", u] : ["xdg-open", u];
  const r = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "ignore" });
  if (r.status !== 0) info(`open ${u}`);
}

// ---------- packing ----------
const EXCLUDE_DIRS = new Set(["node_modules", ".git", ".wrangler", ".celld", ".astro", ".next", ".turbo", ".cache", "coverage", ".fleetiq"]);
const EXCLUDE_FILE = /(^|\/)\.env(\.[^/]*)?$|(^|\/)\.dev\.vars|\.(tgz|tar\.gz|db|db-wal|db-shm|sqlite)$|(^|\/)\.DS_Store$/;
function sourceFiles(root: string): { files: string[]; via: string; skipped: string[] } {
  const skipped: string[] = [];
  const keep = (f: string) => {
    const parts = f.split("/");
    if (parts.some((p) => EXCLUDE_DIRS.has(p)) || /(^|\/)(web\/)?dist\//.test(f)) return false;
    if (EXCLUDE_FILE.test(f) && !/\.(example|sample|template)$/.test(f)) { skipped.push(f); return false; }
    return true;
  };
  const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z", "--", "."], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0 && git.stdout) {
    const files = git.stdout.split("\0").filter(Boolean).filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile()).filter(keep);
    return { files, via: "git (honours .gitignore)", skipped };
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name); const rel = relative(root, p).split("\\").join("/");
      if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walk(p); } else if (e.isFile() && keep(rel)) files.push(rel);
    }
  };
  walk(root);
  return { files, via: "folder", skipped };
}
function pack(root: string): { file: string; bytes: number; count: number; cleanup: () => void; skipped: string[]; via: string } {
  if (!existsSync(join(root, "wrangler.jsonc")) && !existsSync(join(root, "wrangler.json"))) warn(`no wrangler.jsonc in ${root}; the build will look one level down`);
  const { files, via, skipped } = sourceFiles(root);
  if (!files.length) fail(`nothing to upload in ${root}`);
  const tmp = mkdtempSync(join(tmpdir(), "fleetiq-"));
  const list = join(tmp, "files.txt"); const out = join(tmp, "source.tgz");
  writeFileSync(list, files.join("\n") + "\n");
  const r = spawnSync("tar", ["-czf", out, "-C", root, "-T", list], { encoding: "utf8" });
  if (r.status !== 0) fail(`tar failed: ${(r.stderr || r.error?.message || "").slice(0, 300)}`);
  return { file: out, bytes: statSync(out).size, count: files.length, cleanup: () => rmSync(tmp, { recursive: true, force: true }), skipped, via };
}
const mb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
async function formWith(file: string, field: string, extra: Record<string, string>) {
  const fd = new FormData();
  fd.append(field, new Blob([readFileSync(file)], { type: "application/gzip" }), "source.tgz");
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

// ---------- following a deployment ----------
const PHASES: [RegExp, string][] = [
  [/^Fetching|^Source /, "Fetching source"], [/^Scanning/, "Scanning dependencies, secrets and licenses"], [/^Scan:/, "Checking policy"],
  [/^Building in/, "Building in a throwaway container"], [/dependencies$/, "Installing dependencies"], [/type check/, "Type checking"], [/tests/, "Running tests"], [/web build/, "Building the web app"],
  [/^Deploying to/, "Uploading to the fleet"], [/^Node .*adopted/, "Rolling out to nodes"], [/migrations/, "Applying D1 migrations"],
  [/^Running wrangler deploy|Deploying to Cloudflare/, "Deploying to Cloudflare"], [/^Verify/, "Checking it from outside"],
];
async function follow(id: string, opts: { verbose?: boolean; label?: string } = {}) {
  let shown = 0; let last: any = null;
  spin(opts.label ?? "Starting");
  for (;;) {
    const d = await http<any>("GET", `/api/deployments/${id}`);
    const lines = String(d.log ?? "").split("\n");
    for (const l of lines.slice(shown, d.status === "running" ? Math.max(shown, lines.length - 1) : lines.length)) {
      if (!l.trim()) continue;
      const ph = PHASES.find(([re]) => re.test(l.trim()));
      if (ph) spin(ph[1]);
      const important = /^Scan:|^Policy:|^\s+[✗!]|^GitHub:|^Filled|^Verify|failed|error|^Node .*: (failed|unreachable)/i.test(l);
      if (opts.verbose || flags.verbose) say(c.dim(`  ${l}`)); else if (important) say(/✗|blocked|failed|error/i.test(l) ? c.red(`  ${l.trim()}`) : /^\s*!|warning/i.test(l) ? c.yellow(`  ${l.trim()}`) : c.dim(`  ${l.trim()}`));
    }
    shown = d.status === "running" ? Math.max(shown, lines.length - 1) : lines.length;
    last = d;
    if (d.status !== "running") break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  unspin();
  return last;
}

async function appUrl(app: string): Promise<string | null> {
  const sys = await http<any>("GET", "/api/system").catch(() => null);
  const a = sys?.apps?.find((x: any) => x.name === app);
  const host = a?.routes?.find((h: string) => h !== "*");
  return host ? `https://${host}` : a?.routes?.includes("*") && sys?.fleetiq?.appDomain ? `https://${sys.fleetiq.appDomain}` : null;
}
function requireApp(): string {
  const a = flag("app") ?? pos[0] ?? linked()?.app;
  if (!a) fail(`which app? run ${c.bold("fleetiq init")} or ${c.bold("fleetiq link")} here, or pass --app NAME`);
  return a!;
}

// ---------- commands ----------
const cmds: Record<string, { help: string; run: () => Promise<void> }> = {
  login: { help: "save the console address and an API token", run: async () => {
    const prev = readJson(CONF) ?? {};
    let url = String(flag("url") ?? (await ask("Console address", process.env.FLEETIQ_URL ?? prev.url ?? "https://console."))).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    let token = flag("token") ?? process.env.FLEETIQ_TOKEN ?? "";
    if (!token) {
      info(`Create a token in the console: ${c.bold(`${url}/access`)} → New token (operator, for deploys). Opening it…`);
      if (!flags["no-browser"]) openUrl(`${url}/access?new=cli`);
      token = await ask("Paste the token (fiq_…)", "", true);
    }
    if (!token.startsWith("fiq_")) fail("that isn't a FleetIQ token (they start with fiq_)");
    process.env.FLEETIQ_URL = url; process.env.FLEETIQ_TOKEN = token;
    const me = await http<any>("GET", "/api/me");
    mkdirSync(CONF_DIR, { recursive: true });
    writeFileSync(CONF, JSON.stringify({ url, token }, null, 2) + "\n", { mode: 0o600 }); try { chmodSync(CONF, 0o600); } catch {}
    ok(`Signed in to ${c.bold(url)} as ${me.name ?? me.sub} (${me.canOperate ? "operator" : "viewer: read only"})`);
    info(`Saved to ${CONF}. Next: ${c.bold("fleetiq init")} in a project folder.`);
  } },
  logout: { help: "forget the saved token", run: async () => { rmSync(CONF, { force: true }); ok("Signed out (the token itself stays valid until you revoke it in API & access)"); } },
  whoami: { help: "who the token belongs to", run: async () => {
    const me = await http<any>("GET", "/api/me"); const { url } = creds();
    if (json) return printJson({ url, ...me });
    console.log(`${c.bold(me.name ?? me.sub)} on ${url} · ${me.canOperate ? "operator" : "viewer"}`);
  } },

  init: { help: "link this folder to an app: create it, give it an address, optionally deploy on git push", run: async () => {
    const root = resolve(flag("dir") ?? process.cwd());
    const cfgFile = ["wrangler.jsonc", "wrangler.json"].map((f) => join(root, f)).find(existsSync);
    const wname = cfgFile ? /"name"\s*:\s*"([^"]+)"/.exec(readFileSync(cfgFile, "utf8"))?.[1] : undefined;
    if (!cfgFile) warn("no wrangler.jsonc here; FleetIQ deploys Workers projects (the workiq-celld-deploy skill converts WorkIQ apps)");
    const name = (flag("app") ?? (await ask("App name", wname ?? root.split(/[\\/]/).pop()!.toLowerCase()))).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) fail("app names are lowercase letters, digits and hyphens");
    const exists = await http("GET", `/api/apps/${name}`).then(() => true, (e) => (e.status === 404 ? false : Promise.reject(e)));
    const sys = await http<any>("GET", "/api/system");
    if (!exists) {
      if (!(await yes(`Create app ${c.bold(name)} on ${creds().url}?`, true))) fail("nothing changed");
      await http("POST", "/api/apps", { name, managed: true, desiredNodes: 2, healthPath: flag("health") ?? "/api/health" });
      await http("POST", `/api/apps/${name}/scale`, { nodes: 2 });
      ok(`Created ${name} with 2 nodes`);
    } else ok(`Linked to existing app ${name}`);
    const domain = sys.fleetiq?.appDomain;
    const host = domain ? `${name}.${domain}` : null;
    const routed = sys.apps?.find((a: any) => a.name === name)?.routes ?? [];
    if (host && !routed.length && (await yes(`Serve it at https://${host}?`, true))) {
      await http("PUT", "/api/routes", { host, app: name }).then(() => ok(`Route https://${host}`), (e) => warn(`Route saved, but: ${e.message}`));
    }
    // Git: deploy on push from the repo this folder lives in.
    const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "";
    const gh = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remote)?.[1];
    if (gh && !flags["no-git"]) {
      const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).stdout?.trim() ?? root;
      const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "main";
      const sub = relative(top, root).split("\\").join("/");
      if (await yes(`Deploy ${c.bold(`${gh}@${branch}${sub ? `/${sub}` : ""}`)} to production on every push?`, false)) {
        await http("PUT", `/api/apps/${name}/source`, { repo: gh, ref: branch, path: sub, autoDeploy: true });
        const hook = await http<any>("POST", `/api/apps/${name}/source/webhook`, {}).catch((e) => ({ error: e.message }));
        if (hook?.error) warn(`Webhook not registered on GitHub (${hook.error}). Add the GitHub token in the app's Source panel, or add the webhook by hand.`);
        else ok(`GitHub webhook ${hook.action ?? "registered"}: pushes to ${branch} deploy ${name}`);
      }
    }
    writeFileSync(join(root, LINK), JSON.stringify({ app: name, url: creds().url }, null, 2) + "\n");
    ok(`Wrote ${LINK} (no secrets in it; commit it so teammates deploy to the same app)`);
    info(`Next: ${c.bold("fleetiq deploy")} for a preview, ${c.bold("fleetiq deploy --prod")} for production.`);
  } },
  link: { help: "link this folder to an existing app (--app NAME)", run: async () => {
    const name = flag("app") ?? pos[0] ?? (await ask("App name"));
    await http("GET", `/api/apps/${name}`);
    writeFileSync(join(process.cwd(), LINK), JSON.stringify({ app: name, url: creds().url }, null, 2) + "\n");
    ok(`Linked ${process.cwd()} to ${name}`);
  } },
  unlink: { help: "remove the link file", run: async () => { const f = findUp(LINK); if (f) { rmSync(f); ok(`Removed ${f}`); } else info("not linked"); } },

  deploy: { help: "build and deploy: a preview by default, --prod for production", run: async () => {
    const prod = !!flags.prod;
    const app = requireApp();
    const root = resolve(flag("dir") ?? linked()?.root ?? process.cwd());
    const t0 = Date.now();
    await http("GET", `/api/apps/${app}`).catch((e) => fail(e.status === 404 ? `there's no app ${app} on this server: run fleetiq init` : e.message));
    // Where it goes: the app itself, or its preview app (own nodes, own data, own address).
    let target = app; let previewUrl: string | null = null;
    if (!prod) {
      spin("Preparing the preview");
      const p = await http<any>("POST", `/api/apps/${app}/preview`, { alias: flag("alias") });
      unspin(); target = p.app; previewUrl = p.url;
      if (p.created) info(`New preview app ${c.bold(target)}: its own data (empty) and nodes. Remove it with ${c.bold(`fleetiq previews rm${flag("alias") ? ` --alias ${flag("alias")}` : ""}`)}`);
    }
    let dep: any;
    if (flags.git) {
      const src = await http<any>("GET", `/api/apps/${app}/source`).catch(() => null);
      if (!src?.repo) fail(`${app} has no Git source: run fleetiq init in the repo, or deploy this folder without --git`);
      const ref = flag("ref");
      info(`Building ${src.repo}@${ref ?? src.ref}${src.path ? `/${src.path}` : ""} on the server`);
      dep = await http("POST", `/api/apps/${target}/deploy/git`, target === app ? (ref ? { ref } : {}) : { repo: src.repo, ref: ref ?? src.ref, path: src.path });
    } else {
      spin(`Packing ${root}`);
      const p = pack(root); unspin();
      info(`Uploading ${p.count} files (${mb(p.bytes)}, ${p.via})${p.skipped.length ? c.dim(` · left out ${p.skipped.slice(0, 3).join(", ")}${p.skipped.length > 3 ? "…" : ""}`) : ""}`);
      try {
        const msg = flag("message") ?? spawnSync("git", ["log", "-1", "--format=%h %s"], { cwd: root, encoding: "utf8" }).stdout?.trim().slice(0, 100) ?? "";
        const form = await formWith(p.file, "source", { label: `CLI${msg ? `: ${msg}` : ""}`, checks: flags["skip-checks"] ? "false" : "true", path: flag("path") ?? "" });
        dep = await http("POST", `/api/apps/${target}/deploy/source`, undefined, { form });
      } finally { p.cleanup(); }
    }
    const d = await follow(dep.id, { label: "Queued" });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (d.status !== "succeeded") {
      const blocked = /blocked by policy/.test(d.log ?? "");
      if (json) printJson({ app: target, deployment: d.id, status: blocked ? "blocked" : "failed", log: d.log });
      // Show the error itself, not whatever progress came last.
      const lines = String(d.log ?? "").trim().split("\n");
      let at = -1; lines.forEach((l, i) => { if (/^(Error|error)[:\[]|^build failed|failed:|^unexpected:|blocked by policy/.test(l.trim())) at = i; });
      const tail = (at >= 0 ? lines.slice(at, at + 8) : lines.slice(-6)).join("\n");
      console.log(c.red(`✘ ${blocked ? "Blocked by policy" : "Deploy failed"} after ${secs}s`));
      if (!blocked && !flags.verbose) console.log(c.dim(tail));
      info(`Full log: ${creds().url}/app?name=${encodeURIComponent(target)}${blocked ? `  ·  findings and waivers: ${creds().url}/compliance` : ""}`);
      throw new CliError(blocked ? "deploy blocked by policy" : "deploy failed", blocked ? 2 : 1);
    }
    const url = previewUrl ?? (await appUrl(target));
    if (json) printJson({ app: target, preview: !prod, deployment: d.id, status: d.status, version: d.version, url, console: `${creds().url}/app?name=${encodeURIComponent(target)}` });
    else {
      ok(`${prod ? "Live" : "Preview live"} in ${secs}s · version ${c.bold(String(d.version ?? ""))}`);
      if (url) console.log(`  ${prod ? "URL" : "Preview"}:  ${c.bold(c.cyan(url))}`);
      console.log(`  Console: ${c.dim(`${creds().url}/app?name=${encodeURIComponent(target)}`)}`);
      if (!prod) console.log(c.dim(`  When it looks right: fleetiq deploy --prod`));
    }
    // Ship the same build to a Cloudflare target as well.
    const cf = flags.cloudflare;
    if (cf && prod) {
      const targets = await http<any[]>("GET", `/api/apps/${app}/targets`);
      const t = typeof cf === "string" ? targets.find((x) => x.target === cf || x.targetName === cf) : targets[0];
      if (!t) warn(`${app} isn't linked to ${typeof cf === "string" ? cf : "a Cloudflare target"} yet (Also on Cloudflare in the console)`);
      else {
        info(`Deploying the same build to Cloudflare ${t.targetName ?? t.target}`);
        const cd = await http<any>("POST", `/api/apps/${app}/targets/${t.target}/deploy`, { from: "current" });
        const r = await follow(cd.id, { label: "Deploying to Cloudflare" });
        if (r.status === "succeeded") ok(`Cloudflare: ${t.url ?? t.hostname ?? "deployed"}`); else throw new CliError("Cloudflare deploy failed", 1);
      }
    } else if (cf) warn("--cloudflare only applies with --prod");
    if (flags.open && url) openUrl(url);
  } },

  status: { help: "the linked app: version, nodes, address, gate, recent deploys", run: async () => {
    const app = requireApp();
    const [a, deps, comp, prev] = await Promise.all([http<any>("GET", `/api/apps/${app}`), http<any[]>("GET", `/api/apps/${app}/deployments`), http<any>("GET", "/api/compliance").catch(() => null), http<any[]>("GET", `/api/apps/${app}/previews`).catch(() => [])]);
    const url = await appUrl(app);
    const post = comp?.apps?.find((x: any) => x.app === app);
    if (json) return printJson({ app: a.app, fleet: a.fleet, url, compliance: post, deployments: deps.slice(0, 5), previews: prev });
    console.log(`${c.bold(app)}  ${url ? c.cyan(url) : c.dim("(no address: fleetiq init adds one)")}`);
    console.log(`  Version  ${a.fleet?.version ?? "none yet"} · nodes ${a.fleet?.live ?? 0}/${a.app?.desiredNodes ?? "?"}`);
    if (post) console.log(`  Gate     ${post.decision ?? "not scanned"}${post.summary ? ` · ${post.summary.vulns.critical} critical, ${post.summary.vulns.high} high · ${post.summary.secrets} secrets` : ""}`);
    for (const d of deps.slice(0, 5)) console.log(`  ${d.status === "succeeded" ? c.green("✔") : d.status === "running" ? c.yellow("…") : c.red("✘")} ${new Date(d.startedAt * 1000).toLocaleString()}  ${d.kind} ${d.version ?? ""}  ${c.dim(`${d.source ?? ""} · ${d.actor}`)}`);
    for (const p of prev) console.log(`  Preview  ${p.app} ${p.url ? c.cyan(p.url) : ""}`);
  } },
  open: { help: "open the app (--console for its console page)", run: async () => {
    const app = requireApp();
    const u = flags.console || flags.admin ? `${creds().url}/app?name=${encodeURIComponent(app)}` : (await appUrl(app)) ?? `${creds().url}/app?name=${encodeURIComponent(app)}`;
    openUrl(u); info(u);
  } },
  logs: { help: "node logs (-n 200, --follow)", run: async () => {
    const app = requireApp(); const tail = Number(flag("tail") ?? 100);
    const seen = new Set<string>();
    for (;;) {
      const out = await http<any[]>("GET", `/api/apps/${app}/logs?tail=${tail}`);
      for (const n of out) for (const l of String(n.logs).split("\n")) { const k = `${n.container}|${l}`; if (l && !seen.has(k)) { seen.add(k); console.log(`${c.dim(n.container.replace(/^fleetiq-/, ""))} ${l}`); } }
      if (!flags.follow) break;
      await new Promise((r) => setTimeout(r, 2000));
      if (seen.size > 20_000) seen.clear();
    }
  } },
  rollback: { help: "go back to the previous version (or a given one)", run: async () => {
    const app = requireApp();
    let v = pos[1] ?? flag("version");
    if (!v) {
      const vs = await http<any[]>("GET", `/api/apps/${app}/versions`);
      const i = vs.findIndex((x) => x.current); v = vs[i + 1]?.version;
      if (!v) fail("no earlier version to go back to");
      if (!(await yes(`Roll ${app} back to ${v} (uploaded ${vs[i + 1].uploadedAt})?`, true))) fail("nothing changed");
    }
    const r = await http<any>("POST", `/api/apps/${app}/rollback`, { version: v });
    ok(`${app} is on ${r.version}${r.warning ? c.yellow(` (${r.warning})`) : ""}`);
  } },
  scan: { help: "scan this folder against the policy without deploying (exit 2 when it would be blocked)", run: async () => {
    const app = requireApp(); const root = resolve(flag("dir") ?? linked()?.root ?? process.cwd());
    spin("Packing"); const p = pack(root); spin("Scanning on the server");
    let s: any;
    try { s = await http("POST", `/api/apps/${app}/scan`, undefined, { form: await formWith(p.file, "source", { label: "CLI scan", path: flag("path") ?? "" }) }); }
    finally { p.cleanup(); unspin(); }
    if (json) { printJson(s); if (s.now?.decision === "blocked") throw new CliError("", 2); return; }
    const v = s.summary.vulns;
    console.log(`${s.now.decision === "passed" ? c.green("✔ Passes the policy") : s.now.decision === "warned" ? c.yellow("! Passes with warnings") : c.red("✘ Would be blocked")}  ${c.dim(`${s.summary.packages} packages · ${s.summary.filesScanned} files`)}`);
    console.log(`  Vulnerabilities  ${v.critical} critical · ${v.high} high · ${v.moderate} moderate · ${v.low} low${s.summary.fixable ? c.dim(` (${s.summary.fixable} fixable by upgrading)`) : ""}`);
    console.log(`  Secrets          ${s.summary.secrets}${s.summary.config ? ` · config ${s.summary.config}` : ""} · licenses unknown ${s.summary.licensesUnknown}`);
    for (const r of s.now.reasons) console.log(`  ${r.blocking ? c.red("✗") : c.yellow("!")} ${r.message}`);
    for (const x of (s.findings?.secrets ?? []).slice(0, 10)) console.log(c.dim(`    ${x.title}: ${x.file}:${x.line} ${x.preview}`));
    const top = (s.findings?.vulns ?? []).filter((x: any) => !x.dev && !x.build).slice(0, 8);
    for (const x of top) console.log(c.dim(`    ${x.severity.padEnd(8)} ${x.package}@${x.version} ${x.fixed ? `→ ${x.fixed}` : "(no fix yet)"}  ${x.id}`));
    info(`Details: ${creds().url}/compliance`);
    if (s.now.decision === "blocked") throw new CliError("", 2);
  } },
  previews: { help: "list previews; `previews rm [--alias NAME]` removes one", run: async () => {
    const app = flag("app") ?? linked()?.app ?? fail("run in a linked folder or pass --app");
    if (pos[0] === "rm" || pos[0] === "delete") { const r = await http<any>("DELETE", `/api/apps/${app}/preview${flag("alias") ? `?alias=${encodeURIComponent(flag("alias")!)}` : ""}`); ok(`Removed ${r.removed} (its data stays in the bucket)`); return; }
    const ps = await http<any[]>("GET", `/api/apps/${app}/previews`);
    if (json) return printJson(ps);
    if (!ps.length) info(`No previews of ${app}. ${c.bold("fleetiq deploy")} makes one.`);
    for (const p of ps) console.log(`${c.bold(p.app)}  ${p.url ? c.cyan(p.url) : ""}`);
  } },
  apps: { help: "every app on the server", run: async () => {
    const sys = await http<any>("GET", "/api/system");
    if (json) return printJson(sys.apps);
    for (const a of sys.apps) console.log(`${c.bold(a.name.padEnd(24))} ${String(a.version ?? "—").padEnd(18)} ${a.liveNodes}/${a.desiredNodes} nodes  ${c.dim(a.routes.filter((r: string) => r !== "*").join(" "))}`);
  } },
  api: { help: "call any endpoint: fleetiq api GET /api/system (see /api/openapi.json)", run: async () => {
    const [m, p, body] = pos; if (!m || !p) fail("fleetiq api METHOD PATH [JSON]");
    printJson(await http(m!.toUpperCase(), p!, body ? JSON.parse(body) : undefined));
  } },
  upgrade: { help: "install the CLI version your server ships", run: async () => {
    const { url } = creds(); if (!url) fail("fleetiq login first");
    const r = await fetch(`${url}/cli/fleetiq.mjs`); if (!r.ok) fail(`download failed: HTTP ${r.status}`);
    const self = process.argv[1]!; writeFileSync(self, await r.text()); try { chmodSync(self, 0o755); } catch {}
    ok(`Updated ${self}`);
  } },
  version: { help: "print the CLI version", run: async () => console.log(VERSION) },
};

function help() {
  console.log(`${c.bold("fleetiq")} ${VERSION} · deploy Workers and Durable Objects apps to your FleetIQ server\n`);
  for (const [k, v] of Object.entries(cmds)) console.log(`  ${c.bold(k.padEnd(10))} ${v.help}`);
  console.log(`\n${c.bold("Deploy flags")}  --prod  --message "…"  --alias NAME  --git [--ref REF]  --dir PATH  --skip-checks  --cloudflare [TARGET]  --open  --verbose  --json`);
  console.log(`${c.bold("Anywhere")}      --app NAME  --url URL  --token fiq_…  (or FLEETIQ_URL / FLEETIQ_TOKEN for CI)  --yes`);
}

const name = pos.shift() ?? "help";
if (name === "help" || flags.help || !cmds[name]) { if (name !== "help" && !flags.help && !cmds[name]) console.error(c.red(`unknown command ${name}\n`)); help(); process.exit(name === "help" || flags.help ? 0 : 1); }
cmds[name]!.run().then(() => process.exit(0), (e) => {
  unspin();
  if (e instanceof CliError) { if (e.message) console.error(c.red(`✘ ${e.message}`)); process.exit(e.code); }
  console.error(c.red(`✘ ${e?.message ?? e}`)); process.exit(1);
});
