import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type Connector, MoverError, type ObjData, type ObjInfo } from "./types";

// A folder on this server (inside FleetIQ's data volume). Good for a quick local backup, or as a
// staging area when a client's two clouds can't talk to each other directly.
export class LocalConnector implements Connector {
  readonly kind = "local";
  readonly label: string;
  private root: string;
  constructor(base: string, folder: string) {
    if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(folder) || folder.split("/").includes("..")) throw new MoverError("folder must be a simple relative path");
    this.root = resolve(base, folder);
    this.label = `local:${folder}`;
  }
  private path(key: string) {
    const p = resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new MoverError(`key escapes the folder: ${key}`);
    return p;
  }

  async *list(prefix: string): AsyncIterable<ObjInfo> {
    const walk = async function* (dir: string, rel: string): AsyncGenerator<ObjInfo> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.endsWith(".mover-tmp")) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) yield* walk(join(dir, e.name), r);
        else if (e.isFile()) { const s = await stat(join(dir, e.name)); yield { key: r, size: s.size, etag: null, mtime: s.mtimeMs }; }
      }
    };
    for await (const o of walk(this.root, "")) if (o.key.startsWith(prefix)) yield o;
  }
  async get(key: string): Promise<ObjData | null> {
    const f = Bun.file(this.path(key));
    if (!(await f.exists())) return null;
    // Bun infers the type from the extension; plain bytes stay untyped.
    const type = f.type && !f.type.startsWith("application/octet-stream") ? f.type.split(";")[0]! : null;
    return { body: f.stream(), size: f.size, contentType: type };
  }
  // Listings carry no checksum, so "checksum" compares hash the file (streamed, any size).
  async hash(key: string): Promise<string | null> {
    const f = Bun.file(this.path(key));
    if (!(await f.exists())) return null;
    const h = new Bun.CryptoHasher("md5");
    for await (const chunk of f.stream()) h.update(chunk);
    return h.digest("hex");
  }
  // Where the folder is inside FleetIQ's container (shown in the console).
  get location() { return this.root; }
  async put(key: string, data: ObjData): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.mover-tmp`;
    // Streams go to disk as they arrive, so big files don't sit in memory.
    if (data.body instanceof Uint8Array) await Bun.write(tmp, data.body);
    else { const w = Bun.file(tmp).writer(); try { for await (const c of data.body as any) w.write(c); await w.end(); } catch (e) { await w.end(); await rm(tmp, { force: true }); throw e; } }
    await rename(tmp, p);
  }
  async delete(key: string): Promise<void> { await rm(this.path(key), { force: true }); }
  async test(prefix: string) {
    try {
      await mkdir(this.root, { recursive: true });
      const k = `${prefix ? `${prefix}/` : ""}.probe-${Date.now()}`;
      await this.put(k, { body: new Uint8Array([1]), size: 1 }); await this.delete(k);
      return { list: true, write: true, detail: `folder ${this.label} is writable` };
    } catch (e: any) { return { list: false, write: false, detail: e.message }; }
  }
}
