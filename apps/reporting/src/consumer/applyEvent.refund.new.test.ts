/** FP-300: refund.succeeded rollup (Bahrain date, columns, consumer type list). */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";
import { REPORTING_EVENT_TYPES } from "./runConsumerPass.js";
import { withTransaction } from "../db/withTransaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("applyEvent.refund.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(() => pool.end());

async function merchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`refund rollup ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

function row(merchantId: string, amountFils: number, created_at: Date, extra: Record<string, unknown> = {}): OutboxEventRow {
  return {
    id: 1,
    event_type: "refund.succeeded",
    aggregate_id: randomUUID(),
    payload: { merchantId, amountFils, ...extra },
    created_at,
  };
}

test("consumer subscribes to refund.succeeded", () => {
  assert.ok(REPORTING_EVENT_TYPES.includes("refund.succeeded"));
});

test("refund at 00:30 Bahrain (21:30 UTC previous day) lands on the Bahrain date and accumulates", async () => {
  const merchantId = await merchant();
  const at = new Date("2026-04-09T21:30:00Z"); // 2026-04-10 00:30 +03:00
  await withTransaction(pool, async (c) => {
    await applyEvent(c, row(merchantId, 4_000, at));
    await applyEvent(c, row(merchantId, 1_500, at));
  });
  const res = await pool.query(
    `SELECT volume_date::text AS d, refund_count, refund_gross_fils::text AS g FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].d, "2026-04-10");
  assert.equal(res.rows[0].refund_count, 2);
  assert.equal(res.rows[0].g, "5500");
});

test("payload.occurredAt wins over outbox created_at", async () => {
  const merchantId = await merchant();
  await withTransaction(pool, async (c) => {
    await applyEvent(c, row(merchantId, 100, new Date("2026-04-12T10:00:00Z"), { occurredAt: "2026-04-09T21:30:00Z" }));
  });
  const res = await pool.query(`SELECT volume_date::text AS d FROM merchant_daily_volume WHERE merchant_id = $1`, [merchantId]);
  assert.equal(res.rows[0].d, "2026-04-10");
});

test("refund_merchant_summary joins refunds to their transaction and counts correctly", async () => {
  const merchantId = await merchant();
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1,'captured',1000,1000,$2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  for (const amt of [300, 300]) {
    await pool.query(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
       VALUES ($1,$2,$3,7,'succeeded','r','unspecified','merchant_api_key',$4,'2026-04-09T21:30:00Z')`,
      [t.rows[0]!.id, merchantId, amt, randomUUID()],
    );
  }
  await pool.query(`REFRESH MATERIALIZED VIEW refund_merchant_summary`);
  const res = await pool.query(
    `SELECT business_date::text AS d, refund_count::int AS c, total_refunded_fils::text AS s, total_fee_reversed_fils::text AS f
       FROM refund_merchant_summary WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.deepEqual(res.rows, [{ d: "2026-04-10", c: 2, s: "600", f: "14" }]);
});
