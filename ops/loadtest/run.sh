#!/usr/bin/env bash
# Run the fixed checkout scenario with the grafana/k6 docker image.
#
#   ops/loadtest/run.sh <tag> <stages> [extra k6 args...]
#
# Env:
#   MERCHANTS   required: "merchantId:apiKey,..." (seeded keys, see README)
#   NETWORK     docker network to join (default filspay-load_default). Use
#               "host" together with BASE_URL=http://<server>:3000 for a remote box.
#   BASE_URL    default http://api:3000 (in-network); http://web:8080/api = via nginx
#   OUT         directory for summary-<tag>.json and k6-<tag>.log (default ./loadtest-out)
#   K6_CPUS     cpuset for the k6 container so it never steals the stack's core (default 0-7)
#   THINK_S, AMOUNT_FILS, LOG_PAID, TIMEOUT: passed through to checkout.js
set -euo pipefail
tag=${1:?usage: run.sh <tag> <stages>}
stages=${2:?usage: run.sh <tag> <stages e.g. 30s:10,60s:10,10s:0>}
shift 2
here=$(cd "$(dirname "$0")" && pwd)
out=${OUT:-$PWD/loadtest-out}
mkdir -p "$out"
chmod 777 "$out"
: "${MERCHANTS:?set MERCHANTS=merchantId:apiKey,...}"

docker run --rm -i \
  --network "${NETWORK:-filspay-load_default}" \
  --cpuset-cpus "${K6_CPUS:-0-7}" \
  -v "$here:/scripts:ro" -v "$out:/out" \
  -e MERCHANTS -e TAG="$tag" -e STAGES="$stages" \
  -e BASE_URL="${BASE_URL:-http://api:3000}" \
  -e THINK_S="${THINK_S:-1}" -e AMOUNT_FILS="${AMOUNT_FILS:-4750}" \
  -e LOG_PAID="${LOG_PAID:-0}" -e TIMEOUT="${TIMEOUT:-10s}" \
  grafana/k6:latest run --quiet "$@" /scripts/checkout.js 2>&1 | tee "$out/k6-$tag.log"
