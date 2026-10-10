// All runtime wiring comes from the environment, so the same image runs in any fleet.
const env = (k: string, d = "") => process.env[k] ?? d;

export const config = {
  dataDir: env("FLEETIQ_DATA", "local"),
  // Fleet bucket (no prefix — each app gets its own prefix under it).
  bucket: env("FLEET_BUCKET", "s3://fleet").replace(/\/+$/, ""),
  s3Endpoint: env("S3_ENDPOINT"),
  region: env("AWS_REGION", "us-east-1"),
  accessKeyId: env("AWS_ACCESS_KEY_ID"),
  secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
  celld: env("CELLD_BIN", "celld"),
  // Docker Engine API — used to run managed node containers and show stack status.
  dockerSock: env("DOCKER_SOCK", "/var/run/docker.sock"),
  fleetNetwork: env("FLEET_NETWORK", "celliq_fleet"),
  nodeImage: env("NODE_IMAGE", "ghcr.io/denoland/celld:0.6.2"),
  stackProjects: env("STACK_PROJECTS", "celliq,celliq-edge").split(",").map((s) => s.trim()).filter(Boolean),
  // Load balancer Caddy admin API, on a unix socket shared only with this container.
  lbAdminSock: env("LB_ADMIN_SOCK", "/run/caddy-admin/admin.sock"),
  lbListen: env("LB_LISTEN", ":8080"),
  // frp admin APIs (basic auth). frpc at the site; frps on the edge (optional, if reachable).
  frpcApi: env("FRPC_API", ""), frpcUser: env("FRPC_USER", "admin"), frpcPass: env("FRPC_PASS", ""),
  frpsApi: env("FRPS_API", ""), frpsUser: env("FRPS_USER", "admin"), frpsPass: env("FRPS_PASS", ""),
  frpLocalHost: env("FRP_LOCAL_HOST", "lb"), frpLocalPort: Number(env("FRP_LOCAL_PORT", "8080")),
  // Public edge (Caddy + caddy-security) — probed for the request path.
  edgeUrl: env("EDGE_URL", ""),
  // Who may do what. AUTH_MODE=edge verifies the caddy-security ES256 token; none = trusted network only.
  authMode: env("AUTH_MODE", "edge") as "edge" | "none",
  authPublicKeyB64: env("AUTH_PUBLIC_KEY_B64"),
  authJwksUrl: env("AUTH_JWKS_URL"),
  viewerRoles: env("VIEWER_ROLES", "authp/user,authp/admin").split(","),
  operatorRoles: env("OPERATOR_ROLES", "authp/admin").split(","),
  maxUploadBytes: Number(env("MAX_UPLOAD_MB", "64")) * 1024 * 1024,
};

export function bucketName(): string {
  return config.bucket.replace(/^s3:\/\//, "").split("/")[0]!;
}
export function appBucketUrl(prefix: string): string {
  return `s3://${bucketName()}/${prefix}`;
}
