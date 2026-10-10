import { AwsClient } from "aws4fetch";
import { bucketName, config } from "../config";

// Direct, read-mostly access to the fleet bucket: deployment pointers, manifests, node leases.
// The one write is a rollback pointer swap, done with If-Match so a concurrent deploy wins cleanly.

export interface DeployPointer { script_name?: string; version: string; prefix: string; rollout: { percent: number } }
export interface NodeLease { node: string; expires_ms: number; addr: string; peer_protocol?: number; load?: Record<string, number | boolean>; log?: { ensemble?: string[] } }
export interface VersionInfo { version: string; uploadedAt: string | null; current: boolean; manifest?: any }

let client: AwsClient | null = null;
const aws = () => (client ??= new AwsClient({
  accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region || "us-east-1", service: "s3",
}));
const base = () => {
  const ep = (config.s3Endpoint || `https://s3.${config.region}.amazonaws.com`).replace(/\/+$/, "");
  return `${ep}/${bucketName()}`; // path-style: works for R2, MinIO, SeaweedFS and S3
};
const enc = (k: string) => k.split("/").map(encodeURIComponent).join("/");

export class BucketError extends Error { constructor(m: string, public status = 0) { super(m); } }

export async function getObject(key: string): Promise<{ body: string; etag: string | null } | null> {
  const r = await aws().fetch(`${base()}/${enc(key)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new BucketError(`GET ${key}: ${r.status}`, r.status);
  return { body: await r.text(), etag: r.headers.get("etag") };
}
export async function getJson<T>(key: string): Promise<{ value: T; etag: string | null } | null> {
  const o = await getObject(key);
  return o ? { value: JSON.parse(o.body) as T, etag: o.etag } : null;
}
// Conditional write: If-Match an ETag, or If-None-Match: * when the object must not exist yet.
export async function putJsonIfMatch(key: string, value: unknown, etag: string | null) {
  const r = await aws().fetch(`${base()}/${enc(key)}`, {
    method: "PUT", body: JSON.stringify(value, null, 2),
    headers: { "content-type": "application/json", ...(etag ? { "if-match": etag } : { "if-none-match": "*" }) },
  });
  if (r.status === 412) throw new BucketError(`${key} changed while rolling back — another deploy happened; reload and retry`, 412);
  if (!r.ok) throw new BucketError(`PUT ${key}: ${r.status} ${await r.text()}`, r.status);
}

// ListObjectsV2 with delimiter; tiny XML extraction (keys and common prefixes only).
export async function list(prefix: string, delimiter?: string) {
  const keys: { key: string; lastModified: string; size: number }[] = [];
  const prefixes: string[] = [];
  let token: string | null = null;
  do {
    const u = new URL(`${base()}`);
    u.searchParams.set("list-type", "2"); u.searchParams.set("prefix", prefix);
    if (delimiter) u.searchParams.set("delimiter", delimiter);
    if (token) u.searchParams.set("continuation-token", token);
    const r = await aws().fetch(u.toString());
    if (!r.ok) throw new BucketError(`LIST ${prefix}: ${r.status}`, r.status);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const c = m[1]!;
      keys.push({ key: xmlText(c, "Key"), lastModified: xmlText(c, "LastModified"), size: Number(xmlText(c, "Size") || 0) });
    }
    for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>/g)) prefixes.push(unxml(m[1]!));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(xml, "NextContinuationToken") || null : null;
  } while (token);
  return { keys, prefixes };
}
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xmlText = (s: string, tag: string) => unxml(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s)?.[1] ?? "");

// ---- fleet views ----
export const fleetPointer = (prefix: string) => getJson<DeployPointer>(`${prefix}/deploy/current.json`);

export async function nodeLeases(prefix: string): Promise<NodeLease[]> {
  const { keys } = await list(`${prefix}/nodes/`);
  const leases = await Promise.all(keys.filter((k) => k.key.endsWith(".json")).map((k) => getJson<NodeLease>(k.key)));
  return leases.filter((l): l is { value: NodeLease; etag: string | null } => !!l).map((l) => l.value);
}

export async function versions(prefix: string, script: string): Promise<VersionInfo[]> {
  const [pointer, listing] = await Promise.all([fleetPointer(prefix), list(`${prefix}/deploy/${script}/`, "/")]);
  const cur = pointer?.value.version;
  const out: VersionInfo[] = [];
  for (const p of listing.prefixes) {
    const v = p.slice(`${prefix}/deploy/${script}/`.length).replace(/\/$/, "");
    if (!/^[0-9a-f]{16}$/.test(v)) continue;
    const m = await list(`${p}manifest.json`);
    out.push({ version: v, uploadedAt: m.keys[0]?.lastModified ?? null, current: v === cur });
  }
  return out.sort((a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""));
}

export const manifest = async (prefix: string, script: string, version: string) =>
  (await getJson<any>(`${prefix}/deploy/${script}/${version}/manifest.json`))?.value ?? null;

// Bindings declared by the current deployment, grouped for the data explorer.
export function bindingsOf(manifest: any) {
  const b: any[] = manifest?.raw_metadata?.bindings ?? [];
  return {
    durableObjects: b.filter((x) => x.type === "durable_object_namespace").map((x) => ({ binding: x.name, className: x.class_name })),
    kv: b.filter((x) => x.type === "kv").map((x) => ({ binding: x.name, id: x.id })),
    d1: b.filter((x) => x.type === "d1").map((x) => ({ binding: x.name, name: x.database_name, id: x.database_id })),
    queues: b.filter((x) => x.type === "queue").map((x) => ({ binding: x.name, queue: x.queue })),
    r2: b.filter((x) => x.type === "r2_bucket").map((x) => ({ binding: x.name, bucket: x.bucket_name })),
    vars: b.filter((x) => x.type === "plain_text").map((x) => ({ name: x.name, value: x.text })),
    consumers: (manifest?.queue_consumers ?? []).map((c: any) => c.queue),
    crons: manifest?.crons ?? [],
  };
}
