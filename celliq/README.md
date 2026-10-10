# CellIQ

CellIQ — a WorkIQ edge app

Scaffolded by **create-workiq** on the WorkIQ house stack: Bun · Hono · Drizzle · Zod · Cloudflare.

## Run locally (no Cloudflare account)
```bash
make install
make local-up        # flock-locked bun:sqlite server on :8787
curl localhost:8787/api/items
make local-down
```

## Architecture
- `src/` — runtime-agnostic core. `app.ts` is the Hono `makeApi()` factory; `db/runtime.ts` is the
  driver-blind `getDb/setDb` accessor; `lib/repo.ts` is the **synchronous** repo that runs verbatim
  in a Durable Object.
- `src/index.ts` — Bun entry: registers `bun:sqlite` and serves the API + a house-styled dashboard.
- `cloudflare/` — edge tier: `worker/index.ts` (front door + DO with `durable-sqlite` + queue/
  scheduled/email), `access.ts` (Zero Trust), forward-only `migrations/`, `vite.config.ts` (workerd HMR).
- `local/run.sh` — the flock/trap process harness.

## Deploy
```bash
cd cloudflare && wrangler deploy
```

<!-- Push-to-deploy test 2026-10-10T16:25:50Z: GitHub webhook -> FleetIQ -> build -> celld. -->
