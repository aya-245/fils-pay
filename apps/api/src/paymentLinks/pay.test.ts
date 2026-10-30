import assert from "node:assert/strict";
import { test } from "node:test";
import { expiryReferenceTime } from "./pay.js";

// Tolerance for comparing a freshly-minted Date against the test's own
// `Date.now()` — generous enough not to flake on a loaded CI box.
const TOLERANCE_MS = 5_000;

test("expiryReferenceTime: always the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime();
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

// FP-187: the former "a valid ISO-8601 string round-trips" test encoded the
// bug (a client-supplied submittedAt was trusted). The function no longer
// accepts a client value; extra arguments must not influence the result.
test("expiryReferenceTime: ignores any client-supplied value", () => {
  const before = Date.now();
  const resolved = (expiryReferenceTime as (...a: unknown[]) => Date)("2026-03-14T09:30:00.000Z");
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});
