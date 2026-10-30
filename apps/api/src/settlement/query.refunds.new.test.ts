/** FP-300: reconciliation + summary with refunds, integer fee math, multi-capture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getReconciliationReport, getSettlementSummary } from "./query.js";
import { estimateFeeFils } from "../fees/estimate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("query.refunds.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(() => pool.end());

const DAY = "2026-03-10";
const NEXT = "2026-03-11";
const AT = "2026-03-10T09:00:00Z";

async function fixture(opts: { captures: number[]; fee: (a: number) => number; refund?: { amount: number; fee: number } }) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`refund recon ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const total = opts.captures.reduce((a, b) => a + b, 0);
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', $2, $2, $3) RETURNING id`,
    [merchantId, total, `acq_${randomUUID()}`],
  );
  const txnId = t.rows[0]!.id;
  for (const amount of opts.captures) {
    const fee = opts.fee(amount);
    await pool.query(
      `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, metadata, occurred_at)
       VALUES ($1, 'captured', $2, 'system', $3, $4)`,
      [txnId, amount, JSON.stringify({ feeFils: fee }), AT],
    );
    await pool.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES ($1,$2,$3,'card_scheme_clearing','debit',$4,$5,'capture: gross'),
              ($1,$2,$3,'merchant_payable','credit',$4,$5,'capture: gross')`,
      [randomUUID(), merchantId, txnId, amount, AT],
    );
    if (fee > 0) {
      await pool.query(
        `INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES ($1,$2,$3,'merchant_payable','debit',$4,$5,'capture: MDR fee'),
                ($1,$2,$3,'platform_fee_revenue','credit',$4,$5,'capture: MDR fee')`,
        [randomUUID(), merchantId, txnId, fee, AT],
      );
    }
  }
  if (opts.refund) {
    const { amount, fee } = opts.refund;
    await pool.query(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
       VALUES ($1,$2,$3,$4,'succeeded','ref','unspecified','merchant_api_key',$5,$6)`,
      [txnId, merchantId, amount, fee, randomUUID(), AT],
    );
    await pool.query(`UPDATE transactions SET refunded_fils = $2 WHERE id = $1`, [txnId, amount]);
    await pool.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES ($1,$2,$3,'merchant_payable','debit',$4,$5,'refund: gross'),
              ($1,$2,$3,'card_scheme_clearing','credit',$4,$5,'refund: gross')`,
      [randomUUID(), merchantId, txnId, amount, AT],
    );
    if (fee > 0) {
      await pool.query(
        `INSERT INTO ledger_entries (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES ($1,$2,$3,'platform_fee_revenue','debit',$4,$5,'refund: MDR fee reversal'),
                ($1,$2,$3,'merchant_payable','credit',$4,$5,'refund: MDR fee reversal')`,
        [randomUUID(), merchantId, txnId, fee, AT],
      );
    }
  }
  return merchantId;
}

test("estimateFeeFils is integer math (MDR then discount on the fee)", () => {
  assert.equal(estimateFeeFils(1000, 250, 0), 25);
  assert.equal(estimateFeeFils(10_000, 250, 1000), 225);
  assert.ok(Number.isInteger(estimateFeeFils(12345, 175, 333)));
});

test("reconciliation: unbatched partial refund is in pending and gap is 0", async () => {
  const merchantId = await fixture({ captures: [10_000], fee: () => 250, refund: { amount: 4_000, fee: 100 } });
  const r = await getReconciliationReport(pool, { merchantId, from: DAY, to: NEXT });
  assert.equal(r.ledgerMerchantPayableNetFils, 10_000 - 250 - 4_000 + 100);
  assert.equal(r.pendingUnbatchedFils, 10_000 - 250 - (4_000 - 100));
  assert.equal(r.gapFils, 0);
  assert.equal(r.explained, true);
});

test("reconciliation: full refund nets pending to 0, gap 0", async () => {
  const merchantId = await fixture({ captures: [10_000], fee: () => 250, refund: { amount: 10_000, fee: 250 } });
  const r = await getReconciliationReport(pool, { merchantId, from: DAY, to: NEXT });
  assert.equal(r.pendingUnbatchedFils, 0);
  assert.equal(r.gapFils, 0);
});

test("reconciliation: uses the journaled fee, so a fee the current-rate estimate would miss still ties out", async () => {
  const merchantId = await fixture({ captures: [10_002], fee: () => 26 });
  const r = await getReconciliationReport(pool, { merchantId, from: DAY, to: NEXT });
  assert.equal(r.gapFils, 0);
});

test("reconciliation: a batched refund is not counted again in pending", async () => {
  const merchantId = await fixture({ captures: [10_000], fee: () => 250, refund: { amount: 4_000, fee: 100 } });
  const b = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, refunds_fils, refund_fee_reversed_fils, closed_at)
     VALUES ($1,$2,'closed',10000,250,$3,4000,100,now()) RETURNING id`,
    [merchantId, DAY, 10_000 - 250 - 4_000 + 100],
  );
  await pool.query(`UPDATE refunds SET settlement_batch_id = $1 WHERE merchant_id = $2`, [b.rows[0]!.id, merchantId]);
  await pool.query(
    `UPDATE transaction_events SET settlement_batch_id = $1 WHERE transaction_id IN (SELECT id FROM transactions WHERE merchant_id = $2)`,
    [b.rows[0]!.id, merchantId],
  );
  const r = await getReconciliationReport(pool, { merchantId, from: DAY, to: NEXT });
  assert.equal(r.pendingUnbatchedFils, 0);
  assert.equal(r.settlementNetPayoutFils, 5_850);
  assert.equal(r.gapFils, 0);
});

test("settlement summary: multi-capture transaction summed per event, refunds netted", async () => {
  const merchantId = await fixture({ captures: [3_000, 2_000], fee: () => 0, refund: { amount: 1_000, fee: 0 } });
  const s = await getSettlementSummary(pool, { merchantId, from: DAY, to: NEXT });
  assert.equal(s.transactionCount, 1);
  assert.equal(s.totalCapturedFils, 5_000);
  assert.equal(s.refundCount, 1);
  assert.equal(s.totalRefundedFils, 1_000);
  assert.equal(s.netFils, 4_000);
});
