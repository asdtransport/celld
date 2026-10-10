import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type Connector, MoverError, type ObjData, type ObjInfo, readAll } from "./types";

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
    return { body: f.stream(), size: f.size, contentType: null };
  }
  async put(key: string, data: ObjData): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.mover-tmp`;
    await Bun.write(tmp, data.body instanceof Uint8Array ? data.body : await readAll(data.body));
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
