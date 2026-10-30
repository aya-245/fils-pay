# Deploying FilsPay as containers

Images (build context is always the repo root):

| Image | Dockerfile | Purpose | Port |
|---|---|---|---|
| node (api / reporting / migrate / seed) | `ops/Dockerfile.node` | Node 22, `npm ci`, runs TS via tsx | 3000 (api) |
| settlement | `ops/Dockerfile.go` | static Go binary on distroless | 8091 |
| web / admin | `ops/Dockerfile.web` (`--build-arg APP=web\|admin`) | vite build served by nginx | 8080 |

## Local run

```
docker compose -f ops/docker-compose.yml up -d postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed      # dev/demo data only
docker compose -f ops/docker-compose.yml up api settlement reporting
```

Compose does NOT load `ops/.env.docker` automatically (no `env_file:`; compose only
auto-loads `.env` from the project dir `ops/`). Pass it explicitly with
`--env-file ops/.env.docker` for interpolation, or add `env_file:`. The api needs
`WEBHOOK_SECRET_ENCRYPTION_KEY` and, in production mode, `SETTLEMENT_INTERNAL_TOKEN`
and `ACQUIRER_CALLBACK_SIGNING_SECRET`; settlement `daemon` needs the same token.

## Build and push

```
docker build -f ops/Dockerfile.node -t $REGISTRY/filspay-node:$TAG .
docker build -f ops/Dockerfile.go   -t $REGISTRY/filspay-settlement:$TAG .
docker build -f ops/Dockerfile.web  --build-arg APP=web   --build-arg API_URL=https://api.example.com --build-arg WEB_URL=https://app.example.com -t $REGISTRY/filspay-web:$TAG .
docker build -f ops/Dockerfile.web  --build-arg APP=admin --build-arg API_URL=https://api.example.com --build-arg WEB_URL=https://app.example.com -t $REGISTRY/filspay-admin:$TAG .
docker push ...   # each image
```

API URLs are baked in at build time (`VITE_API_BASE_URL`, `VITE_ADMIN_API_BASE_URL`,
`VITE_WEB_BASE_URL`); rebuild per environment.

## Environment variables

api (`apps/api/src/config.ts`; reporting also needs `DATABASE_URL`):

- Required always: `DATABASE_URL`
- Required when `NODE_ENV=production`: `SETTLEMENT_INTERNAL_TOKEN`, `ACQUIRER_CALLBACK_SIGNING_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY` (base64 of exactly 32 bytes, e.g. `openssl rand -base64 32`)
- Service wiring: `SETTLEMENT_INTERNAL_URL` (default `http://settlement:8091`), `SETTLEMENT_INTERNAL_REQUEST_TIMEOUT_MS`, `CHECKOUT_BASE_URL` (default `http://localhost:5173`, set to the public web URL), `PORT` (3000), `NODE_ENV`
- Pool: `PG_POOL_MAX`, `PG_POOL_MIN`, `PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_CONNECTION_TIMEOUT_MS`
- Sessions/cookies: `COOKIE_NAME`, `COOKIE_SECURE`, `ADMIN_COOKIE_NAME`, `SESSION_TTL_HOURS`, `PENDING_SESSION_TTL_MINUTES`, `ADMIN_SESSION_TTL_HOURS`, `ADMIN_PENDING_SESSION_TTL_MINUTES`, `IMPERSONATION_COOKIE_NAME`, `IMPERSONATION_TTL_MINUTES`
- OTP: `OTP_TTL_MINUTES`, `OTP_CODE_LENGTH`, `OTP_MAX_ATTEMPTS`, `OTP_DEV_EXPOSE` (defaults true outside production; keep false in prod), `ADMIN_OTP_*`
- Argon2: `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`
- KYC: `KYC_UPLOAD_DIR` (default `./data/kyc`; mount a volume), `KYC_MAX_FILE_SIZE_BYTES`
- Webhooks: `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_BACKOFF_BASE_MS`, `WEBHOOK_BACKOFF_CAP_MS`, `WEBHOOK_POLL_INTERVAL_MS`, `WEBHOOK_REQUEST_TIMEOUT_MS`
- Acquirer simulator/callbacks: `ACQUIRER_LATENCY_MIN_MS`, `ACQUIRER_LATENCY_MAX_MS`, `ACQUIRER_FAILURE_RATE`, `ACQUIRER_RNG_SEED`, `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE`
- `PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS`

settlement (`apps/settlement/internal/config/config.go`):

- Required: `DATABASE_URL`, `SETTLEMENT_INTERNAL_TOKEN` (must equal the api's)
- Optional: `PGCONN_SETTLEMENT` (overrides DATABASE_URL when set; the code takes precedence over the older compose/README comments), `SETTLEMENT_PG_POOL_MAX_CONNS` (5), `SETTLEMENT_DAEMON_RUN_DELAY_MINUTES` (15), `SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS` (60), `SETTLEMENT_INTERNAL_PORT` (8091), `TZ`

migrate / seed: `DATABASE_URL` only.

## Order of operations

1. Postgres up and reachable.
2. `npm run migrate` (idempotent; tracks applied files).
3. `npm run seed` only for dev/demo. It resets and regenerates fixture tables; never run against production data.
4. Start settlement, then api, then reporting, then web/admin.

## Health checks

- api: `GET /healthz` (liveness), `GET /readyz` (200 once the boot-time DB connection succeeded; it does not re-check the DB later).
- settlement: no unauthenticated health route; every `/internal/*` route needs `Authorization: Bearer <token>`. Use a TCP check on 8091 (the distroless image has no shell for exec checks).
- reporting: no HTTP endpoint; monitor the process/logs.
- web/admin: `GET /` on 8080.

## Dilmune Cloud (generic; no vendor docs available, adapt names)

1. Create a registry repo and push the four images: `docker login <REGISTRY>`, tag, `docker push`.
2. Provision managed Postgres 16. Create a database and a role; use a TLS connection string (`sslmode=require` or `verify-full`) in `DATABASE_URL`.
3. Store secrets in the platform's secret store (not in the image or repo): `DATABASE_URL`, `SETTLEMENT_INTERNAL_TOKEN`, `ACQUIRER_CALLBACK_SIGNING_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY`. Set `NODE_ENV=production`, `CHECKOUT_BASE_URL=<public web URL>`, `SETTLEMENT_INTERNAL_URL=<internal settlement address>`.
4. Run a one-off job from the node image: `npm run migrate`. Wait for exit 0.
5. Deploy services: settlement (internal only, not publicly exposed, port 8091), api (public, port 3000, health `/healthz`, readiness `/readyz`), reporting (no port), web and admin (port 8080, put admin behind an access restriction).
6. Terminate TLS at the platform load balancer (cookies are Secure in production). Mount a persistent volume for `KYC_UPLOAD_DIR`.
7. Smoke test: `curl https://<api-host>/readyz`.
