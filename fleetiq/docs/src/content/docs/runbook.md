---
title: Runbook
description: Everyday operations and recovery.
---

## Deploy a version
Applications → app → **Deploy a version** → upload `tar czf app.tgz -C project .`. The result shows
each node's answer. A node that answers `failed` keeps serving the previous version; open the log.

## Roll back
Versions → **Roll back to this** → type the app name. Durable Object data is not rolled back.

## Scale
Managed apps only. Scaling down sends SIGTERM; celld hands cells to the remaining nodes first.
Keep two or more nodes: with one, every write waits on the bucket.

## Route a hostname
Routes → **Add route**. The hostname must also reach the edge (DNS + the edge Caddyfile).

## When a whole replication pair dies at once
If every node in a write ensemble is killed together (host power loss, sandbox reset), the next
nodes may refuse to take over a cell: `no complete true witness … refusing to seal`. celld will not
guess whether a write was acknowledged. Bring the old nodes back with their original volumes so
they can serve their retained logs. Keep nodes on separate hosts so one failure can't take a pair.
Observed 2026-10-09 in testing; treat it as a reason to spread nodes, not to delete data.

## Health at a glance
Overview shows Edge → Tunnel → Load balancer → Nodes → Bucket, measured live. Fix the first hop
that isn't green.
