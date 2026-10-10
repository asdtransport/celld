import { createHmac } from "node:crypto";
import { type Connector, MoverError, type ObjData, type ObjInfo, readAll, retryableHttp } from "./types";

// Azure Blob Storage, two ways in:
//  - a container SAS URL (https://<account>.blob.core.windows.net/<container>?sv=…&sig=…) with read,
//    add, create, write, delete and list — no account key on this server;
//  - the storage account's connection string (Access keys) plus a container name. Signs each request
//    with the account key (Shared Key) and can create the container.
const VERSION = "2021-08-06";
const BLOCK = 16 * 1024 * 1024;
const SINGLE_MAX = BLOCK;
const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (s: string, t: string) => unxml(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s)?.[1] ?? "");
const enc = (k: string) => k.split("/").map(encodeURIComponent).join("/");

const HINTS: Record<string, string> = {
  AuthenticationFailed: "the signature was refused: the SAS or account key is wrong or expired",
  AuthorizationPermissionMismatch: "the SAS lacks a permission this needs (read, add, create, write, delete, list)",
  AuthorizationFailure: "not allowed: check the SAS permissions, or the storage account's network rules (firewall) let this server in",
  ContainerNotFound: "the container doesn't exist (with a connection string, Test creates it)",
  ResourceNotFound: "not found: check the account and container names",
  InvalidQueryParameterValue: "the SAS URL is malformed; copy it again from the portal",
};

type Auth = { kind: "sas"; sas: string } | { kind: "key"; account: string; key: Buffer };

export function parseConnectionString(cs: string) {
  const kv = Object.fromEntries(cs.split(";").filter(Boolean).map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const account = kv.AccountName; const key = kv.AccountKey;
  if (!account || !key) {
    if (kv.SharedAccessSignature) throw new MoverError("this connection string carries a SAS; use the container SAS URL option instead");
    throw new MoverError("the connection string needs AccountName and AccountKey (Storage account → Access keys → Connection string)");
  }
  const endpoint = (kv.BlobEndpoint ?? `${kv.DefaultEndpointsProtocol ?? "https"}://${account}.blob.${kv.EndpointSuffix ?? "core.windows.net"}`).replace(/\/+$/, "");
  return { account, key, endpoint };
}

export class AzureBlobConnector implements Connector {
  readonly kind = "azure";
  readonly label: string;
  private container: string; private auth: Auth; private path: string;
  sasExpiry: number | null = null; sasPerms: string | null = null;

  constructor(opts: { sasUrl: string } | { connectionString: string; container: string }) {
    if ("sasUrl" in opts) {
      let u: URL;
      try { u = new URL(opts.sasUrl.trim()); } catch { throw new MoverError("container SAS URL is not a URL"); }
      if (!u.searchParams.get("sig")) throw new MoverError("the URL has no SAS signature (sig=…); generate a container SAS in the Azure portal");
      if (!u.pathname.replace(/\/+$/, "").slice(1)) throw new MoverError("the SAS URL has no container in its path; generate the SAS on the container, not the account");
      this.container = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
      this.auth = { kind: "sas", sas: u.search.slice(1) };
      const se = u.searchParams.get("se"); this.sasExpiry = se ? Date.parse(se) : null;
      this.sasPerms = u.searchParams.get("sp");
      this.path = u.pathname.replace(/\/+$/, "");
      this.label = `azure://${u.hostname.split(".")[0]}${this.path}`;
    } else {
      const cs = parseConnectionString(opts.connectionString);
      if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(opts.container)) throw new MoverError("container names are 3–63 lowercase letters, digits and hyphens");
      this.container = `${cs.endpoint}/${opts.container}`;
      this.auth = { kind: "key", account: cs.account, key: Buffer.from(cs.key, "base64") };
      this.path = new URL(this.container).pathname;
      this.label = `azure://${cs.account}/${opts.container}`;
    }
  }

  private url(key: string, extra = "") {
    const q = [extra, this.auth.kind === "sas" ? this.auth.sas : ""].filter(Boolean).join("&");
    return `${this.container}${key ? `/${enc(key)}` : ""}${q ? `?${q}` : ""}`;
  }

  // Shared Key: https://learn.microsoft.com/rest/api/storageservices/authorize-with-shared-key
  private sign(method: string, url: string, headers: Record<string, string>, length: number) {
    if (this.auth.kind !== "key") return;
    const u = new URL(url);
    const xms = Object.entries(headers).filter(([k]) => k.toLowerCase().startsWith("x-ms-")).map(([k, v]) => [k.toLowerCase(), String(v).trim()] as const).sort(([a], [b]) => (a < b ? -1 : 1));
    const params = new Map<string, string[]>();
    for (const [k, v] of u.searchParams) params.set(k.toLowerCase(), [...(params.get(k.toLowerCase()) ?? []), v]);
    const resource = `/${this.auth.account}${u.pathname}` + [...params.keys()].sort().map((k) => `\n${k}:${params.get(k)!.sort().join(",")}`).join("");
    const h = (n: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === n)?.[1] ?? "";
    const sts = [method, h("content-encoding"), h("content-language"), length ? String(length) : "", h("content-md5"), h("content-type"), "", "", "", "", "", h("range")].join("\n")
      + "\n" + xms.map(([k, v]) => `${k}:${v}\n`).join("") + resource;
    headers.authorization = `SharedKey ${this.auth.account}:${createHmac("sha256", this.auth.key).update(sts, "utf8").digest("base64")}`;
  }

  private async call(url: string, init: { method?: string; body?: Uint8Array | string; headers?: Record<string, string> } = {}, what = "request") {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { "x-ms-version": VERSION, "x-ms-date": new Date().toUTCString(), ...(init.headers ?? {}) };
    const body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
    this.sign(method, url, headers, body?.length ?? 0);
    const r = await fetch(url, { method, headers, body }).catch((e) => { throw new MoverError(`${this.label}: ${what} failed: ${e.message}`, 502, true); });
    if (!r.ok && r.status !== 404) {
      const t = await r.text().catch(() => "");
      const code = tag(t, "Code") || r.headers.get("x-ms-error-code") || "";
      throw new MoverError(`${this.label}: ${what}: HTTP ${r.status} ${code}${HINTS[code] ? ` — ${HINTS[code]}` : ` ${tag(t, "Message").split("\n")[0]}`}`.trim(), r.status === 403 ? 403 : 502, retryableHttp(r.status));
    }
    return r;
  }

  async *list(prefix: string): AsyncIterable<ObjInfo> {
    let marker = "";
    do {
      const q = new URLSearchParams({ restype: "container", comp: "list", prefix, maxresults: "1000" });
      if (marker) q.set("marker", marker);
      const r = await this.call(this.url("", q.toString()), {}, `list ${prefix || "/"}`);
      if (r.status === 404) { const t = await r.text(); throw new MoverError(`${this.label}: list: ${HINTS[tag(t, "Code")] ?? "container not found"}`, 404, false); }
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
    // Block upload; the whole-blob MD5 is computed on the way and stored, so checksum compares work later.
    const reader = (data.body instanceof Uint8Array ? new Response(data.body).body! : data.body).getReader();
    const whole = new Bun.CryptoHasher("md5");
    const ids: string[] = []; let buf: Uint8Array[] = []; let len = 0; let done = false;
    const flush = async () => {
      const chunk = new Uint8Array(len); let o = 0; for (const b of buf) { chunk.set(b, o); o += b.length; }
      whole.update(chunk);
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
    const md5 = Buffer.from(whole.digest()).toString("base64");
    await this.call(this.url(key, "comp=blocklist"), { method: "PUT", body: list, headers: { "x-ms-blob-content-type": ct, "x-ms-blob-content-md5": md5, "content-type": "application/xml" } }, `commit ${key}`);
  }

  async delete(key: string): Promise<void> { await this.call(this.url(key), { method: "DELETE" }, `delete ${key}`); }

  async test(prefix: string) {
    let list = false; let write = false; const notes: string[] = [];
    if (this.sasExpiry != null) {
      const days = (this.sasExpiry - Date.now()) / 86_400_000;
      if (days < 0) notes.push(`the SAS expired on ${new Date(this.sasExpiry).toISOString().slice(0, 10)}`);
      else if (days < 14) notes.push(`warning: the SAS expires in ${Math.ceil(days)} days (${new Date(this.sasExpiry).toISOString().slice(0, 10)}); jobs fail after that`);
    }
    if (this.sasPerms) { const miss = ["r", "a", "c", "w", "d", "l"].filter((p) => !this.sasPerms!.includes(p)); if (miss.length) notes.push(`warning: the SAS lacks ${miss.join(", ")} permission (needs r a c w d l)`); }
    if (this.auth.kind === "key") {
      const r = await this.call(`${this.container}?restype=container`, { method: "HEAD" }, "check container").catch((e) => { notes.push(e.message); return null; });
      if (r?.status === 404) {
        await this.call(`${this.container}?restype=container`, { method: "PUT" }, "create container").then(() => notes.push("created the container")).catch((e) => notes.push(e.message));
      }
    }
    try { for await (const _ of this.list(prefix)) break; list = true; } catch (e: any) { notes.push(e.message); }
    const probe = `${prefix ? `${prefix.replace(/\/+$/, "")}/` : ""}.fleetiq-mover-probe-${Date.now()}`;
    try { await this.put(probe, { body: new TextEncoder().encode("probe"), size: 5 }); write = true; await this.delete(probe); } catch (e: any) { notes.push(e.message); }
    return { list, write, detail: notes.join("; ") || "list and write OK" };
  }
}
