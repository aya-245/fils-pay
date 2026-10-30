# FP-300 settlement (Go) — refunds netting and integer payout

Ground truth: 1 BD = 1000 fils, integer int64 fils only; business day = midnight Asia/Bahrain.

## 1. Refunds ignored by CloseBatch
- **What wrong:** `CloseBatch` (`apps/settlement/internal/settlement/batch.go`) selected only capture events; nothing ever read `refunds` or set `refunds.settlement_batch_id`.
- **Why:** the FP-212 refund write path landed in the API without the matching settlement change.
- **Breaks:** a merchant was paid gross minus fee for money already returned to the cardholder. The ledger `merchant_payable` debit from the refund never left a payout, so reconciliation could not tie out.
- **Fix:** inside the CloseBatch transaction, select the merchant's `refunds` with `status='succeeded' AND settlement_batch_id IS NULL AND occurred_at < <batch cutoff>` (no lower bound, so earlier-day stragglers get swept in), oldest first, `FOR UPDATE`. Deduct each refund's `amount_fils - fee_reversed_fils` (the stored fee, never recomputed). Stamp the included refunds with the batch id. Store the gross refunded amount in `settlement_batches.refunds_fils` and the MDR returned in `settlement_batches.refund_fee_reversed_fils` (both from 0073). Add `refundsFils` and `refundFeeReversedFils` to the `settlement.batch_closed` payload. The `merchant_balances` cache moves by the new net through `ApplyBatchClose`. Refunds are **not** written to `scheme_export_lines`, because the acquirer gets them through the refund API.
- **Test:** `refund_netting_test.go`: `TestApplyRefundsToPayout_NetOfRefunds`, `_FullRefundNetsToZero`; DB: `TestCloseBatch_SameDayFullRefundNetsToZero` (net 0, refund stamped, refunds_fils stored, 1 scheme line only, re-close does not re-batch).

## 2. Negative payout when refunds exceed captures
- **What wrong:** with naive netting, a batch whose refunds exceed its captures would get a negative `net_payout_fils`. `PayoutBatch` only posts when net > 0 and then marks the batch paid, so the shortfall would be silently forgiven.
- **Why:** there was no carry-forward rule (lead decision 3).
- **Breaks:** merchant_payable drifts and the merchant keeps money they owe.
- **Fix:** `ApplyRefundsToPayout` (`payable.go`) nets refunds in strict FIFO order. The first refund that would push the payout below 0, and everything after it, stays `settlement_batch_id IS NULL` and rolls to the next batch in order. The payout is never below 0.
- **Test:** `TestApplyRefundsToPayout_ExceedingCapturesRollsForward`; DB: `TestCloseBatch_RefundExceedingCapturesRollsForward` (deferred on day 1, swept on day 2).

## 3. float32 payout math loses fils
- **What wrong:** `NetPayableFils` converted to float32 BD (`float32(gross)/1000 - float32(fee)/1000`) and rounded back.
- **Why:** float32 has a 24-bit mantissa, so it is exact only up to 16,777,216 fils (about 16,777 BD).
- **Breaks:** large batches paid out the wrong number of fils, and the stored net no longer matched gross - fee.
- **Fix:** `return grossFils - feeFils` (int64).
- **Test:** `TestNetPayableFils_LargeAmountExactToTheFil` (16,777,217 up to 9,999,999,999 fils), `TestApplyRefundsToPayout_LargeAmountsExact` (50,000.001 BD / 20,000.003 BD).

## Schema dependency
- `refunds.settlement_batch_id` already exists (0042, FK to settlement_batches).
- `settlement_batches.refunds_fils` (gross refunded) and `settlement_batches.refund_fee_reversed_fils` (MDR returned) come from `db/migrations/0073_refund_reporting_and_settlement.sql`. CloseBatch writes both and the already-closed path reads both, so 0073 must be deployed before this binary.

## Existing tests changed
- None. No existing Go test encoded these bugs. `buildBatchClosedPayload` gained `refundsFils` and `refundFeeReversedFils` parameters; its only caller is CloseBatch.

## Notes
- DB-backed tests skip without `DATABASE_URL`. The pure tests ran and pass.
- `net_payout_fils = gross_fils - fee_fils - refunds_fils + refund_fee_reversed_fils` (matches the 0073 comment).
