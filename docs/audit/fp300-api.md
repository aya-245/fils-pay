# FP-300 merchant refunds: TypeScript API notes

Ground truth: 1 BD = 1000 fils, integer fils only. Every amount below is in fils.

## API contract

`POST /v1/refunds` and `POST /v1/merchants/:merchantId/refunds` use the same handler. On the merchant path, the `:merchantId` must match the authenticated merchant, otherwise the response is 403 `forbidden`.

- Headers: `Idempotency-Key` is required. Without it the response is 400 `idempotency_key_required`.
- Auth:
  - Merchant API keys are accepted.
  - Merchant sessions are accepted for the `owner` and `finance` roles. A `support` session gets 403.
  - Admin impersonation is refused with 403 `impersonation_read_only`, whatever the admin's role.
- Body: `{ "transactionId": uuid, "amountFils"?: positive integer, "reason"?: string (≤500 chars) }`
  - If `amountFils` is omitted, the request refunds everything still refundable.
  - A float, string or non-positive amount gets 400 `invalid_request`.

| Status | Body |
|---|---|
| 200 | `{ id, transactionId, merchantId, amountFils, feeReversedFils, status:"succeeded", transactionStatus, refundedTotalFils, reason, acquirerReference, occurredAt }` |
| 404 | `{ error:"transaction_not_found" }` (missing id, or another merchant's id) |
| 403 | `refunds_on_hold` / `forbidden` / `impersonation_read_only` |
| 409 | `{ ok:false, code:"transaction_not_refundable", status }` |
| 422 | `{ ok:false, code:"refund_exceeds_refundable", refundableFils }`, `refund_amount_invalid`, `idempotency_key_reused` |
| 402 / 502 | `refund_declined` (final) / `acquirer_unavailable` (key marked failed, so a retry is allowed) |

Replaying the same key with the same body returns the stored status and body.

Webhook `refund.succeeded` has `data` = `{ refundId, transactionId, merchantId, amountFils, feeReversedFils, refundedTotalFils, transactionStatus, reason }`.

The outbox payload carries `merchantId`, `transactionId`, `refundId`, `amountFils`, `feeReversedFils`, `refundedTotalFils`, `newStatus`, `reason` and `occurredAt`.

Transaction DTO: adds `refundedFils`. CSV export: adds `refunded_bhd` as the last column. Analytics volumes: each point adds `refundCount`, `refundGrossFils` and `netGrossFils`.

## Bugs

### 1. Route was a 501 stub
- **What was wrong:** `routes/refunds.ts` returned 501. The commented-out draft used `crypto.randomUUID()` as the idempotency key.
- **Why it matters:** FP-212 never shipped. With the draft's random key, every client retry would create a new refund.
- **What it breaks:** Refunds entirely. With the draft, retries double-refund.
- **Fix:** Implemented a real handler on both paths. It requires the client's `Idempotency-Key`, validates the body, checks roles, and refuses impersonation.
- **Test:** `routes/refunds.new.test.ts`. The `transactions.test.ts` 501 test was flipped (see below).

### 2. Cross-merchant refund (critical)
- **What was wrong:** `initiateMerchantRefund` looked the transaction up by id only and passed the OWNER's `merchant_id` on. `processRefund` also used `WHERE id = $1` with no merchant check.
- **Why it matters:** Any merchant could refund any other merchant's transaction by its id. The webhook would go to the owner.
- **What it breaks:** Tenant isolation, and the money itself.
- **Fix:** Both lookups now use `WHERE id=$1 AND merchant_id=$2` with the authenticated merchant. Another merchant's transaction returns 404 `transaction_not_found`.
- **Test:** "cross-merchant: B refunding A's transaction id is 404 and writes nothing". It covers both paths and a direct `processRefund` call, and checks that no refund, ledger or outbox rows are written.

### 3. Ceiling used the authorized amount
- **What was wrong:** `refundable = amount_fils - refunded_fils`.
- **Why it matters:** Authorized but uncaptured money never moved.
- **What it breaks:** Authorize 10000 and capture 4000, and a 10000 refund was allowed, over-refunding by 6000.
- **Fix:** `validateRefundRequest` now takes `capturedFils` and `refundedFils` and works out `captured - refunded` itself, clamped at 0.
- **Test:** `refundRules.new.test.ts`, plus the route test where 4001 of a 4000 capture gets 422 with `refundableFils` 4000.

### 4. Race and a stuck key across the acquirer call
- **What was wrong:** Validation ran in transaction 1 with no lock. The acquirer was called outside any transaction. The journal was written in transaction 2 without re-reading the row.
- **Why it matters:** Concurrent refunds with different keys both passed validation. A crash between the two transactions left the key `in_progress`, so every retry got 409.
- **What it breaks:** `refunded_fils` could exceed `captured_fils` (over-refund), and requests could get stuck.
- **Fix:** One `withTransaction`, mirroring `capture.ts`: claim the key, `SELECT ... FOR UPDATE` scoped by merchant, validate, read the fee, call the acquirer while holding the lock, then write. Migration 0073 (another worker's) adds `CHECK refunded <= captured` as a backstop.
- **Test:** "concurrent refunds ... exactly one wins": three 6000 refunds on 10000 give [200, 422, 422] and `refunded_fils` 6000.

### 5. A NULL reason broke inserts
- **What was wrong:** The code inserted `input.reason ?? null`, but 0070 added `CHECK (reason IS NOT NULL)`. NOT VALID still applies to new rows.
- **Why it matters:** Every refund without a reason failed at INSERT.
- **What it breaks:** Most refunds.
- **Fix:** Default to `'unspecified'`. The route trims the reason and checks its length.
- **Test:** The full-refund route test asserts `reason` is "unspecified". The partial-refund test stores and echoes a supplied reason.

### 6. Fee reversal could exceed the fee charged
- **What was wrong:** Each partial refund was rounded on its own.
- **Why it matters:** Refunds of 100/300/300/300 on 1000 with a fee of 25 reversed 2+8+8+8 = 26 > 25, which breaks Huda's rule.
- **What it breaks:** The platform pays back more than it earned, and reconciliation drifts.
- **Fix:** Cumulative reversal: `cumulativeFeeReversalFils` = `round(fee × refundedTotal / captured)` minus the sum already reversed in `refunds.fee_reversed_fils`, clamped to the fee still unreversed. `packages/money` is unchanged.
- **Test:** 300/300/300/100 on a 1000 capture with a fee of 25 reverses 8/7/7/3 = 25, at both the route and unit level. Four other partial orderings also always total 25 and never go over at any step.

### 7. Fee base ignored the negotiated discount
- **What was wrong:** The fee charged was taken as the sum of `platform_fee_revenue` credits only. The discount adjustment posts a `platform_fee_revenue` debit, which was ignored.
- **Why it matters:** A refund reversed the fee before the discount.
- **What it breaks:** The merchant was overpaid by the discount on every refund, so `merchant_payable` did not net to 0.
- **Fix:** Net fee = credits − debits on `platform_fee_revenue` for the transaction, excluding `refund:%` legs.
- **Test:** "negotiated discount: ... merchant_payable nets to 0": fee 250, 20% discount, net fee 200, and a full refund reverses 200. Every account nets to 0.

### 8. Status after fully refunding a partial capture
- **What was wrong:** `nextStatusAfterRefund` returned `partially_captured` whenever captured < authorized.
- **Why it matters:** That contradicts Huda's rule and lead decision 2. The timeline already said `refunded`. The hold stayed active.
- **What it breaks:** Status and timeline disagreed, and the uncaptured headroom was stranded on an active hold.
- **Fix:**
  - nothing refunded keeps the capture status
  - 0 < refunded < captured gives `partially_refunded`
  - refunded ≥ captured gives `refunded`
  - when the row leaves the capture statuses, the active hold is released
- **Test:** `refundRules.new.test.ts`, plus the route test (partial capture fully refunded gives `refunded` and no active hold). The existing `refundState.test.ts` cases are unchanged and pass.

### 9. refund.succeeded was never delivered
- **What was wrong:** The event was enqueued, but it was not in `WEBHOOK_ELIGIBLE_EVENT_TYPES` and had no `buildEnvelope` case.
- **Why it matters:** The spec requires the merchant webhook.
- **What it breaks:** Merchants got no refund notification.
- **Fix:** Added the envelope case first, then the eligible type. The payload now also carries `transactionId`, `reason` and `occurredAt`.
- **Test:** `webhooks/refundWebhook.new.test.ts`: the envelope maps field by field, and a real refund is delivered, signed, and marked succeeded.

### 10. refundedFils missing from DTO, CSV and analytics
- **What was wrong:** Refund amounts were invisible to API clients, the CSV export and volumes.
- **Why it matters:** The drawer can't compute what is still refundable, and reports overstate volume.
- **What it breaks:** The dashboard and reporting.
- **Fix:**
  - `refundedFils` added to `TransactionDto` (API and web types)
  - `refunded_bhd` added as the last CSV column (BD.fff via `formatBhd`)
  - analytics volumes now include `refundCount`, `refundGrossFils` and `netGrossFils`
- **Test:** The full-refund route test checks `refundedFils` on GET. There is a CSV route test and `analyticsRefunds.new.test.ts`.

## Changed existing test assertions
- `payments/refundValidation.test.ts:22`: the helper built `refundableFils` from the AUTHORIZED amount, which encoded bug 3. It now passes `refundedFils` and the validator derives the ceiling. All the assertions are unchanged and pass. Two misleading comments were fixed.
- `routes/transactions.test.ts` "POST /v1/refunds returns 501": now asserts 400 `idempotency_key_required`, because the stub is gone. Full coverage is in the new file.
- `transactions/exportCsv.test.ts`: the header assertion now includes `,refunded_bhd`, and the first row's expected fields gain `"0.000"`.

## Left / not in scope
- `admin/transactionStatusRecompute.ts` reuses `nextStatusAfterRefund` and could overwrite `chargeback` rows. It should exclude chargeback; that is admin scope.
- `payments/discountAdjustment.ts` `parsePromotionalDiscountFils` uses `parseFloat` × 100, so it is in cents, not fils. It is unused by refunds, but it is a units bug.
- The discount adjustment commits in a separate transaction after capture. A refund racing in between would see the pre-discount fee. Proper fix: move the discount into `capture.ts`'s transaction.
- `webhooks/dispatcher.test.ts` "backoff/exhaustion" asserts `backoffDelayMs(1)` == 1000 exactly, but the function applies random ±10% jitter. This flaky test predates this work and is not related to refunds.
- RefundDrawer (web) is still commented out. It needs one Idempotency-Key per form instance.
