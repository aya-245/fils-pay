# Hackademics — FilsPay Submission

| | |
|---|---|
| **Team** | Hackademics |
| **Members and ownership** | **Aya Ismail**: API, payments and FP-300 refunds (API, ledger, webhooks), auth and security hardening, checkout and dashboard UI. **Lamees Adel**: settlement and finance (Go service, fees, reconciliation, the money/CSV/sweep findings), hosting on Dilmune Cloud, capacity testing, findings report. |
| **Checkout** | https://168-144-92-39.sslip.io/pay/&lt;token&gt;. Demo link: {{DEMO_LINK}} |
| **Merchant dashboard** | https://168-144-92-39.sslip.io/dashboard |
| **Admin console** | https://admin.168-144-92-39.sslip.io |
| **Public API** | https://api.168-144-92-39.sslip.io (health: `/healthz`) |
| **Demo logins** | Merchant `owner@alpharetail.example` / `FilsPaySeed!2026`. Admin `finance@filspay.test` / `FilsPayAdminSeed!2026`. Demo accounts only: the OTP is shown on screen (see §2). |
| **Repository** | {{FORK_URL}} |
| **Last commit before the deadline** | {{LAST_COMMIT}} |

## 1. Summary

**What we found.** FilsPay reached us half-finished and deliberately misleading. We recorded **87 findings**
(10 Critical, 39 High, 35 Medium, 3 Low), plus 25 false agent instructions and one tampered commit.

- **Money bugs:**
  - a 2-decimal "cents" parser made CSV imports 10× too small;
  - the scheme file rounded half-up while the ledger truncated;
  - split payouts lost fils;
  - the balance button rebuilt from exported captures, not the ledger (135K → 7K);
  - MDR recalculation rewrote closed and paid batches.
- **Time bugs:** the daily close ran at 03:15 instead of midnight in Bahrain, and several windows used UTC days.
- **Concurrency bugs:** a payment link could be charged twice, concurrent refunds could pay out twice, and payout
  notifications were duplicated.
- **Security holes:**
  - login worked without the OTP, and could bind to another tenant's user;
  - one merchant could cancel another's link or refund another's payment;
  - links could be paid after expiry;
  - webhooks signed different bytes than they sent;
  - impersonation could write;
  - a reused idempotency key returned the wrong capture.
- **Unfinished feature:** FP-300 merchant refunds was a 501 stub over helpers that had seven bugs of their own.
- **Load-test findings:** missing indexes on the pay path, a phantom 500 on every POST, a Postgres restart that
  crashed the API, and no overload protection.
- **Hosting gaps:** the browser apps could not call the API (no CORS), and no one could log in in production
  (the OTP was delivered nowhere).

**What we fixed.** Every finding above, with the smallest change and a test. We finished FP-300 end to end:
API, ledger to the fil, proportional fee reversal, payout netting, webhook, timeline, reports and
reconciliation. The stack is hosted on one 1 vCPU / 2 GB server with TLS, resource limits, load shedding and
self-restart. Test suites at submission: TypeScript **533/533**, Go **67/67**.

**What we left alone.** We did not run any remediation against existing production data. Every finding that
left bad rows behind has a read-only detection query (`docs/sql/existing-data-checks.sql`) and a proposed
compensating action. We did not change the refund error body shape, the react-router major version, or the
reporting consumer's fail-stop behaviour. Each is explained in §4, "Decisions and open risks".

**The main root cause.** The system had **two sources of truth everywhere, and the wrong one was trusted.**
Instead of the ledger, the code trusted:
- the cache;
- the display schedule instead of the charge schedule;
- a UTC instant instead of the Bahrain business day;
- a client timestamp instead of the server clock;
- a cents parser instead of the fils rule.

The documentation that should have caught this (the AI instruction files, three ADRs, comments marked
"intentional", tests that asserted the bugs) reinforced the wrong one. We used the organisers' brief and
ADR-0001/0002 as the reference and treated everything else as a claim to verify.

## 2. Architecture and deployment

```
                    Internet
                       │  443/tcp (HTTPS, Let's Encrypt via Caddy, HSTS)       22/tcp (SSH, key only)
┌──────────────────────┼──────────────────────────────────────────────────────────────────────────┐
│ Dilmune Cloud VM "Hackademics" — DigitalOcean s-1vcpu-2gb, Ubuntu 24.04, 168.144.92.39          │
│                      ▼                                                                          │
│   caddy :443 ──┬── 168-144-92-39.sslip.io ───────► web    nginx :8080 ─┐ (static checkout +     │
│   0.25 cpu     │                                                         │  dashboard, /api proxy)│
│   64 MB        ├── admin.168-144-92-39.sslip.io ─► admin  nginx :8080 ─┤ (static admin, /api)    │
│                └── api.168-144-92-39.sslip.io ───────────────────────────┤                         │
│                                                                          ▼                         │
│                                  api  Node/Fastify :3000   0.5 cpu · 512 MB  (load shedding)      │
│                                          │                                                        │
│   settlement  Go daemon :8091 ◄── internal token ──┘   reporting  Node consumer                   │
│   0.25 cpu · 96 MB                                       0.25 cpu · 160 MB                          │
│          │                                                     │                                    │
│          └──────────────► postgres :5432 (compose network only, volume filspay_pgdata) ◄──┘        │
│                           768 MB, durability defaults kept                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
Direct ports 3000 / 8080 / 8081 remain published for compatibility; 5432 and 8091 are never published.
```

| Service | Port | Internet-facing | Limits | Health check | Restart |
|---|---|---|---|---|---|
| caddy | 443 (80) | yes | 0.25 cpu, 64 MB | — | always |
| web (checkout + dashboard) | 8080 | via Caddy (+ direct) | 0.25 cpu, 48 MB | smoke `/` and `/api/healthz` | always |
| admin | 8080 → 8081 | via Caddy (+ direct) | 0.25 cpu, 48 MB | smoke `/` | always |
| api | 3000 | via Caddy (+ direct) | **0.5 cpu, 512 MB**, heap 384 MB | `GET /healthz` every 10 s | always, tini PID 1 |
| reporting | — | no | 0.25 cpu, 160 MB | — | always |
| settlement | 8091 (internal) | no | 0.25 cpu, 96 MB | — | always, 60 s stop grace |
| postgres | 5432 (internal) | no | 768 MB | `pg_isready` every 2 s | always |

**One command to redeploy.**
```bash
scripts/env-keys.sh build keys ops/.env.prod      # assemble secrets by name; values are never printed
scripts/deploy-vm.sh dilmune@168.144.92.39 keys/dilmune_ssh
```
`deploy-vm.sh` does the following:
1. builds the four images locally, ships them over SSH and runs the migrations;
2. starts `api`, `reporting`, `web`, `admin`, then `caddy`, then `settlement` last;
3. records the deployed commit in `~/filspay/DEPLOYED_COMMIT`;
4. smoke-tests `/healthz`, the web `/api` proxy and admin.

Infrastructure as code: `ops/docker-compose.prod.yml` + `ops/docker-compose.tls.yml` + `ops/Caddyfile` +
`ops/Dockerfile.{node,go,web}` + `ops/nginx-web.conf.template`.

**Where secrets come from.** `openssl rand` generated `POSTGRES_PASSWORD`, `SETTLEMENT_INTERNAL_TOKEN`,
`ACQUIRER_CALLBACK_SIGNING_SECRET` and `WEBHOOK_SECRET_ENCRYPTION_KEY` (32 bytes, base64).
- **Storage:** they live in the git-ignored `keys/` folder on the deploy workstation.
- **Assembly:** `scripts/env-keys.sh` builds them into `ops/.env.prod` (mode 600), copies that to the server
  over SSH, and reads it through `env_file`.
- **Never in git or the AI's context:** the tool lists key *names* only, and `.claude/settings.json` denies
  the AI read access to `keys/` and `ops/.env.prod`.
- **Rotation:** the old `ops/.env.docker` with a committed signing secret was removed from git. That secret
  must be rotated because it remains in history (open risk).

**Health checks and restart policies.**
- **Every long-running service** has `restart: always`. Node processes run under `tini` (`init: true`), so a
  crash exits the container and Docker restarts it. Measured: `kill -9` of the API process, back in 1.3 s.
- **The API** has a `/healthz` container health check.
- **Postgres** has `pg_isready`, and the app services wait for it.
- **When Postgres restarts**, the API stays up and returns `503 + Retry-After` for about 4 s.
- **Overload** is answered with fast `503 overloaded` responses, not timeouts (§3).

**How a redeploy avoids interrupting a settlement run.**
1. `deploy-vm.sh` **refuses to run 00:00–00:45 Asia/Bahrain**, the nightly close window, unless `FORCE=1`.
2. `docker compose up -d` recreates **only services whose image or config changed**, and settlement is restarted
   **last**.
3. The daemon's SIGTERM handler cancels its context, and compose gives it a **60 s stop grace period**. Every
   batch operation is a **single Postgres transaction**, so an in-flight close either commits or rolls back.
   The next tick re-runs the day idempotently: closed batches are skipped and nothing is half-written.

**Demo login in production.** No email or SMS provider is wired in, so in production the OTP was generated and
delivered nowhere. `OTP_DEMO_EMAIL_DOMAINS` returns the code on screen only for seeded demo accounts. The
config rejects any domain outside the reserved `.example`, `.test`, `.invalid` and `.localhost` TLDs at boot, so
a real customer's code can never be exposed. Every other account keeps full two-factor login.
