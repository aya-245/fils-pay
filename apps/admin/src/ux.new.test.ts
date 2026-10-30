import assert from "node:assert/strict";
import test from "node:test";
import { bhd, parseSignedBhdInput, signedBhd } from "./format.js";
import { messageForAdminError } from "./api/errorMessages.js";

/* UX pass (docs/UI_UX.md): pure logic behind the balance-adjustment form and
 * the admin error copy. */

test("parseSignedBhdInput: signed BD with up to 3 decimals -> exact fils", () => {
  assert.deepEqual(parseSignedBhdInput("-2.5"), { ok: true, fils: -2500 });
  assert.deepEqual(parseSignedBhdInput("+10.250"), { ok: true, fils: 10250 });
  assert.deepEqual(parseSignedBhdInput("3"), { ok: true, fils: 3000 });
  assert.deepEqual(parseSignedBhdInput(" -0.001 "), { ok: true, fils: -1 });
});

test("parseSignedBhdInput rejects zero, too many decimals and junk", () => {
  for (const bad of ["", "0", "-0.000", "abc", "1,5", "--1"]) {
    assert.equal(parseSignedBhdInput(bad).ok, false, bad);
  }
  const precise = parseSignedBhdInput("1.2345");
  assert.equal(precise.ok, false);
  assert.match(precise.ok ? "" : precise.message, /3 decimals/);
});

test("signedBhd shows the direction of a correction", () => {
  assert.equal(signedBhd(2500), "+2.500 BHD");
  assert.equal(signedBhd(-2500), "-2.500 BHD");
  assert.equal(bhd(5014609), "5014.609 BHD");
});

test("403 keeps the server's reason and names the operator's role", () => {
  const msg = messageForAdminError(
    403,
    "forbidden",
    { error: "forbidden", message: "replaying succeeded deliveries requires finance or super_admin" },
    "support",
  );
  assert.match(msg, /replaying succeeded deliveries requires finance or super_admin/);
  assert.match(msg, /support/);
  assert.match(messageForAdminError(403, "forbidden", { error: "forbidden", message: "forbidden" }), /finance or super admin/);
});

test("missing balance row tells the operator how to fix it", () => {
  assert.match(messageForAdminError(404, "merchant_balance_not_found", {}), /Rebuild balances/);
});
