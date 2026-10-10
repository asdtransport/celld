# celld stack — install on one VPS

Everything in this folder installs with one command on a Linux VPS (Ubuntu/Debian, 2 GB+ RAM,
ports 80 and 443 open at the provider):

| Piece | What it is |
|---|---|
| Edge | Caddy + caddy-security: HTTPS (Let's Encrypt) and sign-in for the app and the console |
| CellIQ | The WorkIQ app on two celld nodes behind a Caddy load balancer |
| FleetIQ | The control plane: deploy, roll back, scale, routes, data, containers, activity |
| Bucket | SeaweedFS on the same disk (or Cloudflare R2 / S3 with flags below) |

## Install

On the server (Hostinger browser terminal or SSH), as root:

```bash
curl -fsSL https://github.com/asdtransport/celld/archive/refs/heads/celld-stack.tar.gz | tar xz
cd celld-celld-stack && ./install.sh
```

It installs Docker if missing, builds the images on the server (3–6 minutes the first time), and
prints the console URL and the admin password. Without a domain it uses names that resolve to the
server's IP:

- Console: `https://console.179-236-68-136.sslip.io`
- App: `https://179-236-68-136.sslip.io`

With your own domain (point `app.example.com` and `console.app.example.com` at the server first):

```bash
./install.sh --domain app.example.com --email you@example.com
```

With Cloudflare R2 instead of the local bucket (recommended once it matters: the local bucket
lives on the same disk as everything else):

```bash
./install.sh --s3-endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com --region auto \
  --s3-bucket celld-fleet --s3-key <R2_KEY> --s3-secret <R2_SECRET>
```

Re-run `./install.sh` any time to upgrade or repair. It keeps `/opt/celld-stack/secrets.env`,
the sign-in key and all data.

## After installing

1. Sign in to the console and change the admin password (portal: `/auth/profile`).
2. Rotate the root password and switch SSH to keys. Disable password login when keys work.
3. Back up `/opt/celld-stack/secrets.env` and `/opt/celld-stack/celliq/deploy/oss/edge/jwt/`.

## What's exposed

Only ports 80 and 443 (the edge). The load balancer listens on `127.0.0.1:8080`; nodes, bucket
and console are on a private Docker network. FleetIQ mounts the Docker socket, so the console is
as powerful as root on this server. It is only reachable through the sign-in.

## Deploy a WorkIQ app

On your computer (needs bun), from this folder:

```bash
./workiq-pack.sh ~/code/my-app             # type check, tests, web build → my-app.tgz
./workiq-pack.sh ~/code/my-app --name crm  # deploy it under another application name
```

The app must already run on celld: `wrangler.jsonc` at the project root and a static Astro build
(the workiq-celld-deploy skill does that conversion). Then in the console:

1. **Applications → Create application**: the same name, health check path `/api/health`.
2. Open it → **Deploy** → upload the `.tgz`. D1 migrations run after the deploy, and the app's
   sign-in check gets this server's edge key automatically.
3. **Routes**: add `my-app.<app domain>` → `my-app` (for example `crm.179-236-68-136.sslip.io`).
   The edge gets the HTTPS certificate on the first visit; nothing to run on the server.

### Or deploy straight from GitHub

On the app's page, **Source → Connect GitHub** (repo, branch, project folder), then **Deploy from Git**.
FleetIQ downloads that commit, builds it in a throwaway container (type check, tests, web build) and
deploys it. Turn on **Deploy on every push** and add the webhook shown there to the GitHub repo to ship
on `git push`. Private repos need a read-only GitHub token on the same form.

## Data mover: backups, disaster recovery and client migrations

**Data mover** in the console copies between any two places, like rsync for cloud storage. Built-in
connectors: Cloudflare R2, Amazon S3, Railway buckets, Azure Blob (container SAS), DigitalOcean
Spaces, Backblaze B2, Google Cloud Storage (HMAC), Wasabi, any S3-compatible store (MinIO,
SeaweedFS, Ceph), a folder on this server, and this server's own fleet bucket.

- **Copy** adds and updates; **mirror** also deletes what the source no longer has, but only after
  every copy succeeded. Later runs move only what changed (size and time, or checksums).
- **Dry run** shows exactly what would be copied and deleted. Every run verifies what it wrote.
- **Jobs** save a copy and can repeat it every 15 minutes to daily.
- **Back up an application**: its whole celld state (Durable Objects, D1, KV, queues, deployed
  versions) goes to any endpoint. *Consistent* stops the app's nodes during the copy; *live* has no
  downtime. Backups never delete, so a wiped source can't wipe the backup.
- **Restore an application** onto this or another server: nodes stop, the app's data becomes an
  exact copy of the backup, nodes start. Keep the original app name.

All of it is in the API and the Claude connector (`backup_app`, `restore_app`, `mover_sync`, …).

## API, Claude and automation

Everything in the console is an API. In **API & access**, create a token per script, pipeline or
assistant (operator or viewer, with an expiry), then use any of:

| From | How |
|---|---|
| Claude (claude.ai, desktop, mobile) | Settings → Connectors → add `https://console.<domain>/mcp/t/<token>` |
| Claude Code | `claude mcp add --transport http fleetiq https://console.<domain>/mcp --header "Authorization: Bearer <token>"` |
| Scripts, CI | `curl -H "Authorization: Bearer <token>" https://console.<domain>/api/system` — every endpoint is in `/api/openapi.json` |
| Terminal | `fleetiq/bin/fleetiq` (needs curl): `fleetiq status`, `fleetiq deploy my-app --git`, `fleetiq logs my-app` |

Tokens skip the sign-in page at the edge but FleetIQ checks each one (only a hash is stored), records
every change under the token's name in Activity, and refuses to let a token create more tokens.

## Upgrade

Run the same two install lines again. It keeps your passwords, sign-in key, apps and data.

## Day to day

```bash
cd /opt/celld-stack
docker compose -f celliq/deploy/celld/compose.yml --env-file celliq/deploy/celld/.env ps
docker compose -f celliq/deploy/oss/compose.edge.yml --env-file celliq/deploy/oss/.env.edge logs -f edge
cat install.log                       # full output of the last install
```

Also in this bundle: `create-workiq-static-web.patch` makes new WorkIQ apps use the static Astro
build instead of the generated standalone HTML page. Apply it to the create-workiq generator with
`git apply`.
