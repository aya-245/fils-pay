/** FP-300 pure-unit coverage: ceiling, post-refund status, cumulative fee reversal. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { validateRefundRequest } from "./refundValidation.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { cumulativeFeeReversalFils } from "./processRefund.js";

test("partial capture: ceiling is captured - refunded, not authorized - refunded", () => {
  const txn = {
    id: randomUUID(),
    merchantId: randomUUID(),
    status: "partially_captured",
    capturedFils: toFils(4_000),
    refundedFils: toFils(0),
  };
  assert.deepEqual(validateRefundRequest(txn, toFils(4_001)), {
    ok: false,
    code: "refund_exceeds_refundable",
    refundableFils: 4_000,
  });
  assert.deepEqual(validateRefundRequest(txn), { ok: true, amountFils: 4_000 });
  assert.deepEqual(validateRefundRequest(txn, toFils(10_000)), {
    ok: false,
    code: "refund_exceeds_refundable",
    refundableFils: 4_000,
  });
});

test("a fully refunded partial capture is refunded; a partly refunded one is partially_refunded", () => {
  const base = { amountFils: toFils(10_000), capturedFils: toFils(4_000) };
  assert.equal(nextStatusAfterRefund({ ...base, refundedTotalFils: toFils(4_000) }), "refunded");
  assert.equal(nextStatusAfterRefund({ ...base, refundedTotalFils: toFils(1_000) }), "partially_refunded");
  assert.equal(nextStatusAfterRefund({ ...base, refundedTotalFils: toFils(0) }), "partially_captured");
});

test("cumulative fee reversal: 300/300/300/100 on 1000 with fee 25 => 8/7/7/3 (independent rounding gave 8/8/8/2 or 26)", () => {
  let refunded = 0;
  let reversed = 0;
  const deltas: number[] = [];
  for (const amount of [300, 300, 300, 100]) {
    refunded += amount;
    const d = cumulativeFeeReversalFils({
      capturedFils: toFils(1_000),
      feeChargedFils: toFils(25),
      refundedTotalAfterFils: toFils(refunded),
      feeAlreadyReversedFils: toFils(reversed),
    });
    deltas.push(d);
    reversed += d;
  }
  assert.deepEqual(deltas, [8, 7, 7, 3]);
  assert.equal(reversed, 25);
});

test("cumulative fee reversal never exceeds the fee charged, for any order of partials", () => {
  for (const seq of [
    [100, 300, 300, 300],
    [1, 1, 998],
    [333, 333, 334],
    [999, 1],
  ]) {
    let refunded = 0;
    let reversed = 0;
    for (const amount of seq) {
      refunded += amount;
      reversed += cumulativeFeeReversalFils({
        capturedFils: toFils(1_000),
        feeChargedFils: toFils(25),
        refundedTotalAfterFils: toFils(refunded),
        feeAlreadyReversedFils: toFils(reversed),
      });
      assert.ok(reversed <= 25, `${seq.join("/")}: ${reversed}`);
    }
    assert.equal(reversed, 25, seq.join("/"));
  }
});
