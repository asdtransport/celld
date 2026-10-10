#!/usr/bin/env bash
# celld stack — single-VPS installer.
#
# Brings up, on one Linux host with Docker:
#   edge      Caddy + caddy-security on :80/:443 (Let's Encrypt), sign-in for the app and the console
#   fleet     CellIQ on two celld nodes + a Caddy load balancer (private network only)
#   console   FleetIQ control plane (deploy, scale, routes, data, audit)
#   bucket    SeaweedFS (local, S3-compatible) — or your own S3/R2 with --s3-endpoint
#
# Usage (as root, from the unpacked bundle):
#   ./install.sh                                   # uses <ip>.sslip.io hostnames, real certificates
#   ./install.sh --domain example.com              # app at example.com, console at console.example.com
#   ./install.sh --s3-endpoint https://ACCT.r2.cloudflarestorage.com --s3-bucket fleet \
#                --s3-key KEY --s3-secret SECRET --region auto          # use R2 instead of local SeaweedFS
#
# Re-running is safe: secrets and keys are kept in /opt/celld-stack/secrets.env and reused.
set -euo pipefail

# ---------------------------------------------------------------- options
DOMAIN="" ; PUBLIC_IP="" ; EMAIL=""
S3_ENDPOINT_EXT="" ; S3_BUCKET="fleet" ; S3_KEY="" ; S3_SECRET="" ; REGION="us-east-1"
PREFIX="${PREFIX:-/opt/celld-stack}"
TLS_MODE="${TLS_MODE:-acme}"            # acme | internal (internal = Caddy's own CA, for tests)
SKIP_DOCKER_INSTALL="${SKIP_DOCKER_INSTALL:-0}"
BUILD_FLAGS="${BUILD_FLAGS:-}"           # extra `docker buildx build` flags (mirrors, CA secrets)
HTTP_PORT="${HTTP_PORT:-80}" ; HTTPS_PORT="${HTTPS_PORT:-443}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --ip) PUBLIC_IP="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --s3-endpoint) S3_ENDPOINT_EXT="$2"; shift 2 ;;
    --s3-bucket) S3_BUCKET="$2"; shift 2 ;;
    --s3-key) S3_KEY="$2"; shift 2 ;;
    --s3-secret) S3_SECRET="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✔\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------- preflight
say "Preflight"
[ "$(id -u)" = 0 ] || die "run as root"
[ -d "$HERE/celliq" ] && [ -d "$HERE/fleetiq" ] || die "run from the unpacked bundle (celliq/ and fleetiq/ next to install.sh)"
case "$(uname -m)" in x86_64|amd64|aarch64|arm64) ok "arch $(uname -m)" ;; *) die "unsupported arch $(uname -m)" ;; esac
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[ "$mem_mb" -ge 1800 ] || echo "    ! ${mem_mb} MB RAM — 2 GB+ recommended (image builds use ~1 GB)"
ok "${mem_mb} MB RAM, $(nproc) CPU"

if ! command -v docker >/dev/null 2>&1; then
  [ "$SKIP_DOCKER_INSTALL" = 1 ] && die "docker not found"
  say "Installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing (apt install docker-compose-plugin)"
docker buildx version >/dev/null 2>&1 || die "docker buildx missing (apt install docker-buildx-plugin)"
ok "$(docker --version)"
command -v openssl >/dev/null || { apt-get update -qq && apt-get install -y -qq openssl; }

for p in "$HTTP_PORT" "$HTTPS_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    docker ps --format '{{.Names}} {{.Ports}}' | grep -q "celliq-edge" || die "port $p is in use by something else"
  fi
done

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
fi
[ -n "$PUBLIC_IP" ] || die "could not work out the public IP; pass --ip"
if [ -z "$DOMAIN" ]; then
  APP_HOST="$(echo "$PUBLIC_IP" | tr . -).sslip.io"
  CONSOLE_HOST="console.$APP_HOST"
else
  APP_HOST="$DOMAIN"; CONSOLE_HOST="console.$DOMAIN"
fi
ok "public IP $PUBLIC_IP"
ok "app      https://$APP_HOST"
ok "console  https://$CONSOLE_HOST"

# ---------------------------------------------------------------- files + secrets
say "Installing to $PREFIX"
mkdir -p "$PREFIX"
for d in celliq fleetiq; do
  # Keep generated state (env files, keys) across upgrades; replace code.
  rsync_exclude=(--exclude node_modules --exclude 'web/dist' --exclude '.celld' --exclude 'local/*.db*')
  if command -v rsync >/dev/null; then rsync -a --delete "${rsync_exclude[@]}" --exclude 'deploy/celld/.env' --exclude 'deploy/oss/.env.edge' --exclude 'deploy/oss/edge/jwt' "$HERE/$d/" "$PREFIX/$d/"
  else mkdir -p "$PREFIX/$d" && (cd "$HERE/$d" && tar cf - --exclude node_modules --exclude web/dist --exclude deploy/celld/.env --exclude deploy/oss/.env.edge --exclude deploy/oss/edge/jwt .) | (cd "$PREFIX/$d" && tar xf -); fi
done
cd "$PREFIX"
LOG="$PREFIX/install.log"; : > "$LOG"
umask 077
SECRETS="$PREFIX/secrets.env"
if [ ! -f "$SECRETS" ]; then
  cat > "$SECRETS" <<EOF
# Generated $(date -u +%FT%TZ). Keep this file; re-running install.sh reuses it.
ADMIN_USER=admin
ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)-Aa1
S3_KEY=${S3_KEY:-fleet$(openssl rand -hex 6)}
S3_SECRET=${S3_SECRET:-$(openssl rand -hex 24)}
EOF
  ok "generated secrets.env"
else ok "reusing secrets.env"; fi
# shellcheck disable=SC1090
. "$SECRETS"
[ -n "$S3_ENDPOINT_EXT" ] && { [ -n "$S3_KEY" ] && [ -n "$S3_SECRET" ] || die "--s3-endpoint needs --s3-key and --s3-secret"; }

PUBKEY=$(sh celliq/deploy/oss/keygen.sh 2>/dev/null | sed -n 's/^APP_AUTH_PUBLIC_KEY_B64=//p')
[ -n "$PUBKEY" ] || die "keygen failed"
ok "edge signing key (ES256) ready"

if [ -n "$S3_ENDPOINT_EXT" ]; then S3_URL="$S3_ENDPOINT_EXT"; LOCAL_S3=0; else S3_URL="http://s3:8333"; LOCAL_S3=1; fi

cat > celliq/deploy/celld/.env <<EOF
# --- generated by install.sh ---
CELLD_BUCKET=s3://$S3_BUCKET/celliq
FLEET_BUCKET=s3://$S3_BUCKET
S3_ENDPOINT=$S3_URL
AWS_REGION=$REGION
AWS_ACCESS_KEY_ID=$S3_KEY
AWS_SECRET_ACCESS_KEY=$S3_SECRET
APP_ENVIRONMENT=production
APP_AUTH_MODE=edge
APP_AUTH_PUBLIC_KEY_B64=$PUBKEY
APP_AUTH_ALLOWED_ROLES=authp/admin,authp/user
CELLIQ_PORT=127.0.0.1:8080
EDGE_URL=https://$APP_HOST$( [ "$HTTPS_PORT" != 443 ] && echo ":$HTTPS_PORT" )
EOF
TLS_GLOBAL=""; [ "$TLS_MODE" = internal ] && TLS_GLOBAL="local_certs"; [ -n "$EMAIL" ] && [ "$TLS_MODE" = acme ] && TLS_GLOBAL="email $EMAIL"
[ "$TLS_MODE" = internal ] && echo "EDGE_TLS_INSECURE=1" >> celliq/deploy/celld/.env
cat > celliq/deploy/oss/.env.edge <<EOF
# --- generated by install.sh --- single-host mode: no tunnel, the edge joins the fleet network
SITE_ADDRESS=$APP_HOST
CONSOLE_ADDRESS=$CONSOLE_HOST
UPSTREAM=lb:8080
CONSOLE_UPSTREAM=fleetiq:8790
FLEET_EXTERNAL=true
CELLIQ_ADMIN_USER=$ADMIN_USER
CELLIQ_ADMIN_EMAIL=admin@$APP_HOST
CELLIQ_ADMIN_PASSWORD=$ADMIN_PASSWORD
TOKEN_LIFETIME=28800
COOKIE_INSECURE=disabled
CADDY_EXTRA_GLOBAL=$TLS_GLOBAL
FRP_TOKEN=unused-single-host
EOF
chmod 600 celliq/deploy/celld/.env celliq/deploy/oss/.env.edge
ok "wrote stack configuration"

# ---------------------------------------------------------------- images
say "Building images (first run: 3–6 minutes)"
build() { local tag="$1" ctx="$2"; shift 2; docker buildx build --load $BUILD_FLAGS "$@" -t "$tag" "$ctx" >>"$LOG" 2>&1 || die "build failed: $tag — see $LOG"; ok "$tag"; }
SHA="$(date +%Y%m%d%H%M)"
build celliq-celld:latest celliq --build-arg BUILD_SHA="$SHA"
build fleetiq:latest fleetiq --build-arg BUILD_SHA="$SHA"
build celliq-edge-caddy:latest celliq/deploy/oss/edge -f celliq/deploy/oss/edge/Dockerfile.caddy
for img in "${NODE_IMAGE:-ghcr.io/denoland/celld:0.6.2}"; do docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >>"$LOG" 2>&1; ok "$img"; done

# ---------------------------------------------------------------- start
SITE="docker compose -f celliq/deploy/celld/compose.yml ${COMPOSE_EXTRA:+-f $COMPOSE_EXTRA} --env-file celliq/deploy/celld/.env"
EDGE="docker compose -f celliq/deploy/oss/compose.edge.yml --env-file celliq/deploy/oss/.env.edge"
export CELLIQ_IMAGE=celliq-celld:latest FLEETIQ_IMAGE=fleetiq:latest EDGE_CADDY_IMAGE=celliq-edge-caddy:latest
# Compose interpolates ${VARS} from the shell before --env-file, so a shell with its own AWS_* would
# leak into the bucket's identity config. Pin them to the stack's values for every compose call.
unset AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE
export AWS_ACCESS_KEY_ID="$S3_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET" AWS_REGION="$REGION"
export EDGE_HTTP_PORT="$HTTP_PORT" EDGE_HTTPS_PORT="$HTTPS_PORT"

if [ "$LOCAL_S3" = 1 ]; then
  say "Starting the bucket (SeaweedFS)"
  $SITE --profile local-s3 up -d s3 >>"$LOG" 2>&1 || die "bucket did not start — see $LOG"
  $SITE --profile local-s3 run --rm s3-init >>"$LOG" 2>&1 && ok "bucket $S3_BUCKET ready" || die "bucket init failed — see $LOG"
fi

say "Starting the fleet and the console"
$SITE --profile console up -d --no-build >>"$LOG" 2>&1 || die "fleet failed to start — see $LOG"
for i in $(seq 1 90); do curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 && ok "fleet healthy: $(curl -fsS http://127.0.0.1:8080/api/health)" || die "fleet did not become healthy — see: $SITE logs node-a"

say "Starting the edge"
$EDGE up -d --no-build edge >>"$LOG" 2>&1 || die "edge failed to start — see $LOG"
CURL_TLS=""; [ "$TLS_MODE" = internal ] && CURL_TLS="-k"
for i in $(seq 1 60); do
  code=$(curl -s $CURL_TLS -o /dev/null -w '%{http_code}' --resolve "$APP_HOST:$HTTPS_PORT:127.0.0.1" "https://$APP_HOST:$HTTPS_PORT/api/health" || true)
  [ "$code" = 200 ] && break; sleep 3
done
[ "$code" = 200 ] && ok "edge serving with TLS" || echo "    ! edge not answering yet (certificate issuance can take a minute) — check: $EDGE logs edge"
ccode=$(curl -s $CURL_TLS -o /dev/null -w '%{http_code}' --resolve "$CONSOLE_HOST:$HTTPS_PORT:127.0.0.1" "https://$CONSOLE_HOST:$HTTPS_PORT/" || true)
[ "$ccode" = 302 ] && ok "console gated (redirects to sign-in)" || echo "    ! console answered $ccode (expected 302 to sign-in)"

# ---------------------------------------------------------------- firewall note
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "$HTTP_PORT"/tcp >/dev/null; ufw allow "$HTTPS_PORT"/tcp >/dev/null; ok "ufw: allowed $HTTP_PORT and $HTTPS_PORT"
fi

port_sfx=""; [ "$HTTPS_PORT" != 443 ] && port_sfx=":$HTTPS_PORT"
cat <<EOF

  ────────────────────────────────────────────────────────────────
  Console   https://$CONSOLE_HOST$port_sfx
  App       https://$APP_HOST$port_sfx
  Sign in   user: $ADMIN_USER   password: $ADMIN_PASSWORD
            (stored in $SECRETS — change it after first sign-in)

  Only ports $HTTP_PORT and $HTTPS_PORT are published. The load balancer listens on
  127.0.0.1:8080; nodes, bucket and console stay on the private Docker network.

  Log:      $LOG
  Manage:   cd $PREFIX
            $SITE ps
            $EDGE logs -f edge
  ────────────────────────────────────────────────────────────────
EOF
