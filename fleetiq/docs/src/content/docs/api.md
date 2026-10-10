---
title: API reference
description: Endpoints behind the console. All need a viewer token; non-GET needs an operator.
---

| Method | Path | Does |
|---|---|---|
| GET | `/api/health` | liveness (no auth) |
| GET | `/api/me` | identity and roles |
| GET | `/api/overview` | request-path hops, app summaries, recent activity |
| GET/POST | `/api/apps` | list / create (`{name, managed, desiredNodes, healthPath, nodeImage}`) |
| GET/PATCH/DELETE | `/api/apps/:name` | detail (fleet, bindings, routes) / settings / remove |
| GET | `/api/apps/:name/versions` · `/deployments` · `/diagnose` · `/cells` | versions in the bucket, history, signed probes, DO instances |
| POST | `/api/apps/:name/deploy` | multipart `bundle` (.tar.gz) |
| POST | `/api/apps/:name/rollback` | `{version}` |
| POST | `/api/apps/:name/scale` | `{nodes}` (managed apps) |
| GET/PUT/DELETE | `/api/apps/:name/kv/:ns[/value]` | list keys / write / delete |
| POST | `/api/apps/:name/d1/:db/query` | `{sql}` |
| GET/POST | `/api/apps/:name/d1/:db/migrations` | list / apply |
| GET/POST | `/api/apps/:name/queues/:q[/:action]` | info + peek / pause, resume, purge, redrive |
| GET/POST/DELETE | `/api/apps/:name/r2/:bucket` | list / upload (multipart `file`, `key`) / delete `?key=` |
| GET/PUT/DELETE | `/api/routes` | routes + upstream health / upsert `{host, app}` / remove `?host=` |
| GET/POST/DELETE | `/api/tunnels[/:name]` | frpc status + frps info / add / remove |
| GET/POST | `/api/containers[/:id/:action]` | stack containers / start, stop, restart |
| GET | `/api/containers/:id/logs` | last N lines |
| GET | `/api/audit` | activity log |
