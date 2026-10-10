#!/bin/sh
# CellIQ celld node entrypoint.
#   serve   (default) render config -> [deploy] -> run celld -> [D1 migrate] -> wait
#   deploy  render config -> publish the bundle to the fleet bucket -> exit
#   celld … / sh …  pass through (celld d1|kv|queue|r2|cell|diagnose, or a shell)
set -eu

APP=/app
log() { printf '[celliq] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

# ---- render Wrangler vars from the environment (vars are baked at deploy time) -------------
# Only these keys may be overridden; values with quotes/backslashes/newlines are refused so the
# JSON stays valid without a JSON tool in the image.
render_vars() {
  for key in ENVIRONMENT AUTH_MODE ACCESS_TEAM_DOMAIN ACCESS_AUD AUTH_PUBLIC_KEY_B64 AUTH_JWKS_URL AUTH_ALLOWED_ROLES AUTH_COOKIE_NAME BUILD_SHA ALLOWED_ORIGINS; do
    eval "val=\${APP_$key-}"
    [ -z "$val" ] && [ "$key" = BUILD_SHA ] && val="${BUILD_SHA:-}"
    [ -z "$val" ] && continue
    case "$val" in *'"'*|*'\'*|*'
'*) die "APP_$key contains a quote, backslash or newline" ;; esac
    esc=$(printf '%s' "$val" | sed 's/[&|]/\\&/g')
    if grep -q "\"$key\":" "$APP/wrangler.jsonc"; then
      sed -i "s|\"$key\": \"[^\"]*\"|\"$key\": \"$esc\"|" "$APP/wrangler.jsonc"
    else
      sed -i "s|\"vars\": {|\"vars\": {\n    \"$key\": \"$esc\",|" "$APP/wrangler.jsonc"
    fi
  done
  mode=$(sed -n 's/.*"AUTH_MODE": "\([^"]*\)".*/\1/p' "$APP/wrangler.jsonc")
  aud=$(sed -n 's/.*"ACCESS_AUD": "\([^"]*\)".*/\1/p' "$APP/wrangler.jsonc")
  pk=$(sed -n 's/.*"AUTH_PUBLIC_KEY_B64": "\([^"]*\)".*/\1/p' "$APP/wrangler.jsonc")
  jw=$(sed -n 's/.*"AUTH_JWKS_URL": "\([^"]*\)".*/\1/p' "$APP/wrangler.jsonc")
  if [ "$mode" = access ] && [ -z "$aud" ]; then
    log "warning: AUTH_MODE=access with no APP_ACCESS_AUD — every /api/* call except health will be 403"
  fi
  if [ "$mode" = edge ] && [ -z "$pk$jw" ]; then
    log "warning: AUTH_MODE=edge with no APP_AUTH_PUBLIC_KEY_B64 / APP_AUTH_JWKS_URL — every /api/* call except health will be 403"
  fi
}

storage_args() {
  [ -n "${CELLD_BUCKET:-}" ] || die "CELLD_BUCKET is required (s3://name[/prefix], gs://name, az://container)"
  set -- --bucket "$CELLD_BUCKET"
  [ -n "${S3_ENDPOINT:-}" ] && set -- "$@" --endpoint "$S3_ENDPOINT"
  [ -n "${AWS_REGION:-}" ] && set -- "$@" --region "$AWS_REGION"
  printf '%s\n' "$@"
}

do_deploy() {
  render_vars
  log "deploying $(sed -n 's/.*"name": "\([^"]*\)".*/\1/p' $APP/wrangler.jsonc | head -1) to $CELLD_BUCKET"
  # shellcheck disable=SC2046
  celld deploy "$APP" $(storage_args)
}

do_serve() {
  # Vars are baked into a deployment, so they only matter when this node deploys.
  if [ "${CELLD_DEPLOY:-0}" = 1 ]; then do_deploy; fi
  if [ -z "${CELLD_ADVERTISE:-}" ]; then
    ip=$(hostname -i 2>/dev/null | awk '{print $1}')
    port=${CELLD_INTERNAL_ADDR##*:}
    [ -n "$ip" ] && export CELLD_ADVERTISE="$ip:$port"
  fi
  log "node listen=$CELLD_ADDR internal=$CELLD_INTERNAL_ADDR advertise=${CELLD_ADVERTISE:-auto}"
  # shellcheck disable=SC2046
  celld $(storage_args) &
  child=$!
  trap 'kill -TERM $child 2>/dev/null' TERM INT

  if [ "${CELLD_D1_MIGRATE:-0}" = 1 ]; then
    port=${CELLD_ADDR##*:}
    i=0; until curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; do
      i=$((i+1)); [ $i -gt 120 ] && die "node never became healthy"; kill -0 $child || exit 1; sleep 0.5; done
    log "applying D1 migrations"
    # shellcheck disable=SC2046
    celld d1 migrations apply celliq "$APP" $(storage_args) || log "warning: D1 migrations failed"
  fi
  rc=0
  while kill -0 $child 2>/dev/null; do wait $child || rc=$?; done
  exit $rc
}

cmd=${1:-serve}
case "$cmd" in
  serve)  do_serve ;;
  deploy) do_deploy ;;
  celld)  shift; exec celld "$@" ;;
  sh|bash) exec "$@" ;;
  *)      exec celld "$@" ;;
esac
