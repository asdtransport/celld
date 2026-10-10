import { AwsClient } from "aws4fetch";
import { type Connector, MoverError, type ObjData, type ObjInfo, readAll } from "./types";

// Any S3-compatible store. Path-style addressing works everywhere except AWS buckets that need
// virtual-hosted style (set pathStyle false). Large objects go up in 16 MiB multipart parts.
export interface S3Config { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; pathStyle: boolean; label?: string }

const PART = 16 * 1024 * 1024;
const SINGLE_MAX = 64 * 1024 * 1024;
const enc = (k: string) => k.split("/").map(encodeURIComponent).join("/");
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (s: string, t: string) => unxml(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s)?.[1] ?? "");

export class S3Connector implements Connector {
  readonly kind = "s3";
  readonly label: string;
  private aws: AwsClient;
  private base: string;
  constructor(private c: S3Config) {
    if (!c.endpoint || !c.bucket) throw new MoverError("endpoint and bucket are required");
    this.aws = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region || "auto", service: "s3" });
    const ep = c.endpoint.replace(/\/+$/, "");
    this.base = c.pathStyle ? `${ep}/${c.bucket}` : ep.replace("://", `://${c.bucket}.`);
    this.label = c.label ?? `s3://${c.bucket}`;
  }
  private url(key = "") { return `${this.base}/${enc(key)}`; }
  private async req(url: string, init: RequestInit = {}, what = "request") {
    const r = await this.aws.fetch(url, init).catch((e) => { throw new MoverError(`${this.label}: ${what} failed: ${e.message}`, 502); });
    return r;
  }
  private async fail(r: Response, what: string): Promise<never> {
    const body = await r.text().catch(() => "");
    const code = tag(body, "Code"); const msg = tag(body, "Message");
    throw new MoverError(`${this.label}: ${what}: HTTP ${r.status}${code ? ` ${code}` : ""}${msg ? ` — ${msg}` : ""}`, r.status === 403 || r.status === 401 ? 403 : 502);
  }

  async *list(prefix: string): AsyncIterable<ObjInfo> {
    let token: string | null = null;
    do {
      const u = new URL(this.base + "/");
      u.searchParams.set("list-type", "2"); u.searchParams.set("prefix", prefix); u.searchParams.set("max-keys", "1000");
      if (token) u.searchParams.set("continuation-token", token);
      const r = await this.req(u.toString(), {}, "list");
      if (!r.ok) await this.fail(r, `list ${prefix || "/"}`);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const c = m[1]!;
        const lm = tag(c, "LastModified");
        yield { key: tag(c, "Key"), size: Number(tag(c, "Size") || 0), etag: tag(c, "ETag").replace(/"/g, "") || null, mtime: lm ? Date.parse(lm) : null };
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? tag(xml, "NextContinuationToken") || null : null;
    } while (token);
  }

  async get(key: string): Promise<ObjData | null> {
    const r = await this.req(this.url(key), {}, `get ${key}`);
    if (r.status === 404) { await r.body?.cancel(); return null; }
    if (!r.ok) await this.fail(r, `get ${key}`);
    return { body: r.body ?? new Uint8Array(), size: Number(r.headers.get("content-length") ?? 0), contentType: r.headers.get("content-type"), etag: r.headers.get("etag")?.replace(/"/g, "") ?? null };
  }

  async put(key: string, data: ObjData): Promise<void> {
    const headers: Record<string, string> = { "content-type": data.contentType || "application/octet-stream" };
    if (data.size <= SINGLE_MAX) {
      const body = await readAll(data.body);
      const r = await this.req(this.url(key), { method: "PUT", body, headers }, `put ${key}`);
      if (!r.ok) await this.fail(r, `put ${key}`);
      return;
    }
    // Multipart: read the source stream in PART-sized chunks.
    const init = await this.req(`${this.url(key)}?uploads`, { method: "POST", headers }, `start upload ${key}`);
    if (!init.ok) await this.fail(init, `start upload ${key}`);
    const uploadId = tag(await init.text(), "UploadId");
    const parts: string[] = [];
    try {
      const reader = (data.body instanceof Uint8Array ? new Response(data.body).body! : data.body).getReader();
      let buf: Uint8Array[] = []; let len = 0; let n = 1; let done = false;
      const flush = async () => {
        const chunk = new Uint8Array(len); let o = 0; for (const b of buf) { chunk.set(b, o); o += b.length; }
        const r = await this.req(`${this.url(key)}?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`, { method: "PUT", body: chunk }, `upload part ${n}`);
        if (!r.ok) await this.fail(r, `upload part ${n} of ${key}`);
        parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${r.headers.get("etag")}</ETag></Part>`);
        n++; buf = []; len = 0;
      };
      while (!done) {
        const { value, done: d } = await reader.read(); done = d;
        if (value) { buf.push(value); len += value.length; }
        if (len >= PART || (done && len > 0)) await flush();
      }
      const fin = await this.req(`${this.url(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", body: `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`, headers: { "content-type": "application/xml" } }, `finish upload ${key}`);
      const text = await fin.text();
      if (!fin.ok || /<Error>/.test(text)) throw new MoverError(`${this.label}: finish upload ${key}: ${tag(text, "Message") || fin.status}`, 502);
    } catch (e) {
      await this.req(`${this.url(key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => {});
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    const r = await this.req(this.url(key), { method: "DELETE" }, `delete ${key}`);
    if (!r.ok && r.status !== 404) await this.fail(r, `delete ${key}`);
  }

  async test(prefix: string) {
    let list = false; let write = false; const notes: string[] = [];
    try { for await (const _ of this.list(prefix)) break; list = true; } catch (e: any) { notes.push(e.message); }
    const probe = `${prefix ? `${prefix.replace(/\/+$/, "")}/` : ""}.fleetiq-mover-probe-${Date.now()}`;
    try { await this.put(probe, { body: new TextEncoder().encode("probe"), size: 5, contentType: "text/plain" }); write = true; await this.delete(probe); }
    catch (e: any) { notes.push(e.message); }
    return { list, write, detail: notes.join("; ") || "list and write OK" };
  }
}
