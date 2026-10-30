import assert from "node:assert/strict";
import test from "node:test";
import { refundsNettedFils } from "./format.js";

test("refunds netted = gross − fee − net (refunds minus fee reversed)", () => {
  assert.equal(refundsNettedFils({ grossFils: 65_500, feeFils: 1_474, netPayoutFils: 24_193 }), 39_833);
  assert.equal(refundsNettedFils({ grossFils: 7_326_913, feeFils: 183_174, netPayoutFils: 7_143_739 }), 0);
});
