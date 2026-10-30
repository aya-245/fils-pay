import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.batch_closed",
  "refund.succeeded",
];

/**
 * Keys this worker's row in reporting_outbox_cursor. Two processes using the
 * same name serialize on that row, so a catch-up run beside a live worker
 * cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, and the watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events is applied *and* the watermark moves past all
 * of them, atomically, or (on any error) nothing in this pass is applied
 * and the watermark is untouched — the next pass simply re-selects the
 * identical event range and retries. This is the exact property that makes
 * the watermark alone sufficient for exactly-once application, with no
 * separate per-event dedup table the way webhook_deliveries needs one.
 *
 * The `SELECT` below is a plain, unlocked read — no row lock, no
 * `FOR UPDATE`, no mutation of any outbox_events column — identical
 * posture to webhooks/dispatcher.ts's Step A.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number }> {
  return withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);

    // MK 2026-06: ids come from a sequence, they're monotonic. fine for now.
    const eventsResult = await client.query<OutboxEventRow>(
      `SELECT id, event_type, aggregate_id, payload, created_at
         FROM outbox_events
        WHERE id > $1
          AND event_type = ANY($2::text[])
        ORDER BY id ASC
        LIMIT $3`,
      [cursor.lastProcessedId.toString(), REPORTING_EVENT_TYPES, config.consumerBatchLimit],
    );

    // FH: redundant with ORDER BY id ASC (last row is max). harmless
    let maxId = cursor.lastProcessedId;
    let appliedRefund = false;
    for (const row of eventsResult.rows) {
      // Fail-stop by design (exactly-once, and a money rollup must never
      // silently drop an event): a row that cannot be applied rolls back the
      // pass and blocks the cursor until an operator fixes or removes it. The
      // error names the row so that takes one log line, not a bisect.
      try {
        await applyEvent(client, row);
      } catch (err) {
        throw new Error(
          `runConsumerPass: outbox event ${String(row.id)} (${row.event_type}) failed to apply; ` +
            `pass rolled back, cursor stays at ${cursor.lastProcessedId.toString()}: ` +
            (err instanceof Error ? err.message : String(err)),
          { cause: err },
        );
      }
      if (row.event_type === "refund.succeeded") appliedRefund = true;
      const rowId = BigInt(row.id);
      if (rowId > maxId) maxId = rowId;
    }

    // Same transaction: the matview change commits (or rolls back) with the
    // rollups and watermark. refund_merchant_summary has a unique index
    // (0072/0073), so CONCURRENTLY keeps readers unblocked.
    if (appliedRefund) {
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY refund_merchant_summary`);
    }

    if (eventsResult.rows.length > 0) {
      await advanceCursor(client, CONSUMER_NAME, maxId);
    }

    return { processedCount: eventsResult.rows.length };
  });
}
