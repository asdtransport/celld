#!/usr/bin/env bash
# workiq-pack — turn a WorkIQ app into an archive you upload in FleetIQ (Applications → app → Deploy).
#
#   ./workiq-pack.sh path/to/my-app                 # writes my-app.tgz next to the project
#   ./workiq-pack.sh path/to/my-app --name worklog  # deploy it under another application name
#   ./workiq-pack.sh path/to/my-app --auth none     # no sign-in check inside the app (edge still gates)
#
# The project must already run on celld: wrangler.jsonc at the project root, static web build
# (see the workiq-celld-deploy skill). Any other Workers project with a wrangler.jsonc works too.
# Needs tar, and bun when the project has a package.json. Runs on macOS and Linux.
#
# What goes in the archive: wrangler.jsonc, package.json, the Worker and app source, migrations,
# the built web (web/dist) and production node_modules. Dev tools, tests and local data stay out.
set -euo pipefail

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
ok() { printf '  ✔ %s\n' "$*"; }

[ $# -ge 1 ] || die "usage: $0 PROJECT_DIR [--name NAME] [--auth auto|edge|none|keep] [--out FILE] [--skip-checks]"
PROJECT=$(cd "$1" && pwd); shift
NAME="" AUTH="auto" OUT="" CHECKS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --auth) AUTH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --skip-checks) CHECKS=0; shift ;;
    *) die "unknown option $1" ;;
  esac
done
case "$AUTH" in auto|edge|none|keep) ;; *) die "--auth must be auto, edge, none or keep" ;; esac
cd "$PROJECT"
CFG=""; for f in wrangler.jsonc wrangler.json; do [ -f "$f" ] && CFG=$f && break; done
[ -n "$CFG" ] || die "no wrangler.jsonc at $PROJECT — convert the app for celld first (root wrangler.jsonc, static web)"
HAS_PKG=0; [ -f package.json ] && HAS_PKG=1
[ "$HAS_PKG" = 0 ] || command -v bun >/dev/null || die "bun is required (https://bun.sh)"
FROZEN=""; [ -f bun.lock ] && FROZEN="--frozen-lockfile"

CUR=$(sed -e 's#^[[:space:]]*//.*##' "$CFG" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
NAME=${NAME:-$CUR}
echo "$NAME" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' || die "application name '$NAME' must be lowercase letters, digits and dashes"
OUT=${OUT:-"$(dirname "$PROJECT")/$NAME.tgz"}
echo "==> Packing $PROJECT as '$NAME'"

if [ "$HAS_PKG" = 1 ]; then
  bun install $FROZEN >/dev/null 2>&1 || die "bun install failed (run it in the project to see why)"
  ok "dependencies"
  if [ "$CHECKS" = 1 ] && grep -q '"verify"' package.json; then bun run verify >/dev/null 2>&1 || die "type check failed (bun run verify); fix it or pass --skip-checks"; ok "type check"; fi
  if [ "$CHECKS" = 1 ] && [ -n "$(find . -path ./node_modules -prune -o \( -name '*.test.ts' -o -name '*.test.js' \) -print | head -1)" ]; then
    bun test >/dev/null 2>&1 || die "tests failed (bun test); fix them or pass --skip-checks"; ok "tests"
  fi
fi

ASSETS=$(sed -e 's#^[[:space:]]*//.*##' "$CFG" | tr -d '\n' | grep -o '"assets"[^}]*"directory"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' | sed 's#^\./##' || true)
if [ -d web ] && [ -f web/package.json ]; then
  WF=""; [ -f web/bun.lock ] && WF="--frozen-lockfile"
  (cd web && bun install $WF >/dev/null 2>&1 && bun run build >/dev/null 2>&1) || die "web build failed (cd web && bun run build)"
  ok "web build"
elif [ "$HAS_PKG" = 1 ] && [ -n "$ASSETS" ] && grep -q '"build"[[:space:]]*:' package.json; then
  bun run build >/dev/null 2>&1 || die "build failed (bun run build)"
  ok "build"
fi
[ -z "$ASSETS" ] || [ -f "$ASSETS/index.html" ] || die "$ASSETS/index.html is missing after the build — set build.format \"file\" and output \"static\" in astro.config"

STAGE=$(mktemp -d); chmod 755 "$STAGE"; trap 'rm -rf "$STAGE"' EXIT
if [ -d cloudflare/worker ]; then
  # WorkIQ layout: ship only what the Worker needs.
  cp "$CFG" package.json "$STAGE/"; [ -f bun.lock ] && cp bun.lock "$STAGE/"
  [ -f tsconfig.json ] && cp tsconfig.json "$STAGE/"
  for p in src cloudflare/worker cloudflare/migrations ${ASSETS:+"$ASSETS"}; do
    [ -e "$p" ] || continue
    mkdir -p "$STAGE/$(dirname "$p")"
    cp -R "$p" "$STAGE/$p"
  done
else
  # Any other Workers project: everything except dependencies, VCS and local state.
  tar cf - --exclude ./node_modules --exclude ./.git --exclude ./.celld --exclude ./.wrangler --exclude '*/node_modules' . | (cd "$STAGE" && tar xf -)
fi
# Tests, local databases and editor junk don't ship.
find "$STAGE" \( -name '*.test.ts' -o -name '*.spec.ts' -o -name '.DS_Store' -o -name '*.db' -o -name '*.db-*' -o -name '.dev.vars*' -o -name '.env*' \) -exec rm -rf {} + 2>/dev/null || true

# Application name and sign-in mode, in the archive's copy only.
W="$STAGE/$CFG"
awk -v n="$NAME" '!done && /"name"[[:space:]]*:[[:space:]]*"[^"]*"/ && !/^[[:space:]]*\/\// { sub(/"name"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"name\": \"" n "\""); done=1 } { print }' "$W" > "$W.new" && mv "$W.new" "$W"
setvar() { # setvar KEY VALUE — only if the key exists in vars
  sed -E "s|(\"$1\"[[:space:]]*:[[:space:]]*)\"[^\"]*\"|\1\"$2\"|" "$W" > "$W.new" && mv "$W.new" "$W"
}
if [ "$AUTH" = auto ]; then if grep -q '"AUTH_MODE"' "$W"; then AUTH=edge; else AUTH=keep; fi; fi
case "$AUTH" in
  edge) grep -q '"AUTH_MODE"' "$W" || die "wrangler.jsonc vars have no AUTH_MODE; pass --auth keep or --auth none"
        setvar AUTH_MODE edge; setvar AUTH_PUBLIC_KEY_B64 ""; ok "sign-in checked inside the app too (FleetIQ fills in the server's edge key)" ;;
  none) grep -q '"AUTH_MODE"' "$W" && setvar AUTH_MODE none; ok "no sign-in check inside the app; the edge still requires sign-in" ;;
  keep) ok "sign-in settings left as they are" ;;
esac

if [ -f "$STAGE/package.json" ]; then
  SF=""; [ -f "$STAGE/bun.lock" ] && SF="--frozen-lockfile"
  (cd "$STAGE" && bun install $SF --production >/dev/null 2>&1) || die "production install failed"
fi
# FleetIQ refuses links in uploads; bun's .bin shims are links and nothing at runtime needs them.
[ -d "$STAGE/node_modules" ] && find "$STAGE/node_modules" -name .bin -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -type l -delete

tar czf "$OUT" -C "$STAGE" .
SIZE=$(wc -c < "$OUT" | tr -d ' ')
ok "$(basename "$OUT") ($((SIZE / 1024 / 1024)) MB)"
[ "$SIZE" -le $((64 * 1024 * 1024)) ] || echo "  ! larger than FleetIQ's default 64 MB upload limit (raise MAX_UPLOAD_MB on FleetIQ)"
[ -n "${PACK_QUIET:-}" ] || cat <<EOF

Next, in FleetIQ:
  1. Applications → Create application → name: $NAME, health check path: /api/health
  2. Open $NAME → Deploy → upload $(basename "$OUT")
  3. Routes → add $NAME.<your app domain> → $NAME, then open https://$NAME.<your app domain>
EOF
