# FilsPay — Findings report

Scope: the FilsPay case file (briefing card, finance memo, incident log), the repository at `8b58b0f`, and the
fixes on branch `worktree-filspay-audit`. Ground truth: the brief and `docs/adr/0001`/`0002` (1 BD = 1000 fils,
integer fils, business day = midnight Asia/Bahrain). The repo's agent files (`CLAUDE.md`, `AGENTS.md`,
`.cursorrules`) contained planted wrong rules and were audited separately (`docs/audit/agent-instructions.md`,
AI-01…AI-25).

Conventions:

- **F-NN** findings are ordered by impact (Critical → Low). Each one maps to `BUGS.md` (`BUGS #n`) or to a
  finding found after that list was written (**new**).
- **Commit** ids are on this branch (`git log 8b58b0f..HEAD`). Detailed notes for each area are in `docs/audit/*.md`.
- **Existing data**: whether the bug left wrong rows in a production database. Every detection query is in
  [`docs/sql/existing-data-checks.sql`](sql/existing-data-checks.sql). That file only contains SELECTs, runs inside a
  `READ ONLY` transaction that is rolled back, and was run without errors on the migrated and seeded local DB.
  Counts quoted as "local DB" include seed and test fixtures. They show that the query works. They are not
  production figures.
- **Remediation rule**: `ledger_entries` is append-only (trigger in 0007). Money is corrected with new, balanced,
  compensating entry groups. Then the `merchant_balances` cache is rebuilt from the ledger (CLI `rebuild` or the
  fixed button), and the merchant is told when a payout or statement changes. None of the remediations below was
  run. See "Decisions and open risks".

Counts: 93 findings (all 73 from `BUGS.md` plus 20 new ones, marked **new**) and 2 test-infrastructure faults. Severity:
10 Critical, 40 High, 38 Medium, 5 Low.

---

## 1. Findings

### Critical

### F-01 · Login worked without the OTP (Critical)
BUGS #39 · A1
- **Symptom:** Group chat, quoted in the finance memo: *"Login works without entering the OTP code?"*
- **Found / reproduced:** Started from the memo line and read the session lookup. Repro: log in with the password only, then send the cookie from the login response to any merchant route. It returned 200 before the fix and returns 401 after it.
- **Root cause:** `apps/api/src/auth/sessions.ts:90` `lookupSession` read the view `live_sessions` (0058). That view filters out revoked and expired sessions but does not check `authenticated`, so a pending (pre-OTP) session passed `requireSession`/`requireMerchantAuth`.
- **Fix:** `AND s.authenticated = true`. `promoteSession` promotes only a pending, unrevoked row (`cef68d1`).
- **Verified:** `apps/api/src/auth/authSecurity.new.test.ts` "bug1".
- **Existing data:** No wrong rows, but sessions opened with only a password may have been used. Revoke every session issued before the deploy, which forces a re-login (check `F-01/F-43`; local DB: 8 live sessions).

### F-02 · Login bound the session to another merchant's user (Critical)
BUGS #40 · A2 · new in audit
- **Symptom:** None reported. A user whose email exists under two merchants could end up inside the other merchant's account.
- **Found / reproduced:** Code read of `routes/auth.ts` login. Repro: create the same email under merchants A and B, then log in to B with B's password. The session belonged to A's user.
- **Root cause:** `apps/api/src/routes/auth.ts` login: `findOtpRecipient(email)` picked the first active `merchant_users` row with that email across all merchants. The session and OTP were bound to that row, not to the user whose password was checked.
- **Fix:** Bind the session and OTP to the password-verified `user` (`cef68d1`).
- **Verified:** Existing login tests in `routes/auth*.test.ts` (A2 in `docs/audit/auth-security.md`).
- **Existing data:** Possible cross-tenant sessions. Check `F-02` lists sessions of users whose email is shared across merchants (local DB: 2, both test fixtures). For each one, compare the session's actions with the merchant the user meant, and notify both merchants if data was accessed.

### F-03 · Acquirer callback signature optional, not timing-safe, over re-serialised bytes (Critical)
BUGS #48 · A9 · FP-240 (second half)
- **Symptom:** Incident log, FP-240: *"someone said the incoming signature check has its own problems."*
- **Found / reproduced:** Started from FP-240 and read `webhooks/inboundVerify.ts`. Repro: POST an unsigned `fraud_review.completed` callback. It was accepted (`ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaulted to false, with an empty dev secret).
- **Root cause:** `apps/api/src/webhooks/inboundVerify.ts`, `routes/acquirerCallbacks.ts`: the signature was optional and computed over the parsed and re-serialised body. It had no freshness window, used a non-constant-time compare, and was checked after field validation.
- **Fix:** Signature always required, and an empty secret never verifies. Verification uses the raw body (route-scoped parser), a 300 s tolerance and `timingSafeEqual`, and runs first (`cef68d1`).
- **Verified:** `authSecurity.new.test.ts` "bug5". `routes/acquirerCallbacks.test.ts` and `webhooks/inboundVerify.test.ts` were updated, because they asserted that unsigned callbacks are accepted.
- **Existing data:** Forged fraud verdicts would be stored as notes and as status effects. Check `F-03` lists callback notes received before the deploy, by type and outcome (local DB: 3). Compare them with the acquirer's own callback log, and reverse any verdict the acquirer did not send.

### F-04 · One merchant could refund another merchant's payment (Critical)
BUGS #13 · fp300-api #2
- **Symptom:** None reported (FP-300 was unfinished). Found while building the refund path.
- **Found / reproduced:** Code read. Repro: merchant B posts `POST /v1/refunds {transactionId: <A's txn>}`. The refund went through, and the webhook went to A.
- **Root cause:** `apps/api/src/refunds/initiateMerchantRefund.ts` looked the transaction up by id only and passed the owner's `merchant_id` on. `payments/processRefund.ts` selected `WHERE id = $1` with no merchant check.
- **Fix:** Both lookups use `WHERE id = $1 AND merchant_id = $2` with the authenticated merchant. Another merchant's transaction returns 404 (`e7e4dd9`).
- **Verified:** `routes/refunds.new.test.ts` "cross-merchant: B refunding A's transaction id is 404 and writes nothing" checks both paths and a direct `processRefund` call, with no refund, ledger or outbox rows written.
- **Existing data:** Check `F-04` finds refunds whose creating API key or session belongs to another merchant (local DB: 0). Remediation: report them to the victim merchant, then journal a compensating entry for each, which needs finance and acquirer agreement because the cardholder already received the money.

### F-05 · Refund ceiling used the authorized amount, not captured − refunded (Critical)
BUGS #14 · fp300-api #3
- **Symptom:** Incident log, untriaged list: *"can you refund more than what was actually charged?"*
- **Found / reproduced:** Code read of `processRefund.ts`. Repro: authorize 10,000 fils, capture 4,000, refund 10,000. It succeeded, over-refunding by 6,000.
- **Root cause:** `apps/api/src/payments/processRefund.ts` computed `refundable = amount_fils - refunded_fils`. The authorized amount includes money that never moved.
- **Fix:** `validateRefundRequest` derives `captured - refunded`, clamped at 0 (`e7e4dd9`). 0073 adds `CHECK (refunded_fils <= captured_fils)` (NOT VALID) as a backstop (`732219d`).
- **Verified:** `refundRules.new.test.ts`. Route test: 4,001 refunded on a 4,000 capture gets 422 `refundableFils: 4000`. E2E (`docs/audit/fp300-e2e.md`): asking 6,000 on a 5,000 capture gets 422.
- **Existing data:** Check `F-05/F-06` lists transactions refunded above captured, or whose `refunded_fils` disagrees with the sum of the refunds table (local DB: 3 test-fixture rows). The 0073 CHECK is NOT VALID, so old violations remain until someone fixes them. Remediation: recover the excess from the merchant with a compensating `merchant_payable` debit, then run `ALTER TABLE … VALIDATE CONSTRAINT`.

### F-06 · Concurrent refunds both succeeded (Critical)
BUGS #15 · FP-209 · fp300-api #4
- **Symptom:** Incident log, FP-209: *"Two refund requests came in at the same time. Both went through, and we lost money. Normal payments don't have this problem."*
- **Found / reproduced:** Compared refunds with `capture.ts`, which locks the row. Repro: send three concurrent 6,000 refunds on a 10,000 capture. More than one succeeded.
- **Root cause:** `processRefund.ts` validated in transaction 1 without a lock, called the acquirer outside any transaction, and journaled in transaction 2 without re-reading. A crash between the two transactions also left the idempotency key `in_progress`, so every retry got 409.
- **Fix:** One `withTransaction` holds `SELECT … FOR UPDATE` (merchant-scoped) across the acquirer call, as `capture.ts` does. The 0073 CHECK is the backstop (`e7e4dd9`).
- **Verified:** `routes/refunds.new.test.ts` "concurrent refunds … exactly one wins" returns [200, 422, 422] with `refunded_fils` 6000.
- **Existing data:** Same check as F-05 (`F-05/F-06`). Same remediation.

### F-07 · The same payment link was charged twice (Critical)
BUGS #31 · INCIDENT 2026-05-14
- **Symptom:** Incident log: *"A slow payment let a second buyer use the same link before the first one finished. Both were charged. The code comments say 'this IS reachable.'"*
- **Found / reproduced:** Read the claim and finalize steps in `pay.ts`. Repro: hold the first pay past the reservation timeout (slow acquirer), then pay again. That gave two captures, and the first finalize matched 0 rows but returned 200.
- **Root cause:** `apps/api/src/paymentLinks/pay.ts`: the claim `UPDATE` re-admitted a `reserved` link once `reserved_at` aged past the timeout, which is a time-based reservation and not a lock. A finalize that updated 0 rows still answered 200.
- **Fix:** `SELECT … FOR UPDATE SKIP LOCKED` on the link, held in a dedicated transaction through authorize, capture and finalize. A locked link gets 409 `payment_link_processing`. Crash recovery first looks for an already-completed `paylink:<id>:%` capture and finalizes against it. A finalize failure throws. A semaphore stops lock-holders from starving the pool (`ae8d95c`).
- **Verified:** `paymentLinks/paymentLinks.new.test.ts` "incident 2026-05-14" and "crash after capture". `scripts/integrity-check.ts` check `link_single_capture` was clean after the load test (see `docs/CAPACITY.md`).
- **Existing data:** **Yes.** Check `F-07` lists links with more than one successful capture (local DB: 0). Remediation: refund the later capture to its cardholder through the refund API, which writes the balanced ledger legs, and tell the merchant.

### F-08 · Settlement ignored refunds, so shops were paid for money already returned (Critical)
BUGS #22 · fp300-settlement #1
- **Symptom:** FP-300 "done when": *"Fees and payouts come out right"*. Refunded payments were still paid out in full.
- **Found / reproduced:** Code read of `CloseBatch`, plus the E2E run. Repro: capture 10,000, refund it in full, close the batch. The payout was 10,000 − fee.
- **Root cause:** `apps/settlement/internal/settlement/batch.go` `CloseBatch` selected only capture events. Nothing read `refunds` or set `refunds.settlement_batch_id`, because the FP-212 refund write path shipped without the matching settlement change.
- **Fix:** Inside the close transaction, unbatched succeeded refunds before the cutoff are locked FIFO, `amount − fee_reversed` is netted, the refunds are stamped with the batch id, and `refunds_fils`/`refund_fee_reversed_fils` are stored (`c55dbef`).
- **Verified:** `refund_netting_test.go` (`TestCloseBatch_SameDayFullRefundNetsToZero` and others). E2E: batch payout 4,888 = (15,000 − 337) − (10,000 − 225).
- **Existing data:** **Yes.** Every refund before the fix was paid out to the merchant. Check `F-08` lists succeeded, unbatched refunds older than the merchant's latest closed batch (local DB: 0). The fixed `CloseBatch` has no lower time bound, so the next close nets these old refunds automatically, rolling forward if the payout would go below 0 (F-15). Before deploying, tell affected merchants their next payout will be lower.

### F-09 · "Recalculate cached balances" rebuilt from exported captures, not the ledger (135K → 7K) (Critical)
BUGS #3 · FP-203 · SET-3
- **Symptom:** Finance memo: *"I pressed it last Thursday and Alpha Retail's balance went from 135K to 7K. Yousif had to run the CLI rebuild to fix it. Why do the button and the CLI give different numbers?"*
- **Found / reproduced:** Compared `ledger/refresh.go` (button) with `ledger/rebuild.go` (CLI). Repro: press the button after a payout. The balance was the sum of gross `scheme_export_lines`.
- **Root cause:** `apps/settlement/internal/ledger/refresh.go` `RefreshBalanceCache` read the view `merchant_payable_position` (sum of gross exported captures). That view ignores fees, payouts, refunds, adjustments and unbatched captures. ADR-0004 chose this "faster settled-data path".
- **Fix:** The button uses the CLI's source, `merchant_payable` credit − debit, in one transaction (`4f5201a`).
- **Verified:** `ledger/refresh_ledger_test.go` (button == CLI after a payout). `refresh_test.go` was fixed because its helper seeded export lines with no ledger legs.
- **Existing data:** Only the cache. Check `F-09` compares `merchant_balances` with the ledger (local DB: 12 merchants differ). Some drift between refreshes is expected. Remediation: run the CLI `rebuild`, then the fixed button. No ledger change.

### F-10 · MDR recalculation rewrote batches that were already paid out (Critical)
BUGS #4 · SET-4 · RV-9
- **Symptom:** Finance memo: *"MDR recalculation changed batches that were already paid out. Those should never change. The settlement team says it only touches open batches, but I'm seeing changes on closed ones too."*
- **Found / reproduced:** Read the batch query. Repro: close and pay a batch, then run the recalculation. `fee_fils`/`net_payout_fils` changed.
- **Root cause:** `apps/settlement/internal/settlement/recalculate_mdr.go:67` filtered `status <> 'open'`, which is the inverse of the intent. It selected closed and paid batches and `UPDATE`d them (line 109). The existing test asserted the rewrite ("that's intended").
- **Fix:** First pass excluded paid batches (`6572fa1`). The second review pass (RV-9) restricted it to `status = 'open'` (`d706f6d`).
- **Verified:** `settlement/recalculate_mdr_paid_test.go` (closed and paid batches unchanged). `recalculate_mdr_test.go` now reopens the batch before recalculating.
- **Existing data:** **Yes.** Check `F-10` lists paid batches whose stored `net_payout_fils` differs from the payout ledger leg or the disbursement, plus every `mdr_recalculation` audit entry (local DB: 6 legacy seeded batches with no payout leg, and 2 runs). Remediation: restore each rewritten batch to the figures actually disbursed. `settlement_batches` is not append-only, so finance approves a scripted restore from the disbursement and ledger amounts, recorded in `admin_audit_log`. If a fee was really due, post it as an adjustment in an open batch. Merchant statements for those batches are re-issued.

### High

### F-11 · CSV import read BD with 2 decimals: 4.75 → 0.475, 4.755 → 4.750 (High)
BUGS #52 · MF-1
- **Symptom:** Finance memo: *"I uploaded 4.755 BD and the ledger shows 4.750. I uploaded 4.75 BD and it shows 0.475. That's ten times less."*
- **Found / reproduced:** Traced the parser. Repro: import a row `4.75`. It was posted as 475 fils.
- **Root cause:** `apps/api/src/admin/adjustmentCsvParsing.ts:8` used `parseDecimalMinor(raw)` (`lib/decimal.ts`), which defaults to 2 decimals because it was written for cent currencies. It truncated the third digit and scaled by 100. The planted `CLAUDE.md` rule "integer cents" reinforced it.
- **Fix:** `parseBhdToFils` (×1000, rejects more than 3 decimals) (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug1". `adjustmentImport.test.ts` assertions were corrected 10× (they encoded the bug).
- **Existing data:** **Yes.** Every imported adjustment was posted 10× too small, and 3-decimal amounts lost their last digit. Check `F-11` compares `adjustment_import_rows.raw_amount_text` × 1000 with `parsed_amount_fils` and lists rows whose text is not a plain BD amount (local DB: 0, because the seed re-imports with the fixed parser). Remediation: for each row, post a compensating entry group for `expected − parsed` with the same accounts as the original `ledger_entry_group_id`, then rebuild the cache.

### F-12 · Scheme file rounded half-up while the ledger truncated, and the residue was never journaled (High)
BUGS #1 · SET-1 · ADR-0002
- **Symptom:** Finance memo: *"The scheme statement total is always a few fils higher than ours. It's always over, never under. I checked three months and it's the same every time."*
- **Found / reproduced:** "Always over" pointed to two different roundings of the same amount. Repro: gross 4,747 fils gives a file line of 4.75 BD, while the ledger has 4,740.
- **Root cause:** `apps/settlement/internal/settlement/scheme_export.go:29` `SchemeAmountBD` = `float64(gross)/1000` stored in `NUMERIC(10,2)`, which rounds half-up. `amount_fils` truncates to 10 fils (`TruncateToSchemeAmount`). The 0–9 fil residue per line was never posted, although ADR-0002 requires it.
- **Fix:** The file text comes from the truncated `amount_fils` with integer formatting. Each line's residue is journaled in the close transaction: credit `card_scheme_clearing`, debit `scheme_rounding_residue`, described as "scheme export: rounding residue" (`3ea92a7`).
- **Verified:** `scheme_export_test.go` and `batch_test.go` green. `go vet` clean.
- **Existing data:** **Yes, for every past batch.** Check `F-12` finds lines whose file amount × 1000 ≠ `amount_fils`, plus batches whose expected residue (capture gross − truncated amount) was never journaled (local DB: 62 batches, 72–119 fils each). Remediation: one compensating residue entry group per past batch, using the ADR-0002 accounts. This replaces the ad-hoc March sweep (F-17). Then reconcile the scheme statement once.

### F-13 · Split payouts lost fils every batch (High)
BUGS #2 · SET-2
- **Symptom:** Finance memo: *"the three child payouts don't add up to the parent's total. It's small, a few tens of fils each batch, but it happens every batch since launch. Where do the missing fils go?"*
- **Found / reproduced:** Code read. Repro: 1,001 fils over weights 3333/3333/3334. The children summed to less than 1,001.
- **Root cause:** `apps/settlement/internal/splits/allocate.go` `PayoutSplitBatch` rounded each child with `ApplyRateFils(net, weightBps)` independently. The remainder was never posted, and the existing test used only weights that divide evenly.
- **Fix:** Largest-remainder allocation in `shares.go` `ChildShares`. Shares always sum exactly to the net (`4f5201a`).
- **Verified:** `splits/shares_remainder_test.go` (1,001 over 3333/3333/3334, 7 fils, 99 fils over 4 children).
- **Existing data:** **Yes.** Check `F-13` compares the sum of `settlement_batch_splits.allocated_fils` with `settlement_batches.net_payout_fils` (local DB: 0). Remediation: pay the shortfall per batch to the children by largest remainder through a supplementary payout entry group, then rebuild the cache.

### F-14 · Payout math in float32 lost fils above ~16,777 BD (High)
BUGS #10 · fp300-settlement #3
- **Symptom:** None reported. Large batches would pay the wrong number of fils.
- **Found / reproduced:** Code read while adding refund netting. Repro: 16,777,217 fils gross. The float32 result is off by one.
- **Root cause:** `apps/settlement/internal/settlement/payable.go:11` `NetPayableFils` computed `float32(gross)/1000 - float32(fee)/1000` and rounded back. float32 has a 24-bit mantissa.
- **Fix:** `grossFils - feeFils` in int64 (`c55dbef`).
- **Verified:** `TestNetPayableFils_LargeAmountExactToTheFil` (16,777,217 to 9,999,999,999), `TestApplyRefundsToPayout_LargeAmountsExact`.
- **Existing data:** Check `F-14` lists closed or paid batches where `net ≠ gross − fee − refunds + fee returned` (local DB: 0). Remediation: pay or recover the difference in the merchant's next batch.

### F-15 · Refunds could push a payout negative (High)
BUGS #23 · fp300-settlement #2
- **Symptom:** None reported (design gap in FP-300).
- **Found / reproduced:** Design review of netting. Repro: a day with refunds greater than captures gave a negative net. `PayoutBatch` posts only when net > 0, then marks the batch paid, so the shortfall was forgiven.
- **Root cause:** `batch.go`/`payable.go` had no carry-forward rule.
- **Fix:** `ApplyRefundsToPayout` nets FIFO. The first refund that would go below 0, and every refund after it, stays unbatched and rolls to the next batch (`c55dbef`).
- **Verified:** `TestApplyRefundsToPayout_ExceedingCapturesRollsForward`, `TestCloseBatch_RefundExceedingCapturesRollsForward`.
- **Existing data:** Check `F-15` lists `net_payout_fils < 0` (local DB: 0). None expected, because refunds were not netted at all before FP-300.

### F-16 · Admin recompute tool flipped test merchants live, so they entered real settlement (High)
BUGS #63 · MF-6b · SET-7
- **Symptom:** Group chat, quoted in the memo: *"Test merchants keep showing up in the real settlement run"*. Incident log: *"what happens to test merchants when certain admin tools run?"*
- **Found / reproduced:** Settlement already filters `test_mode = false` (`batch.go:123,490`), so I traced upstream to the admin tool. Repro: run "recompute statuses" on a sandbox merchant with transactions. `test_mode` became false.
- **Root cause:** `apps/api/src/admin/merchantFlags.ts` `reconcileSandboxFlag` cleared `test_mode` whenever `scanned > 0 && openAuthorizations === 0`. The open-authorization count was always 0.
- **Fix:** The tool no longer touches `test_mode`. Going live is an explicit, audited action (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug6".
- **Existing data:** **Yes.** The flip is recorded in `admin_audit_log` (`transaction_status_recompute`, `metadata.flagsUpdated` contains `test_mode`). Check `F-16` lists those merchants with the batches and paid amounts since the flip (local DB: 0). Remediation: set `test_mode` back after the owner confirms. Reverse any payouts of test money (the acquirer has no real funds behind them) with compensating entries, and void the scheme lines with the acquirer.

### F-17 · March sweep doubled when run twice (High)
BUGS #54 · MF-3
- **Symptom:** Finance memo: *"someone ran it twice on staging and the gap doubled. Nobody knows if it ran more than once on production. The log file only has one timestamp. Is it safe to run again? I wouldn't."*
- **Found / reproduced:** Code read of `scripts/reconcile_march.ts`. Repro: run it twice. It posted two entry groups.
- **Root cause:** `entry_group_id` was `randomUUID()` on every run, with no natural key. The "dedupe" comment was false.
- **Fix:** The group id is deterministic, `sha256("reconcile_sweep:<y>-<m>:<merchant>")`. The script checks whether it exists and takes an advisory transaction lock. A second run is a no-op (`63c8ccc`).
- **Verified:** `scripts/reconcile_march.test.ts` "bug3".
- **Existing data:** **This answers finance's question.** Check `F-17` groups the "rounding residue sweep" entries by merchant and lists every merchant with more than one entry group and the run times (local DB: 0). Remediation: post one reversing group per duplicate. Do not delete anything. After that, the sweep is safe to re-run, but F-12's per-batch residue journaling replaces it.

### F-18 · "Adjust balance" was cache-only, so a rebuild erased it (High)
BUGS #68 · RV-2 · ADR-0006
- **Symptom:** None reported. After FP-203 (F-09), every manual correction would disappear on the next rebuild.
- **Found / reproduced:** Second review pass compared ADR-0006 with ADR-0001 and `ADMIN.md`. Repro: adjust a balance, then rebuild. The adjustment was gone.
- **Root cause:** `apps/api/src/routes/adminBalanceAdjustments.ts` called `applyBalanceCorrection` (cache `UPDATE` only, audit action `balance_adjustment`). ADR-0006 ("display corrections, no ledger entry") contradicts ADR-0001.
- **Fix:** The route uses `adjustMerchantBalanceJournaled` (audit action `balance_adjustment_journaled`) (`5ac1ccc`). The UI adds a review step in BD (`9c3173a`).
- **Verified:** Existing `admin/balanceAdjustments.test.ts` and route tests green. No dedicated new test (open risk 14).
- **Existing data:** **Yes.** Check `F-18` lists every `balance_adjustment` audit row with `metadata.deltaFils` and whether a later `balance_rebuild` already erased it (local DB: 3). Remediation: finance decides for each one whether it was a real money correction. If it was, journal it now with `manual_balance_adjustment_contra`, then rebuild.

### F-19 · Payment-link captures skipped the negotiated discount (High)
BUGS #35 · PL-DISCOUNT-MISSING
- **Symptom:** None reported. Merchants with a negotiated discount paid full MDR on link payments.
- **Found / reproduced:** Code read. The discount was applied only in `routes/transactions.ts`, and the comment claiming `capture.ts` did it was false. Repro: pay a link for a discounted merchant. No discount leg was posted.
- **Root cause:** `apps/api/src/paymentLinks/pay.ts` called `captureTransaction` directly, without `applyCaptureDiscountAdjustment`.
- **Fix:** `pay.ts` applies the adjustment after the capture, idempotent per capture event (`ae8d95c`).
- **Verified:** `paymentLinks.new.test.ts` and the full suite.
- **Existing data:** **Yes.** Check `F-19` lists paid links of merchants with `negotiated_discount_bps > 0` and no "capture: negotiated discount adjustment" leg (local DB: 0). The rate is today's, so confirm it applied at capture time. Remediation: post the missing discount adjustment for each one. If its batch is already paid, credit it in the next batch.

### F-20 · Refund fee reversal could exceed the fee charged (High)
BUGS #17 · fp300-api #6
- **Symptom:** None reported. It breaks the rule that the fee returned never exceeds the fee charged.
- **Found / reproduced:** Property test over partial-refund orderings. Repro: refunds of 100/300/300/300 on a 1,000 capture with a 25 fee reversed 2+8+8+8 = 26.
- **Root cause:** `processRefund.ts` rounded each partial reversal independently.
- **Fix:** Cumulative reversal `round(fee × refundedTotal / captured)` minus the amount already reversed, clamped to the fee still unreversed (`e7e4dd9`). `packages/money` unchanged.
- **Verified:** `refundRules.new.test.ts`: 300/300/300/100 gives 8/7/7/3 = 25, and four other orderings total 25 without going over. E2E: 68 + 157 = 225.
- **Existing data:** Check `F-20/F-21` lists transactions where the summed `fee_reversed_fils` exceeds the net fee in the ledger (local DB: 1 test fixture with no fee legs). Remediation: a compensating `merchant_payable` debit / `platform_fee_revenue` credit for the excess.

### F-21 · Refund fee reversal ignored the negotiated discount (High)
BUGS #18 · fp300-api #7
- **Symptom:** None reported. Merchants were overpaid by the discount on every refund.
- **Found / reproduced:** Ledger check after a full refund. `merchant_payable` did not net to 0.
- **Root cause:** `processRefund.ts` took the fee as the sum of `platform_fee_revenue` credits only, and ignored the discount debit.
- **Fix:** Net fee = credits − debits on `platform_fee_revenue` for the transaction, excluding `refund:%` legs (`e7e4dd9`).
- **Verified:** "negotiated discount: … merchant_payable nets to 0" (fee 250, 20% discount, full refund reverses 200).
- **Existing data:** The same check (`F-20/F-21`) flags fully refunded transactions whose reversal ≠ net fee. Remediation as F-20.

### F-22 · Refund endpoint was an unfinished 501 stub (FP-300) (High)
BUGS #12 · fp300-api #1
- **Symptom:** Briefing card, FP-300: *"The last developer started a feature but never finished it… 'looks easy. it isn't. it touches everything.'"*
- **Found / reproduced:** `POST /v1/refunds` returned 501. The commented draft used `crypto.randomUUID()` as the idempotency key, so every retry would refund again.
- **Root cause:** `apps/api/src/routes/refunds.ts`: FP-212 never shipped. The agent files called the 501 "intentional" (AI-05).
- **Fix:** Real handler on both `/v1/refunds` and `/v1/merchants/:id/refunds`. Requires a client `Idempotency-Key`, checks roles (owner/finance/API key) and refuses impersonation (`e7e4dd9`). The UI RefundDrawer was enabled (`9c3173a`). The rest of FP-300 is in F-04…F-08, F-15, F-20/21, F-42, F-54…F-61.
- **Verified:** `routes/refunds.new.test.ts`. E2E (`docs/audit/fp300-e2e.md`): ledger, webhook, timeline, reports, Go payout and reconciliation all PASS. Live demo in `docs/ui/DEMO.md`.
- **Existing data:** None. Runtime only.

### F-23 · Payment link paid after expiry: server trusted the client's clock (High)
BUGS #30 · FP-187
- **Symptom:** Incident log, FP-187: *"A buyer says the link showed 'expired', but the payment still went through. The checkout page sends something that the server shouldn't trust."*
- **Found / reproduced:** Read the pay body. Repro: pay an expired link with `submittedAt` set to a past time. It succeeded.
- **Root cause:** `apps/api/src/paymentLinks/pay.ts` `expiryReferenceTime(submittedAt)` judged expiry against a timestamp from the body, on an unauthenticated route.
- **Fix:** Expiry always uses the server clock. The field was removed from the route, the input and the web client (`ae8d95c`).
- **Verified:** `paymentLinks.new.test.ts` "FP-187". `pay.test.ts` cases that honoured the client value were replaced.
- **Existing data:** **Yes.** Check `F-23` lists links with `paid_at > expires_at` (local DB: 0). Remediation: the merchant decides whether to keep or refund each one. The charge itself is valid.

### F-24 · Capture idempotency key replayed the wrong transaction (High)
BUGS #38 · RV-3
- **Symptom:** None reported. A merchant reusing a key for a second capture of the same amount got a "success" for a transaction that was never captured.
- **Found / reproduced:** Second review pass. Repro: capture txn A with key K, then capture txn B (same amount) with key K. The response was A's, and B stayed authorized.
- **Root cause:** `apps/api/src/payments/capture.ts:64`: the request hash covered only `{amountFils}`, not the transaction id.
- **Fix:** The hash includes `transactionId`, so a different transaction gets 422 `idempotency_key_reused` (`5ac1ccc`).
- **Verified:** Full API suite green. No dedicated new test (open risk 14).
- **Existing data:** No wrong ledger rows. The second transaction simply stayed authorized, and its hold expires after 7 days. It cannot be told apart from a normal uncaptured authorization in the DB. Remediation: tell merchants whose integration reuses keys, so they can re-capture while the hold is still valid.

### F-25 · Reconciliation subtracted a paid batch twice (High)
BUGS #27 · fp300-reporting R2
- **Symptom:** Every paid batch showed `explained: false` with gap = −net payout (E2E §6: Beta, which has no refunds, showed a gap of −1,967).
- **Found / reproduced:** E2E run against the real API and Go settlement.
- **Root cause:** `apps/api/src/settlement/query.ts:296` `getReconciliationReport`: the ledger net included the "settlement payout: batch paid" debit while the settled net was also subtracted, so the payout was counted twice.
- **Fix:** Payout legs are cash movement, so they are excluded from the ledger side (`06d4462`).
- **Verified:** `apps/api/src/settlement/query.paid.new.test.ts` (4 cases).
- **Existing data:** None, because the report is computed on read. Runtime only. Earlier reconciliation sign-offs may have used wrong gaps, so re-run them.

### F-26 · Dashboard showed 245 bps while payments were charged 225 bps (High)
BUGS #53 · MF-2
- **Symptom:** Finance memo: *"It shows 245bps, but payments go through at 225bps. The two fee tables have different dates, and one was a backfill fix."*
- **Found / reproduced:** Compared the display query with `getEffectiveMdrBps`. Repro: add a backfilled row (earlier `effective_from`, later `created_at`). The display picked it.
- **Root cause:** `apps/api/src/fees/currentFeeScheduleDisplay.ts:~35` ordered by `created_at DESC` with no effective-date filter. Charging uses `effective_from <= asOf ORDER BY effective_from DESC, created_at DESC`.
- **Fix:** The display uses the same predicate and order as charging (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug2". `currentFeeScheduleDisplay.test.ts` was corrected from 245 to 225.
- **Existing data:** None. Display only, and charges were right. Runtime only.

### F-27 · Daily close ran at 03:15 Bahrain instead of just after midnight (High)
BUGS #5 · SET-5
- **Symptom:** Group chat: *"The daily close is running at 3am local, not midnight"*. Incident log: *"the daily close timing doesn't match what the docs say"*.
- **Found / reproduced:** Read `daemon.go`. Repro: at 00:30 Bahrain (21:30 UTC the day before), the close was not due.
- **Root cause:** `apps/settlement/internal/scheduler/daemon.go` `runIfDue` passed `time.Now().UTC()` to `BusinessDayWindow`, which uses the argument's own calendar date. The UTC date flips at 03:00 Bahrain, and with the 15-minute delay the close ran at 03:15.
- **Fix:** `BusinessDate` converts the instant to its Asia/Bahrain date first (`settlement/window.go`) (`6572fa1`).
- **Verified:** `TestBusinessDate_UsesBahrainDateOfUTCInstant`.
- **Existing data:** None. The window boundaries were already Bahrain midnight, so batches hold the right captures. Payouts were only about 3 hours late. Runtime only.

### F-28 · Status recompute overwrote chargebacks (High)
BUGS #62 · MF-6a
- **Symptom:** None reported. Chargebacks silently became captured or refunded.
- **Found / reproduced:** Code read. Repro: run recompute on a merchant with a `chargeback` transaction. Its status changed.
- **Root cause:** `apps/api/src/admin/transactionStatusRecompute.ts` scanned every status except authorized/voided, including `chargeback`, which the acquirer sets.
- **Fix:** Only the capture/refund family is recomputed (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug6".
- **Existing data:** **Yes, partly undetectable.** The audit log stores counts only. Check `F-28` lists transactions with `chargeback_suspense` ledger legs whose status is no longer `chargeback`, and recompute runs that updated rows (local DB: 0 / 0). Remediation: restore the status from the acquirer's chargeback report (transaction status is not ledger, so a scripted, audited `UPDATE` is allowed).

### F-29 · Bulk KYC approved merchants that had been rejected (High)
BUGS #64 · MF-6c
- **Symptom:** None reported.
- **Found / reproduced:** Code read against the function's own docstring ("rejected ids are skipped").
- **Root cause:** `apps/api/src/admin/bulkKyc.ts` ran `UPDATE merchants SET onboarding_status='approved', kyc_passed=true WHERE id = ANY($1)` with no status guard.
- **Fix:** `AND onboarding_status = 'under_review'` (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug6".
- **Existing data:** **Yes.** Check `F-29` lists approved merchants whose latest review is `rejected`, and every id in `kyc_bulk_approve.metadata.approvedMerchantIds` whose last review before the bulk run was a rejection (local DB: 0 / 0). Remediation: compliance re-reviews them, and refunds and payouts stay on hold meanwhile.

### F-30 · An empty filter deleted every hold (High)
BUGS #56 · MF-4a
- **Symptom:** None reported. Holds are the record of reserved card funds (HANDOVER/0005: never deleted).
- **Found / reproduced:** Code read of `scripts/expire_holds.ts` + `scripts/lib/sqlFilter.ts`. Repro: run with no expired holds. That executed `DELETE FROM holds` with no `WHERE`.
- **Root cause:** `sqlFilter` turned an empty list into an empty predicate, and the script deleted where it should have updated.
- **Fix:** One guarded `UPDATE … SET status='expired'`. `sqlFilter` refuses an unfiltered DELETE (`63c8ccc`).
- **Verified:** `scripts/expire_holds.test.ts`, rewritten because it asserted the DELETE text.
- **Existing data:** **Yes, rows deleted.** Check `F-30` lists open authorizations with no hold row (local DB: 57, mostly seeded authorizations created without holds, so treat as candidates). Remediation: re-create the holds from `transactions` (amount − captured, expiry = authorization + 7 days), or restore them from a backup.

### F-31 · Admin reporting rebuild wiped refund totals (High)
BUGS #65 · MF-6d
- **Symptom:** None reported (found in the FP-300 E2E, §4).
- **Found / reproduced:** Code read. `refreshAnalyticsRollups` TRUNCATEs `merchant_daily_volume` and re-inserts without the refund columns.
- **Root cause:** `apps/api/src/admin/reportingRebuild.ts` predates migration 0073's `refund_count`/`refund_gross_fils`.
- **Fix:** Rebuild from succeeded `refunds`, bucketed on the Bahrain date (`63c8ccc`).
- **Verified:** `reportingRebuild.new.test.ts`.
- **Existing data:** Derived data only. Check `F-31/F-57` compares rollups with refunds per Bahrain day (local DB: 32 merchant-days differ, mostly test residue). Remediation: run `reporting rebuild` once after deploy.

### F-32 · `platform_stats` INT4 overflow past 2,147,483 BD (High)
BUGS #66 · MF-7 · migration 0080
- **Symptom:** None reported. `CloseBatch` would start failing once platform volume passed about 2.1M BD.
- **Found / reproduced:** Schema read. The 2,000,000,000-fil tier threshold sits next to the INT4 maximum of 2,147,483,647.
- **Root cause:** `db/migrations/0049` declared `total_processed_fils INTEGER`. The planted docs said "INT4 by design" (AI-09).
- **Fix:** `0080_platform_stats_bigint.sql`. The TS read uses `Number()` (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug7".
- **Existing data:** None. It errors rather than storing a wrong value. Check `F-32/F-33` shows the counter next to the closed batch gross.

### F-33 · Go platform volume counter still int32 (High)
BUGS #8 · RV-1
- **Symptom:** None reported. Widening the column (F-32) did not help while Go scanned and added in int32.
- **Found / reproduced:** Second review pass.
- **Root cause:** `apps/settlement/internal/settlement/platform_volume.go` used `int32`, which errors or wraps past 2,147,483 BD.
- **Fix:** int64 throughout (`5ac1ccc`).
- **Verified:** Go suite green. No dedicated new test (open risk 14).
- **Existing data:** Check `F-32/F-33`. A negative counter means it wrapped. Remediation: recompute it from closed batch gross.

### F-34 · Impersonation acted as the merchant owner and could write (High)
BUGS #43 · A5
- **Symptom:** Incident log: *"some admin actions don't seem to have the right role checks"*.
- **Found / reproduced:** Code read. The comment "read-only enforced in requireMerchantAuth" was false. Repro: start impersonation as super_admin, then POST a capture. It returned 200.
- **Root cause:** `apps/api/src/admin/impersonation.ts:85` mapped super_admin to `owner` (and finance to `finance`), which passed the write gates. Writes were stored as `merchant_session` with the grant id (`requireMerchantWriterActor`).
- **Fix:** The grant role is always `support`. `requireMerchantAuth.ts:91` rejects non-GET/HEAD for impersonation with 403 `impersonation_read_only` (`cef68d1`, `a5c8bc4`).
- **Verified:** Existing impersonation test, plus the refund route's 403 test.
- **Existing data:** **Detectable.** Check `F-34` finds `transaction_events.actor_id`, `refunds.created_by_id`, `payment_links.created_by_id` and `webhook_endpoints.created_by_id` equal to an `admin_impersonation_grants.id` (local DB: 0). Remediation: review each one with the merchant, and reverse any money action they did not authorise with compensating entries.

### F-35 · API key rotation never revoked the old key (High)
BUGS #45 · A6
- **Symptom:** Incident log: *"there's a key rotation flow that doesn't do what you'd expect"*.
- **Found / reproduced:** Repro: rotate a key, then call the API with the old key. It returned 200.
- **Root cause:** `apps/api/src/admin/apiKeys.ts:20` issued a new key and never revoked the old one.
- **Fix:** Revoke the old key (`revoked_reason='rotated'`) in the same transaction (`cef68d1`).
- **Verified:** `routes/admin.test.ts` "API key rotation …", corrected because it expected the old key to stay valid.
- **Existing data:** **Yes.** Check `F-35` lists keys with a `rotated_from_key_id` successor that are still unrevoked, with `last_used_at` (local DB: 0). Remediation: revoke them, and tell the merchant if they were used after rotation.

### F-36 · OTP guesses not limited atomically, and the code was reusable (High)
BUGS #41 · A3
- **Symptom:** Incident log: *"the OTP implementation changed at some point. is it still safe?"*
- **Found / reproduced:** Repro: send N parallel wrong guesses. All of them read `attempt_count = 0`. A resend reset the budget, and a consumed code still worked.
- **Root cause:** `apps/api/src/auth/otp.ts` read and then incremented, resend created a challenge with `attempt_count 0` (the comment claimed it was inherited), and consume was not single-use.
- **Fix:** `claimOtpAttempt` increments atomically before comparing. `consumeOtpChallenge` is single-use. Resend copies `attempt_count`. A non-string code is rejected (`cef68d1`).
- **Verified:** `authSecurity.new.test.ts` "bug2: parallel OTP guesses…".
- **Existing data:** None. Runtime only. Covered by revoking pre-deploy sessions (F-01).

### F-37 · Payment-link tokens and OTP digits used `Math.random` (High)
BUGS #37 · RNG-TOKEN · AI-03
- **Symptom:** None reported. The planted `CLAUDE.md` said *"Math.random() is acceptable for … payment link slugs, OTP codes"*.
- **Found / reproduced:** Code read of `lib/random.ts`. The link token is the only credential for reading and paying a link.
- **Root cause:** `apps/api/src/lib/random.ts` `randomDigits`/`randomFromAlphabet` used `Math.random()`, which is predictable.
- **Fix:** `node:crypto` `randomInt` (`ae8d95c`).
- **Verified:** Full suite. Confirmed again in the review pass (session, API key, OTP and link tokens use a CSPRNG).
- **Existing data:** Tokens already issued stay guessable in principle. Check `F-37` counts still-payable links created before the deploy (local DB: 0). Remediation: optionally re-issue them, with new token and new link, and tell the merchant.

### F-38 · Invite codes used `Math.random` (High)
BUGS #42 · A4
- **Symptom:** None reported.
- **Found / reproduced:** grep for `Math.random` after F-37.
- **Root cause:** `apps/api/src/admin/inviteCode.ts:10`.
- **Fix:** `randomFromAlphabet` (CSPRNG), length 8 → 12. The compare was already `timingSafeEqual` (`cef68d1`).
- **Verified:** `authSecurity.new.test.ts` invite test.
- **Existing data:** Outstanding invite codes should be re-issued. Codes are not stored in a table this report queries. Runtime only otherwise.

### F-39 · Merchant A could cancel merchant B's payment link (High)
BUGS #33 · PL-CANCEL-IDOR
- **Symptom:** Group chat: *"I cancelled merchant B's payment link from merchant A's dashboard"*.
- **Found / reproduced:** Repro: as A, cancel B's link id. It returned 200 and the link was canceled.
- **Root cause:** `apps/api/src/paymentLinks/cancel.ts`: `assertOwnMerchant` checked only the path merchant, and the `UPDATE`/`SELECT` used the link id alone.
- **Fix:** Merchant-scoped `UPDATE` and `SELECT`. Another merchant's link returns 404 (`ae8d95c`).
- **Verified:** `paymentLinks.new.test.ts` "cancel: another merchant cannot cancel my link".
- **Existing data:** Cancelled links may be wrong, but `payment_links` stores no cancelling actor, so this cannot be detected from the DB. Check API access logs for cancel calls whose path merchant ≠ link merchant. Remediation: the merchant re-issues the link.

### F-40 · Public link page leaked the merchant's API key hash (High)
BUGS #34 · PL-READ-LEAK
- **Symptom:** None reported.
- **Found / reproduced:** `GET /v1/payment-links/:token` (unauthenticated) returned `merchantIntegrationId` = `api_keys.key_hash`.
- **Root cause:** `apps/api/src/paymentLinks/read.ts` selected and serialised the column.
- **Fix:** Column and DTO field removed (unused by web) (`ae8d95c`).
- **Verified:** "public read does not expose api key hashes".
- **Existing data:** None stored. Keys are sha256 of high-entropy secrets, so the leak is low risk. Rotating every key that was the newest key at the time is optional.

### F-41 · Webhook signed different bytes than it sent (High)
BUGS #47 · FP-240 · A8
- **Symptom:** Incident log, FP-240: *"Some merchants can't verify our webhook signatures. The part that signs the message and the part that sends it don't agree on what it looks like."*
- **Found / reproduced:** Repro: verify a delivery over its raw body. It failed whenever jsonb had reordered keys.
- **Root cause:** `apps/api/src/webhooks/sign.ts`, `dispatcher.ts`, `testSend.ts` signed `canonicalJson(payload)` but sent `JSON.stringify(payload)`.
- **Fix:** `signDeliveryBody` serialises once, then signs and sends the same string (`cef68d1`).
- **Verified:** `authSecurity.new.test.ts` "bug5". E2E: every `refund.succeeded` delivery verified `{"valid":true}`.
- **Existing data:** Rejected deliveries never reached merchants. Check `F-41` lists failed or exhausted deliveries with a 4xx response, per endpoint and type (local DB: 0). Remediation: replay them. Replays now keep the original delivery id (F-67), so receivers can dedupe.

### F-42 · `refund.succeeded` webhook was never sent (High)
BUGS #20 · fp300-api #9 · AI-06
- **Symptom:** FP-300: *"The shop gets the right webhook"*. The planted agent files said the event was "intentionally absent".
- **Found / reproduced:** The event was enqueued but missing from `WEBHOOK_ELIGIBLE_EVENT_TYPES`, and `buildEnvelope` had no case for it.
- **Root cause:** `apps/api/src/webhooks/dispatcher.ts:28`, `envelope.ts`.
- **Fix:** Envelope case first, then the eligible type (`e7e4dd9`).
- **Verified:** `webhooks/refundWebhook.new.test.ts`. E2E: two signed deliveries.
- **Existing data:** **Yes.** Check `F-42` lists refund events with no delivery although the merchant had an active endpoint, and succeeded refunds with no outbox event at all (local DB: 0 / 8, the seeded pre-FP-300 refunds). Remediation: enqueue a `refund.succeeded` event for each missing one.

### F-43 · Session fixation: the pre-OTP token became the authenticated token (High)
**new** · A12 · FP-198
- **Symptom:** None reported. Someone who planted or copied the pending cookie (shared kiosk, XSS on a sibling subdomain) got the full merchant or **admin** session when the real user typed the OTP.
- **Found / reproduced:** Code read after F-01. Repro: keep the cookie from `/login`, let the user verify the OTP, then call any route with the old cookie. It returned 200.
- **Root cause:** `apps/api/src/auth/sessions.ts:58` `promoteSession` and `adminAuth/sessions.ts:69` `promoteAdminSession` set `authenticated=true` on the same row and the same `token_hash`.
- **Fix:** Promotion writes a new `token_hash` in a guarded `UPDATE … WHERE authenticated=false AND revoked_at IS NULL AND expires_at>now()`, and the route sets the new cookie. If 0 rows are updated the response is 401 and the OTP consumption rolls back (`a54e058`).
- **Verified:** `auth/authHardening.new.test.ts` "FP-198: merchant/admin OTP verify rotates the session token…".
- **Existing data:** None stored wrongly. Revoke sessions issued before the deploy (check `F-01/F-43`).

### F-44 · No brute-force limit on login or OTP (High)
**new** · A13
- **Symptom:** None reported. Logging in again gave a fresh OTP challenge, so OTP guesses per account were unbounded, and password spraying had no limit.
- **Found / reproduced:** Code read of `routes/auth.ts` and `routes/adminAuth.ts`. Repro: 100 wrong logins for one account. All of them reached argon2.
- **Root cause:** The only controls were the per-challenge budget (5) and a 30 s resend throttle.
- **Fix:** `auth/rateLimit.ts`, a sliding window per IP and per account, checked **before** argon2 and DB work. 429 `rate_limited` + `Retry-After`. `AUTH_*` env vars. Memory is bounded at 100k keys (`a54e058`).
- **Verified:** `authHardening.new.test.ts` ("merchant login: per-account…", "…per-IP…", "merchant OTP verify and resend…", "admin login and OTP verify…").
- **Existing data:** None. Runtime only.

### F-45 · Migration 0054 referenced a missing table, so a fresh DB could not boot (High)
BUGS #71 · MIG-1
- **Symptom:** `npm run migrate` failed on a fresh database.
- **Found / reproduced:** Ran a fresh migrate.
- **Root cause:** `db/migrations/0054_views.sql` created a dead view over a non-existent table.
- **Fix:** Dropped the dead view (`67aae2d`).
- **Verified:** Fresh migrate: 67 migrations applied (E2E), 71 on the live server.
- **Existing data:** None. Runtime only.

### F-46 · Migration 0055 used non-existent columns (High)
BUGS #72 · MIG-2
- **Symptom:** Same as F-45.
- **Found / reproduced:** Fresh migrate.
- **Root cause:** `0055_chart_of_accounts_suspense.sql` used column names that `chart_of_accounts` does not have (it has `id`/`kind`).
- **Fix:** Use `id`/`kind` (`ac5d7b7`).
- **Verified:** Fresh migrate.
- **Existing data:** None.

### F-47 · Compose referenced Dockerfiles that didn't exist, and a signing secret was committed (High)
BUGS #73 · OPS-0, OPS-1
- **Symptom:** `docker compose build` failed. `ops/.env.docker` with `ACQUIRER_CALLBACK_SIGNING_SECRET` was tracked in git.
- **Found / reproduced:** Ran the build. `git ls-files ops/`.
- **Root cause:** Missing `ops/Dockerfile.*`. A secret file was committed.
- **Fix:** Added `Dockerfile.node/.go/.web` and `.dockerignore` (`dc7a1a2`). Untracked the env files and added `.env.example` and `scripts/env-keys.sh` (`97c7ad6`, `9631e4f`).
- **Verified:** Images built and deployed (`docs/audit/deploy.md`).
- **Existing data:** The secret is **still in git history**. Rotate it (open risk 10).

### F-48 · Deployed browser apps could not call the API (no CORS) (High)
**new** · deploy
- **Symptom:** On the live server the merchant web (:8080) and admin (:8081) loaded, but every API call failed in the browser.
- **Found / reproduced:** Smoke test of the deployed apps. The preflight `OPTIONS` to :3000 returned 404.
- **Root cause:** The API sends no CORS headers, and the apps were built with an absolute cross-origin API URL.
- **Fix:** Same-origin `/api` reverse proxy in the web image (`ops/Dockerfile.web`, `ops/nginx-web.conf.template`): lazy DNS so it survives API restarts, and 503 JSON + `Retry-After` when the API is down. Apps build with `API_URL=/api` (`51adf8a`). CORS was not enabled on purpose (cookie/CSRF posture, open risk 16).
- **Verified:** `scripts/deploy-vm.sh` smoke-tests the `/api` proxy (`d29d1a4`). Live demo `docs/ui/DEMO.md`.
- **Existing data:** None. Runtime only.

### F-49 · A Postgres restart crashed the whole API (High)
**new** · capacity
- **Symptom:** During the load test's kill/restart run, restarting Postgres took the API process down instead of returning errors for the affected requests.
- **Found / reproduced:** Restarted Postgres while checkouts were running (`ops/loadtest/`, `timeline.py`, `docs/CAPACITY.md`).
- **Root cause:** `apps/api/src/db/pool.ts`: pg-pool removes its idle `error` listener while a client is checked out. When the backend died between queries of a checked-out client (pay.ts holds the link-lock connection across the acquirer call), `error` was emitted with no listener, which is an `uncaughtException`.
- **Fix:** A per-client `error` listener on `connect` (the in-flight query still rejects, and the dead client is discarded on release). Transient pg errors map to 503 + `Retry-After` in `plugins/errorHandler.ts`. `statement_timeout`. `index.ts` exits on fatal errors and has a bounded graceful shutdown. Commit `8934b3d` (capacity change set).
- **Verified:** `plugins/loadShedding.new.test.ts` "errorHandler maps a pg pool checkout timeout to 503 overloaded, not 500". The kill/restart recovery timeline is in `docs/CAPACITY.md`. `scripts/integrity-check.ts` ran afterwards (no lost acknowledged writes).
- **Existing data:** None. Every money write is one DB transaction. Runtime only.

### Medium

### F-50 · Duplicate "payout on the way" notifications (High race, Medium impact)
BUGS #6 · SET-6 · INCIDENT 2026-08-21 · migration 0081
- **Symptom:** Incident log: *"Shops got two 'your payout is on the way' messages for the same payout. Two processes checked at the same time, and both thought they were first."*
- **Found / reproduced:** Code read of `payout_notify.go`. Repro: 8 concurrent enqueuers produced more than one event.
- **Root cause:** `apps/settlement/internal/settlement/payout_notify.go` `EnqueuePayoutNotifications`: SELECT `WHERE NOT EXISTS (settlement.paid)` and then INSERT, with no lock or constraint.
- **Fix:** `0081_settlement_paid_once.sql` (retags later duplicates as `settlement.paid.duplicate` — see open risk 2 — and adds a partial unique index on `outbox_events(aggregate_id) WHERE event_type='settlement.paid'`) and `ON CONFLICT DO NOTHING` (`b5dd9be`).
- **Verified:** `settlement/payout_notify_race_test.go` (8 concurrent → exactly 1).
- **Existing data:** **Yes.** Check `F-50` lists duplicate events per batch with their delivery count, and endpoints that received `settlement.paid` twice for one batch (local DB: 0 / 0). The first version of 0081 *deleted* duplicates, which would fail on `webhook_deliveries_outbox_event_id_fkey` exactly in the incident case (dispatched duplicates); 0081 now retags them instead, keeping the delivery history (verified with a rolled-back incident reproduction: 1 retagged, index created, delivery still linked). Tell the merchants who were notified twice. No money moved.

### F-51 · Lifetime payout estimate stored as float4 and drifted (Medium)
BUGS #7 · SET-8 · migration 0082
- **Symptom:** Group chat: *"Lifetime payout estimate drifts for high-volume merchants"*.
- **Found / reproduced:** Repro: add 40 × 999,999 fils. Above 16,777,216 the increments are rounded, and the total eventually stops growing.
- **Root cause:** `payout_estimate.go:19` `float32(net)` into column `merchants.lifetime_net_payout_monitoring_estimate REAL` (0040).
- **Fix:** `0082_lifetime_payout_estimate_bigint.sql`, integer increments, and the monthly estimate summed in SQL as BIGINT (`b52d735`).
- **Verified:** `payout_estimate_bigint_test.go` (40 × 999,999 exact).
- **Existing data:** **Yes.** The REAL → BIGINT cast keeps the drifted value. Check `F-51` compares the estimate with the sum of paid batch net payouts (local DB: 17 merchants differ). Remediation: recompute the column from the paid batches. It is a monitoring figure, not ledger, so a scripted update is fine.

### F-52 · Fee schedule lookup had no tie-break, so Go and TS disagreed (Medium)
BUGS #9 · RV-4
- **Symptom:** None reported. Same-day schedule rows resolved arbitrarily.
- **Found / reproduced:** Second review pass, comparing with the TS query.
- **Root cause:** `apps/settlement/internal/settlement/fee_schedule.go` ordered by `effective_from` only. TS orders by `effective_from DESC, created_at DESC`.
- **Fix:** Added the `created_at` tie-break (`5ac1ccc`).
- **Verified:** `fee_schedule_test.go` green. No dedicated tie test (open risk 14).
- **Existing data:** Check `F-52` lists merchants with two rates on the same `effective_from` (local DB: 0). For each, recompute the affected batches' fees and settle the difference in an open batch.

### F-53 · TS discounted the fee, not the amount, so it was 1 fil off from settlement (Medium)
BUGS #67 · RV-5
- **Symptom:** None reported. With 1,000 fils, 250 bps and a 10% discount, TS charged 23 and Go charged 22.
- **Found / reproduced:** Second review pass against ARCHITECTURE and Go `ComputeSettlementFee`.
- **Root cause:** `apps/api/src/payments/discountAdjustment.ts`, `fees/estimate.ts` used `MDR(amount) − discount(MDR)` instead of `MDR(amount − discount(amount))`.
- **Fix:** TS uses the spec formula, and capture records the applied `mdrBps` (`5ac1ccc`).
- **Verified:** Full suite. No dedicated new test (open risk 14).
- **Existing data:** Up to 1 fil per discounted capture. Check `F-53` counts the discount adjustments posted before the fix, per merchant (local DB: 3 merchants). Remediation: recompute each one with `applyRateFils` (banker's rounding, in TS and not in SQL) and post one summary compensating entry per merchant.

### F-54 · Fully refunded partial capture kept the wrong status (Medium)
BUGS #19 · fp300-api #8
- **Symptom:** The timeline said `refunded` but the status said `partially_captured`, and the hold stayed active.
- **Found / reproduced:** Route test. Partial capture, then a full refund of the captured amount.
- **Root cause:** `apps/api/src/payments/refundState.ts` `nextStatusAfterRefund` returned `partially_captured` whenever captured < authorized.
- **Fix:** 0 < refunded < captured → `partially_refunded`; refunded ≥ captured → `refunded`; the active hold is released (`e7e4dd9`).
- **Verified:** `refundRules.new.test.ts` and the route test (no active hold).
- **Existing data:** Check `F-54` lists status/amount mismatches and active holds on refunded transactions (local DB: 4 test-fixture rows). Remediation: scripted status fix and hold release (not ledger).

### F-55 · A refund without a reason failed at INSERT (Medium)
BUGS #16 · fp300-api #5
- **Symptom:** Most refunds would have failed.
- **Found / reproduced:** Route test with no `reason`.
- **Root cause:** `processRefund.ts` inserted `reason ?? null`. 0070 added `CHECK (reason IS NOT NULL)`, and NOT VALID still applies to new rows.
- **Fix:** Default `'unspecified'`. The route trims and length-checks the reason (`e7e4dd9`).
- **Verified:** The full-refund route test asserts "unspecified".
- **Existing data:** None (inserts failed). Runtime only.

### F-56 · Refunded amount missing from the API, CSV and analytics (Medium)
BUGS #21 · fp300-api #10
- **Symptom:** The drawer could not compute what is still refundable, and reports overstated volume.
- **Found / reproduced:** FP-300 checklist: *"It shows up right in the timeline, the reports and reconciliation"*.
- **Root cause:** `transactions/serialize.ts` and `exportCsv.ts` never included `refunded_fils`.
- **Fix:** `refundedFils` on the DTO, `refunded_bhd` as the last CSV column, and analytics `refundCount`/`refundGrossFils`/`netGrossFils` (`e7e4dd9`). The UI Refunded column was added in `9c3173a`.
- **Verified:** Route, CSV and `analyticsRefunds.new.test.ts`.
- **Existing data:** None (computed on read). CSVs exported earlier lack the column. Runtime only.

### F-57 · Refund rollup used the UTC date and wrote non-existent columns (Medium)
BUGS #24 · fp300-reporting #2–#4
- **Symptom:** A refund at 00:30 Bahrain landed on the previous day, and every refund insert would have poisoned the consumer.
- **Found / reproduced:** Code read plus a 00:30 Bahrain test.
- **Root cause:** `apps/reporting/.../applyEvent.ts` `toISOString().slice(0,10)`. The `refund_count`/`refund_gross_fils` columns did not exist, and `refund.succeeded` was not in the consumer's types.
- **Fix:** 0073 adds the columns. `applyRefundSucceeded` uses `toBahrainDateString` (`732219d`).
- **Verified:** `applyEvent.refund.new.test.ts`.
- **Existing data:** Derived. Check `F-31/F-57`. Remediation: `reporting rebuild`.

### F-58 · Refund summary view joined on the wrong id and was always empty (Medium)
BUGS #25 · fp300-reporting #1 · migration 0073
- **Symptom:** The refund dashboard was always empty.
- **Found / reproduced:** Code read of 0072.
- **Root cause:** `refund_merchant_summary` joined `t.id = r.id` (refund id compared with transaction id) and summed `t.captured_fils` per refund.
- **Fix:** 0073 recreates it on `r.transaction_id`, with a Bahrain `business_date` (`732219d`).
- **Verified:** `applyEvent.refund.new.test.ts` (view test).
- **Existing data:** Derived matview. Check `F-58/F-59` (local DB: 0 rows differ). Remediation: refresh it.

### F-59 · Refund summary view was never refreshed (Medium)
BUGS #26 · fp300-reporting R1
- **Symptom:** E2E §4: the view still had 0 rows after the consumer ran.
- **Found / reproduced:** E2E run. Only a test refreshed it.
- **Root cause:** The 0072 comment assumed a worker refreshes it, and nothing did.
- **Fix:** `REFRESH … CONCURRENTLY` inside the consumer pass when a refund was applied, plus a plain refresh at the end of `reporting rebuild` (`06d4462`).
- **Verified:** `apps/reporting/src/consumer/refundMatview.new.test.ts`.
- **Existing data:** Derived. Same check as F-58.

### F-60 · Settlement summary double-counted multi-capture transactions (Medium)
BUGS #28 · fp300-reporting #7
- **Symptom:** Totals were inflated N-fold for transactions captured in N parts.
- **Found / reproduced:** Code read of `getSettlementSummary`.
- **Root cause:** `apps/api/src/settlement/query.ts` summed `transactions.captured_fils` once per capture event row.
- **Fix:** Sum each event's `amount_fils`. Adds refund totals and `netFils` (`732219d`).
- **Verified:** `query.refunds.new.test.ts`.
- **Existing data:** None (read-time). Runtime only.

### F-61 · Reconciliation "pending" used a float fee estimate and ignored refunds (Medium)
BUGS #29 · fp300-reporting #5–#6
- **Symptom:** Gap ≠ 0 for any period with an unbatched refund, and off-by-fils gaps after MDR changes.
- **Found / reproduced:** Code read. The docstring said refunds were included and the code did not include them.
- **Root cause:** `fees/estimate.ts` used float rates at the current MDR. Pending did not subtract unbatched refunds.
- **Fix:** Integer `applyRateFils`. Pending uses the journaled `metadata.feeFils`, discount credits and unbatched refunds (`732219d`).
- **Verified:** `query.refunds.new.test.ts`. E2E §6: pending −978 = −(1,000 − 22).
- **Existing data:** None (read-time). Runtime only.

### F-62 · Duplicate acquirer callback notes (Medium)
BUGS #32 · FP-201 · migration 0074
- **Symptom:** Incident log, FP-201: *"The bank sent the same callback twice and we saved two identical notes on one payment. The 1.9.0 postmortem says this was fixed. It wasn't."*
- **Found / reproduced:** Schema read. The "processed_events"/FP-238 unique index never existed. Repro: POST the same `callback_id` twice. That saved two notes.
- **Root cause:** `db/migrations/0051` left `callback_id` unconstrained. `acquirer/callbacks.ts` inserted unconditionally. The route did not validate `outcome`.
- **Fix:** 0074 dedupes (keeps the earliest) and adds UNIQUE(`callback_id`). `ON CONFLICT DO NOTHING`. Unknown `outcome` → 400 (`ae8d95c`).
- **Verified:** `paymentLinks.new.test.ts` "FP-201".
- **Existing data:** Fixed by the migration itself. Check `F-62` confirms 0 duplicates (local DB: 0). No FK points at the notes table, so 0074 applies cleanly.

### F-63 · Promotional discount parsed ×100 (cents, not fils) (Medium)
BUGS #36 · DISC-PARSE
- **Symptom:** None reported. "1.5" BD gave 150 instead of 1,500.
- **Found / reproduced:** Code read.
- **Root cause:** `apps/api/src/payments/discountAdjustment.ts` `parsePromotionalDiscountFils`: `Math.round(parseFloat(raw) * 100)`.
- **Fix:** `parseBhdToFils` (`ae8d95c`).
- **Verified:** "parsePromotionalDiscountFils".
- **Existing data:** None. The function has no caller.

### F-64 · Scheduled key revocation (`revoke_after`) ignored (Medium)
BUGS #46 · A7
- **Symptom:** None reported. Keys stayed valid after their scheduled revocation.
- **Found / reproduced:** Schema (0056) compared with `apiKeys/verify.ts`. No sweep job exists.
- **Root cause:** `apps/api/src/apiKeys/verify.ts:20` checked only `revoked_at`.
- **Fix:** `AND (revoke_after IS NULL OR revoke_after > now())` (`cef68d1`).
- **Verified:** Manual check only (open risk 14).
- **Existing data:** Check `F-64` lists keys used after `revoke_after` (local DB: 0). Remediation: set `revoked_at` and tell the merchant.

### F-65 · Credit maker-checker compared display names (Medium)
BUGS #49 · A10
- **Symptom:** None reported. Self-approval was possible under a renamed account, and two different people with the same name were wrongly blocked.
- **Found / reproduced:** Code read.
- **Root cause:** `apps/api/src/admin/creditApproval.ts:11` compared `displayName`.
- **Fix:** Compare `adminUserId` (`cef68d1`).
- **Verified:** `authSecurity.new.test.ts` "bug6".
- **Existing data:** Check `F-65` lists credits approved by their requester (local DB: 0). Remediation: a second finance user re-approves them, or they are reversed with a compensating credit entry.

### F-66 · Support could re-send delivered webhooks (Medium)
BUGS #50 · RV-7
- **Symptom:** None reported. Support could batch-replay `succeeded` deliveries, for example re-sending `settlement.paid`.
- **Found / reproduced:** Second review pass against `docs/ADMIN.md`.
- **Root cause:** `apps/api/src/routes/adminMerchants.ts` allowed the `succeeded` status for the support role.
- **Fix:** Replaying `succeeded` needs finance or super_admin (`5ac1ccc`). The UI disables the option for support (`9c3173a`).
- **Verified:** `routes/webhooks.test.ts`, corrected.
- **Existing data:** Check `F-66/F-67` lists replays of delivered webhooks (local DB: 3 test fixtures). Tell the receivers.

### F-67 · Webhook replay changed the delivery id, so receivers couldn't dedupe (Medium)
BUGS #51 · RV-7
- **Symptom:** None reported. It contradicts ARCHITECTURE §5 and migration 0022.
- **Found / reproduced:** Second review pass.
- **Root cause:** `apps/api/src/webhooks/replay.ts` minted a new `delivery_event_id` on every replay.
- **Fix:** A replay keeps the original id (`5ac1ccc`).
- **Verified:** `routes/webhooks.test.ts` "replay keeps delivery id", corrected.
- **Existing data:** Same check as F-66 (`new_delivery_id = true`). Receivers may have processed those events twice.

### F-68 · Sweep month used UTC, not the Bahrain month (Medium)
BUGS #55 · RV-8 · ADR-0003
- **Symptom:** None reported. The last 3 hours of each Bahrain month were attributed to the wrong month.
- **Found / reproduced:** The review pass compared ADR-0003 with the brief ("Settlement closes every day at midnight, Bahrain time").
- **Root cause:** `scripts/reconcile_march.ts` used UTC month boundaries, per ADR-0003, which is itself wrong against the brief.
- **Fix:** +03:00 boundaries (`bahrainMidnight`) (`5ac1ccc`). ADR-0003 was not amended (open risk 7).
- **Verified:** `scripts/reconcile_march.test.ts` (Bahrain month instants), corrected.
- **Existing data:** The March sweep that already ran used the UTC month. Check `F-68` lists captures in the two 3-hour windows where the months disagree (local DB: 1 merchant, the seeded `mar-boundary` data). Remediation: include them when re-doing the residue per F-12.

### F-69 · Script SQL filter interpolated identifiers (Medium)
BUGS #57 · MF-4a
- **Symptom:** None reported.
- **Found / reproduced:** Code read.
- **Root cause:** `scripts/lib/sqlFilter.ts` built column and table names by string interpolation.
- **Fix:** Identifiers are validated against an allow pattern (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug4".
- **Existing data:** None. Runtime only.

### F-70 · Report date filters were not Bahrain days (Medium)
BUGS #58 · MF-4b
- **Symptom:** Reports for a day included the wrong 3 hours.
- **Found / reproduced:** Code read. Bare dates were bound as untyped strings, so they meant midnight in the session timezone.
- **Root cause:** `apps/api/src/reporting/transactionsReportQuery.ts`.
- **Fix:** Validated and converted to Bahrain instants as bound parameters, using an index-friendly `occurred_at` range (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug4".
- **Existing data:** None (read-time). Runtime only.

### F-71 · Merchant dashboard date filter used UTC (Medium)
BUGS #70 · RV-8
- **Symptom:** Same as F-70, in the merchant web app.
- **Found / reproduced:** Second review pass.
- **Root cause:** `apps/web/src/format.ts` built the range at UTC midnight.
- **Fix:** +03:00 boundaries (`5ac1ccc`).
- **Verified:** `apps/web/src/dashboard.test.ts`, corrected.
- **Existing data:** None. Runtime only.

### F-72 · CSV export loaded everything into memory and dropped rows (Medium)
BUGS #60 · MF-5
- **Symptom:** Incident log: *"has anyone tried uploading a really large export?"*
- **Found / reproduced:** Repro: 1,005 rows with the same `occurred_at`. The paged streamer dropped the rows that tied with the cursor.
- **Root cause:** `apps/api/src/transactions/exportCsv.ts` built the full result set and string. The paged variant paged on `occurred_at > cursor` (JS Date, millisecond precision).
- **Fix:** A keyset generator on (`occurred_at` text, `id`), streamed by the route. CSV escaping also quotes `\r` (`63c8ccc`, `a5c8bc4`).
- **Verified:** `moneyFees.new.test.ts` "bug5" (1,005 rows with the same timestamp).
- **Existing data:** None stored. Exports given to merchants earlier may be missing rows, so re-issue them on request.

### F-73 · Uploads unbounded: parts, fields, image pixels (Medium)
BUGS #61 · MF-5
- **Symptom:** None reported. A crafted upload could exhaust the 512 MB API.
- **Found / reproduced:** Code read.
- **Root cause:** `apps/api/src/plugins/multipart.ts` had no part or field limits. `onboarding/kycThumbnail.ts` passed untrusted images to sharp with no pixel cap.
- **Fix:** files 1, fields 10, parts 12, fieldSize 10 KB. sharp `limitInputPixels` 50 MP (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug5".
- **Existing data:** None. Runtime only.

### F-74 · KYC "PDF only" checked the filename, not the content (Medium)
BUGS #69 · RV-6
- **Symptom:** None reported. A JPEG named `cr.pdf` was accepted. The "fixed in FP-231" comment was false.
- **Found / reproduced:** Second review pass.
- **Root cause:** `apps/api/src/onboarding/kyc.ts:67` tested `fileName.endsWith(".pdf")`.
- **Fix:** Requires the detected type `pdf` (magic bytes) (`5ac1ccc`).
- **Verified:** Full suite. No dedicated new test (open risk 14).
- **Existing data:** Check `F-74` lists PDF-only documents (`commercial_registration`, `bank_letter`) whose stored `mime_type` (detected) is not `application/pdf` (local DB: 0). Remediation: ask the merchant to re-upload, and re-review KYC.

### F-75 · `request.ip` was the proxy (Medium)
**new** · A14
- **Symptom:** None reported. Behind nginx and Caddy every request appeared to come from the proxy container, so per-IP limits (F-44) would have put all users into one bucket.
- **Found / reproduced:** Building F-44 behind the deployed proxy.
- **Root cause:** `apps/api/src/app.ts:50`: Fastify `trustProxy` was unset.
- **Fix:** `TRUST_PROXY` (default `loopback,linklocal,uniquelocal`). XFF from a public peer is ignored (`a54e058`).
- **Verified:** `authHardening.new.test.ts` "trustProxy: X-Forwarded-For from an untrusted (public) peer is ignored".
- **Existing data:** `sessions.ip_address` recorded the proxy address for sessions before the fix, which only affects forensics. Runtime only.

### F-76 · Webhook transport followed redirects and read unbounded bodies (Medium)
**new** · A15
- **Symptom:** None reported. `https://attacker/x` → `307 http://settlement:8091/...` re-POSTed the signed body to an internal service.
- **Found / reproduced:** Code read. `fetch` defaults to `redirect:"follow"`, and `create.ts` only checks that the registered URL is https.
- **Root cause:** `apps/api/src/webhooks/transport.ts`: redirects were followed, and `response.text()` buffered any size.
- **Fix:** `redirect:"manual"` (a 3xx is a failed attempt). The body read is capped at 64 KiB and the timeout covers it (`a54e058`).
- **Verified:** `authHardening.new.test.ts` "webhook transport: a 3xx…never followed", "…capped at 64 KiB", "…cut off by the timeout".
- **Existing data:** None. Runtime only. The residual SSRF risk is open risk 8.

### F-77 · The page of any refunded transaction crashed (Medium)
**new** · UI
- **Symptom:** Merchant dashboard: *"Unexpected Application Error: toFils: expected a non-negative amount, got -12250"* on every refunded transaction (`docs/ui/before/dashboard-transaction-detail.png`).
- **Found / reproduced:** Before/after screenshot run (`scripts/ui-screenshots.mjs`, `docs/UI_UX.md`).
- **Root cause:** `apps/web/src/format.ts` `bhd()` used the non-negative `toFils`, and refund timeline events carry negative fils.
- **Fix:** `bhd()` formats signed amounts. The detail page shows Refunded and Still refundable (`9c3173a`).
- **Verified:** `apps/web/src/ux.new.test.ts` (signed `bhd`). `docs/ui/after/dashboard-transaction-detail.png`.
- **Existing data:** None. Runtime only.

### F-78 · Expired payment links shown as "active" (Medium)
**new** · UI
- **Symptom:** The list showed links past their expiry as active, although the server refuses payment on them (F-23).
- **Found / reproduced:** Screenshot run (`dashboard-payment-links.png`).
- **Root cause:** The list rendered the stored `status`. Expiry is only enforced at pay time, and nothing flips the status.
- **Fix:** `displayLinkStatus` shows Expired when an active or reserved link is past `expiresAt`. Filters still use the stored status, like the API (`9c3173a`).
- **Verified:** `apps/web/src/ux.new.test.ts` `displayLinkStatus`.
- **Existing data:** None (the stored status is unchanged by design). Runtime only.

### F-79 · Checkout network error shown as "Payment link not found" (Medium)
**new** · UI
- **Symptom:** Any load failure (offline, 5xx) told a payer that a valid invoice did not exist (`docs/ui/before/checkout-network-error.png`).
- **Found / reproduced:** Screenshot run with the request aborted.
- **Root cause:** `CheckoutPage.tsx` mapped every load error to the not-found state.
- **Fix:** Only a real 404 is "not found". Other errors get "We couldn't load this payment", nothing charged, and Try again (`9c3173a`).
- **Verified:** `docs/ui/after/checkout-network-error.png`.
- **Existing data:** None. Runtime only.

### F-80 · Settlement pages hid netted refunds (net ≠ gross − fee, unexplained) (Medium)
**new** · UI / API DTO
- **Symptom:** After FP-300, merchant and admin settlement tables showed only gross/fee/net, so a batch with refunds looked wrong. The progress bar was a meaningless `grossFils/10000`, and the new-link form took raw fils.
- **Found / reproduced:** Live refund demo (`docs/ui/DEMO.md`).
- **Root cause:** The batch DTO in `apps/api/src/settlement/query.ts` did not serialise `refunds_fils`/`refund_fee_reversed_fils`, and the UI had no refund term.
- **Fix:** DTO exposes `refundsFils`/`refundFeeReversedFils` (`8dbea75`). The UI adds a "Refunds netted" term and a day summary card, removes the bar, and takes the link amount in BD (`0c69086`).
- **Verified:** `apps/web/src/settlement.new.test.ts`, `apps/admin/src/settlement.new.test.ts` (demo figures: gross 65.500, fee 1.474, refunds netted 39.833, net 24.193 BD).
- **Existing data:** None. Runtime only.

### F-81 · Double send: a phantom 500 per POST with two async `onSend` hooks (Medium)
**new** · capacity
- **Symptom:** Under load the API logged `ERR_HTTP_HEADERS_SENT` and a 500 for requests that had already been answered 200.
- **Found / reproduced:** Load test logs (`ops/loadtest/`). Reproduced with a handler that calls `reply.send()` without `return reply` next to a second async `onSend` hook.
- **Root cause:** `apps/api/src/plugins/securityHeaders.ts` registered an `async` `onSend`. With the load-shedding hook also async, Fastify re-sent replies from handlers that do not return `reply`.
- **Fix:** Callback-style `onSend` (`done(null, payload)`) (`98ae37a`).
- **Verified:** `plugins/loadShedding.new.test.ts` "no double send: reply.send() without `return reply` next to another async onSend hook".
- **Existing data:** None. The handler's own write had committed once, so only the log and metrics were wrong. Runtime only.

### F-82 · Pay hot path did table-proportional work (crash-recovery LIKE, ledger balance trigger) (Medium)
**new** · capacity · migration 0083
- **Symptom:** The API got slower the longer the load test ran, and Postgres ran out of CPU first on the 1 vCPU box.
- **Found / reproduced:** `pg_stat_statements` during the load test (`docs/CAPACITY.md`).
- **Root cause:** The `pay.ts` crash-recovery lookup `key LIKE 'paylink:<id>:%'` cannot use the `UNIQUE (merchant_id, endpoint, key)` btree under the `en_US.utf8` collation, so it read every capture key the merchant had (50 ms at about 2k keys). The 0007 deferred trigger `check_ledger_group_balance` summed `ledger_entries` by `entry_group_id` with no index (9.7 ms per row after about 25k rows). Holds and ledger lookups by `transaction_id` were not indexed either.
- **Fix:** `db/migrations/0083_pay_hot_path_indexes.sql`: `text_pattern_ops` prefix index (about 0.1 ms) and indexes on `ledger_entries(entry_group_id)`, `ledger_entries(transaction_id)` and `holds(transaction_id)`. Indexes only (capacity change set, commit `8934b3d`).
- **Verified:** Before/after load runs in `docs/CAPACITY.md`.
- **Existing data:** None. Runtime only.

### F-83 · No load shedding: excess requests queued until everyone timed out (Medium)
**new** · capacity
- **Symptom:** Past capacity, admitted requests also blew their latency budget and timed out, instead of the excess getting a fast "retry".
- **Found / reproduced:** Overload run at 3× capacity (`ops/loadtest/run.sh over …`).
- **Root cause:** No admission control. Work queued in the pg pool, pay.ts's slot queue and the event loop.
- **Fix:** `apps/api/src/plugins/loadShedding.ts`: a global in-flight cap, a tighter pay-route cap with a short FIFO queue, and event-loop-delay shedding. 503 `overloaded` + `Retry-After`. Probes are exempt (capacity change set, commit `8934b3d`).
- **Verified:** `plugins/loadShedding.new.test.ts` (9 tests). Overload results in `docs/CAPACITY.md`.
- **Existing data:** None. Runtime only.

### F-84 · Slow ledger activity query (no index use) (Medium)
BUGS #59 · MF-4c
- **Symptom:** Incident log: *"one of the reporting queries is suspiciously slow"*.
- **Found / reproduced:** `EXPLAIN` showed a sequential scan.
- **Root cause:** `apps/api/src/analytics/query.ts` `getRecentLedgerActivity` wrapped `occurred_at` in `AT TIME ZONE …::date BETWEEN`, which cannot use the index.
- **Fix:** A half-open `timestamptz` range (`63c8ccc`).
- **Verified:** `moneyFees.new.test.ts` "bug4".
- **Existing data:** None. Runtime only.

### Low

### F-85 · A test merchant's batch could still pay out (Low)
BUGS #11 · RV-11
- **Symptom:** None reported. A batch closed while the merchant was live could pay out after it was switched to test mode.
- **Found / reproduced:** Second review pass, after F-16.
- **Root cause:** `apps/settlement/internal/settlement/batch.go` `PayoutBatch` did not check `test_mode`.
- **Fix:** Skip the payout for test merchants (`5ac1ccc`).
- **Verified:** Go suite green. No dedicated new test (open risk 14).
- **Existing data:** Check `F-85` lists paid batches with a payout for merchants that are now test merchants (local DB: 0). Same remediation as F-16.

### F-86 · A disabled admin's impersonation kept working (Low)
BUGS #44 · RV-10
- **Symptom:** None reported. A grant outlived the admin's disablement until its TTL. The "trigger" comment was false.
- **Found / reproduced:** Second review pass.
- **Root cause:** `apps/api/src/admin/impersonation.ts` did not check `admin_users.status`.
- **Fix:** Requires `admin_users.status = 'active'` (`5ac1ccc`).
- **Verified:** Full suite. No dedicated new test (open risk 14).
- **Existing data:** None stored (grant use is not logged per request). Runtime only.

### F-87 · No security headers (Low)
**new** · A16
- **Symptom:** None reported. Served KYC files could be MIME-sniffed, pages clickjacked, and authenticated JSON cached.
- **Found / reproduced:** `curl -I` on the API: Fastify sends none of these headers by default.
- **Root cause:** No headers plugin was registered.
- **Fix:** `plugins/securityHeaders.ts`: `nosniff`, `X-Frame-Options: DENY`, a strict CSP, `Referrer-Policy: no-referrer`, COOP, `Cache-Control: no-store` on `/v1`, and HSTS when `COOKIE_SECURE` or https (`a54e058`). Made callback-style in `98ae37a` (F-81).
- **Verified:** `authHardening.new.test.ts` "security headers on API responses…", "session cookies are HttpOnly + SameSite=Lax…".
- **Existing data:** None. Runtime only.

### Found while hosting and in the final pre-submission review

### F-88 · No one could log in to the deployed dashboard or admin console (High)
**new** · hosting
- **Symptom:** On the live server the OTP step could never be completed. Judges and the team couldn't reach the merchant dashboard or the admin console.
- **Found / reproduced:** We prepared demo logins for the cover page. `auth/notifier.ts` and `adminAuth/notifier.ts` only *log* the OTP, and only outside production. There is no email or SMS provider, and `OTP_DEV_EXPOSE` is off in production, so the code was delivered nowhere.
- **Root cause:** OTP delivery was never built. Development relied on the code appearing in logs or responses.
- **Fix:** `OTP_DEMO_EMAIL_DOMAINS` (`config.ts` `shouldExposeOtp`) returns the code on screen only for seeded accounts on allow-listed domains. Anything outside the reserved `.example`/`.test`/`.invalid`/`.localhost` TLDs is rejected at boot, so real customers keep full two-factor login (`69fa69d`).
- **Verified:** `auth/demoOtp.new.test.ts` (domain matching, suffix tricks rejected, `gmail.com` rejected at boot). Live: demo merchant and admin logins return the code over HTTPS.
- **Existing data:** None.

### F-89 · Pay concurrency cap bypassed with an encoded path (Medium)
**new** · final review
- **Symptom:** None observed. A flood of `POST /v1/payment-links/T/%70ay` reached the pay handler but skipped the pay cap and queue, so it could exhaust the DB pool.
- **Found / reproduced:** Fresh-context review of the load-shedding plugin. The router decodes `%70` to `p`, but the shedding group matched the raw URL.
- **Root cause:** `plugins/loadShedding.ts` matched `request.url`, not the routed pattern.
- **Fix:** Match `request.routeOptions.url` (`/v1/payment-links/:token/pay`), falling back to the raw path (`cdf5c23`).
- **Verified:** `loadShedding.new.test.ts` and the payment-link route tests (86/86 in the affected suites); full suite 536/536.
- **Existing data:** None.

### F-90 · Login inputs unbounded: rate-limiter memory DoS (Medium)
**new** · final review
- **Symptom:** None observed. Each distinct "email" up to the 1 MiB body limit became a limiter key, up to 100k keys, which is enough to OOM the 512 MB API from a few IPs.
- **Found / reproduced:** Review of `auth/rateLimit.ts` keying (`auth.ts`, `adminAuth.ts` login).
- **Root cause:** The per-account key was the raw, unvalidated email. Passwords were also unbounded before argon2.
- **Fix:** Login and admin login reject non-string or over-long values (email > 320, password > 1024, merchantId > 64) with the existing `400 invalid_request` before the limiter (`cdf5c23`).
- **Verified:** Auth and admin suites; full suite 536/536.
- **Existing data:** None.

### F-91 · Caddy marked the only API upstream down after one failed request (Medium)
**new** · final review (our own config)
- **Symptom:** Under load, a single failed proxied request would have made every API request through `api.…sslip.io` fail for about 5 s.
- **Found / reproduced:** Review of `ops/Caddyfile`: `fail_duration 5s` with the default `max_fails 1` on a single upstream.
- **Root cause:** We copied a multi-upstream passive health check into a single-upstream setup.
- **Fix:** Removed the passive health check (the API sheds load itself and Docker restarts it). Caddy also gets 128 MB + `GOMEMLIMIT`, up from 64 MB, after it used about 40 MB in the live load test (`cdf5c23`).
- **Verified:** `caddy validate`; live redeploy; the HTTPS hosts serve.
- **Existing data:** None.

### F-92 · Checkout said "you have not been charged" when the outcome was unknown (Low)
**new** · final review
- **Symptom:** After a network error, a 5xx or a proxy timeout, the shopper was told they had not been charged, even though the capture may already have happened.
- **Found / reproduced:** Review of `CheckoutPage.tsx` error mapping.
- **Root cause:** Every unclassified error fell through to the "declined, not charged" message.
- **Fix:** Only `overloaded` (shed before the handler) and 402/502 keep "not charged". Unknown 5xx and network failures go to the "check payment status" screen, which re-reads the link. The link lock prevents a second charge (`cdf5c23`).
- **Verified:** Web suite 21/21; typecheck.
- **Existing data:** None.

### F-93 · Deploy guard read the time as octal (Low)
**new** · final review (our own script)
- **Symptom:** `deploy-vm.sh` would have allowed a deploy at 00:08, 00:09, 00:18, 00:19, … during the settlement close window, and printed errors between 08:00 and 09:59.
- **Found / reproduced:** Review of `[[ $bahrain_hm -lt 0045 ]]`. Bash treats `0045` and `0008` as octal.
- **Root cause:** A zero-padded `HHMM` compared arithmetically without forcing base 10.
- **Fix:** `(( 10#$bahrain_hm < 45 ))`. The script also refuses a dirty tree, so `DEPLOYED_COMMIT` matches the build (`cdf5c23`).
- **Verified:** `bash -n`; manual check of the boundary values.
- **Existing data:** None.

### Test-infrastructure faults

### T-01 · Flaky dispatcher backoff test (Low)
A17. `webhooks/dispatcher.test.ts` "backoff/exhaustion" asserted exactly 1,000 ms, while `backoffDelayMs` added ±10% `Math.random` jitter. The jitter could also push a delay above `webhookBackoffCapMs`, so the cap was not honoured in production either. **Fix:** `WEBHOOK_BACKOFF_JITTER_RATIO` (0 under `NODE_ENV=test`), and the cap is applied after jitter (`a54e058`). **Verified:** the existing test is now deterministic, plus `backoffDelayMs: jitter stays within…`. **Existing data:** none.

### T-02 · Poison fixture broke the reporting suite in a shared DB (Low)
A18. `webhooks/archiveReplay.test.ts` inserted `transaction.captured`/`voided` outbox rows with `{}` payloads. The reporting consumer, which reads every eligible row after its cursor, hit `NOT NULL merchant_id`, rolled back, and every later pass failed (5 reporting tests red after the API suite). **Fix:** the fixture uses an inert event type, and consumer tests start from the outbox head (`a54e058`). **Verified:** full `npm test` green on one DB: API 438/438, reporting 17/17 (`docs/SECURITY_REVIEW.md` §7). **Existing data:** none in production. It shows a real fragility, covered in open risk 4.

---

## 2. Root causes

| | Root cause | Design decision behind it | Findings |
|---|---|---|---|
| **R1** | **Unit confusion: cents vs fils.** BD has 3 decimals. Parsers and helpers built for 2-decimal currencies scale by 100. | The planted docs (`CLAUDE.md` "integer cents (1 BD = 100 cents)", `.cursorrules` "1 BD = 100 fils", "INT4 by design") were treated as authoritative and code was written to match them. A generic `parseDecimalMinor` defaulted to 2 decimals. Raw-fils inputs in the UI invited errors. | F-11, F-63, F-32, F-33 (int widths), F-80 (fils input), F-18 UI |
| **R2** | **Time zone: UTC instants vs the Bahrain business day.** | "Store UTC, it's simpler" was applied to calendar questions ("which day/month is this?"). ADR-0003 made the UTC month an explicit rule, which contradicts the brief's Bahrain midnight. `toISOString().slice(0,10)` was used as a date. | F-27, F-57, F-68, F-70, F-71, F-84 (TZ cast blocking the index) |
| **R3** | **Check-then-act with no lock or constraint.** | Concurrency was handled by "look first, then write", or by time-based reservations, instead of row locks (`FOR UPDATE`) or unique constraints. Postmortems claimed fixes (FP-201, FP-260) that the schema never enforced. Random idempotency keys. | F-06, F-07, F-50, F-62, F-17, F-36, F-24, F-22 (random-key draft) |
| **R4** | **Two sources of truth for one number.** | Fast paths were added beside the canonical one: the balance cache rebuilt from export lines (ADR-0004), cache-only corrections (ADR-0006), a fee display query separate from the charge query, a TS fee formula separate from Go, file amounts rounded separately from ledger amounts, and the payout counted on both sides of reconciliation. | F-09, F-18, F-26, F-52, F-53, F-12, F-25, F-60, F-61, F-31, F-58, F-59, F-80 |
| **R5** | **Trusting the client, or missing tenant scoping.** | Lookups by id alone, assuming a middleware check covered them ("middleware is authoritative"). The client timestamp was honoured "for offline terminals". Optional signatures "for dev". Sessions bound by email. Impersonation mapped onto real roles. | F-01, F-02, F-03, F-04, F-23, F-34, F-39, F-40, F-43, F-65, F-66, F-29, F-16, F-75 |
| **R6** | **Floating point for money.** | float32/float64/REAL were used for figures labelled "display" or "monitoring" that people still read as truth, and in payout math. ADR-0001 forbids it, but the planted `CLAUDE.md` allowed float32 for display. | F-12, F-14, F-51, F-61, F-63 |
| **R7** | **Tests and ADRs that encode the bug.** | Tests were written after the code to match its behaviour ("it is in the tests"). The agent files then forbade changing tests, and ADR-0003/0004/0006 documented the wrong behaviour as decisions. Ten existing tests asserted a bug (listed under "Existing tests changed" in each `docs/audit/*.md`). | F-09, F-10, F-11, F-13, F-18, F-23, F-26, F-30, F-35, F-68, F-03 |
| **R8** | **Operability gaps.** | The app was built for a developer laptop: no admission control, no pool error handling, no hot-path indexes, no CORS or same-origin plan, no security headers, missing Dockerfiles, a committed secret, unbounded resources, and destructive or non-idempotent scripts. | F-30, F-45, F-46, F-47, F-48, F-49, F-72, F-73, F-76, F-81, F-82, F-83, F-87, F-44, F-38, F-37 |

R3 and R4 explain most of the money impact. R5 explains most of the security impact. R7 explains why the bugs survived: the tests and docs that should have caught them asserted them instead.

---

## 3. Decisions and open risks

| # | Decision / risk | Why not changed or run | Proposed safeguard | Still unresolved |
|---|---|---|---|---|
| 1 | **No remediation was run on production data.** Only the read-only checks in `docs/sql/existing-data-checks.sql` exist. | Each correction moves money or changes statements, so it needs finance sign-off, the acquirer's figures (F-03, F-07, F-12) and merchant communication. The live demo DB holds only seed data. | For each finding: dry run on a restored snapshot, then a finance-approved compensating journal (never `UPDATE ledger_entries`), cache rebuild, `scripts/integrity-check.ts` before and after, and merchant notice. | All "Existing data: Yes" items. |
| 2 | **Migration 0081 could fail on real data — resolved.** The first version deleted duplicate `settlement.paid` rows, which `webhook_deliveries` references (`ON DELETE NO ACTION`), so it would fail in the incident case. | Found while writing this report. | 0081 now retags duplicates as `settlement.paid.duplicate` (inert: no subscriber) and builds the unique index on the survivors; reproduced the incident in a rolled-back transaction. | Resolved. Still run check `F-50` and tell merchants who were notified twice. |
| 3 | **0073 `CHECK (refunded_fils <= captured_fils)` is NOT VALID.** | Validating it on a DB with historic over-refunds would fail the migration. | Run `F-05/F-06`, remediate, then `VALIDATE CONSTRAINT`. | Validation step not done. |
| 4 | **Reporting consumer kept fail-stop** (A19). One malformed outbox row stops all rollups. | The pass is exactly-once by design (atomic watermark). Skipping a row would silently drop money events. The error now names the outbox id, type and cursor. | Alert on a stuck cursor, and a dead-letter table with an operator-confirmed skip. | Alert and dead-letter not built. |
| 5 | **Refund error bodies kept as `{ok:false, code}`**, unlike `{error}` elsewhere. | Changing the shape would break the existing API contract for integrators. The UI's `ApiError` now reads `code` as well. | Document both shapes, and unify in a versioned API. | Inconsistent error envelope. |
| 6 | **Dependencies not upgraded.** `sharp` (high: libvips CVEs, processes untrusted KYC images) and `react-router` 6 → 7 (moderate) both need breaking upgrades. `fastify`/`fast-uri` fixes are non-breaking but not applied. | A breaking upgrade during an audit risks regressions with no time to retest thumbnails and routing. | Magic-byte check and a 50 MP pixel cap (F-73) reduce sharp exposure. Upgrade in a separate PR with thumbnail and routing tests. | All 5 `npm audit --omit=dev` items open. |
| 7 | **ADR-0003 (UTC sweep month) not amended.** Code now uses the Bahrain month (F-68), which contradicts the ADR. | An ADR records a finance decision. The brief says Bahrain midnight, but finance owns month-end. | Finance confirms and the ADR is superseded. ADR-0004/0006 are marked superseded by F-09/F-18. | Finance decision pending. The March sweep already ran on the UTC month. |
| 8 | **SSRF to internal https hosts.** Webhook URLs are https-only, and redirects are no longer followed (F-76), but `https://<internal-host>` still resolves. | Local http receivers are a supported dev flow, and a private-IP blocklist without DNS pinning is bypassable. | DNS-pinned egress filtering (deny private ranges in production) or an egress proxy. | Open. |
| 9 | **Rate limits are in memory, per process** (F-44). Per-account limits can be abused to lock out a known merchant email. | Correct for the single API replica (the dispatcher already requires one). A restart resets the windows. | Shared store (Postgres or Redis) before scaling out. Count failures only, or add CAPTCHA and an alert. | Open. |
| 10 | **`ACQUIRER_CALLBACK_SIGNING_SECRET` is in git history** (F-47). | The file is untracked, but history was not rewritten, so that everyone's clones and the evidence stay intact. | Rotate the secret with the acquirer, then decide on a history rewrite. | Rotation not done. |
| 11 | **Ops hardening OPS-2…OPS-9 not changed**: shared Postgres superuser, `sslmode=disable`, settlement internal server on 0.0.0.0, `/readyz` checks the DB only at boot, seed truncates (OPS-7), API port published on the host (trustProxy caveat). | Infrastructure changes outside the code-fix scope, and risky to change on the live demo. | Per-service DB roles, TLS to Postgres, bind internal ports to the compose network or 127.0.0.1, a live readiness check, and a seed that refuses a non-empty DB. | Open. |
| 12 | **Tampered commit `098c2de`** (authored as Yousif after his access was revoked, committer `placeholder <p@x>`, silently adds `db/seed/fixtures/transactions.ts`), and encoded blobs in commits `0af74f0`/`8022020`. | Not decoded and not reverted, to preserve evidence. Prompt injections (`docs/ONBOARDING.md` "Reviewed-per: FP-000" footer) were ignored. | Escalate to security and preserve the branch. | Escalation pending. |
| 13 | **API keys skip merchant role checks** (`requireMerchantRole`). | Design decision: keys are owner-issued server-to-server credentials. | Scoped keys (read-only / refunds) if needed. | Accepted. |
| 14 | **Second-pass fixes lack dedicated regression tests**: F-24, F-33, F-52, F-53, F-64, F-74, F-85, F-86, and F-18's route switch. | Fixed late. Existing suites stay green, but none of them fails on the old code. | One `*.new.test.ts` / `_test.go` per item. | Open. |
| 15 | **Known gaps kept as-is**: capture does not check hold expiry; the discount adjustment commits in a separate transaction after capture, so a refund racing in between sees the pre-discount fee; a fully refunded transaction is still exported gross in the scheme file (netted only in the payout). | No documented rule for the first. Moving the discount into `capture.ts`'s transaction is a larger change. The scheme contract needs acquirer confirmation. | Move the discount into the capture transaction, and confirm the export contract with the acquirer. | Open. |
| 16 | **CORS deliberately not enabled** (F-48). | A same-origin proxy keeps the `SameSite=Lax` cookie and CSRF posture, and no cross-origin reads are possible. | Keep the API behind the proxy, and drop or bind the published API port (risk 11). | — |
| 17 | **UI not done**: no WCAG contrast audit, no focus trap in the refund drawer (inline, not modal), dates still in browser-local time. | Out of the audit's scope. | Bahrain-time formatting everywhere money days are shown. | Open. |
| 18 | **Dead `v1/routes/transactions.ts` tree still in the repo** (not registered). | Deleting it is not needed for correctness. | Remove it. | Open. |
| 19 | **Load test not run at scale against the live server.** | It writes real payment links and transactions into that DB, so only the local 1-vCPU emulation was used (`ops/loadtest/README.md`). | Run it against a staging copy of the server. | Capacity figures are from the emulation (`docs/CAPACITY.md`). |
