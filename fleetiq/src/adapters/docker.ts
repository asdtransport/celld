import { config } from "../config";
import { UpstreamError, unixJson } from "./http";

// Docker Engine API over the unix socket. Used for: stack status, restarts, logs, and managed node containers.
const API = "/v1.43";
export interface ContainerSummary {
  id: string; name: string; image: string; state: string; status: string;
  project: string | null; service: string | null; app: string | null; role: string | null;
}

const summarize = (c: any): ContainerSummary => ({
  id: c.Id.slice(0, 12), name: (c.Names?.[0] ?? "").replace(/^\//, ""), image: c.Image, state: c.State, status: c.Status,
  project: c.Labels?.["com.docker.compose.project"] ?? null, service: c.Labels?.["com.docker.compose.service"] ?? null,
  app: c.Labels?.["fleetiq.app"] ?? null, role: c.Labels?.["fleetiq.role"] ?? null,
});

export async function listContainers(): Promise<ContainerSummary[]> {
  const all = await unixJson<any[]>(config.dockerSock, `${API}/containers/json?all=1`);
  return all.map(summarize).filter((c) => c.app || (c.project && config.stackProjects.includes(c.project)));
}

// Only containers FleetIQ can see in listContainers() may be acted on.
async function assertManaged(idOrName: string) {
  const c = (await listContainers()).find((x) => x.id === idOrName || x.name === idOrName);
  if (!c) throw new UpstreamError(`container ${idOrName} is not part of the managed stack`, 404);
  return c;
}
export async function containerAction(idOrName: string, action: "start" | "stop" | "restart") {
  const c = await assertManaged(idOrName);
  await unixJson(config.dockerSock, `${API}/containers/${c.id}/${action}?t=10`, { method: "POST" }, 30_000);
  return c;
}

// Non-TTY logs are multiplexed: 8-byte frame headers (stream, 0,0,0, size BE32).
export function demuxLogs(buf: Uint8Array): string {
  const out: string[] = []; let i = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    while (i + 8 <= buf.length) {
      const size = dv.getUint32(i + 4); i += 8;
      out.push(new TextDecoder().decode(buf.subarray(i, i + size))); i += size;
    }
    return out.join("");
  }
  return new TextDecoder().decode(buf);
}
export async function containerLogs(idOrName: string, tail = 200): Promise<string> {
  const c = await assertManaged(idOrName);
  const r = await fetch(`http://localhost${API}/containers/${c.id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`, { unix: config.dockerSock } as any);
  if (!r.ok) throw new UpstreamError(`logs ${c.name}: ${r.status}`, r.status);
  return demuxLogs(new Uint8Array(await r.arrayBuffer())).replace(/\x1b\[[0-9;]*m/g, "");
}

// ---- managed celld nodes ----
export const nodeContainerName = (app: string, i: number) => `fleetiq-${app}-node-${i}`;

export function nodeSpec(app: string, prefix: string, i: number, image: string) {
  const name = nodeContainerName(app, i);
  const args = ["--bucket", `s3://${config.bucket.replace(/^s3:\/\//, "").split("/")[0]}/${prefix}`,
    "--listen", "0.0.0.0:8787", "--internal-listen", "0.0.0.0:8788", "--advertise", `${name}:8788`];
  if (config.s3Endpoint) args.push("--endpoint", config.s3Endpoint);
  if (config.region) args.push("--region", config.region);
  return {
    name,
    body: {
      Image: image, Cmd: args,
      Env: [`AWS_ACCESS_KEY_ID=${config.accessKeyId}`, `AWS_SECRET_ACCESS_KEY=${config.secretAccessKey}`, `AWS_REGION=${config.region}`, "CELLD_WATCH=/var/lib/celld/state"],
      Labels: { "fleetiq.app": app, "fleetiq.role": "node", "fleetiq.index": String(i) },
      HostConfig: {
        NetworkMode: config.fleetNetwork, RestartPolicy: { Name: "unless-stopped" },
        Mounts: [{ Type: "volume", Source: `${name}-state`, Target: "/var/lib/celld" }],
      },
      NetworkingConfig: { EndpointsConfig: { [config.fleetNetwork]: { Aliases: [name] } } },
    },
  };
}

export async function ensureImage(image: string) {
  try { await unixJson(config.dockerSock, `${API}/images/${encodeURIComponent(image)}/json`); return; } catch {}
  const [from, tag] = image.includes(":") ? [image.slice(0, image.lastIndexOf(":")), image.slice(image.lastIndexOf(":") + 1)] : [image, "latest"];
  const r = await fetch(`http://localhost${API}/images/create?fromImage=${encodeURIComponent(from)}&tag=${encodeURIComponent(tag)}`, { method: "POST", unix: config.dockerSock } as any);
  const text = await r.text();
  if (!r.ok || /"error"/.test(text)) throw new UpstreamError(`pull ${image}: ${text.slice(-300)}`, r.status);
}

export async function createNode(app: string, prefix: string, i: number, image: string) {
  const { name, body } = nodeSpec(app, prefix, i, image);
  await ensureImage(image);
  await unixJson(config.dockerSock, `${API}/containers/create?name=${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 30_000);
  await unixJson(config.dockerSock, `${API}/containers/${name}/start`, { method: "POST" }, 30_000);
  return name;
}
export async function removeNode(name: string) {
  // SIGTERM first: celld hands cells off and drains before exit.
  await unixJson(config.dockerSock, `${API}/containers/${name}/stop?t=30`, { method: "POST" }, 60_000).catch(() => {});
  await unixJson(config.dockerSock, `${API}/containers/${name}?v=1`, { method: "DELETE" }, 30_000);
}

// ---- builder containers ----
// A build runs in a throwaway container from the FleetIQ image: no Docker socket, no fleet network,
// memory-capped, removed afterwards. Files go in and out through the archive API (tar streams).
export async function runBuilder(opts: {
  image: string; env: string[]; files: { name: string; data: Uint8Array }[]; timeoutMs: number; memoryMb: number;
  onLog?: (text: string) => void;
}): Promise<{ exitCode: number; logs: string; output: Uint8Array | null }> {
  const name = `fleetiq-build-${Date.now().toString(36)}`;
  const body = {
    Image: opts.image, Cmd: ["sh", "/app/bin/build.sh"], Env: opts.env, WorkingDir: "/tmp",
    Labels: { "fleetiq.role": "builder" },
    HostConfig: { NetworkMode: "bridge", Memory: opts.memoryMb * 1024 * 1024, AutoRemove: false },
  };
  await unixJson(config.dockerSock, `${API}/containers/create?name=${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, 30_000);
  const sock = config.dockerSock;
  try {
    const tar = await makeTar(opts.files.map((f) => ({ name: `in/${f.name}`, data: f.data })));
    const put = await fetch(`http://localhost${API}/containers/${name}/archive?path=/tmp`, { method: "PUT", headers: { "content-type": "application/x-tar" }, body: tar, unix: sock } as any);
    if (!put.ok) throw new UpstreamError(`builder upload: ${put.status} ${await put.text()}`, put.status);
    await unixJson(sock, `${API}/containers/${name}/start`, { method: "POST" }, 30_000);
    const deadline = Date.now() + opts.timeoutMs;
    let state: any = null;
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      if (opts.onLog) opts.onLog(await builderLogs(name).catch(() => ""));
      state = await unixJson(sock, `${API}/containers/${name}/json`).then((j: any) => j.State);
      if (!state.Running) break;
    }
    if (state?.Running) {
      await unixJson(sock, `${API}/containers/${name}/kill`, { method: "POST" }).catch(() => {});
      return { exitCode: 124, logs: (await builderLogs(name).catch(() => "")) + "\n✗ build timed out", output: null };
    }
    const logs = await builderLogs(name).catch(() => "");
    if (state.ExitCode !== 0) return { exitCode: state.ExitCode, logs, output: null };
    const r = await fetch(`http://localhost${API}/containers/${name}/archive?path=/tmp/out/app.tgz`, { unix: sock } as any);
    if (!r.ok) return { exitCode: 1, logs: `${logs}\n✗ the build produced no archive`, output: null };
    return { exitCode: 0, logs, output: extractSingleFromTar(new Uint8Array(await r.arrayBuffer())) };
  } finally {
    await unixJson(sock, `${API}/containers/${name}?force=1&v=1`, { method: "DELETE" }, 30_000).catch(() => {});
  }
}
async function builderLogs(name: string): Promise<string> {
  const r = await fetch(`http://localhost${API}/containers/${name}/logs?stdout=1&stderr=1`, { unix: config.dockerSock } as any);
  return demuxLogs(new Uint8Array(await r.arrayBuffer())).replace(/\x1b\[[0-9;]*m/g, "");
}

// Minimal ustar writer/reader: enough for a few regular files.
export async function makeTar(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const enc = new TextEncoder(); const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  for (const f of files) { const d = f.name.split("/").slice(0, -1); for (let i = 1; i <= d.length; i++) dirs.add(d.slice(0, i).join("/") + "/"); }
  const header = (name: string, size: number, type: "0" | "5") => {
    const h = new Uint8Array(512);
    const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
    put(name, 0, 100); put(type === "5" ? "0000755\0" : "0000644\0", 100, 8); put("0000000\0", 108, 8); put("0000000\0", 116, 8);
    put(size.toString(8).padStart(11, "0") + "\0", 124, 12); put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
    put("        ", 148, 8); put(type, 156, 1); put("ustar\0", 257, 6); put("00", 263, 2);
    let sum = 0; for (const b of h) sum += b; put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    return h;
  };
  for (const d of dirs) parts.push(header(d, 0, "5"));
  for (const f of files) {
    parts.push(header(f.name, f.data.length, "0"), f.data);
    const pad = (512 - (f.data.length % 512)) % 512; if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}
export function extractSingleFromTar(tar: Uint8Array): Uint8Array | null {
  const dec = new TextDecoder(); let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return null;
    const size = parseInt(dec.decode(h.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8);
    const type = String.fromCharCode(h[156]!);
    off += 512;
    if (type === "0" || type === "\0") return tar.slice(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return null;
}
