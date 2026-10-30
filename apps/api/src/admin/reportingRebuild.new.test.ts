import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { refreshAnalyticsRollups } from "./reportingRebuild.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("reportingRebuild.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
after(async () => pool.end());

test("rebuild keeps refund rollups, bucketed on the Bahrain date (rolled back)", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const m = (
      await client.query(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
        `rb ${randomUUID()}`,
      ])
    ).rows[0].id;
    const t = (
      await client.query(
        `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference, occurred_at)
         VALUES ($1,'partially_refunded',10000,10000,3000,$2,'2026-04-01T00:00:00Z') RETURNING id`,
        [m, `acq_${randomUUID()}`],
      )
    ).rows[0].id;
    // 21:30Z on Mar 31 is already Apr 1 in Bahrain
    for (const [amt, at] of [
      [1000, "2026-03-31T21:30:00Z"],
      [2000, "2026-04-01T08:00:00Z"],
    ] as const) {
      await client.query(
        `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, status, acquirer_reference, created_by_type, created_by_id, occurred_at)
         VALUES ($1,$2,$3,'succeeded',$4,'merchant_session',$5,$6)`,
        [t, m, amt, `r_${randomUUID()}`, randomUUID(), at],
      );
    }
    await refreshAnalyticsRollups(client);
    const r = await client.query(
      `SELECT volume_date::text AS d, refund_count, refund_gross_fils FROM merchant_daily_volume WHERE merchant_id=$1`,
      [m],
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].d, "2026-04-01");
    assert.equal(Number(r.rows[0].refund_count), 2);
    assert.equal(Number(r.rows[0].refund_gross_fils), 3000);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
