import { type Connector, MoverError, type ObjData, type ObjInfo, readAll } from "./types";

// Azure Blob Storage through a container SAS URL (https://<account>.blob.core.windows.net/<container>?sv=…&sig=…).
// A SAS with read, add, create, write, delete and list on the container is all the mover needs; no account key.
const VERSION = "2021-08-06";
const BLOCK = 16 * 1024 * 1024;
const SINGLE_MAX = 64 * 1024 * 1024;
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (s: string, t: string) => unxml(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s)?.[1] ?? "");
const enc = (k: string) => k.split("/").map(encodeURIComponent).join("/");

export class AzureBlobConnector implements Connector {
  readonly kind = "azure";
  readonly label: string;
  private container: string; private sas: string;
  constructor(sasUrl: string) {
    let u: URL;
    try { u = new URL(sasUrl); } catch { throw new MoverError("container SAS URL is not a URL"); }
    if (!u.searchParams.get("sig")) throw new MoverError("the URL has no SAS signature (sig=…); generate a container SAS in the Azure portal");
    this.container = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    this.sas = u.search.slice(1);
    this.label = `azure://${u.hostname.split(".")[0]}${u.pathname}`;
  }
  private url(key: string, extra = "") { return `${this.container}/${enc(key)}?${extra ? `${extra}&` : ""}${this.sas}`; }
  private async call(url: string, init: RequestInit = {}, what = "request") {
    const r = await fetch(url, { ...init, headers: { "x-ms-version": VERSION, ...(init.headers as any) } }).catch((e) => { throw new MoverError(`${this.label}: ${what} failed: ${e.message}`, 502); });
    if (!r.ok && r.status !== 404) {
      const t = await r.text().catch(() => "");
      throw new MoverError(`${this.label}: ${what}: HTTP ${r.status} ${tag(t, "Code")} ${tag(t, "Message").split("\n")[0]}`.trim(), r.status === 403 ? 403 : 502);
    }
    return r;
  }

  async *list(prefix: string): AsyncIterable<ObjInfo> {
    let marker = "";
    do {
      const q = new URLSearchParams({ restype: "container", comp: "list", prefix, maxresults: "1000" });
      if (marker) q.set("marker", marker);
      const r = await this.call(`${this.container}?${q}&${this.sas}`, {}, `list ${prefix || "/"}`);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
        const b = m[1]!;
        const md5 = tag(b, "Content-MD5");
        const lm = tag(b, "Last-Modified");
        yield { key: tag(b, "Name"), size: Number(tag(b, "Content-Length") || 0), etag: md5 ? Buffer.from(md5, "base64").toString("hex") : null, mtime: lm ? Date.parse(lm) : null };
      }
      marker = tag(xml, "NextMarker");
    } while (marker);
  }

  async get(key: string): Promise<ObjData | null> {
    const r = await this.call(this.url(key), {}, `get ${key}`);
    if (r.status === 404) { await r.body?.cancel(); return null; }
    const md5 = r.headers.get("content-md5");
    return { body: r.body ?? new Uint8Array(), size: Number(r.headers.get("content-length") ?? 0), contentType: r.headers.get("content-type"), etag: md5 ? Buffer.from(md5, "base64").toString("hex") : null };
  }

  async put(key: string, data: ObjData): Promise<void> {
    const ct = data.contentType || "application/octet-stream";
    if (data.size <= SINGLE_MAX) {
      const body = await readAll(data.body);
      const md5 = Buffer.from(new Bun.CryptoHasher("md5").update(body).digest()).toString("base64");
      await this.call(this.url(key), { method: "PUT", body, headers: { "x-ms-blob-type": "BlockBlob", "x-ms-blob-content-type": ct, "x-ms-blob-content-md5": md5 } }, `put ${key}`);
      return;
    }
    const reader = (data.body instanceof Uint8Array ? new Response(data.body).body! : data.body).getReader();
    const ids: string[] = []; let buf: Uint8Array[] = []; let len = 0; let done = false;
    const flush = async () => {
      const chunk = new Uint8Array(len); let o = 0; for (const b of buf) { chunk.set(b, o); o += b.length; }
      const id = Buffer.from(String(ids.length).padStart(6, "0")).toString("base64");
      await this.call(this.url(key, `comp=block&blockid=${encodeURIComponent(id)}`), { method: "PUT", body: chunk }, `put block ${ids.length} of ${key}`);
      ids.push(id); buf = []; len = 0;
    };
    while (!done) {
      const { value, done: d } = await reader.read(); done = d;
      if (value) { buf.push(value); len += value.length; }
      if (len >= BLOCK || (done && len > 0)) await flush();
    }
    const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((i) => `<Latest>${i}</Latest>`).join("")}</BlockList>`;
    await this.call(this.url(key, "comp=blocklist"), { method: "PUT", body: list, headers: { "x-ms-blob-content-type": ct, "content-type": "application/xml" } }, `commit ${key}`);
  }

  async delete(key: string): Promise<void> { await this.call(this.url(key), { method: "DELETE" }, `delete ${key}`); }

  async test(prefix: string) {
    let list = false; let write = false; const notes: string[] = [];
    try { for await (const _ of this.list(prefix)) break; list = true; } catch (e: any) { notes.push(e.message); }
    const probe = `${prefix ? `${prefix.replace(/\/+$/, "")}/` : ""}.fleetiq-mover-probe-${Date.now()}`;
    try { await this.put(probe, { body: new TextEncoder().encode("probe"), size: 5 }); write = true; await this.delete(probe); } catch (e: any) { notes.push(e.message); }
    return { list, write, detail: notes.join("; ") || "list and write OK" };
  }
}
