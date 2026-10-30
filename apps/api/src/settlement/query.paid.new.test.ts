/** Paid batch reconciles (gap 0, explained) with and without refunds. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getReconciliationReport } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("query.paid.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(() => pool.end());

const DAY = "2026-03-12";
const NEXT = "2026-03-13";
const AT = "2026-03-12T09:00:00Z";
const PAID_AT = "2026-03-13T12:00:00Z";

async function paidBatch(withRefund: boolean, payoutAt: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`paid recon ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1,'captured',10000,10000,$2) RETURNING id`,
    [merchantId, `acq_${randomUUID()}`],
  );
  const txnId = t.rows[0]!.id;
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata, occurred_at)
     VALUES ($1,'captured',10000,'system',$2,$3)`,
    [txnId, JSON.stringify({ feeFils: 250 }), AT],
  );
  const pair = (dr: string, cr: string, amt: number, desc: string, at: string, batch: string | null = null) =>
    pool.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES ($1,$2,$3,$4,$5,'debit',$7,$8,$9), ($1,$2,$3,$4,$6,'credit',$7,$8,$9)`,
      [randomUUID(), merchantId, batch ? null : txnId, batch, dr, cr, amt, at, desc],
    );
  await pair("card_scheme_clearing", "merchant_payable", 10000, "capture: gross", AT);
  await pair("merchant_payable", "platform_fee_revenue", 250, "capture: MDR fee", AT);
  let net = 9750;
  let refund = { n: 0, f: 0 };
  if (withRefund) {
    refund = { n: 4000, f: 100 };
    await pair("merchant_payable", "card_scheme_clearing", 4000, "refund: gross", AT);
    await pair("platform_fee_revenue", "merchant_payable", 100, "refund: MDR fee reversal", AT);
    net = 9750 - 4000 + 100;
  }
  const b = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, refunds_fils, refund_fee_reversed_fils, closed_at, paid_at)
     VALUES ($1,$2,'paid',10000,250,$3,$4,$5,now(),now()) RETURNING id`,
    [merchantId, DAY, net, refund.n, refund.f],
  );
  const batchId = b.rows[0]!.id;
  await pool.query(`UPDATE transaction_events SET settlement_batch_id=$1 WHERE transaction_id=$2`, [batchId, txnId]);
  if (withRefund) {
    await pool.query(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, reason, created_by_type, created_by_id, occurred_at, settlement_batch_id)
       VALUES ($1,$2,4000,100,'succeeded','ref','unspecified','merchant_api_key',$3,$4,$5)`,
      [txnId, merchantId, randomUUID(), AT, batchId],
    );
  }
  await pair("merchant_payable", "platform_cash", net, "settlement payout: batch paid", payoutAt, batchId);
  return { merchantId, net };
}

for (const withRefund of [false, true]) {
  for (const [label, at] of [["payout inside window", AT], ["payout after window", PAID_AT]] as const) {
    test(`paid batch reconciles ${withRefund ? "with" : "without"} refunds (${label})`, async () => {
      const { merchantId, net } = await paidBatch(withRefund, at);
      const r = await getReconciliationReport(pool, { merchantId, from: DAY, to: NEXT });
      assert.equal(r.settlementNetPayoutFils, net);
      assert.equal(r.ledgerMerchantPayableNetFils, net);
      assert.equal(r.pendingUnbatchedFils, 0);
      assert.equal(r.gapFils, 0);
      assert.equal(r.explained, true);
    });
  }
}
