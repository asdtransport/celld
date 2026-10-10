#!/usr/bin/env bash
# flock-guarded, signal-managed launcher (WorkIQ devkit).
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"
LOCK="local/.run.lock"; PIDF="local/.server.pid"; PORT="${PORT:-8787}"
exec 9>"$LOCK"
if ! flock -n 9; then echo "[lock] another instance holds $LOCK — refusing to double-start"; exit 1; fi
cleanup(){ kill -TERM "$CHILD" 2>/dev/null || true; wait "$CHILD" 2>/dev/null || true; rm -f "$PIDF"; }
trap cleanup INT TERM EXIT
PORT="$PORT" bun run src/index.ts & CHILD=$!
echo "$CHILD" > "$PIDF"
echo "[lock] acquired $LOCK — pid $CHILD on :$PORT"
wait "$CHILD"
