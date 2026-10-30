# FilsPay capacity: checkout load test

Measured 2026-10-30. Everything below can be reproduced with `ops/loadtest/` (see [Reproduce](#reproduce)).

## The estimate

> **About 120 concurrent checkout users** (each doing create link, open link, pay, then 1 s of think time).
> That is **about 70-75 completed checkouts per second** (about 220 API requests/s). All thresholds hold at that load:
> pay p95 0.78 s, checkout p95 0.78 s, 0% errors, under 1% shed.
>
> - **The ceiling is set on purpose.** `API_MAX_INFLIGHT_PAY=40` pays are in flight at once, plus up to 40 more waiting at most 200 ms.
> - **Past the ceiling,** extra pays get `503 {"error":"overloaded"}` with `Retry-After: 1` in about 200 ms. They do not queue up or time out.
> - **Without think time** the same ceiling is about 40-45 concurrent users.
>   In general, `users ≈ 72/s × (checkout time ≈ 0.55 s + think time)`.

Two things can lower these numbers on the real server. Neither was measured here:

1. **A slower CPU core.** At the ceiling the stack used about 60% of one local core. See the CPU section below.
2. **TLS in Caddy** (`ops/docker-compose.tls.yml`, `cpus: 0.25`). The test traffic went straight to the API, or through the web nginx over plain HTTP.

## Scenario (`ops/loadtest/checkout.js`)

Each k6 virtual user loops through one checkout:

| Step | Request | Expected |
|---|---|---|
| 1. Merchant creates the link | `POST /v1/merchants/:id/payment-links`, Bearer API key, 4.750 BD | 201 + token |
| 2. Buyer opens the hosted checkout | `GET /v1/payment-links/:token` | 200, amount matches |
| 3. Buyer pays with the approved test card `4242…` | `POST /v1/payment-links/:token/pay`, Idempotency-Key | 200 `paid`, amount matches |
| 4. Think time | `sleep(1)` | |

Every response is put in exactly one class:

| Class | Meaning |
|---|---|
| ok | Expected status and a correct body |
| declined | 402/502: the acquirer simulator's 2% `ACQUIRER_FAILURE_RATE` (a valid business answer) |
| shed | 503 + Retry-After / 429 / 409 `payment_link_processing` |
| error | Anything else, including status 0 (timeout, connection reset) and wrong bodies |

The thresholds that define "fast and correct":

- create and get p95 < 500 ms
- pay p95 < 1000 ms
- whole checkout p95 < 1500 ms
- errors < 1%, shed < 1%

Pay has a latency floor of its own. The simulator sleeps 100-400 ms for authorize and again for capture (`ACQUIRER_LATENCY_MIN/MAX_MS`, defaults left unchanged). That puts pay p50 at about 500 ms and p95 at about 705 ms even with zero server time. No API that keeps the simulator honest can meet "p95 < 500 ms" on the pay step.

## Hardware and limits

The target is one server with 1 vCPU and 2 GB RAM. The API is limited to 0.5 vCPU and 512 MB.

Local emulation used the same `ops/docker-compose.prod.yml` with `ops/loadtest/compose.1vcpu.yml` on top:

- **All on one core.** Every container (postgres, api, reporting, settlement, web, admin) is pinned to one physical core (`cpuset`) of an Intel i5-12400F (4.4 GHz).
- **Same caps as production.** The per-container limits from the prod file still apply:

  | Service | CPU | Memory |
  |---|---|---|
  | api | 0.5 | 512 MB (`--max-old-space-size=384`) |
  | postgres | uncapped | 768 MB (shared_buffers 256 MB, max_connections 110) |
  | reporting | 0.25 | 160 MB |
  | settlement | 0.25 | 96 MB |
  | web / admin | 0.25 each | 48 MB each |

- **k6 kept off that core.** k6 ran in Docker on other cores, on the compose network (`http://api:3000`).
- **Fresh data.** The database was migrated and seeded from scratch before the final series.

API settings for the run, which are also the prod compose defaults:

- `PG_POOL_MAX=88`
- `API_MAX_INFLIGHT_PAY=40`, `API_PAY_QUEUE_MAX=40`, `API_PAY_QUEUE_WAIT_MS=200`
- `API_MAX_INFLIGHT=300`
- `API_SHED_EVENT_LOOP_DELAY_MS=250`
- `PG_POOL_CONNECTION_TIMEOUT_MS=1500`, `PG_STATEMENT_TIMEOUT_MS=15000`

## Results (final series, constant VUs: 10 s ramp, 45 s hold, 5 s ramp-down)

The req/s and checkouts/s columns are averaged over the whole 61 s run, ramps included. Steady-state rates during the hold are about 15% higher.

| VUs | req/s | paid checkouts/s | checkout p50 / p95 / p99 (ms) | create p95 | get p95 | pay p95 | error % | shed % | api CPU | pg CPU |
|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 20 | 34.8 | 11.0 | 504 / 719 / 780 | 4 | 2 | 716 | 0 | 0 | 5% | 8% |
| 60 | 103.8 | 33.2 | 510 / 717 / 776 | 5 | 2 | 713 | 0 | 0 | 13% | 19% |
| 100 | 171.5 | 55.0 | 523 / 732 / 788 | 9 | 3 | 727 | 0 | 0 | 18% | 32% |
| **120** | **200.2** | **63.9** | **560 / 783 / 855** | 10 | 3 | **777** | **0** | **0.10** | 22% | 37% |
| 140 | 226.7 | 65.8 | 663 / 891 / 957 | 11 | 3 | 881 | 0 | 9.6 | 19% | 36% |
| 160 | 263.0 | 65.6 | 688 / 910 / 977 | 15 | 4 | 891 | 0 | 22.2 | 21% | 37% |
| 360 (3x) | 502.8 | 52.5* | 743 / 1045 / 1157 | 63 | 27 | 913 | **0** | 67.5 | 27% | 45% |

\* The 360 VU run held 360 VUs for 60 s, then dropped to 60 VUs for 40 s to measure recovery.

What the table shows:

- Successful checkouts stop growing after about 120 VUs (65.8/s, then 65.6/s). That flat line is the pay cap at work.
- Above 120 VUs, the extra load turns into shed responses, not errors: 0 errors at every level, even 3x.
- Latency for admitted requests stays under the thresholds up to 160 VUs.

Through the web nginx `/api` proxy, which is the path browsers use, at 100 VUs:

- checkout p95 770 ms, versus 732 ms direct
- create p95 19 ms, versus 9 ms
- 0.3% shed, 0 errors
- nginx used about 2% CPU

The proxy opens a new upstream connection per request, which costs a little.

## Bottleneck and why

1. **Database connections on the pay path, by design.** `paymentLinks/pay.ts` holds the payment link row lock (`FOR UPDATE`) on one pooled connection, for the whole authorize and capture sequence. `authorizeTransaction` and `captureTransaction` each open their own `withTransaction`, which holds a second connection during each acquirer call. So every pay in flight ties up 2 connections for about 0.55 s.

   This made pool size a hard limit:
   - The old pool (`max: 5`) allowed 3 lock holders, which left only 2 connections free for authorize and capture.
   - Throughput was therefore about 2 / 0.55 s ≈ 4 pays/s, whatever the CPU.
   - Every other request queued behind the same 2 connections.

   Now `PG_POOL_MAX=88` and the load-shedding pay cap of 40 guarantee each admitted pay its two connections: 40 × 2 = 80, plus 8 spare for reads. Throughput is about 40 / 0.555 s ≈ 72 pays/s.

2. **CPU.** At the ceiling the whole stack used about 60% of the pinned core (postgres about 37%, api about 22%). So locally the cap binds before CPU does. The cap was kept at 40 rather than raised to about 44, which measured CPU-bound. That leaves room for a slower server core.

3. **Memory is not a constraint.**
   - api RSS is 57-83 MB.
   - postgres peaks at 570 MB: about 290 MB of backends, the 200 MB of shared_buffers it actually touched, and the rest reclaimable page cache. There were 0 OOM events.
   - reporting uses about 50 MB.

### Bugs found by the load test (all fixed)

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Postgres CPU doubled within 15 min at the same load (23% → 49% at 40 VUs). Capacity dropped from 80 to about 60 VUs as data grew. | Missing indexes on the per-pay hot path (found with `pg_stat_statements`). The deferred trigger `check_ledger_group_balance` runs `SUM … WHERE entry_group_id = ?` for each inserted ledger row (2-4 per capture) with no index: a full scan, 9.7 ms each at about 25k rows. Also: `UPDATE holds … WHERE transaction_id`, `ledger_entries … WHERE transaction_id`, and the pay crash-recovery lookup `key LIKE 'paylink:<id>:%'`. That LIKE cannot use the UNIQUE btree under the en_US.utf8 collation, so it took 50 ms at 2k keys per merchant. | `db/migrations/0083_pay_hot_path_indexes.sql`, indexes only: the LIKE went from 50 ms to 0.1 ms, and postgres CPU at 40 VUs from 54% to 16%. Load no longer degrades as tables grow. |
| 2 | Every POST that calls `reply.send()` without `return reply` (create link, pay, …) logged `ERR_HTTP_HEADERS_SENT` plus a phantom 500 after the real 201/200: 7k error log lines per run. | With two async `onSend` hooks (load shedding and securityHeaders), Fastify's `wrapThenable` sees the async handler resolve while `reply.sent` is still false, and sends a second time. | Both hooks are now callback-style. There is a regression test in `plugins/loadShedding.new.test.ts`. |
| 3 | Restarting Postgres under load crashed the API (`uncaughtException: terminating connection due to administrator command`). Docker restarted it about 1.5 s later. | pg-pool removes its idle `'error'` listener while a client is checked out. The pay link-lock connection sits idle between queries during the acquirer call, so the backend's termination was emitted with no listener. | `db/pool.ts` attaches an error listener per client on `connect`. The query still fails (503) and pg-pool discards the dead client on release. A Postgres restart no longer restarts the API. |
| 4 | During the Postgres restart, 10 requests returned 500. | `getaddrinfo EAI_AGAIN postgres`: the container's DNS name is briefly gone. | EAI_AGAIN and ENOTFOUND added to the transient DB errors, which map to 503. |

## Behaviour past the limit

- **Shedding, not queueing.** `apps/api/src/plugins/loadShedding.ts` has three gates. When one trips, the response is `503 {"error":"overloaded"}` with `Retry-After: 1`:
  - **Pay cap:** 40 in flight, at most 40 waiting for up to 200 ms.
  - **Global in-flight cap:** 300 requests.
  - **Event-loop lag:** shed when p90 lag exceeds 250 ms, which detects CPU starvation under the 0.5 vCPU quota.

  `/healthz` and `/readyz` are never shed. A pool checkout that waits longer than 1.5 s, a statement over 15 s, or Postgres being down also give 503 (from `errorHandler.ts`), not 500.
- **Measured at 3x capacity (360 VUs, about 830 req/s offered):**
  - About 25% of requests, the excess pays, got 503 with p95 203 ms.
  - 0 errors and 0 server-side 500s.
  - Admitted pays had p95 913 ms. Successful checkouts stayed at the ceiling.
  - The API was never restarted and stayed healthy.
- **Recovery after load drops:** immediate. In the first 5 s bucket after dropping to 60 VUs there were 0 shed and 0 failed, and ok p95 was 704 ms (`ops/loadtest/timeline.py`).

| t (s) | reqs / 5 s | ok | shed | fail | ok p95 (ms) |
|---:|---:|---:|---:|---:|---:|
| 10-65 (360 VUs) | ~4100 | ~3080 | ~1045 | 0 | 790-830 |
| 70 (ramp down) | 2941 | 2290 | 651 | 0 | 820 |
| 75 (60 VUs) | 674 | 674 | 0 | 0 | 704 |

## Crash and restart (100 VUs, chaos run `chaos2`)

**API crash: `kill -9` of the node process inside the api container at t = 30 s.**

- The container runs tini as PID 1 (`init: true`), so the kill takes the container down and Docker's restart policy (`restart: always`) brings it back.
- `/healthz` failed at 30.32 s and was back at 31.61 s: **1.3 s to restart**.
- In the 30-32 s window, 153 requests that were in flight at the kill failed with connection reset. That cannot be avoided for a hard kill.
- 48 requests got 503 while the restarted process warmed up its pool.
- From 34 s on, traffic was normal: p95 740 ms.
- **`docker kill` does NOT trigger the restart policy.** Docker treats it as a manual stop (verified: `exit=137, restarts=0, status=exited`). A real crash (OOM, fatal exception, killed process) does trigger it. The API now exits with code 1 after logging any `uncaughtException` or `unhandledRejection`, so Docker restarts a clean process.

**Postgres restart at t = 70 s (`docker restart`, about 0.7 s).**

- The API stayed up: restart count unchanged.
- 101 requests got 503 `overloaded` / `database busy`.
- 10 requests got a DNS 500, fixed as bug 4 above.
- Normal again within about 4 s, as the pool replaces dead clients by itself.

**Graceful stop (SIGTERM).** The dispatcher stops, `app.close()` waits for in-flight requests (open pay transactions commit or roll back), and then the pool drains. An 8 s hard deadline sits inside Docker's 10 s `stop_grace_period`.

## Integrity after all runs (`scripts/integrity-check.ts`, read-only)

The check ran on the load database after every final-series run, the 3x overload, both chaos runs (2 api kills, 2 postgres restarts) and the nginx run. That is 61,256 paid links, 63,320 captured transactions (the extras are seed data) and 266,908 ledger rows.

| Check | Result |
|---|---|
| Every ledger entry group nets to 0 | PASS |
| No payment link has more than one captured transaction (no double charge) | PASS |
| A paid link points at the transaction its pay flow captured | PASS |
| Every paid link's transaction is captured for the link amount, for the right merchant | PASS |
| One gross capture journal per pay-link transaction | PASS |
| `refunded_fils <= captured_fils` | PASS |
| `merchant_balances` cache equals ledger `merchant_payable` | WARN before, PASS `--strict-cache` after `settlement rebuild-balances`. The cache is refreshed by settlement, not on every capture, so it lags between refreshes by design. |
| **All 60,945 pays the client saw as `200 paid` are committed, captured and linked** | **PASS: no acknowledged write was lost** |
| Captured but link not finalized | 3 WARN, then healed |

About those 3 links: each api kill or Postgres restart landed between the capture COMMIT and the link-finalize COMMIT. Those clients got a connection reset, never a 200. Re-POSTing pay with a new Idempotency-Key returned `200 paid` with the **same** transaction id each time: pay.ts's crash recovery finalized against the existing capture and charged nothing new. The check was then all PASS.

## Capacity on the real server (calibration)

The local core is fast. At the ceiling the stack used about 60% of it, so:

- **If the server's single core is at least about 60% as fast,** the numbers above should hold. The binding limit stays the pay cap, not CPU.
- **On a slower core** the stack becomes CPU-bound. Scale throughput by the ratio of CPU scores (below), and lower `API_MAX_INFLIGHT_PAY` (with `PG_POOL_MAX ≥ 2 × cap + 8`) so that extra load is shed rather than slowing down every admitted pay.

To get the scores, run this on the server while it is idle:

```bash
ops/loadtest/cpu-calibrate.sh        # local reference, pinned to core 11: 700065 ops/s
```

TLS in Caddy (0.25 CPU) is not included. If the external load tester opens a new TLS connection per request, Caddy's handshakes could become the limit before the API does.

## Reproduce

Full instructions are in `ops/loadtest/README.md`. In short:

```bash
dc="docker compose -p filspay-load -f ops/docker-compose.prod.yml -f ops/loadtest/compose.1vcpu.yml --env-file /tmp/load.env"
$dc build
$dc up -d postgres
$dc run --rm --no-deps migrate
$dc run --rm --no-deps migrate npm run seed > /tmp/seed.out
$dc up -d api settlement reporting web admin
export MERCHANTS=$(ops/loadtest/merchants.sh /tmp/seed.out)
LOG_PAID=1 OUT=/tmp/lt ops/loadtest/run.sh v120 10s:120,45s:120,5s:0
LOG_PAID=1 OUT=/tmp/lt ops/loadtest/run.sh over 10s:360,60s:360,5s:60,40s:60,5s:0 --out csv=/out/ts-over.csv
python3 -I ops/loadtest/timeline.py /tmp/lt/ts-over.csv 5
ENV_FILE=/tmp/load.env IMAGE=filspay-node:load ops/loadtest/integrity.sh /tmp/lt/k6-*.log
$dc down -v
```
