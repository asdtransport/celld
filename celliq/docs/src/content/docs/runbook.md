---
title: Runbook
description: Operate CellIQ.
---

## Local
```bash
make check && make local-up
curl localhost:8787/api/health
```

## Deploy
`git push` triggers CI: gate → forward-only D1 migrate → build web → `versions upload` →
**canary 10%** → `/api/health` gate → **promote 100%**.

## Rollback
`wrangler rollback --version-id <prev>`. DO SQLite state survives Worker rollbacks; migrations must
stay additive/back-compatible.
