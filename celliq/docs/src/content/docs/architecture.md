---
title: Architecture
description: How CellIQ is built.
---

- **Driver-blind core** — `src/lib/repo.ts` is synchronous and talks to the DB via `@workiq/runtime`'s
  `getDb()`. It runs verbatim on bun:sqlite (local) and Durable-Object SQLite (edge).
- **Shared factory** — `@workiq/hono-core`'s `makeApi()` supplies CORS, body limits, rate limiting,
  the Zod→400 envelope, and `/api/health`. This app injects its `dbPing` + routes via `src/resources.ts`.
- **Front door** — `@workiq/edge`'s `frontDoor()` Access-gates `/api/*` to the data DO, everything else
  to the Astro `ASSETS` build.
- **UI** — the `@workiq/ui` console (navy/teal) under `web/`.
