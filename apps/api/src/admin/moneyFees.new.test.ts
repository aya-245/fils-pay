/**
 * Money/fees audit regressions (docs/audit/money-fees.md). Real Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";
import { bulkApproveMerchantsKyc } from "./bulkKyc.js";
import { reconcileSandboxFlag } from "./merchantFlags.js";
import { recomputeTransactionStatusesForMerchant } from "./transactionStatusRecompute.js";
import { getCurrentFeeScheduleForDisplay } from "../fees/currentFeeScheduleDisplay.js";
import { getEffectiveMdrBps } from "../fees/feeSchedule.js";
import { getVolumeTierBonusBps } from "../fees/platformVolumeTier.js";
import { runTransactionsReport } from "../reporting/transactionsReportQuery.js";
import { getRecentLedgerActivity } from "../analytics/query.js";
import { buildTransactionsExportCsv } from "../transactions/exportCsv.js";
import { buildWhere, buildDelete } from "../../../../scripts/lib/sqlFilter.js";
import { sweepEntryGroupId } from "../../../../scripts/reconcile_march.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("moneyFees.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
after(async () => {
  await pool.query(`UPDATE platform_stats SET total_processed_fils = 0 WHERE id = 1`);
  await pool.end();
});

async function merchant(opts: { testMode?: boolean; onboarding?: string } = {}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, test_mode, onboarding_status) VALUES ($1, 250, $2, $3) RETURNING id`,
    [`audit ${randomUUID()}`, opts.testMode ?? false, opts.onboarding ?? "submitted"],
  );
  return r.rows[0]!.id;
}

async function txn(merchantId: string, status: string, amount: number, captured: number, at: string, refunded = 0) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [merchantId, status, amount, captured, refunded, `acq_${randomUUID()}`, at],
  );
  return r.rows[0]!.id;
}

test("bug1: CSV import reads BD with 3 decimals as fils", () => {
  assert.equal(parseAdjustmentAmountFils("4.755"), 4755);
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
  assert.equal(parseAdjustmentAmountFils("-1.5"), -1500);
  assert.equal(parseAdjustmentAmountFils("12"), 12000);
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse/);
});

test("bug2: dashboard fee display matches the schedule used for charging", async () => {
  const m = await merchant();
  const ins = (bps: number, eff: string, created: string) =>
    pool.query(`INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES ($1,$2,$3,$4)`, [
      m, bps, eff, created,
    ]);
  await ins(225, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  // backfill entered later, effective in the future / not yet applicable
  await ins(245, "2099-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
  const shown = await getCurrentFeeScheduleForDisplay(pool, m);
  const client = await pool.connect();
  try {
    const charged = await getEffectiveMdrBps(client, m, new Date(), 250);
    assert.equal(charged, 225);
    assert.equal(shown?.mdrBps, charged);
  } finally {
    client.release();
  }
  // backdated correction entered today: wins by effective_from, not created_at
  await ins(200, "2025-06-01T00:00:00Z", "2026-03-01T00:00:00Z");
  assert.equal((await getCurrentFeeScheduleForDisplay(pool, m))?.mdrBps, 225);
});

test("bug3: sweep entry group id is deterministic per period and merchant", () => {
  const a = sweepEntryGroupId(2026, 3, "m1");
  assert.equal(a, sweepEntryGroupId(2026, 3, "m1"));
  assert.notEqual(a, sweepEntryGroupId(2026, 3, "m2"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("bug4: filters are bound, identifiers are checked, dates are Bahrain days", async () => {
  assert.throws(() => buildWhere({ "id; DROP TABLE x": 1 }), /unsafe SQL identifier/);
  assert.throws(() => buildDelete("holds", {}), /without a filter/);
  assert.throws(() => buildDelete("holds", { id: [] }), /without a filter/);

  const m = await merchant();
  // 2026-03-31T21:30Z is 2026-04-01 00:30 in Bahrain
  await txn(m, "captured", 1000, 1000, "2026-03-31T21:30:00Z");
  await txn(m, "captured", 2000, 2000, "2026-04-01T10:00:00Z");
  const apr = await runTransactionsReport(pool, { merchantId: m, from: "2026-04-01", to: "2026-04-02" });
  assert.equal(apr.length, 2);
  await assert.rejects(() => runTransactionsReport(pool, { merchantId: m, status: "x' OR '1'='1", from: "nope" }));
  const none = await runTransactionsReport(pool, { merchantId: m, status: "x' OR '1'='1" });
  assert.equal(none.length, 0);

  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at)
     VALUES ($1,$2,'merchant_payable','debit',100,'2026-03-31T21:30:00Z'),
            ($1,$2,'scheme_rounding_residue','credit',100,'2026-03-31T21:30:00Z')`,
    [randomUUID(), m],
  );
  const day = await getRecentLedgerActivity(pool, { merchantId: m, from: "2026-04-01", to: "2026-04-01" });
  assert.equal(day.points.length, 2);
  const prev = await getRecentLedgerActivity(pool, { merchantId: m, from: "2026-03-31", to: "2026-03-31" });
  assert.equal(prev.points.length, 0);
});

test("bug5: export pages by (occurred_at, id) so equal timestamps are not dropped", async () => {
  const m = await merchant();
  for (let i = 0; i < 1005; i++) await txn(m, "captured", 1000, 1000, "2026-05-01T00:00:00Z");
  const csv = await buildTransactionsExportCsv(pool, { merchantId: m });
  assert.equal(csv.split("\n").length, 1006);
});

test("bug6: recompute leaves chargebacks and sandbox flag alone; bulk KYC only moves under_review", async () => {
  const m = await merchant({ testMode: true });
  const cb = await txn(m, "chargeback", 5000, 5000, "2026-05-01T00:00:00Z");
  const ok = await txn(m, "captured", 5000, 5000, "2026-05-01T00:00:00Z", 5000);
  const client = await pool.connect();
  try {
    const res = await recomputeTransactionStatusesForMerchant(client, m);
    assert.equal(res.scanned, 1);
    assert.deepEqual(await reconcileSandboxFlag(client, m, res), []);
  } finally {
    client.release();
  }
  const rows = await pool.query(`SELECT id, status FROM transactions WHERE id = ANY($1)`, [[cb, ok]]);
  assert.equal(rows.rows.find((r) => r.id === cb).status, "chargeback");
  assert.equal(rows.rows.find((r) => r.id === ok).status, "refunded");
  assert.equal((await pool.query(`SELECT test_mode FROM merchants WHERE id=$1`, [m])).rows[0].test_mode, true);

  const rejected = await merchant({ onboarding: "rejected" });
  const review = await merchant({ onboarding: "under_review" });
  const admin = await pool.query<{ id: string }>(`SELECT id FROM admin_users LIMIT 1`);
  if (admin.rows[0]) {
    const out = await bulkApproveMerchantsKyc(pool, { merchantIds: [rejected, review], adminUserId: admin.rows[0].id });
    assert.deepEqual(out.approvedMerchantIds, [review]);
  }
});

test("bug7: platform_stats holds volumes past INT4", async () => {
  await pool.query(`UPDATE platform_stats SET total_processed_fils = 5000000000 WHERE id = 1`);
  const c = await pool.connect();
  try {
    assert.equal(await getVolumeTierBonusBps(c), 15);
  } finally {
    c.release();
  }
});
