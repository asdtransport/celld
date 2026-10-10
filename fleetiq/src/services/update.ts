import { demuxLogs, ensureImage } from "../adapters/docker";
import { UpstreamError, unixJson } from "../adapters/http";
import { config } from "../config";

// One-click platform updates. FleetIQ can't run the installer itself (it is one of the containers
// the installer replaces), so it starts a one-shot helper: the Docker CLI image with the Docker
// socket and the stack folder mounted at the same path as on the host. The helper downloads the
// exact commit and runs install.sh, which keeps secrets, keys, options (install.env) and all data.
const API = "/v1.43";
const sock = () => config.dockerSock;

async function gh<T = any>(path: string): Promise<T | null> {
  const r = await fetch(`${config.githubApi}/repos/${config.updateRepo}${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "fleetiq", "x-github-api-version": "2022-11-28", ...(config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  return r?.ok ? ((await r.json()) as T) : null;
}

export async function versionInfo() {
  const current = config.stackVersion || null;
  if (config.updateSourceUrl) return { repo: config.updateSourceUrl, ref: "mirror", current, latest: null, behind: null, commits: [], canUpdate: !!config.stackPrefix, reason: config.stackPrefix ? null : "no STACK_PREFIX", githubReachable: false, mirror: true };
  const head = await gh<any>(`/commits/${encodeURIComponent(config.updateRef)}`);
  const latest = head ? { sha: head.sha as string, message: String(head.commit?.message ?? "").split("\n")[0], date: head.commit?.committer?.date ?? null } : null;
  let behind: number | null = null; let commits: { sha: string; message: string; date: string | null }[] = [];
  if (latest && current && /^[0-9a-f]{7,40}$/.test(current)) {
    if (latest.sha.startsWith(current) || current.startsWith(latest.sha)) behind = 0;
    else {
      const cmp = await gh<any>(`/compare/${current}...${latest.sha}`);
      if (cmp) { behind = cmp.ahead_by ?? null; commits = (cmp.commits ?? []).slice(-20).reverse().map((c: any) => ({ sha: c.sha, message: String(c.commit?.message ?? "").split("\n")[0], date: c.commit?.committer?.date ?? null })); }
    }
  }
  return {
    repo: config.updateRepo, ref: config.updateRef, current, latest, behind, commits,
    canUpdate: !!config.stackPrefix, reason: config.stackPrefix ? null : "this FleetIQ wasn't installed by install.sh (no STACK_PREFIX), so it can't update itself",
    githubReachable: !!head,
  };
}

async function updaters(): Promise<any[]> {
  const all = await unixJson<any[]>(sock(), `${API}/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ["fleetiq.role=updater"] }))}`);
  return all.sort((a, b) => b.Created - a.Created);
}

export async function updateStatus(tail = 400) {
  const last = (await updaters().catch(() => []))[0];
  if (!last) return { running: false, last: null };
  const r = await fetch(`http://localhost${API}/containers/${last.Id}/logs?stdout=1&stderr=1&tail=${tail}`, { unix: sock() } as any).catch(() => null);
  const logs = r?.ok ? demuxLogs(new Uint8Array(await r.arrayBuffer())).replace(/\x1b\[[0-9;]*m/g, "") : "";
  const info = await unixJson<any>(sock(), `${API}/containers/${last.Id}/json`).catch(() => null);
  return {
    running: last.State === "running",
    last: { name: (last.Names?.[0] ?? "").replace(/^\//, ""), version: last.Labels?.["fleetiq.version"] ?? null, actor: last.Labels?.["fleetiq.actor"] ?? null, startedAt: info?.State?.StartedAt ?? null, finishedAt: info?.State?.Running ? null : info?.State?.FinishedAt ?? null, exitCode: info?.State?.Running ? null : info?.State?.ExitCode ?? null, logs },
  };
}

export async function startUpdate(ref: string | undefined, actor: string) {
  if (!config.stackPrefix) throw new UpstreamError("this FleetIQ can't update itself (no STACK_PREFIX); run install.sh on the server", 409);
  const list = await updaters();
  if (list.some((c) => c.State === "running")) throw new UpstreamError("an update is already running", 409);
  const mirror = config.updateSourceUrl;
  const head = mirror ? { sha: `mirror-${new Date().toISOString().replace(/\D/g, "").slice(0, 12)}`, commit: { message: `from ${mirror}` } } : await gh<any>(`/commits/${encodeURIComponent(ref || config.updateRef)}`);
  if (!head?.sha) throw new UpstreamError(`GitHub has no ${ref || config.updateRef} in ${config.updateRepo}`, 404);
  const sha: string = head.sha;
  for (const c of list) await unixJson(sock(), `${API}/containers/${c.Id}?force=1`, { method: "DELETE" }).catch(() => {}); // keep only the newest log
  await ensureImage(config.updaterImage);
  const script = [
    "set -e",
    "for t in bash curl openssl; do command -v $t >/dev/null || NEED=1; done; [ -z \"$NEED\" ] || apk add --no-cache bash curl openssl >/dev/null",
    "mkdir -p /tmp/u && cd /tmp/u",
    'if [ -n "$UPDATE_URL" ]; then echo "==> Downloading $UPDATE_URL"; curl -fsSL "$UPDATE_URL" | tar xz;',
    'else echo "==> Downloading $UPDATE_REPO@$UPDATE_SHA"; curl -fsSL "https://codeload.github.com/$UPDATE_REPO/tar.gz/$UPDATE_SHA" | tar xz; fi',
    'cd "$(ls -d */ | head -1)"',
    'echo "==> Running install.sh (keeps passwords, keys, options and data)"',
    'STACK_UPDATE=1 STACK_VERSION="$UPDATE_SHA" UPDATE_REPO="$UPDATE_REPO" UPDATE_REF="$UPDATE_REF" PREFIX="$STACK_PREFIX" SKIP_DOCKER_INSTALL=1 bash ./install.sh',
    'echo "==> Update to ${UPDATE_SHA%${UPDATE_SHA#???????}} finished"',
  ].join("\n");
  const name = `fleetiq-update-${Date.now().toString(36)}`;
  await unixJson(sock(), `${API}/containers/create?name=${name}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      Image: config.updaterImage, Cmd: ["sh", "-c", script],
      Env: [`UPDATE_URL=${mirror}`, `UPDATE_REPO=${config.updateRepo}`, `UPDATE_REF=${ref || config.updateRef}`, `UPDATE_SHA=${sha}`, `STACK_PREFIX=${config.stackPrefix}`],
      Labels: { "fleetiq.role": "updater", "fleetiq.version": sha, "fleetiq.actor": actor.slice(0, 120) },
      // Host network: the installer's health checks talk to 127.0.0.1 on the host.
      HostConfig: { NetworkMode: "host", AutoRemove: false, Binds: [`${config.dockerSock}:/var/run/docker.sock`, `${config.stackPrefix}:${config.stackPrefix}`] },
    }),
  }, 30_000);
  await unixJson(sock(), `${API}/containers/${name}/start`, { method: "POST" }, 30_000);
  return { started: true, name, sha, message: String(head.commit?.message ?? "").split("\n")[0] };
}
