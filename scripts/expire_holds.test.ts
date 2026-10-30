import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpireHoldsUpdate } from "./expire_holds.js";

test("expiry is one guarded UPDATE, never a DELETE", () => {
  const { text, values } = buildExpireHoldsUpdate();
  assert.match(text, /^UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now\(\)/);
  assert.doesNotMatch(text, /DELETE/i);
  assert.deepEqual(values, []);
});
