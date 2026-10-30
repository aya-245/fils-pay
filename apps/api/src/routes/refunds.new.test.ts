/**
 * FP-300 refund route tests (POST /v1/refunds and
 * POST /v1/merchants/:merchantId/refunds) against a real, migrated Postgres.
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { sha256Hex } from "../lib/crypto.js";
import { startImpersonation } from "../admin/impersonation.js";
import { processRefund } from "../payments/processRefund.js";
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function createMerchant(label: string, opts: { mdrBps?: number; discountBps?: number } = {}) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, $2, $3) RETURNING id`,
    [`Refund Route ${label} ${randomUUID()}`, opts.mdrBps ?? 250, opts.discountBps ?? 0],
  );
  const merchantId = merchantResult.rows[0]!.id;
  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: userResult.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function sessionCookie(merchantId: string, role: "owner" | "finance" | "support") {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, $3, 'unused') RETURNING id`,
    [merchantId, `${role}-${randomUUID()}@example.test`, role],
  );
  const rawToken = randomUUID() + randomUUID();
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [user.rows[0]!.id, sha256Hex(rawToken)],
  );
  return { [config.cookieName]: rawToken };
}

async function captured(rawKey: string, amountFils: number, captureFils?: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-route" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

function refund(
  rawKey: string,
  payload: Record<string, unknown>,
  opts: { key?: string | null; url?: string } = {},
) {
  const headers: Record<string, string> = { authorization: `Bearer ${rawKey}` };
  if (opts.key !== null) headers["idempotency-key"] = opts.key ?? randomUUID();
  return app.inject({ method: "POST", url: opts.url ?? "/v1/refunds", headers, payload });
}

async function counts(transactionId: string) {
  const r = await pool.query<{ refunds: number; ledger: number; refunded: string; status: string }>(
    `SELECT (SELECT COUNT(*)::int FROM refunds WHERE transaction_id = $1) AS refunds,
            (SELECT COUNT(*)::int FROM ledger_entries WHERE transaction_id = $1) AS ledger,
            t.refunded_fils::text AS refunded, t.status
       FROM transactions t WHERE t.id = $1`,
    [transactionId],
  );
  return r.rows[0]!;
}

test("full refund via POST /v1/refunds: 200, refunded, balanced legs, refundedFils on the DTO", async () => {
  const m = await createMerchant("full");
  const txnId = await captured(m.rawKey, 10_000);

  const res = await refund(m.rawKey, { transactionId: txnId });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.amountFils, 10_000);
  assert.equal(body.feeReversedFils, 250);
  assert.equal(body.transactionStatus, "refunded");
  assert.equal(body.refundedTotalFils, 10_000);
  assert.equal(body.reason, "unspecified");

  const legs = await pool.query<{ account_id: string; net: string }>(
    `SELECT account_id, SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 GROUP BY account_id`,
    [txnId],
  );
  const net = new Map(legs.rows.map((r) => [r.account_id, Number(r.net)]));
  assert.equal(net.get("merchant_payable"), 0);
  assert.equal(net.get("platform_fee_revenue"), 0);
  assert.equal(net.get("card_scheme_clearing"), 0);

  const dto = await app.inject({
    method: "GET",
    url: `/v1/transactions/${txnId}`,
    headers: { authorization: `Bearer ${m.rawKey}` },
  });
  assert.equal(dto.statusCode, 200, dto.body);
  assert.equal(dto.json().refundedFils, 10_000);
  assert.equal(dto.json().status, "refunded");
});

test("partial refund via POST /v1/merchants/:id/refunds with a reason", async () => {
  const m = await createMerchant("partial-path");
  const txnId = await captured(m.rawKey, 10_000);
  const res = await refund(
    m.rawKey,
    { transactionId: txnId, amountFils: 2_500, reason: "damaged item" },
    { url: `/v1/merchants/${m.merchantId}/refunds` },
  );
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().transactionStatus, "partially_refunded");
  assert.equal(res.json().reason, "damaged item");
  const row = await pool.query<{ reason: string }>(`SELECT reason FROM refunds WHERE transaction_id = $1`, [txnId]);
  assert.equal(row.rows[0]!.reason, "damaged item");
});

test("path merchant that is not the caller is 403", async () => {
  const m = await createMerchant("path-mismatch");
  const other = await createMerchant("path-mismatch-other");
  const txnId = await captured(m.rawKey, 1_000);
  const res = await refund(m.rawKey, { transactionId: txnId }, { url: `/v1/merchants/${other.merchantId}/refunds` });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal((await counts(txnId)).refunds, 0);
});

test("cross-merchant: B refunding A's transaction id is 404 and writes nothing", async () => {
  const a = await createMerchant("victim");
  const b = await createMerchant("attacker");
  const txnId = await captured(a.rawKey, 10_000);
  const before = await counts(txnId);

  for (const url of ["/v1/refunds", `/v1/merchants/${b.merchantId}/refunds`]) {
    const res = await refund(b.rawKey, { transactionId: txnId }, { url });
    assert.equal(res.statusCode, 404, res.body);
    assert.equal(res.json().error, "transaction_not_found");
  }
  // processRefund itself is scoped too, not only the entry point.
  const direct = await processRefund(pool, app.acquirer, {
    transactionId: txnId,
    merchantId: b.merchantId,
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });
  assert.equal(direct.statusCode, 404);

  const after = await counts(txnId);
  assert.deepEqual(after, before);
  const outbox = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'refund.succeeded'`,
    [txnId],
  );
  assert.equal(outbox.rows[0]!.c, 0);
});

test("missing Idempotency-Key is 400; float or non-positive amounts are 400 invalid_request", async () => {
  const m = await createMerchant("bad-input");
  const txnId = await captured(m.rawKey, 1_000);
  const noKey = await refund(m.rawKey, { transactionId: txnId }, { key: null });
  assert.equal(noKey.statusCode, 400);
  assert.equal(noKey.json().error, "idempotency_key_required");
  for (const amountFils of [4.75, 0, -5, "100"]) {
    const res = await refund(m.rawKey, { transactionId: txnId, amountFils });
    assert.equal(res.statusCode, 400, `${String(amountFils)}: ${res.body}`);
    assert.equal(res.json().error, "invalid_request");
  }
  const badId = await refund(m.rawKey, { transactionId: "not-a-uuid" });
  assert.equal(badId.statusCode, 400);
  assert.equal((await counts(txnId)).refunds, 0);
});

test("replaying the same Idempotency-Key returns the same body and refunds once", async () => {
  const m = await createMerchant("replay");
  const txnId = await captured(m.rawKey, 6_000);
  const key = randomUUID();
  const first = await refund(m.rawKey, { transactionId: txnId, amountFils: 1_500 }, { key });
  const second = await refund(m.rawKey, { transactionId: txnId, amountFils: 1_500 }, { key });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), first.json());
  const c = await counts(txnId);
  assert.equal(c.refunds, 1);
  assert.equal(Number(c.refunded), 1_500);
});

test("refunds_enabled = false is 403 refunds_on_hold", async () => {
  const m = await createMerchant("on-hold");
  const txnId = await captured(m.rawKey, 3_000);
  await pool.query(`UPDATE merchants SET refunds_enabled = false WHERE id = $1`, [m.merchantId]);
  const res = await refund(m.rawKey, { transactionId: txnId });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "refunds_on_hold");
});

test("sessions: owner and finance may refund, support may not", async () => {
  const m = await createMerchant("roles");
  const txnId = await captured(m.rawKey, 3_000);
  for (const [role, expected] of [
    ["support", 403],
    ["finance", 200],
    ["owner", 200],
  ] as const) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/merchants/${m.merchantId}/refunds`,
      headers: { "idempotency-key": randomUUID() },
      cookies: await sessionCookie(m.merchantId, role),
      payload: { transactionId: txnId, amountFils: 1_000 },
    });
    assert.equal(res.statusCode, expected, `${role}: ${res.body}`);
  }
});

test("admin impersonation (even super_admin, which maps to owner) is refused", async () => {
  const m = await createMerchant("impersonation");
  const txnId = await captured(m.rawKey, 3_000);
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused', 'Refund Test Admin', 'super_admin') RETURNING id`,
    [`admin-${randomUUID()}@example.test`],
  );
  const grant = await startImpersonation(pool, {
    adminUserId: admin.rows[0]!.id,
    merchantId: m.merchantId,
    ttlMinutes: 10,
  });
  const res = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { "idempotency-key": randomUUID() },
    cookies: { [config.impersonationCookieName]: grant.rawToken },
    payload: { transactionId: txnId },
  });
  assert.equal(res.statusCode, 403, res.body);
  // requireMerchantAuth refuses every impersonation write before the handler runs.
  assert.equal(res.json().error, "forbidden");
  assert.equal((await counts(txnId)).refunds, 0);
});

test("partial capture: ceiling is captured - refunded (4001 of 4000 rejected); full refund -> refunded, hold released", async () => {
  const m = await createMerchant("partial-capture");
  const txnId = await captured(m.rawKey, 10_000, 4_000);

  const over = await refund(m.rawKey, { transactionId: txnId, amountFils: 4_001 });
  assert.equal(over.statusCode, 422, over.body);
  assert.deepEqual(over.json(), { ok: false, code: "refund_exceeds_refundable", refundableFils: 4_000 });

  const ok = await refund(m.rawKey, { transactionId: txnId, amountFils: 4_000 });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().transactionStatus, "refunded");

  const again = await refund(m.rawKey, { transactionId: txnId, amountFils: 1 });
  assert.equal(again.statusCode, 409, again.body);

  const holds = await pool.query<{ status: string }>(`SELECT status FROM holds WHERE transaction_id = $1`, [txnId]);
  for (const h of holds.rows) assert.notEqual(h.status, "active");
});

test("over-refund across partials is rejected with the remaining ceiling", async () => {
  const m = await createMerchant("over-refund");
  const txnId = await captured(m.rawKey, 10_000);
  assert.equal((await refund(m.rawKey, { transactionId: txnId, amountFils: 7_000 })).statusCode, 200);
  const over = await refund(m.rawKey, { transactionId: txnId, amountFils: 3_001 });
  assert.equal(over.statusCode, 422);
  assert.equal(over.json().refundableFils, 3_000);
  assert.equal(Number((await counts(txnId)).refunded), 7_000);
});

test("concurrent refunds with different keys summing above captured: exactly one wins", async () => {
  const m = await createMerchant("concurrent");
  const txnId = await captured(m.rawKey, 10_000);
  const slowAcquirer: AcquirerSimulator = {
    authorize() {
      throw new Error("unused");
    },
    capture() {
      throw new Error("unused");
    },
    async refund(req): Promise<AcquirerRefundResult> {
      await new Promise((r) => setTimeout(r, 150));
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 150 };
    },
  };
  const actor = { type: "merchant_api_key" as const, id: randomUUID() };
  const results = await Promise.all(
    [0, 1, 2].map(() =>
      processRefund(pool, slowAcquirer, {
        transactionId: txnId,
        merchantId: m.merchantId,
        amountFils: toFils(6_000),
        idempotencyKey: randomUUID(),
        actor,
      }),
    ),
  );
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 422, 422]);
  const c = await counts(txnId);
  assert.equal(c.refunds, 1);
  assert.equal(Number(c.refunded), 6_000);
});

test("fee reversal is cumulative: 300/300/300/100 of 1000 at 250 bps (fee 25) reverses 8/7/7/3", async () => {
  const m = await createMerchant("fee-cumulative", { mdrBps: 250 });
  const txnId = await captured(m.rawKey, 1_000);
  const reversed: number[] = [];
  for (const amountFils of [300, 300, 300, 100]) {
    const res = await refund(m.rawKey, { transactionId: txnId, amountFils });
    assert.equal(res.statusCode, 200, res.body);
    reversed.push(res.json().feeReversedFils);
  }
  assert.deepEqual(reversed, [8, 7, 7, 3]);
  const sum = await pool.query<{ s: string }>(
    `SELECT SUM(fee_reversed_fils)::text AS s FROM refunds WHERE transaction_id = $1`,
    [txnId],
  );
  assert.equal(Number(sum.rows[0]!.s), 25);
  const mp = await pool.query<{ net: string }>(
    `SELECT SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'merchant_payable'`,
    [txnId],
  );
  assert.equal(Number(mp.rows[0]!.net), 0);
});

test("negotiated discount: a full refund reverses the NET fee charged, merchant_payable nets to 0", async () => {
  const m = await createMerchant("discount", { mdrBps: 250, discountBps: 2_000 });
  const txnId = await captured(m.rawKey, 10_000);
  // fee 250, discount 20% of fee = 50, net fee charged 200
  const res = await refund(m.rawKey, { transactionId: txnId });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().feeReversedFils, 200);
  const net = await pool.query<{ account_id: string; net: string }>(
    `SELECT account_id, SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 GROUP BY account_id`,
    [txnId],
  );
  for (const row of net.rows) assert.equal(Number(row.net), 0, row.account_id);
});

test("CSV export carries refunded_bhd", async () => {
  const m = await createMerchant("csv");
  const txnId = await captured(m.rawKey, 4_750);
  assert.equal((await refund(m.rawKey, { transactionId: txnId, amountFils: 1_250 })).statusCode, 200);
  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export",
    headers: { authorization: `Bearer ${m.rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const lines = res.body.trim().split("\n");
  assert.equal(lines[0], "id,status,amount_bhd,captured_bhd,reference,occurred_at,refunded_bhd");
  const line = lines.find((l) => l.startsWith(txnId))!;
  assert.equal(line.split(",")[6], "1.250");
});
