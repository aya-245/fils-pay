DEPLOY DONE: http://168.144.92.39:3000 (API) · http://168.144.92.39:8080 (web) · http://168.144.92.39:8081 (admin)

# Deploy — Dilmune Cloud

Verified 2026-10-30 ~16:00: all 71 migrations applied, seed passed all REAL assertions, `/healthz`, :8080 and :8081
return 200 from outside, and all 6 containers are up. Settlement daemon processed 7 merchants.
The seed prints the seeded merchants' API keys to stdout. They are demo keys on a public server, so treat them as
disposable.

## Live URLs
| Service | URL |
|---|---|
| API | http://168.144.92.39:3000 (health: `/healthz`) |
| Merchant web / checkout | http://168.144.92.39:8080 |
| Admin | http://168.144.92.39:8081 |

## Server
- Dilmune Cloud server `Hackademics` (id `85faff30-505a-4ea2-bc9a-7ce4ef7d75ff`), DigitalOcean blr1,
  `s-1vcpu-2gb`, Ubuntu 24.04.5 LTS. SSH user is `dilmune`, with passwordless sudo.
- Created in the Dilmune portal. The Free plan refuses `create_server` over the API ("managed servers require
  Builder"). It was renamed to `Hackademics` through the MCP `update_server_settings`.
- SSH: account key `filspay-deploy` is authorized on the server. The private key stays on the deploy workstation
  at `keys/dilmune_ssh` (gitignored, never committed).
- Firewall (ufw via Dilmune, Free cap is 5 rules): 22, 443, 3000, 8080, 8081. The default port 80 rule was removed
  to make room for 8081.

## Steps that were run
1. Generate secrets into `keys/prod-generated.env` with `openssl rand`: POSTGRES_PASSWORD,
   SETTLEMENT_INTERNAL_TOKEN, ACQUIRER_CALLBACK_SIGNING_SECRET, and WEBHOOK_SECRET_ENCRYPTION_KEY (base64 32 bytes).
   DATABASE_URL points at the compose `postgres` service, SETTLEMENT_INTERNAL_URL=`http://settlement:8091`, and
   the public URLs are built from the IP.
2. `scripts/env-keys.sh check keys` and then `scripts/env-keys.sh build keys ops/.env.prod`. The resulting file
   is mode 600 and gitignored.
3. `scripts/deploy-vm.sh dilmune@168.144.92.39 keys/dilmune_ssh` builds the images locally, ships them over ssh,
   runs `migrate`, starts postgres, api, settlement, reporting, web and admin, then runs a smoke check.
4. Seed once:
   `ssh -i keys/dilmune_ssh dilmune@168.144.92.39 'cd ~/filspay/ops && sudo docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --no-deps migrate npm run seed'`

## Redeploy / operate
- Redeploy: rebuild `ops/.env.prod` if the keys changed, then re-run step 3. Postgres data lives in the
  `filspay_pgdata` volume and survives a redeploy.
- Logs: `ssh … 'cd ~/filspay/ops && sudo docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api'`
- **The seed truncates tables (OPS-7).** Never re-run it against data you want to keep.

## Known trade-offs (demo deployment)
- Plain HTTP only, with no TLS or domain (custom SSL is blocked on the Free plan). That is why
  `COOKIE_SECURE=false` is set; without it, browsers drop the session cookie over http. Put a domain and TLS in
  front and remove that line before handling real merchants.
- `OTP_DEV_EXPOSE` keeps its production default of off.
- Postgres is not published on the host. It is reachable only on the compose network.
