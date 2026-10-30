-- FilsPay: existing-data checks for the findings in docs/FINDINGS.md.
--
-- READ-ONLY. Every statement is a SELECT, and the whole file runs inside a
-- READ ONLY transaction that is rolled back, so it cannot change data even
-- by mistake. Each query returns the rows a finding may have left wrong in
-- production; zero rows means nothing to remediate for that finding.
--
--   docker exec -i ops-postgres-1 psql -U filspay -d filspay -v ON_ERROR_STOP=1 -f - < docs/sql/existing-data-checks.sql
--
-- Remediation is NEVER an UPDATE/DELETE on ledger_entries (append-only,
-- trigger in 0007). Money corrections are new, balanced, compensating entry
-- groups; the balance cache is then rebuilt from the ledger. See the
-- "Existing data" line of each finding.
--
-- Timestamps marked DEPLOY_CUTOFF are the commit times of the fixes on this
-- branch (2026-10-30, +03:00). Replace them with the real production deploy
-- time before running against production.

\set QUIET on
\pset footer on
BEGIN TRANSACTION READ ONLY;

\echo '== G-0 baseline: ledger entry groups that do not net to zero (must be 0 rows) =='
SELECT entry_group_id,
       SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END) AS net_fils
  FROM ledger_entries
 GROUP BY entry_group_id
HAVING SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END) <> 0;

-- ---------------------------------------------------------------- Critical

\echo '== F-01 / F-43: sessions issued before the OTP + rotation fixes that are still live (force re-login) =='
SELECT authenticated, COUNT(*) AS live_sessions
  FROM sessions
 WHERE revoked_at IS NULL AND expires_at > now()
   AND created_at < TIMESTAMPTZ '2026-10-30 16:28:46+03'   -- DEPLOY_CUTOFF a54e058
 GROUP BY authenticated;

\echo '== F-02: sessions of users whose email exists under more than one merchant (cross-tenant login candidates) =='
SELECT s.id AS session_id, s.created_at, s.authenticated, mu.email, mu.merchant_id, s.ip_address
  FROM sessions s
  JOIN merchant_users mu ON mu.id = s.merchant_user_id
 WHERE lower(mu.email) IN (SELECT lower(email) FROM merchant_users
                            GROUP BY lower(email) HAVING COUNT(DISTINCT merchant_id) > 1)
 ORDER BY mu.email, s.created_at;

\echo '== F-03: acquirer callback notes saved while signatures were optional (review fraud verdicts) =='
SELECT n.callback_type, n.outcome, COUNT(*) AS notes, MIN(n.received_at) AS first_seen, MAX(n.received_at) AS last_seen
  FROM acquirer_callback_notes n
 WHERE n.received_at < TIMESTAMPTZ '2026-10-30 15:22:16+03'  -- DEPLOY_CUTOFF cef68d1
 GROUP BY n.callback_type, n.outcome;

\echo '== F-04: refunds created by an actor (API key / session) of a different merchant =='
SELECT r.id AS refund_id, r.transaction_id, r.merchant_id AS refunded_merchant,
       COALESCE(ak.merchant_id, mu.merchant_id) AS actor_merchant, r.amount_fils, r.occurred_at
  FROM refunds r
  LEFT JOIN api_keys ak       ON r.created_by_type = 'merchant_api_key' AND ak.id = r.created_by_id
  LEFT JOIN sessions s        ON r.created_by_type = 'merchant_session' AND s.id = r.created_by_id
  LEFT JOIN merchant_users mu ON mu.id = s.merchant_user_id
 WHERE COALESCE(ak.merchant_id, mu.merchant_id) IS NOT NULL
   AND COALESCE(ak.merchant_id, mu.merchant_id) <> r.merchant_id;

\echo '== F-05 / F-06: refunded more than captured, or refunded_fils out of step with the refunds table =='
SELECT t.id, t.merchant_id, t.status, t.captured_fils, t.refunded_fils,
       COALESCE(SUM(r.amount_fils) FILTER (WHERE r.status = 'succeeded'), 0) AS succeeded_refunds_fils
  FROM transactions t
  JOIN refunds r ON r.transaction_id = t.id
 GROUP BY t.id
HAVING t.refunded_fils > t.captured_fils
    OR COALESCE(SUM(r.amount_fils) FILTER (WHERE r.status = 'succeeded'), 0) > t.captured_fils
    OR COALESCE(SUM(r.amount_fils) FILTER (WHERE r.status = 'succeeded'), 0) <> t.refunded_fils;

\echo '== F-07: payment links with more than one successful capture (double charge) =='
SELECT pl.id AS link_id, pl.merchant_id, pl.status, pl.amount_fils,
       array_agg(DISTINCT ik.resource_id) AS captured_transactions
  FROM payment_links pl
  JOIN idempotency_keys ik
    ON ik.merchant_id = pl.merchant_id AND ik.endpoint = 'transactions.capture'
   AND ik.key LIKE 'paylink:' || pl.id || ':%'
   AND ik.status = 'completed' AND ik.response_status_code = 200 AND ik.resource_id IS NOT NULL
 GROUP BY pl.id
HAVING COUNT(DISTINCT ik.resource_id) > 1;

\echo '== F-08: succeeded refunds never netted although a later batch for the merchant already closed =='
SELECT r.id AS refund_id, r.merchant_id, r.amount_fils, r.fee_reversed_fils,
       r.amount_fils - r.fee_reversed_fils AS overpaid_fils, r.occurred_at, lb.last_closed_at
  FROM refunds r
  JOIN LATERAL (SELECT MAX(sb.closed_at) AS last_closed_at
                  FROM settlement_batches sb
                 WHERE sb.merchant_id = r.merchant_id AND sb.status IN ('closed', 'paid')) lb ON true
 WHERE r.status = 'succeeded' AND r.settlement_batch_id IS NULL
   AND lb.last_closed_at > r.occurred_at;

\echo '== F-09: balance cache differs from the merchant_payable ledger (rebuild from ledger) =='
SELECT mb.merchant_id, mb.cached_payable_fils, COALESCE(l.ledger_fils, 0) AS ledger_fils,
       mb.cached_payable_fils - COALESCE(l.ledger_fils, 0) AS diff_fils, mb.updated_at
  FROM merchant_balances mb
  LEFT JOIN (SELECT merchant_id,
                    SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS ledger_fils
               FROM ledger_entries WHERE account_id = 'merchant_payable'
              GROUP BY merchant_id) l USING (merchant_id)
 WHERE mb.cached_payable_fils <> COALESCE(l.ledger_fils, 0);

\echo '== F-10: paid batches whose stored net no longer matches the payout actually posted/disbursed =='
SELECT sb.id, sb.merchant_id, sb.batch_date, sb.fee_fils, sb.net_payout_fils,
       COALESCE(p.paid_fils, 0) AS payout_ledger_fils, d.disbursed_fils
  FROM settlement_batches sb
  LEFT JOIN (SELECT settlement_batch_id, SUM(amount_fils) AS paid_fils
               FROM ledger_entries
              WHERE description = 'settlement payout: batch paid'
                AND account_id = 'merchant_payable' AND direction = 'debit'
              GROUP BY settlement_batch_id) p ON p.settlement_batch_id = sb.id
  LEFT JOIN (SELECT settlement_batch_id, SUM(amount_fils) AS disbursed_fils
               FROM settlement_payout_disbursements GROUP BY settlement_batch_id) d ON d.settlement_batch_id = sb.id
 WHERE sb.status = 'paid'
   AND (COALESCE(p.paid_fils, 0) <> GREATEST(sb.net_payout_fils, 0)
        OR (d.disbursed_fils IS NOT NULL AND d.disbursed_fils <> sb.net_payout_fils));

\echo '== F-10: MDR recalculation runs to review (they could touch closed/paid batches) =='
SELECT created_at, admin_user_id, metadata
  FROM admin_audit_log WHERE action = 'mdr_recalculation' ORDER BY created_at;

-- -------------------------------------------------------------------- High

\echo '== F-11: CSV import rows whose posted fils differ from the BD text (x1000, 3 decimals) =='
SELECT r.adjustment_import_id, r.row_number, r.merchant_id, r.raw_amount_text, r.parsed_amount_fils,
       (trim(r.raw_amount_text)::numeric * 1000)::bigint AS expected_fils,
       (trim(r.raw_amount_text)::numeric * 1000)::bigint - r.parsed_amount_fils AS missing_fils,
       r.ledger_entry_group_id
  FROM adjustment_import_rows r
 WHERE trim(r.raw_amount_text) ~ '^-?[0-9]+(\.[0-9]{1,3})?$'
   AND (trim(r.raw_amount_text)::numeric * 1000) <> r.parsed_amount_fils;

\echo '== F-11: CSV import rows whose text is not a plain BD amount (manual review) =='
SELECT adjustment_import_id, row_number, merchant_id, raw_amount_text, parsed_amount_fils
  FROM adjustment_import_rows
 WHERE trim(raw_amount_text) !~ '^-?[0-9]+(\.[0-9]{1,3})?$';

\echo '== F-12: scheme lines whose file amount (BD.xx) is not the truncated ledger amount (sent over) =='
SELECT sel.settlement_batch_id, sel.transaction_id, sel.amount_fils, sel.amount AS file_amount_bd,
       (sel.amount * 1000)::bigint - sel.amount_fils AS over_reported_fils
  FROM scheme_export_lines sel
 WHERE sel.amount IS NOT NULL AND sel.amount * 1000 <> sel.amount_fils;

\echo '== F-12: batches whose truncation residue was never journaled (ADR-0002) =='
WITH line_gross AS (
  SELECT sel.settlement_batch_id, sel.amount_fils,
         (SELECT SUM(te.amount_fils) FROM transaction_events te
           WHERE te.transaction_id = sel.transaction_id
             AND te.settlement_batch_id = sel.settlement_batch_id
             AND te.event_type IN ('captured', 'partially_captured')) AS gross_fils
    FROM scheme_export_lines sel
), journaled AS (
  SELECT settlement_batch_id, SUM(amount_fils) AS residue_fils
    FROM ledger_entries
   WHERE account_id = 'scheme_rounding_residue' AND direction = 'debit'
     AND description = 'scheme export: rounding residue'
   GROUP BY settlement_batch_id
)
SELECT lg.settlement_batch_id, SUM(lg.gross_fils - lg.amount_fils) AS expected_residue_fils,
       COALESCE(j.residue_fils, 0) AS journaled_residue_fils
  FROM line_gross lg
  LEFT JOIN journaled j USING (settlement_batch_id)
 WHERE lg.gross_fils IS NOT NULL
 GROUP BY lg.settlement_batch_id, j.residue_fils
HAVING SUM(lg.gross_fils - lg.amount_fils) <> COALESCE(j.residue_fils, 0);

\echo '== F-13: split batches whose children do not add up to the parent net payout =='
SELECT sb.id, sb.merchant_id, sb.batch_date, sb.net_payout_fils,
       SUM(s.allocated_fils) AS allocated_fils, sb.net_payout_fils - SUM(s.allocated_fils) AS short_fils
  FROM settlement_batches sb
  JOIN settlement_batch_splits s ON s.settlement_batch_id = sb.id
 GROUP BY sb.id
HAVING SUM(s.allocated_fils) <> sb.net_payout_fils;

\echo '== F-14: closed/paid batches where net <> gross - fee - refunds + fee returned (float32 loss) =='
SELECT id, merchant_id, batch_date, status, gross_fils, fee_fils, refunds_fils, refund_fee_reversed_fils,
       net_payout_fils, gross_fils - fee_fils - refunds_fils + refund_fee_reversed_fils AS expected_net_fils
  FROM settlement_batches
 WHERE status <> 'open'
   AND net_payout_fils <> gross_fils - fee_fils - refunds_fils + refund_fee_reversed_fils;

\echo '== F-15: negative payouts =='
SELECT id, merchant_id, batch_date, status, net_payout_fils FROM settlement_batches WHERE net_payout_fils < 0;

\echo '== F-16: merchants whose test_mode was cleared by the status-recompute tool, and batches since =='
SELECT a.created_at AS flipped_at, a.admin_user_id, m.id AS merchant_id, m.display_name, m.test_mode AS test_mode_now,
       (SELECT COUNT(*) FROM settlement_batches sb
         WHERE sb.merchant_id = m.id AND sb.created_at > a.created_at) AS batches_since,
       (SELECT COALESCE(SUM(sb.net_payout_fils), 0) FROM settlement_batches sb
         WHERE sb.merchant_id = m.id AND sb.created_at > a.created_at AND sb.status = 'paid') AS paid_since_fils
  FROM admin_audit_log a
  JOIN merchants m ON m.id::text = a.target_id
 WHERE a.action = 'transaction_status_recompute'
   AND a.metadata -> 'flagsUpdated' ? 'test_mode';

\echo '== F-17: residue sweeps posted more than once for the same merchant =='
SELECT merchant_id, description, COUNT(DISTINCT entry_group_id) AS entry_groups,
       SUM(amount_fils) FILTER (WHERE account_id = 'merchant_payable' AND direction = 'debit') AS total_debited_fils,
       array_agg(DISTINCT occurred_at) AS run_times
  FROM ledger_entries
 WHERE description LIKE '%rounding residue sweep%'
 GROUP BY merchant_id, description
HAVING COUNT(DISTINCT entry_group_id) > 1;

\echo '== F-18: "Adjust balance" corrections that were cache-only (never journaled) =='
SELECT a.created_at, a.admin_user_id, a.target_id AS merchant_id, a.metadata,
       EXISTS (SELECT 1 FROM admin_audit_log b
                WHERE b.action = 'balance_rebuild' AND b.created_at > a.created_at) AS erased_by_later_rebuild
  FROM admin_audit_log a
 WHERE a.action = 'balance_adjustment'
 ORDER BY a.created_at;

\echo '== F-19: paid payment links of discounted merchants with no discount adjustment journaled =='
SELECT pl.id AS link_id, t.id AS transaction_id, pl.merchant_id, m.negotiated_discount_bps, t.captured_fils, pl.paid_at
  FROM payment_links pl
  JOIN transactions t ON t.id = pl.transaction_id
  JOIN merchants m    ON m.id = pl.merchant_id
 WHERE pl.status = 'paid' AND COALESCE(m.negotiated_discount_bps, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM ledger_entries le
                    WHERE le.transaction_id = t.id
                      AND le.description = 'capture: negotiated discount adjustment');

\echo '== F-20 / F-21: fee reversed exceeds the net fee charged, or a full refund did not return exactly the net fee =='
WITH fee AS (
  SELECT transaction_id,
         SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS net_fee_fils
    FROM ledger_entries
   WHERE account_id = 'platform_fee_revenue' AND transaction_id IS NOT NULL
     AND description NOT LIKE 'refund:%'
   GROUP BY transaction_id
), rev AS (
  SELECT transaction_id, SUM(fee_reversed_fils) AS reversed_fils, SUM(amount_fils) AS refunded_fils
    FROM refunds WHERE status = 'succeeded' GROUP BY transaction_id
)
SELECT t.id, t.merchant_id, t.captured_fils, rev.refunded_fils, COALESCE(fee.net_fee_fils, 0) AS net_fee_fils,
       rev.reversed_fils,
       CASE WHEN rev.reversed_fils > COALESCE(fee.net_fee_fils, 0) THEN 'reversed > fee (F-20)'
            ELSE 'full refund, reversal <> net fee (F-21)' END AS problem
  FROM rev
  JOIN transactions t ON t.id = rev.transaction_id
  LEFT JOIN fee ON fee.transaction_id = rev.transaction_id
 WHERE rev.reversed_fils > COALESCE(fee.net_fee_fils, 0)
    OR (rev.refunded_fils >= t.captured_fils AND rev.reversed_fils <> COALESCE(fee.net_fee_fils, 0));

\echo '== F-23: payment links paid after they expired =='
SELECT id, merchant_id, amount_fils, expires_at, paid_at, transaction_id
  FROM payment_links
 WHERE status = 'paid' AND paid_at > expires_at;

\echo '== F-28: transactions with chargeback ledger legs whose status is no longer chargeback =='
SELECT t.id, t.merchant_id, t.status, t.captured_fils, t.refunded_fils
  FROM transactions t
 WHERE t.status <> 'chargeback'
   AND EXISTS (SELECT 1 FROM ledger_entries le
                WHERE le.transaction_id = t.id AND le.account_id = 'chargeback_suspense');

\echo '== F-28: status-recompute runs that rewrote rows (audit stores counts only) =='
SELECT created_at, admin_user_id, target_id AS merchant_id, metadata
  FROM admin_audit_log
 WHERE action = 'transaction_status_recompute' AND COALESCE((metadata ->> 'updated')::int, 0) > 0;

\echo '== F-29: merchants approved although their latest KYC review is a rejection =='
SELECT m.id, m.display_name, m.onboarding_status, m.kyc_passed, r.outcome AS latest_review, r.reviewed_at
  FROM merchants m
  JOIN LATERAL (SELECT outcome, reviewed_at FROM merchant_kyc_reviews
                 WHERE merchant_id = m.id ORDER BY reviewed_at DESC LIMIT 1) r ON true
 WHERE m.onboarding_status = 'approved' AND r.outcome = 'rejected';

\echo '== F-29: merchants in a bulk approval whose last review before it was a rejection =='
SELECT a.created_at AS bulk_approved_at, a.admin_user_id, x.merchant_id
  FROM admin_audit_log a
 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(a.metadata -> 'approvedMerchantIds', '[]'::jsonb)) AS x(merchant_id)
 WHERE a.action = 'kyc_bulk_approve'
   AND (SELECT r.outcome FROM merchant_kyc_reviews r
         WHERE r.merchant_id::text = x.merchant_id AND r.reviewed_at < a.created_at
         ORDER BY r.reviewed_at DESC LIMIT 1) = 'rejected';

\echo '== F-30: open authorizations with no hold row at all (holds wiped by the unfiltered DELETE) =='
SELECT t.id, t.merchant_id, t.status, t.amount_fils, t.captured_fils, t.occurred_at
  FROM transactions t
 WHERE t.status IN ('authorized', 'partially_captured')
   AND NOT EXISTS (SELECT 1 FROM holds h WHERE h.transaction_id = t.id);

\echo '== F-31 / F-57: daily refund rollup vs refunds table, Bahrain business date =='
WITH r AS (
  SELECT merchant_id, (occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS d,
         COUNT(*) AS n, SUM(amount_fils) AS gross_fils
    FROM refunds WHERE status = 'succeeded'
   GROUP BY 1, 2
)
SELECT COALESCE(r.merchant_id, v.merchant_id) AS merchant_id, COALESCE(r.d, v.volume_date) AS business_date,
       COALESCE(r.n, 0) AS refunds, COALESCE(v.refund_count, 0) AS rollup_count,
       COALESCE(r.gross_fils, 0) AS refunds_fils, COALESCE(v.refund_gross_fils, 0) AS rollup_fils
  FROM r
  FULL JOIN merchant_daily_volume v ON v.merchant_id = r.merchant_id AND v.volume_date = r.d
 WHERE COALESCE(r.n, 0) <> COALESCE(v.refund_count, 0)
    OR COALESCE(r.gross_fils, 0) <> COALESCE(v.refund_gross_fils, 0);

\echo '== F-32 / F-33: platform volume counter (negative or far below batch gross = wrapped/stuck) =='
SELECT ps.total_processed_fils,
       (SELECT COALESCE(SUM(gross_fils), 0) FROM settlement_batches WHERE status <> 'open') AS closed_batch_gross_fils,
       ps.updated_at
  FROM platform_stats ps;

\echo '== F-34: writes recorded as merchant_session but made through an impersonation grant =='
SELECT 'transaction_event' AS kind, te.id::text AS row_id, g.admin_user_id, g.merchant_id, te.event_type AS what, te.occurred_at AS at
  FROM transaction_events te JOIN admin_impersonation_grants g ON g.id = te.actor_id
 WHERE te.actor_type = 'merchant_session'
UNION ALL
SELECT 'refund', r.id::text, g.admin_user_id, g.merchant_id, r.amount_fils::text, r.occurred_at
  FROM refunds r JOIN admin_impersonation_grants g ON g.id = r.created_by_id
 WHERE r.created_by_type = 'merchant_session'
UNION ALL
SELECT 'payment_link', pl.id::text, g.admin_user_id, g.merchant_id, pl.status, pl.created_at
  FROM payment_links pl JOIN admin_impersonation_grants g ON g.id = pl.created_by_id
 WHERE pl.created_by_type = 'merchant_session'
UNION ALL
SELECT 'webhook_endpoint', we.id::text, g.admin_user_id, g.merchant_id, we.url, we.created_at
  FROM webhook_endpoints we JOIN admin_impersonation_grants g ON g.id = we.created_by_id
 WHERE we.created_by_type = 'merchant_session';

\echo '== F-35: keys replaced by a rotation but never revoked =='
SELECT old.id AS old_key_id, old.merchant_id, old.key_prefix, newk.created_at AS rotated_at, old.last_used_at
  FROM api_keys newk
  JOIN api_keys old ON old.id = newk.rotated_from_key_id
 WHERE old.revoked_at IS NULL;

\echo '== F-37: payment links still payable whose token came from Math.random (reissue) =='
SELECT merchant_id, COUNT(*) AS open_links, MIN(created_at) AS oldest
  FROM payment_links
 WHERE status IN ('active', 'reserved') AND expires_at > now()
   AND created_at < TIMESTAMPTZ '2026-10-30 15:17:07+03'   -- DEPLOY_CUTOFF ae8d95c
 GROUP BY merchant_id;

\echo '== F-41: deliveries rejected by receivers with a 4xx (FP-240 signature mismatch candidates) =='
SELECT wd.endpoint_id, wd.event_type, wd.status, wd.response_status_code, COUNT(*) AS deliveries, MAX(wd.created_at) AS last_at
  FROM webhook_deliveries wd
 WHERE wd.status IN ('failed', 'exhausted') AND wd.response_status_code BETWEEN 400 AND 499
 GROUP BY 1, 2, 3, 4;

\echo '== F-42: refund.succeeded events never turned into a delivery although the merchant had an active endpoint =='
SELECT oe.id AS outbox_id, oe.payload ->> 'merchantId' AS merchant_id, oe.payload ->> 'refundId' AS refund_id, oe.created_at
  FROM outbox_events oe
 WHERE oe.event_type = 'refund.succeeded'
   AND EXISTS (SELECT 1 FROM webhook_endpoints we
                WHERE we.merchant_id::text = oe.payload ->> 'merchantId'
                  AND we.status = 'active' AND we.created_at <= oe.created_at)
   AND NOT EXISTS (SELECT 1 FROM webhook_deliveries wd WHERE wd.outbox_event_id = oe.id);

\echo '== F-42: succeeded refunds with no refund.succeeded outbox event at all =='
SELECT r.id AS refund_id, r.merchant_id, r.amount_fils, r.occurred_at
  FROM refunds r
 WHERE r.status = 'succeeded'
   AND NOT EXISTS (SELECT 1 FROM outbox_events oe
                    WHERE oe.event_type = 'refund.succeeded' AND oe.payload ->> 'refundId' = r.id::text);

-- ------------------------------------------------------------------ Medium

\echo '== F-50: duplicate settlement.paid outbox events per batch (and deliveries that block 0081) =='
SELECT oe.aggregate_id AS settlement_batch_id, COUNT(DISTINCT oe.id) AS events, COUNT(wd.id) AS deliveries
  FROM outbox_events oe
  LEFT JOIN webhook_deliveries wd ON wd.outbox_event_id = oe.id
 WHERE oe.event_type = 'settlement.paid'
 GROUP BY oe.aggregate_id
HAVING COUNT(DISTINCT oe.id) > 1;

\echo '== F-50: settlement.paid delivered more than once to the same endpoint for one batch (merchants notified twice) =='
SELECT wd.endpoint_id, wd.payload -> 'data' ->> 'settlementBatchId' AS settlement_batch_id,
       COUNT(DISTINCT wd.outbox_event_id) AS distinct_events
  FROM webhook_deliveries wd
 WHERE wd.event_type = 'settlement.paid' AND wd.replay_of_delivery_id IS NULL
 GROUP BY 1, 2
HAVING COUNT(DISTINCT wd.outbox_event_id) > 1;

\echo '== F-51: lifetime payout estimate vs the sum of paid batch payouts =='
SELECT m.id, m.display_name, m.lifetime_net_payout_monitoring_estimate AS estimate_fils,
       COALESCE(SUM(sb.net_payout_fils), 0) AS paid_net_fils,
       m.lifetime_net_payout_monitoring_estimate - COALESCE(SUM(sb.net_payout_fils), 0) AS drift_fils
  FROM merchants m
  LEFT JOIN settlement_batches sb ON sb.merchant_id = m.id AND sb.status = 'paid'
 GROUP BY m.id
HAVING m.lifetime_net_payout_monitoring_estimate <> COALESCE(SUM(sb.net_payout_fils), 0);

\echo '== F-52: fee schedules with two different rates for the same merchant and effective_from =='
SELECT merchant_id, effective_from, array_agg(mdr_bps ORDER BY created_at) AS rates_in_created_order
  FROM fee_schedules
 GROUP BY merchant_id, effective_from
HAVING COUNT(DISTINCT mdr_bps) > 1;

\echo '== F-53: discount adjustments posted by the old TS formula (recompute each; may be 1 fil off) =='
SELECT le.merchant_id, COUNT(DISTINCT le.entry_group_id) AS discount_groups, SUM(le.amount_fils) AS discount_fils
  FROM ledger_entries le
 WHERE le.description = 'capture: negotiated discount adjustment'
   AND le.account_id = 'platform_fee_revenue' AND le.direction = 'debit'
   AND le.created_at < TIMESTAMPTZ '2026-10-30 16:08:14+03'   -- DEPLOY_CUTOFF 5ac1ccc
 GROUP BY le.merchant_id;

\echo '== F-54: refund status out of step with amounts, or a hold still active on a fully refunded payment =='
SELECT t.id, t.status, t.captured_fils, t.refunded_fils, 'status' AS problem
  FROM transactions t
 WHERE t.refunded_fils > 0 AND t.status <> 'chargeback'
   AND ((t.refunded_fils >= t.captured_fils AND t.status <> 'refunded')
     OR (t.refunded_fils < t.captured_fils AND t.status <> 'partially_refunded'))
UNION ALL
SELECT t.id, t.status, t.captured_fils, t.refunded_fils, 'active hold'
  FROM transactions t JOIN holds h ON h.transaction_id = t.id
 WHERE t.status = 'refunded' AND h.status = 'active';

\echo '== F-58 / F-59: refund_merchant_summary (matview) vs refunds table =='
SELECT COALESCE(s.merchant_id, r.merchant_id) AS merchant_id,
       COALESCE(s.n, 0) AS view_refunds, COALESCE(r.n, 0) AS table_refunds,
       COALESCE(s.fils, 0) AS view_fils, COALESCE(r.fils, 0) AS table_fils
  FROM (SELECT merchant_id, SUM(refund_count) AS n, SUM(total_refunded_fils) AS fils
          FROM refund_merchant_summary GROUP BY merchant_id) s
  FULL JOIN (SELECT merchant_id, COUNT(*) AS n, SUM(amount_fils) AS fils
               FROM refunds WHERE status = 'succeeded' GROUP BY merchant_id) r USING (merchant_id)
 WHERE COALESCE(s.n, 0) <> COALESCE(r.n, 0) OR COALESCE(s.fils, 0) <> COALESCE(r.fils, 0);

\echo '== F-62: acquirer callbacks with more than one note (0074 should leave 0) =='
SELECT callback_id, COUNT(*) AS notes FROM acquirer_callback_notes GROUP BY callback_id HAVING COUNT(*) > 1;

\echo '== F-64: keys used after their scheduled revoke_after =='
SELECT id, merchant_id, key_prefix, revoke_after, revoked_at, last_used_at
  FROM api_keys
 WHERE revoke_after IS NOT NULL AND revoke_after < now()
   AND (revoked_at IS NULL OR last_used_at > revoke_after);

\echo '== F-65: credit requests approved by the admin who requested them =='
SELECT id, merchant_id, requested_by_admin_user_id, approved_by_admin_user_id, base_amount_fils, fee_reversal_fils, status, approved_at
  FROM credit_requests
 WHERE approved_by_admin_user_id IS NOT NULL
   AND approved_by_admin_user_id = requested_by_admin_user_id;

\echo '== F-66 / F-67: replays of delivered webhooks, or replays that minted a new delivery id =='
SELECT wd.id AS replay_id, wd.replay_of_delivery_id, wd.event_type, orig.status AS original_status,
       wd.delivery_event_id <> orig.delivery_event_id AS new_delivery_id, wd.created_at
  FROM webhook_deliveries wd
  JOIN webhook_deliveries orig ON orig.id = wd.replay_of_delivery_id
 WHERE orig.status = 'succeeded' OR wd.delivery_event_id <> orig.delivery_event_id;

\echo '== F-68: captures in the 3-hour windows where the UTC month and the Bahrain month disagree (March sweep) =='
SELECT le.merchant_id,
       CASE WHEN le.occurred_at < TIMESTAMPTZ '2026-03-01 00:00+00'
            THEN 'Bahrain March, UTC February' ELSE 'UTC March, Bahrain April' END AS window,
       COUNT(*) AS captures, SUM(le.amount_fils) AS gross_fils
  FROM ledger_entries le
 WHERE le.account_id = 'merchant_payable' AND le.direction = 'credit' AND le.description LIKE 'capture%'
   AND ((le.occurred_at >= TIMESTAMPTZ '2026-02-28 21:00+00' AND le.occurred_at < TIMESTAMPTZ '2026-03-01 00:00+00')
     OR (le.occurred_at >= TIMESTAMPTZ '2026-03-31 21:00+00' AND le.occurred_at < TIMESTAMPTZ '2026-04-01 00:00+00'))
 GROUP BY 1, 2;

\echo '== F-74: PDF-only KYC documents whose detected type is not PDF =='
SELECT id, merchant_id, document_type, file_name, mime_type, uploaded_at
  FROM kyc_documents
 WHERE document_type IN ('commercial_registration', 'bank_letter') AND mime_type <> 'application/pdf';

-- --------------------------------------------------------------------- Low

\echo '== F-85: paid batches with a payout for merchants that are test merchants now =='
SELECT sb.id, sb.merchant_id, m.display_name, sb.batch_date, sb.net_payout_fils, sb.paid_at
  FROM settlement_batches sb JOIN merchants m ON m.id = sb.merchant_id
 WHERE m.test_mode AND sb.status = 'paid' AND sb.net_payout_fils > 0;

ROLLBACK;
