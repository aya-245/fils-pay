-- INCIDENT 2026-08-21: two settlement processes both saw "no settlement.paid
-- yet" for the same batch and both enqueued one, so merchants got two
-- "your payout is on the way" messages. Make the database enforce one
-- settlement.paid event per batch; EnqueuePayoutNotifications inserts with
-- ON CONFLICT DO NOTHING against this index.

-- Keep the earliest event per batch, drop later duplicates.
DELETE FROM outbox_events oe
 USING outbox_events earlier
 WHERE oe.event_type = 'settlement.paid'
   AND earlier.event_type = 'settlement.paid'
   AND earlier.aggregate_id = oe.aggregate_id
   AND (earlier.created_at, earlier.id) < (oe.created_at, oe.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_settlement_paid_per_batch
    ON outbox_events (aggregate_id)
 WHERE event_type = 'settlement.paid';
