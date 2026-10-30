-- INCIDENT 2026-08-21: two settlement processes both saw "no settlement.paid
-- yet" for the same batch and both enqueued one, so merchants got two
-- "your payout is on the way" messages. Make the database enforce one
-- settlement.paid event per batch; EnqueuePayoutNotifications inserts with
-- ON CONFLICT DO NOTHING against this index.

-- Keep the earliest event per batch and RETAG later duplicates instead of
-- deleting them: webhook_deliveries.outbox_event_id references outbox_events
-- (0022, no ON DELETE), and on a database where the incident happened the
-- duplicate was already delivered, so a DELETE would fail on the foreign key
-- and also erase the record of what merchants were actually sent. Neither
-- the webhook dispatcher nor the reporting consumer subscribes to the
-- '.duplicate' type, so it is inert.
UPDATE outbox_events oe
   SET event_type = 'settlement.paid.duplicate'
  FROM outbox_events earlier
 WHERE oe.event_type = 'settlement.paid'
   AND earlier.event_type = 'settlement.paid'
   AND earlier.aggregate_id = oe.aggregate_id
   AND (earlier.created_at, earlier.id) < (oe.created_at, oe.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_settlement_paid_per_batch
    ON outbox_events (aggregate_id)
 WHERE event_type = 'settlement.paid';
