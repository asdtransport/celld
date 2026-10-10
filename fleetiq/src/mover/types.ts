// The data mover's plug-in contract. A connector is one place objects live: an S3-compatible bucket
// (AWS, Cloudflare R2, Railway, DigitalOcean, Backblaze, GCS interop, MinIO, SeaweedFS), an Azure Blob
// container, this server's fleet bucket, or a local folder. The engine only ever lists, reads,
// writes and deletes keys under a root prefix, so adding a provider means implementing these five calls.

export interface ObjInfo { key: string; size: number; etag?: string | null; mtime?: number | null }
export interface ObjData { body: Uint8Array | ReadableStream<Uint8Array>; size: number; contentType?: string | null; etag?: string | null }

export interface Connector {
  readonly kind: string;
  readonly label: string;          // human description, e.g. "r2://celld-backups/notes/"
  list(prefix: string): AsyncIterable<ObjInfo>;
  get(key: string): Promise<ObjData | null>;
  put(key: string, data: ObjData): Promise<void>;
  delete(key: string): Promise<void>;
  // MD5 (hex) of an object, for stores whose listings carry none (a local folder). Optional.
  hash?(key: string): Promise<string | null>;
  // Proves we can list and write (writes and deletes a probe object under the prefix).
  test(prefix: string): Promise<{ list: boolean; write: boolean; detail: string }>;
}

// status is the HTTP status FleetIQ answers with; retryable says whether trying again can help
// (network errors, 5xx, throttling) or not (bad keys, missing bucket, no permission).
export class MoverError extends Error { constructor(m: string, public status = 400, public retryable = false) { super(m); } }
export const retryableHttp = (s: number) => s >= 500 || s === 408 || s === 429;

// Field definitions drive the console form, the API validation and the MCP tool docs.
export interface FieldDef { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; help?: string; default?: string }
export interface ProviderDef { id: string; label: string; family: "s3" | "azure" | "local" | "fleet"; fields: FieldDef[]; note?: string }

export async function readAll(body: ObjData["body"]): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}
export const joinKey = (prefix: string, rel: string) => (prefix ? `${prefix.replace(/\/+$/, "")}/${rel}` : rel).replace(/^\/+/, "");
