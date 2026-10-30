import assert from "node:assert/strict";
import test from "node:test";
import { bhd, bhdAmount, humanize, parseBhdInput } from "./format.js";
import { messageForApiError } from "./api/errorMessages.js";
import { isRefundable, refundableFils, refundState } from "./pages/transactions/refundable.js";
import { validateCard } from "./pages/checkout/cardValidation.js";
import { displayLinkStatus } from "./pages/payment-links/linkStatus.js";

/* UX pass (docs/UI_UX.md): the pure logic behind the refund drawer, the
 * checkout form and the error copy. Rendering is covered by the screenshot
 * run (scripts/ui-screenshots.mjs). */

test("bhd renders negative refund deltas instead of throwing (timeline crash)", () => {
  assert.equal(bhd(-12250), "-12.250 BHD");
  assert.equal(bhdAmount(-1), "-0.001");
  assert.equal(bhd(45750), "45.750 BHD");
});

test("parseBhdInput accepts 0-3 decimals and returns exact fils", () => {
  assert.deepEqual(parseBhdInput("4.75"), { ok: true, fils: 4750 });
  assert.deepEqual(parseBhdInput("4.750"), { ok: true, fils: 4750 });
  assert.deepEqual(parseBhdInput(" 12 "), { ok: true, fils: 12000 });
  assert.deepEqual(parseBhdInput("0.001"), { ok: true, fils: 1 });
});

test("parseBhdInput rejects bad input with a readable message", () => {
  for (const bad of ["", "abc", "-1", "1,5", "1.2.3", "0", "0.000"]) {
    const r = parseBhdInput(bad);
    assert.equal(r.ok, false, bad);
  }
  const tooPrecise = parseBhdInput("1.2345");
  assert.equal(tooPrecise.ok, false);
  assert.match(tooPrecise.ok ? "" : tooPrecise.message, /3 decimals/);
  const over = parseBhdInput("40.000", { maxFils: 33500 });
  assert.equal(over.ok, false);
  assert.match(over.ok ? "" : over.message, /33\.500 BHD/);
  assert.deepEqual(parseBhdInput("33.500", { maxFils: 33500 }), { ok: true, fils: 33500 });
});

test("refund_exceeds_refundable names the refundable amount in BD", () => {
  const msg = messageForApiError(422, "refund_exceeds_refundable", {
    ok: false,
    code: "refund_exceeds_refundable",
    refundableFils: 4000,
  });
  assert.match(msg, /4\.000 BHD/);
  assert.match(
    messageForApiError(422, "refund_exceeds_refundable", { refundableFils: 0 }),
    /fully refunded/,
  );
});

test("role / read-only refusals explain what to do", () => {
  assert.match(messageForApiError(403, "impersonation_read_only", {}), /read-only/);
  assert.match(messageForApiError(403, "forbidden", {}), /owner or finance/);
  assert.match(messageForApiError(403, "refunds_on_hold", {}), /on hold/);
  assert.match(messageForApiError(500, "internal_error", {}), /Nothing was changed/);
});

test("refundable = captured - refunded, clamped, status-aware", () => {
  const base = { status: "partially_refunded" as const, capturedFils: 45750, refundedFils: 12250 };
  assert.equal(refundableFils(base), 33500);
  assert.equal(isRefundable(base), true);
  assert.equal(refundState(base), "partial");
  assert.equal(refundState({ capturedFils: 1000, refundedFils: 1000 }), "full");
  assert.equal(refundState({ capturedFils: 1000, refundedFils: 0 }), "none");
  assert.equal(isRefundable({ status: "refunded", capturedFils: 1000, refundedFils: 1000 }), false);
  assert.equal(isRefundable({ status: "authorized", capturedFils: 0, refundedFils: 0 }), false);
  assert.equal(refundableFils({ capturedFils: 100, refundedFils: 200 }), 0);
});

test("validateCard flags malformed fields and expired cards", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  assert.deepEqual(
    validateCard({ pan: "4111 1111 1111 1111", expiryMonth: "12", expiryYear: "2028", cvv: "123" }, now),
    {},
  );
  const bad = validateCard({ pan: "4111", expiryMonth: "13", expiryYear: "28", cvv: "1" }, now);
  assert.ok(bad.pan && bad.expiryMonth && bad.expiryYear && bad.cvv);
  const expired = validateCard({ pan: "4111111111111111", expiryMonth: "9", expiryYear: "2026", cvv: "123" }, now);
  assert.match(expired.expiryYear ?? "", /expired/);
});

test("displayLinkStatus shows an active link past its expiry as expired", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  assert.equal(displayLinkStatus({ status: "active", expiresAt: "2026-10-30T11:59:59Z" }, now), "expired");
  assert.equal(displayLinkStatus({ status: "active", expiresAt: "2026-11-06T00:00:00Z" }, now), "active");
  assert.equal(displayLinkStatus({ status: "paid", expiresAt: "2026-10-01T00:00:00Z" }, now), "paid");
});

test("humanize turns API codes into labels", () => {
  assert.equal(humanize("partially_refunded"), "Partially refunded");
  assert.equal(humanize("refund_partial"), "Refund partial");
});
