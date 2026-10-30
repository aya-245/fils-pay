/**
 * Audit regression tests: FP-187 (client timestamp), incident 2026-05-14
 * (double charge), cross-merchant cancel, public read leak, discount parsing,
 * and FP-201 (duplicate acquirer callbacks). Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { parsePromotionalDiscountFils } from "../payments/discountAdjustment.js";
import { applyAcquirerCallback } from "../acquirer/callbacks.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("paymentLinks.new.test.ts requires DATABASE_URL");

function mkConfig(latencyMs: string, timeoutSeconds: string) {
  return loadConfig({
    DATABASE_URL: databaseUrl as string,
    NODE_ENV: "test",
    INTERNAL_API_TOKEN: "test-internal-token",
    ACQUIRER_FAILURE_RATE: "0",
    ACQUIRER_LATENCY_MIN_MS: latencyMs,
    ACQUIRER_LATENCY_MAX_MS: latencyMs,
    PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: timeoutSeconds,
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  });
}
const config = mkConfig("0", "60");
// Slow acquirer + 1s reservation timeout: a payment outlives the old timeout.
const slowConfig = mkConfig("700", "1");

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);
const slowApp = buildApp(slowConfig, pool);

test.after(async () => {
  await app.close();
  await slowApp.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchant(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`New ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function link(a: { merchantId: string; rawKey: string }) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${a.merchantId}/payment-links`,
    headers: { authorization: `Bearer ${a.rawKey}` },
    payload: { amountFils: 5_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; token: string };
}

function pay(a: typeof app, token: string, extra: Record<string, unknown> = {}) {
  return a.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: CARD, ...extra },
  });
}

test("FP-187: a client-supplied past submittedAt cannot pay an expired link", async () => {
  const m = await merchant("fp187");
  const l = await link(m);
  await pool.query(`UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [l.id]);
  const res = await pay(app, l.token, { submittedAt: new Date(Date.now() - 3_600_000).toISOString() });
  assert.equal(res.statusCode, 410, res.body);
  const row = await pool.query(`SELECT status FROM payment_links WHERE id = $1`, [l.id]);
  assert.equal(row.rows[0].status, "active");
});

test("incident 2026-05-14: a slow payment never admits a second buyer (one charge only)", async () => {
  const m = await merchant("double");
  const l = await link(m);
  const first = pay(slowApp, l.token);
  await new Promise((r) => setTimeout(r, 1_800)); // past the 1s reservation timeout, first still in flight
  const second = pay(slowApp, l.token);
  const [r1, r2] = await Promise.all([first, second]);
  const codes = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(codes, [200, 409], `${r1.body} / ${r2.body}`);
  const txns = await pool.query(`SELECT count(*)::int AS c FROM transactions WHERE merchant_id = $1`, [m.merchantId]);
  assert.equal(txns.rows[0].c, 1);
});

test("crash after capture, retry under a different Idempotency-Key does not charge again", async () => {
  const m = await merchant("crash");
  const l = await link(m);
  const r1 = await pay(app, l.token);
  assert.equal(r1.statusCode, 200, r1.body);
  // Simulate a crash before finalize: put the link back to a stale reservation.
  await pool.query(`UPDATE payment_links SET status='reserved', reserved_at=now()-interval '5 minutes', transaction_id=NULL, paid_at=NULL WHERE id=$1`, [l.id]);
  const r2 = await pay(app, l.token);
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().transactionId, r1.json().transactionId);
  const txns = await pool.query(`SELECT count(*)::int AS c FROM transactions WHERE merchant_id = $1`, [m.merchantId]);
  assert.equal(txns.rows[0].c, 1);
});

test("cancel: another merchant cannot cancel my link (404, link untouched)", async () => {
  const owner = await merchant("owner");
  const attacker = await merchant("attacker");
  const l = await link(owner);
  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${attacker.merchantId}/payment-links/${l.id}`,
    headers: { authorization: `Bearer ${attacker.rawKey}` },
  });
  assert.equal(res.statusCode, 404, res.body);
  const row = await pool.query(`SELECT status FROM payment_links WHERE id = $1`, [l.id]);
  assert.equal(row.rows[0].status, "active");
});

test("public read does not expose api key hashes", async () => {
  const m = await merchant("leak");
  const l = await link(m);
  const res = await app.inject({ method: "GET", url: `/v1/payment-links/${l.token}` });
  assert.equal(res.statusCode, 200);
  assert.equal("merchantIntegrationId" in res.json(), false);
});

test("parsePromotionalDiscountFils: BD string -> fils (1 BD = 1000)", () => {
  assert.equal(parsePromotionalDiscountFils("1.5"), 1_500);
  assert.equal(parsePromotionalDiscountFils("4.750"), 4_750);
  assert.equal(parsePromotionalDiscountFils("0.005"), 5);
  assert.throws(() => parsePromotionalDiscountFils("-1"));
  assert.throws(() => parsePromotionalDiscountFils("abc"));
});

test("FP-201: the same acquirer callback delivered twice stores one note", async () => {
  const m = await merchant("cb");
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 5000, 5000, $2) RETURNING id`,
    [m.merchantId, `acq_${randomUUID()}`],
  );
  const cb = {
    callbackId: `cb_${randomUUID()}`,
    type: "fraud_review.completed" as const,
    transactionId: t.rows[0]!.id,
    occurredAt: "2026-09-16T10:00:00.000Z",
    outcome: "cleared" as const,
    note: "ok",
  };
  await applyAcquirerCallback(pool, cb);
  await applyAcquirerCallback(pool, cb);
  const n = await pool.query(`SELECT count(*)::int AS c FROM acquirer_callback_notes WHERE callback_id = $1`, [cb.callbackId]);
  assert.equal(n.rows[0].c, 1);
});
