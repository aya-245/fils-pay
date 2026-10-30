#!/usr/bin/env bash
# Deploy FilsPay to a plain Linux VM over SSH (Dilmune Cloud server or any Ubuntu box).
#
#   scripts/deploy-vm.sh <user@host> [ssh-key]
#
# Needs locally: docker, ssh, ops/.env.prod (scripts/env-keys.sh build keys ops/.env.prod).
# On the VM it installs Docker if missing, loads the images built here, runs
# migrations once, then starts postgres, api, settlement, reporting, web, admin.
# Set PUBLIC_API_URL / PUBLIC_WEB_URL (e.g. http://<vm-ip>:3000) before running so
# the static web/admin bundles point at the right API.
set -euo pipefail

host=${1:?usage: deploy-vm.sh <user@host> [ssh-key]}
ssh_opts=(-o StrictHostKeyChecking=accept-new)
[[ -n ${2:-} ]] && ssh_opts+=(-i "$2")
root=$(cd "$(dirname "$0")/.." && pwd)
compose="$root/ops/docker-compose.prod.yml"
envfile="$root/ops/.env.prod"
images=(filspay-node:latest filspay-settlement:latest filspay-web:latest filspay-admin:latest)

[[ -f $envfile ]] || { echo "missing $envfile — run scripts/env-keys.sh build <keys-dir> ops/.env.prod"; exit 1; }
remote() { ssh "${ssh_opts[@]}" "$host" "$@"; }

echo "== build images locally"
docker compose -f "$compose" --env-file "$envfile" build

echo "== prepare VM"
remote 'command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker "$USER")'
remote 'mkdir -p ~/filspay/ops && chmod 700 ~/filspay'

echo "== ship images (gzip over ssh)"
docker save "${images[@]}" | gzip | remote 'gunzip | sudo docker load'

echo "== ship compose + env"
scp "${ssh_opts[@]}" "$compose" "$host:~/filspay/ops/docker-compose.prod.yml"
scp "${ssh_opts[@]}" "$envfile" "$host:~/filspay/ops/.env.prod"
remote 'chmod 600 ~/filspay/ops/.env.prod'

dc='cd ~/filspay/ops && sudo docker compose -f docker-compose.prod.yml --env-file .env.prod'
echo "== migrate + start"
remote "$dc up -d --no-build postgres"
remote "$dc run --rm --no-deps migrate"
remote "$dc up -d --no-build api settlement reporting web admin"
remote "$dc ps"
remote 'sudo docker image prune -f >/dev/null'

echo "== smoke"
remote 'curl -fsS http://localhost:3000/healthz && echo " api healthz ok"' || echo "api healthz FAILED — check: $dc logs api"
