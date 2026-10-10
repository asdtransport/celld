---
title: API Reference
description: Resources exposed by CellIQ.
---

Base URL: the Worker origin. All routes are under `/api`.

## Health
`GET /api/health` → `{ ok, version, db, ts }`. Used by the CI promotion gate.

## Items
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/items` | — | `Item[]` |
| GET | `/api/items/:id` | — | `Item` \| 404 |
| POST | `/api/items` | `{ name, note? }` | `Item` (201) |

`Item = { id, name, note, createdAt }`. Invalid bodies return **400** (Zod). Oversized bodies **413**.

> AGENT: add a section per resource as you add them in `src/routes.ts`.
