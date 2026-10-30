# FP-300 refunds: DB, reporting, reconciliation

Format: What wrong | Why | Breaks | Fix | Test

1. refund_merchant_summary (0072) joined `t.id = r.id` | refund id compared to transaction id | view always empty; SUM(t.captured_fils) double counts repeated refunds | 0073 drops and recreates it joining `r.transaction_id`, Bahrain `::date` business_date, adds refunded_transaction_count, drops original_captured_fils | applyEvent.refund.new.test.ts (view test)
2. merchant_daily_volume lacked refund_count / refund_gross_fils | rollup code wrote columns no migration created | every refund rollup insert would throw and poison the consumer pass | 0073 adds both (NOT NULL DEFAULT 0) | applyEvent.refund.new.test.ts
3. Reporting consumer ignored refund.succeeded | REPORTING_EVENT_TYPES and applyEvent had no case | refunds never reach analytics; default branch would throw if added without a case | added to type list and `applyRefundSucceeded` | same
4. applyDailySummaryRollup bucketed by UTC date | `toISOString().slice(0,10)` | refund at 00:30 Bahrain landed on the previous day | uses toBahrainDateString; payload.occurredAt preferred, else outbox created_at | 00:30 Bahrain test
5. Reconciliation pending ignored refunds | docstring said included, code did not | gap != 0 for any period with an unbatched refund | pending -= SUM(amount - fee_reversed) of unbatched succeeded refunds in window | query.refunds.new.test.ts
6. Pending fee used float estimate at current MDR | estimateFeeFils used float rates, ignored journaled fee and tier | off-by-fils gaps, MDR changes after capture | estimateFeeFils now integer (applyRateFils); pending uses journaled `metadata.feeFils`, plus discount ledger credits for unbatched captures | same
7. getSettlementSummary double counted multi-capture transactions | summed transactions.captured_fils per capture event row | total inflated N-fold | sums per-event amount_fils; adds refundCount, totalRefundedFils, netFils | same
8. Settlement plumbing for Go | no batch refund totals | CloseBatch cannot record netted refunds | 0073: settlement_batches.refunds_fils, refund_fee_reversed_fils (BIGINT NOT NULL DEFAULT 0); index on refunds.settlement_batch_id (column already existed in 0042) | query test (batched case)
9. No DB backstop for over-refund | only refunded_fils >= 0 | race could push refunded above captured | 0073 CHECK refunded_fils <= captured_fils (NOT VALID, enforced for new writes) | n/a

Existing tests changed: none. Baseline reporting failures (4) no longer fail after migrate (all 15 pass).
Not done: analytics getVolumes (apps/api/src/analytics/query.ts) does not yet expose refund_count/refund_gross_fils; run `reporting rebuild` after deploy.
