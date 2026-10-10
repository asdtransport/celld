---
title: Running on celld
description: Self-host CellIQ on celld — the open-source Workers + Durable Objects runtime — as a Docker image.
---

CellIQ ships two deploy targets from **one code path**:

| Target | Config | Data | Gate |
|---|---|---|---|
| Cloudflare Workers | `cloudflare/wrangler.jsonc` | DO SQLite on Cloudflare | Access at the edge |
| **celld** (self-hosted) | `wrangler.jsonc` (repo root) | DO SQLite cells, LTX-replicated to your bucket | Access via Cloudflare Tunnel, or private network |

The Worker (`cloudflare/worker/index.ts`), the sync repo, and the static Astro build are identical on
both. Only the Wrangler config differs, because `celld deploy` accepts a Wrangler **subset** and stops on
any key it doesn't know.

## How it maps

- **Node** = one `celld` process = one container from this image. Each embeds V8 and runs the bundle.
- **Fleet** = every node pointed at the same bucket (`CELLD_BUCKET`). The bucket holds the deployment,
  the cell state, and ownership leases. No consensus service, no membership protocol.
- **Cell** = each Durable Object instance (`AppData:singleton`), and also each KV namespace, Queue and D1
  database. A conditional bucket write gives exactly one node the lease.
- **Durability**: one node waits on the bucket for every write (slow, ~90 ms region-local). Two or more
  nodes ack a write once a peer holds it on disk, then upload. **Run at least two nodes.**

## Config differences (why there are two wrangler files)

celld refuses, and the root `wrangler.jsonc` therefore omits: `account_id`, `routes`, `observability`,
`send_email`, `vectorize`, `ai`, `browser`. IDs (`database_id`, KV `id`) are local names, not
Cloudflare IDs. `main`, `assets.directory` and `migrations_dir` must sit **inside** the project
directory, which is why the celld config lives at the repo root.

Not available on celld: Email Workers (the `email` handler was removed from the shared entry),
Workers AI, Vectorize, Browser Rendering, the edge cache (`caches.default` always misses), and gzip on
static assets (compress at the ingress if needed).

## The image

```bash
make celld-image                                  # gate (tsc + bun test) runs inside the build
make celld-image CA=/root/.ccr/ca-bundle.crt      # behind a TLS-intercepting proxy (build-only secret)
```

Entrypoint modes:

| Command | Does |
|---|---|
| `serve` (default) | runs a node; `CELLD_DEPLOY=1` deploys first; `CELLD_D1_MIGRATE=1` applies D1 migrations once healthy |
| `deploy` | renders `APP_*` vars into the config, publishes the bundle to the bucket, exits |
| `celld …` | any celld subcommand: `d1`, `kv`, `queue`, `r2`, `cell list`, `diagnose` |

Environment:

| Var | Purpose |
|---|---|
| `CELLD_BUCKET` | `s3://name[/prefix]`, `gs://name`, `az://container` — **required** |
| `S3_ENDPOINT`, `AWS_REGION` | R2: `https://<acct>.r2.cloudflarestorage.com` + `auto` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | bucket credentials = **fleet admin**; scope them to this one bucket |
| `CELLD_ADDR` | public listener, default `0.0.0.0:8787` |
| `CELLD_INTERNAL_ADDR`, `CELLD_ADVERTISE` | peer/operator listener (default `:8788`) and the address peers dial. **Never publish 8788.** |
| `APP_AUTH_MODE` | `access` (verify the Access JWT) or `none` (private network only) |
| `APP_ACCESS_AUD`, `APP_ACCESS_TEAM_DOMAIN` | Access application audience + team domain |

`APP_*` vars are baked into a **deployment**, not read per node — change them by running `deploy` again.
Nodes adopt a new deployment at their next pointer poll (observed ≈10 s) without a restart.

## Run it

```bash
cp deploy/celld/.env.example deploy/celld/.env    # bucket + creds + APP_*
make celld-up          # deploy job -> node-a + node-b -> caddy lb on :8080
make celld-local-up    # same, with a bundled SeaweedFS bucket for testing
make celld-deploy      # ship a new version to the running fleet
make celld-down
```

Single host, no compose:

```bash
docker volume create celld-a
docker run -d --name celliq-a -p 8787:8787 \
  -e CELLD_BUCKET=s3://celliq-fleet -e S3_ENDPOINT=https://ACCOUNT.r2.cloudflarestorage.com -e AWS_REGION=auto \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -e CELLD_DEPLOY=1 -e CELLD_D1_MIGRATE=1 -e APP_AUTH_MODE=none \
  -v celld-a:/var/lib/celld celliq-celld:latest
```

## Zero Trust on celld

celld doesn't terminate TLS or do auth. Keep the house Access model by putting a **Cloudflare Tunnel**
in front of the load balancer (`--profile tunnel`, `TUNNEL_TOKEN` in `.env`) and an Access application
on the tunnel hostname. Access injects `Cf-Access-Jwt-Assertion`; the same `verifyAccess()` that runs on
Workers verifies it here. Use `workiq-cloudflare-deploy`'s `cf-access-app.sh` to create the app and get
the AUD, then `APP_AUTH_MODE=access APP_ACCESS_AUD=<aud> make celld-deploy`.

`/api/health` and `/api/runtime` stay outside the gate so the load balancer can probe them.

## Operate

```bash
docker compose -f deploy/celld/compose.yml exec node-a celld diagnose --bucket "$CELLD_BUCKET"
docker compose -f deploy/celld/compose.yml exec node-a celld cell list --bucket "$CELLD_BUCKET"
```

Replacing a node is safe: the bucket is the long-term state. Deleting **every** node and its volume and
starting a fresh one restores all data from the bucket.

## Known gotchas

- **Nested `index.html` 404s** (celld 0.6.2): `/items/` → `items/index.html` returns 404. The Astro build
  uses `build.format: "file"` (`items.html` → `/items`), so links are `/items?id=…`.
- **Old esbuild**: wrangler 3 pins esbuild 0.19, which rejects `--target=es2024`. The project pins
  `esbuild@0.25` and points `CELLD_ESBUILD` at it.
- **SSR Astro**: celld serves static assets only; the web build must be `output: "static"` with
  client-side `fetch('/api/…')`.
- **Port 8080 on the host** may already be taken (SeaweedFS's volume server defaults to it).

## Fully open-source edge (no Cloudflare)

`deploy/oss/` replaces the two Cloudflare pieces with open-source ones:

| Cloudflare | Open-source stand-in | Where it runs |
|---|---|---|
| Access (login, policy, signed JWT) | **Caddy + caddy-security** (AuthCrunch, Apache-2.0) | edge |
| Edge TLS | Caddy automatic HTTPS (Let's Encrypt) | edge |
| Tunnel (`cloudflared`) | **frp** — `frpc` at the site dials out to `frps` (Apache-2.0) | site → edge |
| Access bypass app for health | Caddy `@open` route for `/api/health`, `/api/runtime` | edge |

```
browser ──HTTPS──▶ [edge VPS]  Caddy ── login/authorize ──▶ frps:6000
                                                              ▲  (TLS, token, outbound only)
                   [site, behind NAT]  frpc ─────────────────┘
                                         └▶ lb:8080 ─▶ node-a / node-b (celld) ─▶ bucket
```

The Worker verifies the token **again** (`AUTH_MODE=edge`), so a request that reaches the fleet without
going through Caddy (e.g. someone on the site LAN hitting `lb:8080`) still gets 403.

### Set up

On the **edge** (any small public VPS with Docker):

```bash
cd deploy/oss
sh keygen.sh                       # ES256 signing key -> edge/jwt/sign.pem; prints APP_AUTH_PUBLIC_KEY_B64
cp .env.edge.example .env.edge     # SITE_ADDRESS, admin user/password, FRP_TOKEN
docker compose -f compose.edge.yml --env-file .env.edge up -d --build
```

At the **site** (behind NAT — no ports opened):

```bash
cat deploy/oss/site/.env.site.example >> deploy/celld/.env   # FRP_SERVER_ADDR, FRP_TOKEN, APP_AUTH_MODE=edge, public key
make celld-oss-up                                           # fleet + lb + frpc
```

Same host, no NAT: set `UPSTREAM=lb:8080` and `FLEET_EXTERNAL=true` in `.env.edge`, start the fleet first,
then the edge joins the fleet's network and skips the tunnel.

### Identity

The portal ships with a local user store (bootstrap admin from `.env.edge`; add users in the portal).
For Entra SSO, merge `edge/Caddyfile.entra.example` into the Caddyfile. Roles come from the portal's
`transform user` rules; the Worker enforces `AUTH_ALLOWED_ROLES`.

### Edge gotchas (observed)

- **ES256 only.** caddy-security auto-generates ES512 keys by default; celld's WebCrypto verifies only
  ECDSA P-256/SHA-256, so the Worker would reject every token. `keygen.sh` makes a P-256 key.
- **Cookie name.** caddy-security 1.4.x sets `AUTHP_ACCESS_TOKEN`, not the documented `access_token`.
  The Worker accepts both (override with `APP_AUTH_COOKIE_NAME`).
- **Two-step login.** The portal asks for the username, then the password, on separate screens.
- **frp TLS.** frps forces TLS and a shared token, but frpc doesn't pin the server certificate by default.
  For a hostile network, add `transport.tls.trustedCaFile` (and certs) on both sides.
- **The signing key is the crown jewel.** Keep `edge/jwt/sign.pem` on the edge only; the site gets the
  public half. Rotate by deleting it, rerunning `keygen.sh`, and redeploying with the new public key.
