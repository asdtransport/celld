---
title: Architecture
description: What FleetIQ talks to, and how.
---

```
browser ─▶ edge Caddy (+caddy-security) ─▶ frps ─tunnel─▶ frpc ─▶ FleetIQ :8790
                                                            └─▶ lb (Caddy) ─▶ app nodes (celld)
FleetIQ ─▶ fleet bucket (pointers, leases, manifests)
        ─▶ node internal API :8788 (/state, /reload)
        ─▶ celld CLI (deploy, kv, d1, queue, r2, cell list, diagnose)
        ─▶ Docker socket (managed node containers, stack status, logs)
        ─▶ lb admin unix socket (whole-config load, upstream health)
        ─▶ frpc admin API (tunnels), frps API (optional)
```

**Why the CLI runs inside the fleet network.** celld commands reach the owning node by its
advertised address (`node-a:8788`), which only resolves on the fleet network.

**Deploy.** celld writes the version, then the named pointer, then the fleet pointer. Nodes poll
the pointer every `CELLD_DEPLOY_POLL_S` (30 s). FleetIQ then sends `POST /reload` to every live
node, so they switch at once, and records each node's answer.

**Rollback.** A queue's consumer attachment (`deploy/queues/<q>/consumer.json`) pins the exact
deployment that declared it. Moving only the pointers makes nodes refuse the older version
("queue … is attached to deployment …"). FleetIQ moves the attachments first, then the named
pointer, then the fleet pointer, each with If-Match / If-None-Match. A concurrent deploy makes the
rollback fail rather than overwrite it.

**Routes.** FleetIQ owns the LB config: `POST /load` with routes rendered from its table. Managed
apps' upstreams are their containers; adopted apps' upstreams come from live node leases. A
reconciler re-pushes when those change.

**Auth.** Same ES256 tokens as the apps. ES256 is required because celld's WebCrypto verifies
only P-256/SHA-256; the console verifies the token itself even behind the edge.
