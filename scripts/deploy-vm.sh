#!/usr/bin/env bash
# Deploy FilsPay to a plain Linux VM over SSH (Dilmune Cloud server or any Ubuntu box).
#
#   scripts/deploy-vm.sh <user@host> [ssh-key]          FORCE=1 to deploy inside the close window
#
# Needs locally: docker, ssh, ops/.env.prod (scripts/env-keys.sh build keys ops/.env.prod).
# On the VM it installs Docker if missing, loads the images built here, runs
# migrations once, then starts postgres, api, reporting, web, admin, settlement
# (and Caddy on 443 when WEB_HOST is set in ops/.env.prod).
#
# Settlement safety:
#  - refuses to run 00:00–00:45 Asia/Bahrain (the daemon closes the previous
#    business day just after midnight) unless FORCE=1;
#  - `docker compose up -d` only recreates services whose image/config changed;
#    settlement is (re)started last;
#  - if it is restarted mid-close anyway, SIGTERM cancels the daemon's context:
#    the in-flight CloseBatch transaction rolls back and the next tick re-runs
#    the day idempotently (closed batches are skipped, nothing is half-written).
set -euo pipefail

host=${1:?usage: deploy-vm.sh <user@host> [ssh-key]}
ssh_opts=(-o StrictHostKeyChecking=accept-new)
[[ -n ${2:-} ]] && ssh_opts+=(-i "$2")
root=$(cd "$(dirname "$0")/.." && pwd)
compose="$root/ops/docker-compose.prod.yml"
tls="$root/ops/docker-compose.tls.yml"
envfile="$root/ops/.env.prod"
images=(filspay-node:latest filspay-settlement:latest filspay-web:latest filspay-admin:latest)

[[ -f $envfile ]] || { echo "missing $envfile — run scripts/env-keys.sh build <keys-dir> ops/.env.prod"; exit 1; }
# Images are built from the working tree; refuse uncommitted changes so the
# recorded DEPLOYED_COMMIT is exactly what runs.
git -C "$root" diff --quiet HEAD -- || { echo "uncommitted changes: commit first (DEPLOYED_COMMIT must match the build)"; exit 1; }

bahrain_hm=$(TZ=Asia/Bahrain date +%H%M)
if [[ ${FORCE:-0} != 1 ]] && (( 10#$bahrain_hm < 45 )); then   # base 10: "0008" is not octal
  echo "refusing to deploy at $(TZ=Asia/Bahrain date +%H:%M) Asia/Bahrain: settlement closes the previous day 00:00-00:45. FORCE=1 to override."
  exit 1
fi

use_tls=0
grep -q '^WEB_HOST=.' "$envfile" && use_tls=1
files=(-f "$compose"); remote_files='-f docker-compose.prod.yml'
if [[ $use_tls == 1 ]]; then
  files+=(-f "$tls"); remote_files+=' -f docker-compose.tls.yml'
fi

remote() { ssh "${ssh_opts[@]}" "$host" "$@"; }

echo "== build images locally ($(git -C "$root" rev-parse --short HEAD))"
docker compose -f "$compose" --env-file "$envfile" build

echo "== prepare VM"
remote 'command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$USER")'
remote 'mkdir -p ~/filspay/ops && chmod 700 ~/filspay'

echo "== ship images (gzip over ssh)"
docker save "${images[@]}" | gzip | remote 'gunzip | sudo docker load'

echo "== ship compose + env"
scp "${ssh_opts[@]}" "$compose" "$host:~/filspay/ops/docker-compose.prod.yml"
if [[ $use_tls == 1 ]]; then
  scp "${ssh_opts[@]}" "$tls" "$root/ops/Caddyfile" "$host:~/filspay/ops/"
fi
scp "${ssh_opts[@]}" "$envfile" "$host:~/filspay/ops/.env.prod"
remote 'chmod 600 ~/filspay/ops/.env.prod'
git -C "$root" rev-parse HEAD | remote 'cat > ~/filspay/DEPLOYED_COMMIT'

dc="cd ~/filspay/ops && sudo docker compose $remote_files --env-file .env.prod"
echo "== migrate + start (only changed services are recreated)"
remote "$dc up -d --no-build postgres"
remote "$dc run --rm --no-deps migrate"
remote "$dc up -d --no-build api reporting web admin"
[[ $use_tls == 1 ]] && remote "$dc up -d --no-build caddy"
remote "$dc up -d --no-build settlement"
remote "$dc ps"
remote 'sudo docker image prune -f >/dev/null'

echo "== smoke"
remote 'curl -fsS http://localhost:3000/healthz && echo " api healthz ok"' || echo "api healthz FAILED — check: $dc logs api"
remote 'curl -fsS -o /dev/null http://localhost:8080/ && echo "web ok"' || echo "web FAILED — check: $dc logs web"
remote 'curl -fsS -o /dev/null http://localhost:8080/api/healthz && echo "web /api proxy ok"' || echo "web /api proxy FAILED"
remote 'curl -fsS -o /dev/null http://localhost:8081/ && echo "admin ok"' || echo "admin FAILED — check: $dc logs admin"
