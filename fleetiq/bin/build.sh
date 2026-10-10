#!/bin/sh
# Runs inside a throwaway builder container started by FleetIQ (no Docker socket, no fleet network).
# In:  /tmp/in/src.tgz (a GitHub tarball or any .tar.gz of the project), optional /tmp/in/ca.pem
# Env: APP (application name), SUBPATH (project folder inside the source), CHECKS (1|0)
# Out: /tmp/out/app.tgz — the same archive workiq-pack.sh makes on a laptop.
set -eu
[ -s /tmp/in/ca.pem ] && export NODE_EXTRA_CA_CERTS=/tmp/in/ca.pem
mkdir -p /tmp/w /tmp/out
tar xzf /tmp/in/src.tgz -C /tmp/w --no-same-owner
root=/tmp/w
# A GitHub tarball wraps everything in one folder (owner-repo-sha/).
if [ "$(ls -A /tmp/w | wc -l)" -eq 1 ] && [ -d "/tmp/w/$(ls -A /tmp/w)" ]; then root="/tmp/w/$(ls -A /tmp/w)"; fi
proj="$root/${SUBPATH:-}"
if [ ! -f "$proj/wrangler.jsonc" ] && [ ! -f "$proj/wrangler.json" ] && [ -z "${SUBPATH:-}" ]; then
  # No path given: the shallowest wrangler config outside node_modules and cloudflare/ (that one is the Cloudflare config).
  found=$(find "$root" -maxdepth 3 \( -name node_modules -o -name cloudflare \) -prune -o \( -name wrangler.jsonc -o -name wrangler.json \) -print \
    | awk '{ print gsub("/", "/"), $0 }' | sort -n | head -1 | cut -d' ' -f2-)
  [ -n "$found" ] && proj=$(dirname "$found")
fi
[ -f "$proj/wrangler.jsonc" ] || [ -f "$proj/wrangler.json" ] || { echo "✗ no wrangler.jsonc in ${SUBPATH:-the source root} — set the project path"; exit 2; }
rel=${proj#"$root"}; echo "==> Building ${rel:-the source root}"
flags=""; [ "${CHECKS:-1}" = 1 ] || flags="--skip-checks"
PACK_QUIET=1 bash /app/bin/workiq-pack.sh "$proj" --name "$APP" --out /tmp/out/app.tgz $flags
