#!/usr/bin/env bash
# Build MERCHANTS ("merchantId:apiKey,...") for checkout.js from the seed
# output and the stack's postgres container.
#
#   export MERCHANTS=$(ops/loadtest/merchants.sh /tmp/seed.out [postgres-container])
#
# The seed prints "seed: issued API key for <name>: <key>" twice (generate +
# self-verify re-run); the last line per merchant is the live key.
set -euo pipefail
seed=${1:?usage: merchants.sh <seed-output> [postgres-container]}
pg=${2:-filspay-load-postgres-1}
declare -A key
while IFS= read -r line; do
  name=${line#seed: issued API key for }
  key[${name%: *}]=${name##*: }
done < <(grep '^seed: issued API key for ' "$seed")
out=()
while IFS='|' read -r name id; do
  [[ -n ${key[$name]:-} ]] && out+=("$id:${key[$name]}")
done < <(docker exec "$pg" psql -U filspay -d filspay -Atc "select display_name, id from merchants")
(IFS=,; echo "${out[*]}")
