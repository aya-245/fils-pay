-- CAPACITY (docs/CAPACITY.md): indexes for queries that every
-- POST /v1/payment-links/:token/pay runs. Without them each pay does work
-- proportional to the size of the table, so the API got slower the longer it
-- ran, and Postgres ran out of CPU first on the 1 vCPU box. Found with
-- pg_stat_statements during the load test. Only indexes are added here, no
-- data or behaviour changes.

-- 1. The deferred constraint trigger check_ledger_group_balance (0007) runs
--    SELECT SUM(...) FROM ledger_entries WHERE entry_group_id = ? once per
--    inserted row (2-4 rows per capture). With no index that is a full
--    table scan: 9.7 ms each after ~25k rows, and growing.
CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_group
    ON ledger_entries (entry_group_id);

-- 2. applyCaptureDiscountAdjustment / refunds look up ledger rows by
--    transaction (count(*) ... WHERE transaction_id = ?).
CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction
    ON ledger_entries (transaction_id)
 WHERE transaction_id IS NOT NULL;

-- 3. capture: UPDATE holds SET status = 'released' WHERE transaction_id = ?.
CREATE INDEX IF NOT EXISTS idx_holds_transaction
    ON holds (transaction_id);

-- 4. pay.ts crash-recovery lookup:
--      WHERE merchant_id = ? AND endpoint = 'transactions.capture'
--        AND key LIKE 'paylink:<linkId>:%'
--    The UNIQUE (merchant_id, endpoint, key) btree cannot serve a LIKE
--    prefix under a non-C collation (the postgres image default is
--    en_US.utf8), so it read every capture key the merchant ever had
--    (50 ms at ~2k keys per merchant). text_pattern_ops turns the prefix
--    into an index range scan (~0.1 ms).
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key_prefix
    ON idempotency_keys (merchant_id, endpoint, key text_pattern_ops);
