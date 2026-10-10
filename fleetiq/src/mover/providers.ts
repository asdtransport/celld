import { bucketName, config } from "../config";
import { AzureBlobConnector } from "./azure";
import { LocalConnector } from "./local";
import { S3Connector } from "./s3";
import { type Connector, type FieldDef, MoverError, type ProviderDef } from "./types";

const keys: FieldDef[] = [
  { key: "accessKeyId", label: "Access key ID", required: true },
  { key: "secretAccessKey", label: "Secret access key", required: true, secret: true },
];
const bucket: FieldDef = { key: "bucket", label: "Bucket", required: true };

// Plug-and-play: each provider is a set of fields plus how they become a connector.
export const PROVIDERS: ProviderDef[] = [
  { id: "cloudflare-r2", label: "Cloudflare R2", family: "s3", fields: [{ key: "accountId", label: "Account ID", required: true }, bucket, ...keys, { key: "jurisdiction", label: "Jurisdiction", placeholder: "(none) or eu, fedramp", help: "Only for buckets created in a jurisdiction." }], note: "Create an R2 API token with Object Read & Write on the bucket; use its S3 access key and secret." },
  { id: "aws-s3", label: "Amazon S3", family: "s3", fields: [{ key: "region", label: "Region", required: true, placeholder: "us-east-1" }, bucket, ...keys], note: "An IAM user or role key limited to this bucket (s3:ListBucket, GetObject, PutObject, DeleteObject)." },
  { id: "railway", label: "Railway bucket", family: "s3", fields: [{ key: "endpoint", label: "Endpoint", required: true, placeholder: "https://…", help: "From the bucket’s Credentials tab in Railway." }, { key: "region", label: "Region", default: "auto" }, bucket, ...keys], note: "Railway buckets speak the S3 API; copy the endpoint, bucket name and keys from the bucket’s Credentials tab." },
  { id: "azure-blob", label: "Azure Blob Storage", family: "azure", fields: [{ key: "sasUrl", label: "Container SAS URL", required: true, secret: true, placeholder: "https://account.blob.core.windows.net/container?sv=…&sig=…", help: "Generate a container SAS with read, add, create, write, delete and list." }] },
  { id: "digitalocean-spaces", label: "DigitalOcean Spaces", family: "s3", fields: [{ key: "region", label: "Region", required: true, placeholder: "nyc3" }, bucket, ...keys] },
  { id: "backblaze-b2", label: "Backblaze B2", family: "s3", fields: [{ key: "region", label: "Region", required: true, placeholder: "us-west-004" }, bucket, ...keys] },
  { id: "google-gcs", label: "Google Cloud Storage (HMAC)", family: "s3", fields: [bucket, { key: "accessKeyId", label: "HMAC access ID", required: true }, { key: "secretAccessKey", label: "HMAC secret", required: true, secret: true }], note: "Create an HMAC key for a service account with access to the bucket." },
  { id: "wasabi", label: "Wasabi", family: "s3", fields: [{ key: "region", label: "Region", required: true, placeholder: "us-east-1" }, bucket, ...keys] },
  { id: "s3-compatible", label: "Other S3-compatible (MinIO, SeaweedFS, Ceph…)", family: "s3", fields: [{ key: "endpoint", label: "Endpoint", required: true, placeholder: "https://minio.example.com" }, { key: "region", label: "Region", default: "us-east-1" }, bucket, ...keys, { key: "pathStyle", label: "Path-style URLs", default: "true", help: "true for most self-hosted stores." }] },
  { id: "local", label: "Folder on this server", family: "local", fields: [{ key: "folder", label: "Folder", required: true, placeholder: "backups", help: "Inside FleetIQ’s data volume (/data/mover/…)." }] },
];
export const FLEET_PROVIDER: ProviderDef = { id: "fleet", label: "This server’s fleet bucket", family: "fleet", fields: [] };

export const providerOf = (id: string) => (id === "fleet" ? FLEET_PROVIDER : PROVIDERS.find((p) => p.id === id));

export function validateConfig(provider: string, cfg: Record<string, string>) {
  const p = providerOf(provider); if (!p) throw new MoverError(`unknown provider ${provider}`);
  for (const f of p.fields) if (f.required && !cfg[f.key]?.trim()) throw new MoverError(`${f.label} is required`);
  for (const k of Object.keys(cfg)) if (!p.fields.some((f) => f.key === k)) delete cfg[k];
  for (const f of p.fields) if (!cfg[f.key] && f.default) cfg[f.key] = f.default;
  return cfg;
}
// Secret fields never leave the server.
export function redact(provider: string, cfg: Record<string, string>) {
  const p = providerOf(provider);
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, p?.fields.find((f) => f.key === k)?.secret ? (v ? "••••" + v.slice(-4) : "") : v]));
}

export function connectorFor(provider: string, cfg: Record<string, string>, label?: string): Connector {
  const s3 = (endpoint: string, region: string, pathStyle = true) => new S3Connector({ endpoint, region, bucket: cfg.bucket!, accessKeyId: cfg.accessKeyId!, secretAccessKey: cfg.secretAccessKey!, pathStyle, label: label ?? `${provider}://${cfg.bucket}` });
  switch (provider) {
    case "cloudflare-r2": return s3(`https://${cfg.accountId}${cfg.jurisdiction ? `.${cfg.jurisdiction}` : ""}.r2.cloudflarestorage.com`, "auto");
    case "aws-s3": return s3(`https://s3.${cfg.region}.amazonaws.com`, cfg.region!, false);
    case "railway": return s3(cfg.endpoint!, cfg.region || "auto");
    case "digitalocean-spaces": return s3(`https://${cfg.region}.digitaloceanspaces.com`, cfg.region!);
    case "backblaze-b2": return s3(`https://s3.${cfg.region}.backblazeb2.com`, cfg.region!);
    case "google-gcs": return s3("https://storage.googleapis.com", "auto");
    case "wasabi": return s3(`https://s3.${cfg.region}.wasabisys.com`, cfg.region!);
    case "s3-compatible": return s3(cfg.endpoint!, cfg.region || "us-east-1", cfg.pathStyle !== "false");
    case "azure-blob": return new AzureBlobConnector(cfg.sasUrl!);
    case "local": return new LocalConnector(`${config.dataDir}/mover`, cfg.folder!);
    case "fleet": return new S3Connector({
      endpoint: config.s3Endpoint || `https://s3.${config.region}.amazonaws.com`, region: config.region || "us-east-1", bucket: bucketName(),
      accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, pathStyle: true, label: `fleet://${bucketName()}`,
    });
    default: throw new MoverError(`unknown provider ${provider}`);
  }
}
