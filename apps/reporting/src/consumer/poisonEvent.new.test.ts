/**
 * A malformed outbox row stops the reporting consumer (fail-stop, see
 * runConsumerPass.ts) — this pins that the failure names the offending row
 * and leaves the cursor untouched, so an operator can find and fix it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { CONSUMER_NAME, runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("poisonEvent.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(() => pool.end());

test("a malformed event aborts the pass with an error naming the outbox id, and the cursor does not move", async () => {
  await pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ($1, (SELECT COALESCE(MAX(id), 0) FROM outbox_events), now())
     ON CONFLICT (consumer_name) DO UPDATE
       SET last_processed_id = GREATEST(reporting_outbox_cursor.last_processed_id, EXCLUDED.last_processed_id)`,
    [CONSUMER_NAME],
  );
  const cursorOf = async () =>
    (await pool.query<{ v: string }>(`SELECT last_processed_id::text AS v FROM reporting_outbox_cursor WHERE consumer_name = $1`, [
      CONSUMER_NAME,
    ])).rows[0]!.v;
  const before = await cursorOf();
  const bad = await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: {},
  });
  try {
    await assert.rejects(runConsumerPass(pool, { consumerBatchLimit: 500 }), (err: Error) => {
      assert.match(err.message, new RegExp(`outbox event ${bad.id} \\(transaction\\.captured\\)`));
      assert.ok(err.cause, "original database error kept as cause");
      return true;
    });
    assert.equal(await cursorOf(), before);
  } finally {
    await pool.query(`DELETE FROM outbox_events WHERE id = $1`, [bad.id]);
  }
  assert.equal((await runConsumerPass(pool, { consumerBatchLimit: 500 })).processedCount, 0);
});
