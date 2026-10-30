/**
 * FP-300: refund.succeeded envelope mapping and end-to-end delivery (real
 * refund via the route -> outbox -> runDispatchPass -> fake transport).
 * Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { buildEnvelope } from "./envelope.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { verifySignature } from "./sign.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refundWebhook.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_MAX_ATTEMPTS: "3",
  WEBHOOK_BACKOFF_BASE_MS: "1000",
  WEBHOOK_BACKOFF_CAP_MS: "60000",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("buildEnvelope maps refund.succeeded field by field", () => {
  const deliveryId = randomUUID();
  const transactionId = randomUUID();
  const merchantId = randomUUID();
  const refundId = randomUUID();
  const envelope = buildEnvelope(deliveryId, {
    eventType: "refund.succeeded",
    aggregateId: transactionId,
    payload: {
      merchantId,
      transactionId,
      refundId,
      amountFils: 2_500,
      feeReversedFils: 63,
      refundedTotalFils: 2_500,
      newStatus: "partially_refunded",
      reason: "damaged",
      occurredAt: "2026-10-30T09:00:00.000Z",
      internalOnly: "must not leak",
    },
    createdAt: new Date("2026-10-30T09:00:00.000Z"),
  });
  assert.deepEqual(envelope, {
    id: deliveryId,
    type: "refund.succeeded",
    createdAt: "2026-10-30T09:00:00.000Z",
    data: {
      refundId,
      transactionId,
      merchantId,
      amountFils: 2_500,
      feeReversedFils: 63,
      refundedTotalFils: 2_500,
      transactionStatus: "partially_refunded",
      reason: "damaged",
    },
  });
});

test("a real refund is delivered to the merchant's endpoint as refund.succeeded, signed", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund Webhook ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label: "wh" });
  const headers = (key = randomUUID()) => ({ authorization: `Bearer ${rawKey}`, "idempotency-key": key });

  const endpointUrl = `http://fake-receiver.test/refund-${randomUUID()}`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: endpointUrl,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });

  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: headers(),
    payload: { amountFils: 8_000, card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } },
  });
  const transactionId = (auth.json() as { id: string }).id;
  await app.inject({ method: "POST", url: `/v1/transactions/${transactionId}/capture`, headers: headers(), payload: {} });
  const refundRes = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: headers(),
    payload: { transactionId, amountFils: 3_000, reason: "customer request" },
  });
  assert.equal(refundRes.statusCode, 200, refundRes.body);
  const refundBody = refundRes.json() as { id: string };

  const delivered: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === endpointUrl) delivered.push(req);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);

  const refundDeliveries = delivered
    .map((r) => ({ req: r, body: JSON.parse(r.body) as { type: string; data: Record<string, unknown> } }))
    .filter((d) => d.body.type === "refund.succeeded");
  assert.equal(refundDeliveries.length, 1);
  const { req, body } = refundDeliveries[0]!;
  assert.deepEqual(body.data, {
    refundId: refundBody.id,
    transactionId,
    merchantId,
    amountFils: 3_000,
    feeReversedFils: 75,
    refundedTotalFils: 3_000,
    transactionStatus: "partially_refunded",
    reason: "customer request",
  });
  assert.deepEqual(verifySignature(body, req.headers[WEBHOOK_SIGNATURE_HEADER]!, endpoint.secret), { valid: true });

  const status = await pool.query<{ status: string }>(
    `SELECT wd.status FROM webhook_deliveries wd JOIN outbox_events oe ON oe.id = wd.outbox_event_id
      WHERE oe.aggregate_id = $1 AND oe.event_type = 'refund.succeeded' AND wd.endpoint_id = $2`,
    [transactionId, endpoint.id],
  );
  assert.deepEqual(
    status.rows.map((r) => r.status),
    ["succeeded"],
  );
});
