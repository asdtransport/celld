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
