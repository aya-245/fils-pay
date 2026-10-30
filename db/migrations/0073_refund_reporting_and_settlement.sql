-- FP-300 refunds: reporting, reconciliation and settlement plumbing.

-- 1. merchant_daily_volume refund rollup columns. The reporting consumer
--    (applyRefundSucceeded) writes these; no earlier migration created them.
ALTER TABLE merchant_daily_volume
    ADD COLUMN IF NOT EXISTS refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

-- 2. Refund totals netted into a settlement batch (written by the Go
--    CloseBatch in the same tx that stamps refunds.settlement_batch_id).
--    refunds_fils = gross refunded amount; refund_fee_reversed_fils = MDR
--    handed back for those refunds. net_payout = gross - fee - refunds_fils
--    + refund_fee_reversed_fils.
ALTER TABLE settlement_batches
    ADD COLUMN IF NOT EXISTS refunds_fils               BIGINT NOT NULL DEFAULT 0 CHECK (refunds_fils >= 0),
    ADD COLUMN IF NOT EXISTS refund_fee_reversed_fils   BIGINT NOT NULL DEFAULT 0 CHECK (refund_fee_reversed_fils >= 0);

-- refunds.settlement_batch_id already exists (0042); index it for batch lookups.
CREATE INDEX IF NOT EXISTS idx_refunds_settlement_batch
    ON refunds (settlement_batch_id) WHERE settlement_batch_id IS NOT NULL;

-- 3. Backstop for the over-refund race: never refund more than was captured.
--    NOT VALID so legacy rows do not block the migration; enforced for new writes.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_refunded_le_captured') THEN
        ALTER TABLE transactions
            ADD CONSTRAINT transactions_refunded_le_captured
            CHECK (refunded_fils <= captured_fils) NOT VALID;
    END IF;
END $$;

-- 4. Fix 0072's refund_merchant_summary: it joined transactions on
--    t.id = r.id (refund id vs transaction id), so it was always empty, and
--    SUM(t.captured_fils) double-counted a transaction refunded repeatedly.
--    Materialized views cannot be CREATE OR REPLACEd, so drop + recreate.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
SELECT
    r.merchant_id,
    (r.occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS business_date,
    COUNT(*)                     AS refund_count,
    SUM(r.amount_fils)           AS total_refunded_fils,
    SUM(r.fee_reversed_fils)     AS total_fee_reversed_fils,
    COUNT(DISTINCT r.transaction_id) AS refunded_transaction_count
FROM refunds r
JOIN transactions t ON t.id = r.transaction_id AND t.merchant_id = r.merchant_id
WHERE r.status = 'succeeded'
GROUP BY r.merchant_id, (r.occurred_at AT TIME ZONE 'Asia/Bahrain')::date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
