#!/usr/bin/env node
/**
 * Creates realistic UI-screenshot data through the public API (never the DB):
 * an open payment link, a paid link with a partial refund, an expired link,
 * a link reserved for the in-browser "success" shot and one for the decline
 * shot. Prints a JSON fixture to stdout for ui-screenshots.mjs.
 *
 *   node scripts/ui-screenshots.seed.mjs --api http://localhost:3310 \
 *     --merchant <uuid> --key fp_test_... > fixture.json
 */
import { randomUUID } from "node:crypto";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const api = arg("api", "http://localhost:3310");
const merchantId = arg("merchant");
const key = arg("key");
if (!merchantId || !key) {
  console.error("usage: --merchant <uuid> --key <api key> [--api url]");
  process.exit(2);
}

async function call(method, path, body, { auth = true, idem = true } = {}) {
  const headers = {};
  if (auth) headers.authorization = `Bearer ${key}`;
  if (idem) headers["idempotency-key"] = randomUUID();
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();
const card = { pan: "4111111111111111", expiryMonth: 12, expiryYear: new Date().getFullYear() + 2, cvv: "123" };

const link = (amountFils, reference, description, expiresAt = inDays(7)) =>
  call("POST", `/v1/merchants/${merchantId}/payment-links`, { amountFils, reference, description, expiresAt });

const stamp = Date.now().toString(36).slice(-5);
const open = await link(12_500, `INV-${stamp}-OPEN`, "Annual hosting plan — 12 months");
const success = await link(7_250, `INV-${stamp}-OK`, "Domain renewal (2 years)");
const decline = await link(3_125, `INV-${stamp}-DECL`, "Support add-on");
const paidLink = await link(45_750, `INV-${stamp}-PAID`, "Website redesign — milestone 1");
const expiring = await link(9_000, `INV-${stamp}-EXP`, "Quarterly maintenance", new Date(Date.now() + 4_000).toISOString());

const paid = await call("POST", `/v1/payment-links/${paidLink.token}/pay`, { card }, { auth: false });
const refund = await call("POST", "/v1/refunds", {
  transactionId: paid.transactionId,
  amountFils: 12_250,
  reason: "Customer cancelled one deliverable",
});

// A webhook endpoint so the admin replay screen has something to target.
// Best-effort: a second run may already have one.
await call("POST", `/v1/merchants/${merchantId}/webhook-endpoints`, { url: "https://hooks.example.com/filspay" }).catch(
  (err) => console.error(`webhook endpoint: ${err.message}`),
);

// Let the short-lived link lapse.
await new Promise((r) => setTimeout(r, 5_000));

console.log(
  JSON.stringify(
    {
      merchantId,
      openToken: open.token,
      successToken: success.token,
      declineToken: decline.token,
      paidToken: paidLink.token,
      expiredToken: expiring.token,
      paidTransactionId: paid.transactionId,
      refundId: refund.id,
    },
    null,
    2,
  ),
);
