import type { Context, Hono } from "hono";
import { AccessError } from "../lib/access";
import { config } from "../config";
import { identify, identifyToken } from "../auth";

// One list of operations drives three things: the OpenAPI document (/api/openapi.json), the MCP tools
// (/mcp, for Claude and other assistants) and the CLI's `fleetiq ops`. Add an endpoint here when you add a route.
type P = { type: "string" | "integer" | "boolean" | "object"; description?: string; enum?: string[]; required?: boolean; in: "path" | "query" | "body" };
export interface Op { tool: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; summary: string; params?: Record<string, P> }

const name: P = { type: "string", in: "path", required: true, description: "application name" };
const s = (description: string, extra: Partial<P> = {}): P => ({ type: "string", in: "body", description, ...extra });
const q = (description: string, extra: Partial<P> = {}): P => ({ type: "string", in: "query", description, ...extra });

export const OPS: Op[] = [
  { tool: "system", method: "GET", path: "/api/system", summary: "Everything at a glance: apps with versions, nodes, routes and Git sources; containers; builder and bucket settings; who you are." },
  { tool: "overview", method: "GET", path: "/api/overview", summary: "Live health of each hop on the request path (edge, tunnel, load balancer, nodes, bucket) and recent activity." },
  { tool: "platform_version", method: "GET", path: "/api/platform/version", summary: "The stack's installed commit, the latest on GitHub, and the commits in between." },
  { tool: "update_platform", method: "POST", path: "/api/platform/update", summary: "Update the whole stack (console, edge, CellIQ images) to the latest commit: a helper container re-runs install.sh; passwords, keys, options and data are kept. The console restarts during it.", params: { ref: s("branch, tag or commit; default the configured branch") } },
  { tool: "update_status", method: "GET", path: "/api/platform/update", summary: "Progress and log of the latest platform update." },
  { tool: "list_apps", method: "GET", path: "/api/apps", summary: "List applications with their live version, node counts and last deployment." },
  { tool: "get_app", method: "GET", path: "/api/apps/{name}", summary: "One application: fleet nodes with state, bindings (DOs, KV, D1, R2, queues) and routes.", params: { name } },
  { tool: "create_app", method: "POST", path: "/api/apps", summary: "Register an application (one celld fleet). Then scale it, deploy it and add a route.", params: {
    name: s("lowercase name; must equal the `name` in the project's wrangler.jsonc", { required: true }), description: s("what it is for"),
    managed: { type: "boolean", in: "body", description: "true = FleetIQ runs its node containers (default)" },
    desiredNodes: { type: "integer", in: "body", description: "node count, 2 recommended" }, healthPath: s("load balancer health check path, e.g. /api/health"), nodeImage: s("celld image; empty for the default") } },
  { tool: "update_app", method: "PATCH", path: "/api/apps/{name}", summary: "Change an application's description, health check path or node image.", params: { name, description: s("description"), healthPath: s("health check path"), nodeImage: s("node image") } },
  { tool: "delete_app", method: "DELETE", path: "/api/apps/{name}", summary: "Remove an application from FleetIQ (scale to 0 and remove its routes first). Bucket data is kept.", params: { name } },
  { tool: "scale_app", method: "POST", path: "/api/apps/{name}/scale", summary: "Set how many node containers FleetIQ runs for a managed application.", params: { name, nodes: { type: "integer", in: "body", required: true, description: "0-9" } } },
  { tool: "app_logs", method: "GET", path: "/api/apps/{name}/logs", summary: "Recent logs from each of an application's node containers.", params: { name, tail: q("lines per node, default 100") } },
  { tool: "app_cells", method: "GET", path: "/api/apps/{name}/cells", summary: "Cells (Durable Objects, KV, queues, D1) and which node owns each.", params: { name } },
  { tool: "diagnose_app", method: "GET", path: "/api/apps/{name}/diagnose", summary: "Run celld diagnose against the application's bucket prefix.", params: { name } },
  { tool: "list_versions", method: "GET", path: "/api/apps/{name}/versions", summary: "Uploaded versions in the bucket, newest first, marking the live one.", params: { name } },
  { tool: "list_deployments", method: "GET", path: "/api/apps/{name}/deployments", summary: "Deployment history with status and logs.", params: { name } },
  { tool: "get_deployment", method: "GET", path: "/api/deployments/{id}", summary: "One deployment, including its full log. Status is running, succeeded or failed.", params: { id: { type: "string", in: "path", required: true } } },
  { tool: "wait_deployment", method: "GET", path: "/api/deployments/{id}/wait", summary: "Wait until a deployment finishes (up to `timeout` seconds, max 240) and return it.", params: { id: { type: "string", in: "path", required: true }, timeout: q("seconds, default 60") } },
  { tool: "rollback", method: "POST", path: "/api/apps/{name}/rollback", summary: "Make an earlier version live on every node.", params: { name, version: s("16-character version id from list_versions", { required: true }) } },
  { tool: "get_source", method: "GET", path: "/api/apps/{name}/source", summary: "The application's Git source (repo, ref, path), deploy-on-push setting and webhook URL.", params: { name } },
  { tool: "set_source", method: "PUT", path: "/api/apps/{name}/source", summary: "Set where the application's code lives on GitHub, so it can deploy from Git and on every push.", params: {
    name, repo: s("owner/repo on GitHub, or an https URL to a .tar.gz", { required: true }), ref: s("branch, tag or commit; default main"),
    path: s("project folder inside the repo (where wrangler.jsonc is); empty = repo root"), token: s("GitHub token for a private repo; omit to keep the current one, empty to clear"),
    autoDeploy: { type: "boolean", in: "body", description: "deploy on every push to ref (needs the webhook added on GitHub)" }, checks: { type: "boolean", in: "body", description: "run type check and tests during the build (default true)" } } },
  { tool: "register_webhook", method: "POST", path: "/api/apps/{name}/source/webhook", summary: "Create or update the GitHub webhook for deploy-on-push (needs a token with Webhooks read/write on the repo).", params: { name } },
  { tool: "deploy_from_git", method: "POST", path: "/api/apps/{name}/deploy/git", summary: "Build the application from its Git source in a throwaway container and deploy it. Returns the running deployment; follow it with wait_deployment.", params: {
    name, ref: s("branch, tag or commit; default the source's ref"), path: s("override the project folder"), checks: { type: "boolean", in: "body", description: "override running checks" },
    repo: s("deploy once from this repo without saving it as the source"), wait: q("1 = block until the deployment finishes") } },
  { tool: "list_nodes", method: "GET", path: "/api/nodes", summary: "Every node holding a lease, per application.", params: { state: q("1 = include each node's live state (version, cells, memory)") } },
  { tool: "kv_list", method: "GET", path: "/api/apps/{name}/kv/{ns}", summary: "List keys in a KV namespace.", params: { name, ns: { type: "string", in: "path", required: true, description: "namespace id from get_app bindings" }, after: q("continue after this key") } },
  { tool: "kv_get", method: "GET", path: "/api/apps/{name}/kv/{ns}/value", summary: "Read one KV value.", params: { name, ns: { type: "string", in: "path", required: true }, key: q("key", { required: true }) } },
  { tool: "kv_put", method: "PUT", path: "/api/apps/{name}/kv/{ns}/value", summary: "Write one KV value.", params: { name, ns: { type: "string", in: "path", required: true }, key: s("key", { required: true }), value: s("value", { required: true }) } },
  { tool: "kv_delete", method: "DELETE", path: "/api/apps/{name}/kv/{ns}/value", summary: "Delete one KV key.", params: { name, ns: { type: "string", in: "path", required: true }, key: q("key", { required: true }) } },
  { tool: "d1_query", method: "POST", path: "/api/apps/{name}/d1/{db}/query", summary: "Run SQL against a D1 database (reads and writes).", params: { name, db: { type: "string", in: "path", required: true, description: "database name from get_app bindings" }, sql: s("SQL", { required: true }) } },
  { tool: "d1_migrations", method: "GET", path: "/api/apps/{name}/d1/{db}/migrations", summary: "List D1 migrations and which are applied.", params: { name, db: { type: "string", in: "path", required: true } } },
  { tool: "d1_migrate", method: "POST", path: "/api/apps/{name}/d1/{db}/migrations", summary: "Apply pending D1 migrations from the last deployed project.", params: { name, db: { type: "string", in: "path", required: true } } },
  { tool: "queue_info", method: "GET", path: "/api/apps/{name}/queues/{q}", summary: "Queue depth, consumer state and a peek at messages.", params: { name, q: { type: "string", in: "path", required: true } } },
  { tool: "queue_action", method: "POST", path: "/api/apps/{name}/queues/{q}/{action}", summary: "Pause, resume, purge or redrive a queue.", params: { name, q: { type: "string", in: "path", required: true }, action: { type: "string", in: "path", required: true, enum: ["pause", "resume", "purge", "redrive"] } } },
  { tool: "r2_list", method: "GET", path: "/api/apps/{name}/r2/{bucket}", summary: "List objects in an R2 bucket.", params: { name, bucket: { type: "string", in: "path", required: true }, after: q("continue after this key") } },
  { tool: "r2_delete", method: "DELETE", path: "/api/apps/{name}/r2/{bucket}", summary: "Delete one R2 object.", params: { name, bucket: { type: "string", in: "path", required: true }, key: q("object key", { required: true }) } },
  { tool: "list_routes", method: "GET", path: "/api/routes", summary: "Hostname → application routes and the load balancer's upstream health." },
  { tool: "set_route", method: "PUT", path: "/api/routes", summary: "Send a hostname to an application. The edge gets its HTTPS certificate on the first visit.", params: { host: s("hostname, or * for the default route", { required: true }), app: s("application name", { required: true }) } },
  { tool: "delete_route", method: "DELETE", path: "/api/routes", summary: "Remove a route.", params: { host: q("hostname", { required: true }) } },
  { tool: "list_tunnels", method: "GET", path: "/api/tunnels", summary: "frp tunnels from this site to a remote edge." },
  { tool: "list_containers", method: "GET", path: "/api/containers", summary: "Containers in the stack and the nodes FleetIQ runs." },
  { tool: "container_action", method: "POST", path: "/api/containers/{id}/{action}", summary: "Start, stop or restart a container (the console and edge can't be stopped from here).", params: { id: { type: "string", in: "path", required: true, description: "container name or id" }, action: { type: "string", in: "path", required: true, enum: ["start", "stop", "restart"] } } },
  { tool: "container_logs", method: "GET", path: "/api/containers/{id}/logs", summary: "Recent logs of one container.", params: { id: { type: "string", in: "path", required: true }, tail: q("lines, default 200") } },
  { tool: "activity", method: "GET", path: "/api/audit", summary: "Who changed what, including refused actions.", params: { limit: q("default 100, max 500") } },
  { tool: "mover_providers", method: "GET", path: "/api/mover/providers", summary: "Data mover connectors (Cloudflare R2, AWS S3, Railway, Azure Blob, DigitalOcean, Backblaze, GCS, Wasabi, any S3-compatible, local folder) and the fields each needs." },
  { tool: "mover_endpoints", method: "GET", path: "/api/mover/endpoints", summary: "Saved storage endpoints (secrets are never returned). The built-in endpoint `fleet` is this server's fleet bucket; each app lives under its name." },
  { tool: "mover_add_endpoint", method: "POST", path: "/api/mover/endpoints", summary: "Save a storage endpoint for the data mover.", params: { name: s("display name", { required: true }), provider: s("provider id from mover_providers", { required: true }), config: { type: "object", in: "body", required: true, description: "the provider's fields, e.g. {accountId, bucket, accessKeyId, secretAccessKey}" }, prefix: s("default root folder inside the bucket") } },
  { tool: "mover_test_endpoint", method: "POST", path: "/api/mover/endpoints/{id}/test", summary: "Check the mover can list and write at an endpoint (writes and deletes a probe object).", params: { id: { type: "string", in: "path", required: true, description: "endpoint id or name" }, prefix: s("folder to test") } },
  { tool: "mover_browse", method: "GET", path: "/api/mover/endpoints/{id}/browse", summary: "List objects under a prefix at an endpoint, with total count and bytes.", params: { id: { type: "string", in: "path", required: true }, prefix: q("folder"), limit: q("max items returned, default 200") } },
  { tool: "mover_sync", method: "POST", path: "/api/mover/sync", summary: "One-off rsync-style copy between endpoints. dryRun returns the plan only. mirror also deletes destination objects missing from the source.", params: {
    source: { type: "object", in: "body", required: true, description: "{endpoint, prefix}" }, destination: { type: "object", in: "body", required: true, description: "{endpoint, prefix}" },
    mode: { type: "string", in: "body", enum: ["copy", "mirror"] }, compare: { type: "string", in: "body", enum: ["quick", "checksum", "size"] }, dryRun: { type: "boolean", in: "body" }, wait: q("1 = wait up to 4 minutes for the result") } },
  { tool: "mover_jobs", method: "GET", path: "/api/mover/jobs", summary: "Saved sync and backup jobs with schedules and their last run." },
  { tool: "mover_add_job", method: "POST", path: "/api/mover/jobs", summary: "Save a sync job, optionally every N minutes.", params: { name: s("job name", { required: true }), source: { type: "object", in: "body", required: true, description: "{endpoint, prefix}" }, destination: { type: "object", in: "body", required: true, description: "{endpoint, prefix}" }, mode: { type: "string", in: "body", enum: ["copy", "mirror"] }, everyMinutes: { type: "integer", in: "body", description: "schedule; omit for manual" } } },
  { tool: "mover_run_job", method: "POST", path: "/api/mover/jobs/{id}/run", summary: "Run a saved job now (dryRun=1 for the plan only).", params: { id: { type: "string", in: "path", required: true }, dryRun: q("1 = plan only"), wait: q("1 = wait up to 4 minutes") } },
  { tool: "mover_runs", method: "GET", path: "/api/mover/runs", summary: "Recent mover runs with progress and results.", params: { job: q("only this job") } },
  { tool: "mover_run", method: "GET", path: "/api/mover/runs/{id}", summary: "One run: status, plan, progress, verify result and log. wait=N waits up to N seconds for it to finish.", params: { id: { type: "string", in: "path", required: true }, wait: q("seconds, max 240") } },
  { tool: "mover_cancel", method: "POST", path: "/api/mover/runs/{id}/cancel", summary: "Cancel a running copy.", params: { id: { type: "string", in: "path", required: true } } },
  { tool: "backup_app", method: "POST", path: "/api/apps/{name}/backup", summary: "Back up an application's whole celld state (Durable Objects, D1, KV, queues, deployments) to an endpoint, now and/or on a schedule. consistent=true stops its nodes during the copy.", params: { name, endpoint: s("endpoint id or name", { required: true }), prefix: s("destination folder, default celld/<app>"), consistent: { type: "boolean", in: "body" }, everyMinutes: { type: "integer", in: "body" }, runNow: { type: "boolean", in: "body" } } },
  { tool: "restore_app", method: "POST", path: "/api/mover/restore", summary: "Restore an application from a backup into this server: stops its nodes, makes the fleet data an exact copy of the backup, starts nodes. Creates the app if it doesn't exist. Keep the original app name.", params: { endpoint: s("endpoint id or name", { required: true }), prefix: s("backup folder, e.g. celld/notes", { required: true }), app: s("application name", { required: true }), nodes: { type: "integer", in: "body" }, dryRun: { type: "boolean", in: "body" } } },
  { tool: "list_targets", method: "GET", path: "/api/targets", summary: "Deploy targets (Cloudflare accounts) and which apps use each. Tokens are never returned." },
  { tool: "add_target", method: "POST", path: "/api/targets", summary: "Add a Cloudflare account as a deploy target. Runs a preflight (account, Workers, D1, KV, R2, Queues, Access, zones) and refuses tokens Cloudflare rejects.", params: { name: s("display name", { required: true }), accountId: s("32-hex Cloudflare account ID", { required: true }), apiToken: s("API token with Workers Scripts, D1, KV, R2 (Queues, Access: Apps and Policies, Zone read optional) edit", { required: true }) } },
  { tool: "preflight_target", method: "POST", path: "/api/targets/{id}/preflight", summary: "Re-check a Cloudflare target's token permissions, zones, team domain and workers.dev subdomain.", params: { id: { type: "string", in: "path", required: true, description: "target id or name" } } },
  { tool: "app_targets", method: "GET", path: "/api/apps/{name}/targets", summary: "Clouds an application also deploys to, with URL, last version and provisioned resources.", params: { name } },
  { tool: "link_app_target", method: "PUT", path: "/api/apps/{name}/targets/{target}", summary: "Set how an application deploys to a Cloudflare target: custom hostname (a zone in the account), Access gate and who it lets in.", params: { name, target: { type: "string", in: "path", required: true, description: "target id or name" }, hostname: s("custom domain, e.g. crm.example.com; omit for workers.dev"), access: { type: "boolean", in: "body", description: "gate with Cloudflare Access (default true; needs hostname)" }, allow: { type: "object", in: "body", description: "array of emails or @domain.com allowed through Access" }, workerName: s("Worker name, default the app name"), healthPath: s("bypassed by Access, default /api/health") } },
  { tool: "plan_cloudflare", method: "GET", path: "/api/apps/{name}/targets/{target}/plan", summary: "Show the Cloudflare resources and wrangler config FleetIQ would use, without changing anything.", params: { name, target: { type: "string", in: "path", required: true } } },
  { tool: "deploy_to_target", method: "POST", path: "/api/apps/{name}/targets/{target}/deploy", summary: "Deploy an application to Cloudflare: provision D1/KV/R2/Queues, set up Access, wrangler deploy, migrate D1, verify. from=current ships the exact version running on celld; from=git builds the Git source. dryRun validates and bundles only. Follow with wait_deployment.", params: { name, target: { type: "string", in: "path", required: true }, from: { type: "string", in: "body", enum: ["current", "git"] }, ref: s("Git ref when from=git"), dryRun: { type: "boolean", in: "body" } } },
  { tool: "verify_target", method: "POST", path: "/api/apps/{name}/targets/{target}/verify", summary: "Check a Cloudflare deployment from outside: health 200 and the Access gate redirecting to the team domain.", params: { name, target: { type: "string", in: "path", required: true } } },
  { tool: "move_app_data", method: "POST", path: "/api/apps/{name}/migrate-data", summary: "Move an application's data between this server and its Cloudflare deployment (either direction): D1 tables, KV entries and Durable Object tables. from/to are \"celld\" or a target id/name. replace makes the destination match exactly; merge upserts. Dry run first.", params: { name, from: s("celld or a target", { required: true }), to: s("celld or a target", { required: true }), parts: { type: "object", in: "body", description: "array of d1, kv, do (default all)" }, mode: { type: "string", in: "body", enum: ["replace", "merge"] }, dryRun: { type: "boolean", in: "body" }, wait: q("1 = wait up to 4 minutes") } },
  { tool: "list_tokens", method: "GET", path: "/api/tokens", summary: "API tokens (names, roles, expiry, last used). Secrets are never shown." },
  { tool: "revoke_token", method: "DELETE", path: "/api/tokens/{id}", summary: "Revoke an API token.", params: { id: { type: "string", in: "path", required: true } } },
];

// ---- OpenAPI 3.1 ----
export function openapi(baseUrl: string) {
  const paths: Record<string, any> = {};
  for (const op of OPS) {
    const ps = Object.entries(op.params ?? {});
    const body = ps.filter(([, p]) => p.in === "body");
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = {
      operationId: op.tool, summary: op.summary,
      parameters: ps.filter(([, p]) => p.in !== "body").map(([k, p]) => ({ name: k, in: p.in, required: p.in === "path" || !!p.required, description: p.description, schema: { type: p.type, enum: p.enum } })),
      ...(body.length ? { requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: body.filter(([, p]) => p.required).map(([k]) => k), properties: Object.fromEntries(body.map(([k, p]) => [k, { type: p.type, description: p.description, enum: p.enum }])) } } } } } : {}),
      responses: { "200": { description: "OK" }, "4XX": { description: "`{ error }` explains what to change" } },
    };
  }
  paths["/api/apps/{name}/deploy"] = { post: { operationId: "deploy_archive", summary: "Deploy a built archive (workiq-pack output). multipart/form-data, field `bundle`.", parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { bundle: { type: "string", format: "binary" } } } } } }, responses: { "201": { description: "deployed" } } } };
  paths["/api/apps/{name}/deploy/source"] = { post: { operationId: "deploy_source_archive", summary: "Build and deploy an unbuilt project archive. multipart/form-data: `source` (.tar.gz), optional `path`, `checks`.", parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }], requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { source: { type: "string", format: "binary" }, path: { type: "string" }, checks: { type: "string" } } } } } }, responses: { "202": { description: "building" } } } };
  return {
    openapi: "3.1.0",
    info: { title: "FleetIQ API", version: "1", description: "Control plane for celld fleets. Authenticate with `Authorization: Bearer fiq_…` (create tokens in the console under Access)." },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { token: { type: "http", scheme: "bearer" } } }, security: [{ token: [] }],
    paths,
  };
}

// ---- MCP (Streamable HTTP, JSON responses) ----
const TOOL_EXTRA = [{
  name: "api_request", description: "Call any FleetIQ API endpoint directly (see the OpenAPI document at /api/openapi.json). Use for anything the other tools don't cover.",
  inputSchema: { type: "object", required: ["method", "path"], properties: { method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, path: { type: "string", description: "starts with /api/" }, body: { type: "object", description: "JSON body" } } },
}];
export const mcpTools = () => [
  ...OPS.map((op) => {
    const ps = Object.entries(op.params ?? {});
    return {
      name: op.tool, description: `${op.summary} (${op.method} ${op.path})`,
      inputSchema: { type: "object", required: ps.filter(([, p]) => p.in === "path" || p.required).map(([k]) => k), properties: Object.fromEntries(ps.map(([k, p]) => [k, { type: p.type, description: p.description, enum: p.enum }])) },
      annotations: { readOnlyHint: op.method === "GET", destructiveHint: op.method === "DELETE" || /rollback|container_action|queue_action/.test(op.tool) },
    };
  }),
  ...TOOL_EXTRA,
];

function requestFor(op: Op, args: Record<string, any>) {
  let path = op.path; const query = new URLSearchParams(); const body: Record<string, any> = {};
  for (const [k, p] of Object.entries(op.params ?? {})) {
    const v = args[k]; if (v === undefined || v === null || v === "") { if (p.in === "path") throw new Error(`${k} is required`); continue; }
    if (p.in === "path") path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
    else if (p.in === "query") query.set(k, String(v));
    else body[k] = v;
  }
  return { method: op.method, path: path + (query.size ? `?${query}` : ""), body: Object.keys(body).length ? body : op.method === "GET" || op.method === "DELETE" ? undefined : {} };
}

export function mcpRoutes(app: Hono) {
  const PROTOCOL = "2025-06-18";
  const handle = async (c: Context, tokenFromUrl?: string) => {
    // MCP clients send a bearer token; connectors that can't set headers put it in the URL (/mcp/t/<token>).
    let auth = c.req.header("authorization") ?? "";
    try {
      if (tokenFromUrl) { identifyToken(tokenFromUrl); auth = `Bearer ${tokenFromUrl}`; }
      else await identify(c.req.raw);
    } catch (e) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: e instanceof AccessError ? e.message : "authentication failed" } }, 401, { "www-authenticate": 'Bearer realm="fleetiq"' });
    }
    if (c.req.method === "GET") return c.text("FleetIQ MCP endpoint. POST JSON-RPC here.", 405, { allow: "POST" });
    if (c.req.method === "DELETE") return c.body(null, 204);
    let msg: any; try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
    const one = async (m: any): Promise<any> => {
      const reply = (result: any) => ({ jsonrpc: "2.0", id: m.id, result });
      const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: m.id ?? null, error: { code, message } });
      switch (m.method) {
        case "initialize": return reply({ protocolVersion: m.params?.protocolVersion ?? PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "fleetiq", version: process.env.BUILD_SHA ?? "dev" },
          instructions: "FleetIQ manages celld fleets (self-hosted Cloudflare Workers + Durable Objects). Start with `system`. To ship code: set_source then deploy_from_git, then wait_deployment; add a route with set_route. Deploys build in a throwaway container from GitHub." });
        case "notifications/initialized": case "notifications/cancelled": return null;
        case "ping": return reply({});
        case "tools/list": return reply({ tools: mcpTools() });
        case "tools/call": {
          const nameArg = m.params?.name; const args = m.params?.arguments ?? {};
          let req: { method: string; path: string; body?: any };
          try {
            if (nameArg === "api_request") {
              if (!String(args.path ?? "").startsWith("/api/")) throw new Error("path must start with /api/");
              req = { method: String(args.method ?? "GET").toUpperCase(), path: String(args.path), body: args.body };
            } else {
              const op = OPS.find((o) => o.tool === nameArg); if (!op) return err(-32602, `unknown tool ${nameArg}`);
              req = requestFor(op, args);
            }
          } catch (e: any) { return reply({ isError: true, content: [{ type: "text", text: e.message }] }); }
          const r = await app.fetch(new Request(new URL(req.path, c.req.url).toString(), {
            method: req.method, headers: { authorization: auth, cookie: c.req.header("cookie") ?? "", "content-type": "application/json", "x-forwarded-for": c.req.header("x-forwarded-for") ?? "mcp" },
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
          }));
          const text = await r.text();
          return reply({ isError: r.status >= 400, content: [{ type: "text", text: `HTTP ${r.status}\n${text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(truncated)` : text}` }] });
        }
        default: return m.id === undefined ? null : err(-32601, `method not found: ${m.method}`);
      }
    };
    if (Array.isArray(msg)) { const out = (await Promise.all(msg.map(one))).filter(Boolean); return out.length ? c.json(out) : c.body(null, 202); }
    const out = await one(msg);
    return out ? c.json(out) : c.body(null, 202);
  };
  app.all("/mcp", (c) => handle(c));
  app.all("/mcp/t/:token", (c) => handle(c, c.req.param("token")));
  app.get("/api/openapi.json", (c) => c.json(openapi(config.publicUrl || new URL(c.req.url).origin)));
}
