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
