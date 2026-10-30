#!/usr/bin/env bash
# Single-core CPU score, to scale the locally measured capacity to another box.
# Run it on the load-test workstation (pinned like the stack) AND on the server;
# capacity_on_server ~= capacity_measured * score_server / score_local.
#
#   ops/loadtest/cpu-calibrate.sh [cpuset]      # e.g. 11 locally, omit on the server
#
# Uses the filspay-node image that is already on both machines; CPU-only, no
# network, no disk, ~5 s. Run it while the server is otherwise idle.
set -euo pipefail
image=${IMAGE:-filspay-node:${FILSPAY_IMAGE_TAG:-latest}}
pin=()
[[ -n ${1:-} ]] && pin=(--cpuset-cpus "$1")
docker run --rm "${pin[@]}" --cpus 1 --entrypoint node "$image" -e '
const { createHash } = require("node:crypto");
function score() {
  // mixed JSON + hashing + allocation, roughly the API/PG-client mix
  const t0 = process.hrtime.bigint(); let n = 0;
  while (process.hrtime.bigint() - t0 < 1_000_000_000n) {
    const o = JSON.parse(JSON.stringify({ id: n, amountFils: 4750, items: [1, 2, 3, "x".repeat(64)] }));
    createHash("sha256").update(String(o.id)).digest("hex"); n++;
  }
  return n;
}
score(); const runs = [score(), score(), score()].sort((a, b) => a - b);
console.log(`cpu score (median ops/s, 1 core): ${runs[1]}`);
'
