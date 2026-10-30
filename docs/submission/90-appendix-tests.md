# Test results and existing-data checks

## Test suites (fresh database: reset → `npm run migrate` → `npm run seed`, one shared DB, sequential)

| Suite | Command | Result |
|---|---|---|
| API (apps/api) | `npm test` | **441 / 441** |
| Money (packages/money) | `npm test` | **40 / 40** |
| Web (apps/web) | `npm test` | **21 / 21** |
| Reporting (apps/reporting) | `npm test` | **17 / 17** |
| Admin (apps/admin) | `npm test` | **6 / 6** |
| Events (packages/events) | `npm test` | **4 / 4** |
| Scripts | `npm test` | **4 / 4** |
| **TypeScript total** | `npm test` | **533 / 533, 0 failed** |
| Typecheck | `npm run typecheck` | 0 errors |
| Go settlement | `go test -p 1 ./...` with `DATABASE_URL` | **67 / 67**, all packages `ok`, `go vet` clean (the one seeded-fixture test was run against the seeded DB, not skipped) |

**Changes made after the full run.** The review fixes that followed (session rotation gated by config, login input
bounds, pay-route matching, checkout messages) were each re-run with their affected suites:

| Suites re-run | Result |
|---|---|
| auth, admin, app and payment-link routes, plus the new hardening tests | 100 / 100 and 86 / 86 |
| web | 21 / 21 |
| typecheck | clean |

**Existing tests we changed because they asserted a bug.** Each is listed in its finding in §4. Examples:
- `adminAdjustmentImport.test.ts` expected 600 fils for 6.000 BD;
- `currentFeeScheduleDisplay.test.ts` expected 245 bps;
- `webhooks.test.ts` expected a new delivery id on replay;
- `recalculate_mdr_test.go` expected a closed batch to be rewritten;
- `dashboard.test.ts` expected UTC day boundaries.

No assertion was weakened.

## End-to-end and integrity

| Check | Evidence | Result |
|---|---|---|
| FP-300 refund flow against the running API and Go settlement | `docs/audit/fp300-e2e.md` | ledger nets 0; fee reversed 68 + 157 = 225 = fee charged; batch net 4.888 BD |
| Demo: full and partial refund through the UI and the settlement close | `docs/ui/DEMO.md`, `docs/ui/demo/` | net 24.193 BD = 65.500 − 1.474 − (40.750 − 0.917); reconciliation gap 0.000 |
| Integrity after load and kill tests (61k paid links) | `scripts/integrity-check.ts` | every acknowledged pay committed; no double charge; every ledger group balanced; refunded ≤ captured; cache = ledger |
| Live load test (HTTPS, live server) | §3 | ≈ 50 users / 18.7 checkouts/s at 0 errors; overload answered with 503 + Retry-After |

## Existing-data checks

`docs/sql/existing-data-checks.sql` holds **51 read-only detection queries**, one or more for every finding that can
leave wrong rows behind (CSV imports posted 10× too small, MDR-rewritten paid batches, short split payouts,
duplicate callback notes, duplicate `settlement.paid`, balance cache drift, links captured twice, refunded > captured,
test merchants flipped live, …). The file runs inside a `READ ONLY` transaction that is rolled back. It was run
against the seeded database with `ON_ERROR_STOP=1`: exit 0, nothing modified. We did **not** run any remediation
against data. Each finding in §4 gives the compensating action we propose (the ledger is append-only, so corrections
are new balanced entry groups, never `UPDATE`s).

## Reproduce

```bash
docker compose -f ops/docker-compose.yml up -d postgres
export DATABASE_URL=postgres://filspay:filspay_dev_password@localhost:5432/filspay?sslmode=disable
export WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
npm ci && npm run migrate && npm run seed && npm test && npm run typecheck
docker run --rm --network host -e DATABASE_URL -v "$PWD/apps/settlement:/src" -w /src golang:1.23 go test -p 1 ./...
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/sql/existing-data-checks.sql
```
