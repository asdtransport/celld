# FleetIQ

Control plane for self-hosted **celld** fleets: deploy and roll back Workers, scale nodes, route
hostnames, manage tunnels, and read or change application data, with every action audited.
A WorkIQ app: Bun · Hono · Drizzle · Zod, with an Astro console. The UI is the static Astro build
in `web/dist`; the server contains no hand-written HTML.

## What it manages

| Area | How FleetIQ does it |
|---|---|
| Applications | One celld fleet per app, each under its own prefix in the fleet bucket |
| Deploy | Upload a project `.tar.gz` → archive checks → `celld deploy` → forced `/reload` on every node |
| Rollback | Move queue-consumer attachments, the named pointer, then the fleet pointer (all conditional writes) → `/reload` |
| Nodes | Docker Engine API runs `fleetiq-<app>-node-N` containers; scale up/down; leases + `/state` per node |
| Routes | Renders the load balancer's whole Caddy config from the routes table, over a private admin socket |
| Tunnels | frpc admin API (store proxies) at the site; frps v2 API at the edge when reachable |
| Data | KV, D1, Queues, R2, Durable Object instances through the `celld` CLI |
| Containers | Status, restart and logs for the stack's compose projects and managed nodes |
| Activity | Who did what, including refused and failed attempts |

## Run it

FleetIQ runs inside the celld stack as the `console` profile and is reached through the edge:

```bash
make image                                   # gate (tsc + 19 tests) runs inside the build
# in the celliq repo:
docker compose -f deploy/celld/compose.yml --profile oss-tunnel --profile console up -d
```

Local development against a running stack (CLI and node addresses only resolve on the fleet network):

```bash
make install && make check
cd web && bun run dev        # console on :4321, API on :8787
```

## Configuration (environment)

| Var | Meaning |
|---|---|
| `FLEET_BUCKET` | `s3://bucket` — apps live under `s3://bucket/<app>` |
| `S3_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | bucket access (fleet-admin) |
| `FLEET_NETWORK` | Docker network the nodes, LB and FleetIQ share (`celliq_fleet`) |
| `NODE_IMAGE` | image for managed nodes (default `ghcr.io/denoland/celld:0.6.2`) |
| `STACK_PROJECTS` | compose projects shown under Containers |
| `LB_ADMIN_SOCK` | Caddy admin unix socket of the load balancer |
| `FRPC_API`, `FRPC_USER`, `FRPC_PASS` | frpc admin API at this site |
| `FRPS_API`, `FRPS_USER`, `FRPS_PASS` | frps dashboard API at the edge (optional) |
| `EDGE_URL` | public edge URL probed for the request path |
| `AUTH_MODE` | `edge` (verify caddy-security ES256 token) or `none` (trusted network only) |
| `AUTH_PUBLIC_KEY_B64` / `AUTH_JWKS_URL` | edge signing key (from `keygen.sh`) or JWKS |
| `VIEWER_ROLES`, `OPERATOR_ROLES` | role claims for read-only vs change access |
| `DEFAULT_APP` | adopt this app and route `*` to it on first run |

## Security model

- Two checks on every request: the edge (Caddy + caddy-security) and FleetIQ itself (ES256 token,
  roles). Calling FleetIQ directly on the fleet network with a forged token gets 401.
- Viewers read; operators change. Refusals are written to the activity log.
- FleetIQ mounts the Docker socket and holds bucket credentials, so treat it as host-admin.
  Expose it only through the edge.
- The LB admin API is a unix socket shared only with FleetIQ, so Workers on the fleet network
  cannot reconfigure routing. frpc's admin API needs a password.
- Uploads: `.tar.gz` only, size-capped, no links/devices/absolute/`..` paths, and the wrangler
  `name` must equal the application name.
