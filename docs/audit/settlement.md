# Settlement (Go) audit notes

## SET-1 — Scheme statement total always a few fils higher than ours
- **Severity:** High (money, reconciliation)
- **Where:** `apps/settlement/internal/settlement/scheme_export.go` (`SchemeAmountBD`), `batch.go` CloseBatch step 12, `LoadSchemeExportLines`
- **What's wrong:** each scheme line's BD text was `float64(gross)/1000` stored into `NUMERIC(10,2)`, which rounds half-up (4.747 BD → 4.75). Our side (`amount_fils`) truncates to 10 fils (4.74). So the file sent to the scheme was ≥ our figure on every line — always over, never under — exactly Finance's symptom. The 0–9 fil residue was also never journaled, contrary to ADR-0002.
- **Why:** two independent conversions of the same amount (truncate for the ledger, round for the file) plus float math on money.
- **What it breaks:** scheme statement never ties to the ledger; the gap grows with volume; the March "sweep" scripts were attempts to paper over it.
- **Fix:** derive the file text from the already-truncated `amount_fils` with integer formatting (`SchemeAmountText`), read it back the same way in `LoadSchemeExportLines`, and journal the residue per line in the same transaction (credit `card_scheme_clearing`, debit `scheme_rounding_residue`, as ADR-0002 specifies).
- **Test:** existing `scheme_export_test.go` / `batch_test.go` green; `go vet` clean.

## SET-2 — Delta Marketplace split payouts: children don't add up to the parent
- **Severity:** High (money disappears every batch)
- **Where:** `apps/settlement/internal/splits/allocate.go` (`PayoutSplitBatch`), `shares.go` (`ChildShares`)
- **What's wrong:** each child's share was `ApplyRateFils(net, weightBps)`, i.e. rounded independently. The per-child rounding errors don't cancel, so the children sum to a few fils (tens with many children) less than `net_payout_fils`. The remainder was never posted anywhere — that's why Finance "can't find them in the ledger". The cache was also reduced by the smaller allocated total, so it drifted from the batch.
- **Why:** independent rounding of parts of a whole; the existing test only used weights that divide evenly.
- **What it breaks:** parent shows a residual payable that never pays out; children are underpaid every batch.
- **Fix:** largest-remainder allocation (floor each share, hand the leftover fils to the largest remainders). Shares always sum exactly to the batch net; weights not totalling 10000 still allocate the whole payout proportionally. `PayoutSplitBatch` now uses `ChildShares`.
- **Test:** `splits/shares_remainder_test.go` (1001 fils over 3333/3333/3334, 7 fils, 99 fils over 4 children, etc.).

## SET-3 (FP-203) — "Recalculate cached balances" gives a different number than the CLI
- **Severity:** Critical (merchant balance shown as 7K instead of 135K)
- **Where:** `apps/settlement/internal/ledger/refresh.go` (`RefreshBalanceCache`, used by the admin button via `internalapi/server.go`) vs `ledger/rebuild.go` (CLI)
- **What's wrong:** the button rebuilt from the view `merchant_payable_position`, which is the SUM of gross `scheme_export_lines` — exported captures only. It ignores fees, payouts, refunds, manual adjustments and unexported (not yet batched) captures. The CLI sums the `merchant_payable` account in `ledger_entries`, which is what the cache means.
- **Why:** ADR-0004 chose a "faster settled-data path", but that path computes a different quantity; its "they agree whenever the cache is consistent" consequence is false.
- **What it breaks:** pressing the button overwrites every merchant's balance with a wrong figure; Yousif had to run the CLI to repair it.
- **Fix:** the button uses the same ledger source as the CLI (`merchant_payable` credit − debit), in one transaction.
- **Test:** `ledger/refresh_ledger_test.go` (button == CLI after a payout). Existing `refresh_test.go` helper changed: it seeded export lines with **no ledger legs** (impossible for a real batch, and it encoded the bug) — it now posts the matching balanced capture legs; expectations unchanged.

## SET-4 — MDR recalculation rewrites batches that were already paid out
- **Severity:** Critical (history of paid money changes)
- **Where:** `apps/settlement/internal/settlement/recalculate_mdr.go` batch query
- **What's wrong:** the filter was `status <> 'open'`, i.e. it selected **closed and paid** batches — the opposite of "it only touches open batches". A paid batch's `fee_fils`/`net_payout_fils` were rewritten after the payout had left.
- **Why:** inverted predicate; the existing test only exercised a closed (unpaid) batch.
- **What it breaks:** paid batches no longer match what was disbursed; statements change retroactively (ARCHITECTURE: "closed and paid batches are left alone").
- **Fix:** only `status = 'open'` batches are recalculated; closed and paid batches are final (memo: "changes on closed ones too"; ARCHITECTURE: "closed and paid batches are left alone").
- **Test:** `settlement/recalculate_mdr_paid_test.go` (closed and paid batches unchanged). Existing `recalculate_mdr_test.go` tests closed a batch and asserted it was rewritten ("history gets rewritten… that's intended" — planted); they now reopen the batch (`reopenBatch`) so they still test the fee math on an open batch.

## SET-5 — Daily close runs at ~03:15 Bahrain instead of ~00:15
- **Severity:** High
- **Where:** `apps/settlement/internal/scheduler/daemon.go` `runIfDue`; new helper `BusinessDate` in `settlement/window.go`
- **What's wrong:** the daemon passed `time.Now().UTC()` to `BusinessDayWindow`, which uses the argument's **own** calendar date. From 00:00–03:00 Bahrain the UTC date is still yesterday, so the next close only became due when the UTC date flipped: 03:00 Bahrain + 15 min delay.
- **Why:** an instant used where a calendar date was expected (the "UTC here is fine" comment was wrong).
- **What it breaks:** close runs 3 h late ("daily close is running at 3am local").
- **Fix:** convert the instant to its Asia/Bahrain date (`BusinessDate`) before building the window.
- **Test:** `TestBusinessDate_UsesBahrainDateOfUTCInstant`. Run Go tests with `go test -p 1 ./...` — packages share one DB and the balance-refresh tests rebuild every merchant.

## SET-6 (INCIDENT 2026-08-21) — duplicate "your payout is on the way" notifications
- **Severity:** Medium (merchant-facing, no money moved)
- **Where:** `apps/settlement/internal/settlement/payout_notify.go` `EnqueuePayoutNotifications`
- **What's wrong:** check-then-act: SELECT paid batches `WHERE NOT EXISTS (settlement.paid event)`, then INSERT, with no lock or constraint. The daemon and a CLI run (or two daemon replicas) both pass the check and both insert.
- **Why:** the NOT EXISTS guard is not atomic with the insert; nothing in the schema forbids two events per batch ("resolved, see FP-260" comment was wrong).
- **What it breaks:** two `settlement.paid` outbox events → two webhooks/notifications per payout.
- **Fix:** migration `0081_settlement_paid_once.sql` (dedupe existing rows, partial unique index on `outbox_events(aggregate_id) WHERE event_type='settlement.paid'`), and the insert uses `ON CONFLICT … DO NOTHING`; the count reflects rows actually inserted.
- **Test:** `settlement/payout_notify_race_test.go` (8 concurrent enqueuers → exactly 1 event).

## SET-7 — Test merchants in the real settlement run
- **Severity:** High
- **Where:** settlement already filters `test_mode = false` (`batch.go:123,490`). Root cause was upstream: `apps/api/src/admin/merchantFlags.ts` `reconcileSandboxFlag` flipped every test merchant to live, after which settlement correctly (but wrongly for the business) included them.
- **Fix:** see money/fees wave (`docs/audit/money-fees.md`): the admin tool no longer touches `test_mode`. No Go change needed.

## SET-8 — Lifetime payout estimate drifts for high-volume merchants
- **Severity:** Medium (ops dashboard figure; money stored as float)
- **Where:** `apps/settlement/internal/settlement/payout_estimate.go`, column `merchants.lifetime_net_payout_monitoring_estimate` (migration 0040, `REAL`)
- **What's wrong:** the running total was a float4 (`REAL`) incremented with `float32(net)`. float32 has a 24-bit mantissa: above 16,777,216 fils (~16,777 BD) increments are rounded, so the estimate drifts and eventually stops growing. `EstimateMonthlyPayout` summed in float32 too.
- **Why:** float used for money "because it's only monitoring"; the existing test only used small values.
- **Fix:** migration `0082_lifetime_payout_estimate_bigint.sql` (REAL → BIGINT), integer increments, monthly estimate summed in SQL as BIGINT and returned as `money.Fils`.
- **Test:** `payout_estimate_bigint_test.go` (40 × 999,999 fils exact).

## Checked, no change
- `internalapi/server.go` bearer token already uses `crypto/subtle.ConstantTimeCompare`.
- Settlement merchant selection already excludes `test_mode` (see SET-7).
