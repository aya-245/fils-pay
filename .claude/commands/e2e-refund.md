---
description: Run the FP-300 refund flow end to end against a running API and Go settlement and check every layer
argument-hint: [api base url, default http://localhost:3000]
---

Against ${ARGUMENTS:-http://localhost:3000} with a seeded merchant API key (`npm run seed` prints them):

1. Create a payment link, pay it with an approved test card, capture.
2. Partial refund with an `Idempotency-Key`; replay the same key (must return the same refund id, no second row).
3. Refund the remainder (status `refunded`); try an over-refund (expect 422) and another merchant's transaction (expect 404).
4. Check, with SQL and API reads:
   - every `ledger_entries` entry group nets to 0; fee reversed ≤ fee charged;
   - webhook receiver got signed `refund.succeeded`;
   - transaction timeline shows the refund events, `refundedFils` correct;
   - reporting consumer pass → `merchant_daily_volume` refund columns and `refund_merchant_summary`;
   - Go settlement close for the day → `settlement_batches.refunds_fils`, `refund_fee_reversed_fils`,
     net payout = (gross − fee) − (refunds − fee reversed); refunds not in `scheme_export_lines`;
   - reconciliation summary nets refunds, gap 0.
5. Run `scripts/integrity-check` and report PASS/FAIL per check with the numbers.
Reference run: `docs/audit/fp300-e2e.md`.
