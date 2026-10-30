/** refund_merchant_summary is refreshed by runConsumerPass when a refund.succeeded was applied. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("refundMatview.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(() => pool.end());

test("matview is populated after a consumer pass applying refund.succeeded", async () => {
  while ((await runConsumerPass(pool, { consumerBatchLimit: 500 })).processedCount > 0);
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1,250) RETURNING id`,
    [`matview ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1,'captured',10000,10000,$2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  const at = "2026-04-09T21:30:00Z"; // Bahrain 2026-04-10
  const r = await pool.query<{ id: string }>(
    `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
     VALUES ($1,$2,4000,100,'succeeded','ref','unspecified','merchant_api_key',$3,$4) RETURNING id`,
    [t.rows[0]!.id, merchantId, randomUUID(), at],
  );
  const before = await pool.query(`SELECT 1 FROM refund_merchant_summary WHERE merchant_id=$1`, [merchantId]);
  assert.equal(before.rows.length, 0);
  await pool.query(
    `INSERT INTO outbox_events (aggregate_type, event_type, aggregate_id, payload, created_at)
     VALUES ('refund','refund.succeeded',$1,$2,$3)`,
    [r.rows[0]!.id, JSON.stringify({ merchantId, amountFils: 4000, occurredAt: at }), at],
  );
  await runConsumerPass(pool, { consumerBatchLimit: 500 });
  const res = await pool.query(
    `SELECT business_date::text AS d, refund_count::int AS c, total_refunded_fils::text AS a, total_fee_reversed_fils::text AS f
       FROM refund_merchant_summary WHERE merchant_id=$1`,
    [merchantId],
  );
  assert.equal(res.rows.length, 1);
  assert.deepEqual(res.rows[0], { d: "2026-04-10", c: 1, a: "4000", f: "100" });
});
