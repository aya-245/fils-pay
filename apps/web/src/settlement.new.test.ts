import assert from "node:assert/strict";
import test from "node:test";
import { bahrainToday, batchBreakdown, nextDay } from "./pages/settlement/batchBreakdown.js";

/* FP-300 settlement display: a batch nets refunds (minus the MDR they
 * reverse) out of its payout, so net ≠ gross − fee once refunds exist. */

test("refunds netted is derived as (gross − fee) − net when the DTO lacks the columns", () => {
  // 40.000 + 25.500 captured, fee 0.900 + 0.574, partial refund 15.250
  // (fee back 0.343) + full refund 25.500 (fee back 0.574) — the demo batch.
  const b = batchBreakdown({ grossFils: 65_500, feeFils: 1_474, netPayoutFils: 24_193 });
  assert.equal(b.captureNetFils, 64_026);
  assert.equal(b.refundsNettedFils, 64_026 - 24_193);
  assert.equal(b.refundsFils, null);
});

test("uses refunds_fils / refund_fee_reversed_fils when the API exposes them", () => {
  const b = batchBreakdown({
    grossFils: 65_500,
    feeFils: 1_474,
    netPayoutFils: 24_193,
    refundsFils: 40_750,
    refundFeeReversedFils: 917,
  });
  assert.equal(b.refundsNettedFils, 39_833);
  assert.equal(b.captureNetFils - b.refundsNettedFils, 24_193);
});

test("a batch without refunds nets to zero", () => {
  assert.equal(batchBreakdown({ grossFils: 7_326_913, feeFils: 183_174, netPayoutFils: 7_143_739 }).refundsNettedFils, 0);
});

test("Bahrain business date helpers", () => {
  assert.equal(bahrainToday(new Date("2026-10-30T21:30:00Z")), "2026-10-31");
  assert.equal(bahrainToday(new Date("2026-10-30T20:59:59Z")), "2026-10-30");
  assert.equal(nextDay("2026-10-31"), "2026-11-01");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
});
