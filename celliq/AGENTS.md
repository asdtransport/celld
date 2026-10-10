# CellIQ — Agent Guide (golden path)

You are extending a WorkIQ house app. The platform (runtime, data layer, auth, deploy, local harness,
CI) is **already solved**. Your job is only: **business logic → API → UI → ship**.

## Touch ONLY these files

| Concern | Files |
|---------|-------|
| Business logic | `src/db/schema.ts` · `src/lib/repo.ts` · `src/lib/actions.ts` (create if needed) · `src/contract.ts` |
| API | `src/app.ts` (the `makeApi()` factory) |
| UI | `web/src/pages/**` (+ nav in `web/src/layouts/Base.astro`) |
| Tests | `src/**/*.test.ts` |
| Migrations | generated — run `make db-generate`, never hand-write |

Do **not** edit: `src/db/runtime.ts`, `src/index.ts`, `cloudflare/worker/**`, `local/run.sh`, the Makefile.
Those are the platform. If you think you need to, stop and reconsider.

## Add a resource (one command)

```bash
bunx create-workiq resource Widget      # scaffolds + wires + tests + documents
```
Then edit the table fields in `src/db/schema.ts` and run `make check`.

<details><summary>What it touches (if doing it by hand)</summary>

To add `widgets`:
1. `src/db/schema.ts` — add the `widgets` table (integer cents for money; `createdAt` default).
2. `src/db/ddl.ts` — add the matching `CREATE TABLE IF NOT EXISTS widgets (...)`.
3. `src/lib/repo.ts` — add `list/get/create/update/deleteWidget`, **synchronous**, via `getDb()`.
4. `src/contract.ts` — add the Zod `WidgetInput`.
5. `src/app.ts` — mount `GET/POST/PATCH/DELETE /api/widgets` in `makeApi()`.
6. `src/lib/repo.test.ts` + `src/app.test.ts` — add cases.
7. `web/src/pages/widgets/` — add list + `[id]` pages using `Base/PageHeader/Panel/DataTable`.
8. `make db-generate` to emit the migration.

## The loop — run after every change

```bash
make verify      # tsc --noEmit — must be clean
make test        # bun test — must be green
make local-up    # bun:sqlite server on :8787
curl -s localhost:8787/api/<resource>
make web-build   # Astro SSR build
make local-down
```

## Ship

```bash
make db-generate                 # schema -> migration (forward-only)
make seed                        # optional: fixture data locally
git push                         # CI: check -> migrate -> canary 10% -> /health gate -> 100%
```
CI lives in `.github/workflows/deploy.yml`. Set repo secrets `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` and the `HEALTH_URL` variable. `GET /api/health` returns
`{ ok, version, db }` and is the promotion gate — never weaken it.

## Rules

- Keep the core **synchronous and driver-blind** — no `bun:sqlite`/D1 imports outside entrypoints.
- **Forward-only migrations** (add `000N_*.sql`, never edit an applied one).
- **Zod at every mutation boundary**; the factory already returns 400 on validation errors.
- Every new logic path gets a test. Green `make verify && make test` is the definition of done.

## Two runtimes: Cloudflare Workers and celld

The same Worker entry (`cloudflare/worker/index.ts`) runs on Cloudflare and on **celld**
(self-hosted Workers/DO runtime, Docker image in `Dockerfile`). Rules that keep both working:

- Edge config: `cloudflare/wrangler.jsonc`. celld config: **`wrangler.jsonc` at the repo root**.
  A binding added to one must be added to the other. celld rejects `routes`, `account_id`,
  `observability`, email, AI, Vectorize, Browser — keep those in the Cloudflare file only.
- No `email` handler, no `caches.default` reliance, no SSR: the web build is static
  (`output: "static"`, `build.format: "file"`) and pages fetch `/api/*` client-side.
- Local celld: `make celld-dev` (port 9876). Image: `make celld-image`. Fleet: `make celld-local-up`.
- Open-source edge (no Cloudflare): `deploy/oss/` — Caddy + caddy-security + frp; Worker `AUTH_MODE=edge`.
- Full runbook: `docs/src/content/docs/celld.md`.
