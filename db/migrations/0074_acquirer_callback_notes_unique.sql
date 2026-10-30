-- FP-201: the acquirer redelivers callbacks (at-least-once); 0051 left
-- callback_id unconstrained and its comment's "processed_events" / FP-238
-- dedupe never existed, so every redelivery saved another note.
-- Collapse existing duplicates (keep the earliest note per callback_id) and
-- enforce one note per acquirer callback_id from now on.

DELETE FROM acquirer_callback_notes n
 USING acquirer_callback_notes keep
 WHERE n.callback_id = keep.callback_id
   AND (keep.created_at, keep.id) < (n.created_at, n.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);
