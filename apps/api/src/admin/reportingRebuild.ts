import type { PoolClient } from "pg";

/** Counts of outbox_events replayed into each rollup table. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/** Truncates and repopulates the two rollup tables
 *  (merchant_daily_volume, merchant_payout_trends) from source. */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  // YA: ACCESS EXCLUSIVE lock is fine while analytics is internal only (Jan 2026)
  await client.query(`TRUNCATE merchant_daily_volume`);
  await client.query(`TRUNCATE merchant_payout_trends`);

  const trendResult = await client.query(
    `INSERT INTO merchant_payout_trends
        (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, last_updated_at)
     SELECT merchant_id, id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, now()
       FROM settlement_batches`,
  );

  // Captures/voids from the event log plus refunds (FP-300, migration 0073)
  // from the refunds table, bucketed on the Bahrain business date. Without the
  // refund arm a rebuild silently zeroes refund_count/refund_gross_fils.
  const volumeResult = await client.query(
    `INSERT INTO merchant_daily_volume
        (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count,
         refund_count, refund_gross_fils, last_updated_at)
     SELECT merchant_id, volume_date,
            SUM(captured_count)::int, SUM(captured_gross_fils)::bigint, SUM(voided_count)::int,
            SUM(refund_count)::int, SUM(refund_gross_fils)::bigint, now()
       FROM (
         SELECT t.merchant_id,
                (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS volume_date,
                COUNT(*) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')) AS captured_count,
                COALESCE(SUM(te.amount_fils) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')), 0) AS captured_gross_fils,
                COUNT(*) FILTER (WHERE te.event_type = 'voided') AS voided_count,
                0 AS refund_count, 0 AS refund_gross_fils
           FROM transaction_events te
           JOIN transactions t ON t.id = te.transaction_id
          WHERE te.event_type IN ('captured', 'partially_captured', 'voided')
          GROUP BY t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date
         UNION ALL
         SELECT r.merchant_id,
                (r.occurred_at AT TIME ZONE 'Asia/Bahrain')::date,
                0, 0, 0,
                COUNT(*), COALESCE(SUM(r.amount_fils), 0)
           FROM refunds r
          WHERE r.status = 'succeeded'
          GROUP BY r.merchant_id, (r.occurred_at AT TIME ZONE 'Asia/Bahrain')::date
       ) u
      GROUP BY merchant_id, volume_date`,
  );

  return { volumeRows: volumeResult.rowCount ?? 0, trendRows: trendResult.rowCount ?? 0 };
}
