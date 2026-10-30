#!/usr/bin/env bash
# Run scripts/integrity-check.ts inside the filspay-node image on the stack's
# network (read-only; safe while traffic is running).
#
#   ops/loadtest/integrity.sh [k6-log-with-LOG_PAID=1 ...] [--strict-cache]
#
# Env: NETWORK (default filspay-load_default), DATABASE_URL (default: read
# from ENV_FILE, default ops/.env.prod), IMAGE (default filspay-node:latest).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
env_file=${ENV_FILE:-$root/ops/.env.prod}
db=${DATABASE_URL:-$(grep -E '^DATABASE_URL=' "$env_file" | cut -d= -f2-)}
args=() mounts=()
i=0
for a in "$@"; do
  if [[ -f $a ]]; then
    mounts+=(-v "$(cd "$(dirname "$a")" && pwd)/$(basename "$a"):/in/$i.log:ro")
    args+=(--paid-log "/in/$i.log")
    i=$((i + 1))
  else
    args+=("$a")
  fi
done
docker run --rm --network "${NETWORK:-filspay-load_default}" \
  -e DATABASE_URL="$db" \
  -v "$root/scripts:/app/scripts-check:ro" "${mounts[@]}" \
  --entrypoint node "${IMAGE:-filspay-node:latest}" \
  --import tsx /app/scripts-check/integrity-check.ts "${args[@]}"
