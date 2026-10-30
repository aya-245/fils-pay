# Load test: fixed checkout scenario

`checkout.js` is a k6 script. Each virtual user (VU) repeats one checkout:

1. The merchant creates a payment link with its API key: `POST /v1/merchants/:id/payment-links` (4.750 BD).
2. The buyer opens it: `GET /v1/payment-links/:token`.
3. The buyer pays with the approved test card `4242424242424242`: `POST /v1/payment-links/:token/pay`.
4. The VU waits 1 s (`THINK_S`) and starts the next checkout.

Every response falls into one of these classes:

| Class | Responses |
|---|---|
| ok | Correct status and a correct body (`status: paid`, the right amount) |
| declined | 402/502 from the simulator's 2% `ACQUIRER_FAILURE_RATE` |
| shed | 503 with Retry-After, 429, or 409 `payment_link_processing` |
| error | Anything else, including timeouts |

The thresholds are:

- p95 < 500 ms for create and get.
- p95 < 1000 ms for pay. Two simulated acquirer calls of 100-400 ms each put the floor near 705 ms.
- p95 < 1500 ms for the whole checkout.
- errors < 1% and shed < 1%.

Results and the capacity estimate are in `docs/CAPACITY.md`.

## Files

| File | Purpose |
|---|---|
| `checkout.js` | The k6 scenario (env vars are documented at the top of the file) |
| `run.sh <tag> <stages>` | Runs it with the `grafana/k6` image, writes `summary-<tag>.json` and `k6-<tag>.log` |
| `compose.1vcpu.yml` | Overlay that pins the whole stack onto ONE host core to emulate the 1 vCPU server |
| `merchants.sh <seed.out>` | Prints `MERCHANTS` (merchant ids joined with their seeded API keys) |
| `integrity.sh [k6 logs]` | Runs `scripts/integrity-check.ts` (read-only) against the stack's DB |
| `cpu-calibrate.sh` | Single-core CPU score, used to scale results between machines |

## Exact local reproduction (prod-like, same limits)

Run these from the repo root. Use a throwaway env file. Never point this at the live DB.

```bash
cp ops/.env.example /tmp/load.env    # then fill it in. Must include:
#   NODE_ENV=production  POSTGRES_PASSWORD=...  DATABASE_URL=postgres://filspay:<pw>@postgres:5432/filspay?sslmode=disable
#   SETTLEMENT_INTERNAL_TOKEN=... SETTLEMENT_INTERNAL_URL=http://settlement:8091
#   ACQUIRER_CALLBACK_SIGNING_SECRET=... WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
#   CHECKOUT_BASE_URL=http://localhost:18080
#   FILSPAY_ENV_FILE=/tmp/load.env FILSPAY_IMAGE_TAG=load
#   API_HOST_PORT=13000 WEB_HOST_PORT=18080 ADMIN_HOST_PORT=18081
dc="docker compose -p filspay-load -f ops/docker-compose.prod.yml -f ops/loadtest/compose.1vcpu.yml --env-file /tmp/load.env"
$dc build
$dc up -d postgres
$dc run --rm --no-deps migrate
$dc run --rm --no-deps migrate npm run seed | tee /tmp/seed.out
$dc up -d api settlement reporting web admin

export MERCHANTS=$(ops/loadtest/merchants.sh /tmp/seed.out)   # "merchantId:apiKey,..." from the seed output

# one constant level: 10 s ramp, 45 s hold
LOG_PAID=1 OUT=/tmp/lt ops/loadtest/run.sh v100 10s:100,45s:100,5s:0
# through the web nginx (what browsers use): BASE_URL=http://web:8080/api
# overload (3x capacity): ops/loadtest/run.sh over 10s:400,60s:400,30s:40,30s:40,5s:0

ENV_FILE=/tmp/load.env IMAGE=filspay-node:load ops/loadtest/integrity.sh /tmp/lt/k6-*.log
$dc down -v
```

`compose.1vcpu.yml` pins every container to core `LOADTEST_CPU` (default 11), and `run.sh` keeps k6 on cores 0-7 (`K6_CPUS`). The API still has its own `cpus: 0.5` / `mem_limit: 512m` caps from the prod file.

## Against the live server

You can point the same scenario at a deployed box, from another machine:

```bash
NETWORK=host BASE_URL=http://<server>:3000 MERCHANTS=... ops/loadtest/run.sh live-20 10s:20,45s:20,5s:0
```

This creates real payment links and transactions in that database. Keep it to low levels, and run it only when you mean to.
