/**
 * Regression tests for the auth audit (docs/audit/auth-security.md).
 * Needs DATABASE_URL to a migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { claimOtpAttempt, hashOtpCode, verifyOtpCode } from "./otp.js";
import { lookupSession } from "./sessions.js";
import { randomDigits } from "../lib/random.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { assertDistinctApprover } from "../admin/creditApproval.js";
import { generateInviteCode } from "../admin/inviteCode.js";
import { verifyAcquirerCallbackSignature } from "../webhooks/inboundVerify.js";
import { signDeliveryBody, verifySignature } from "../webhooks/sign.js";
import { createHmac } from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
test.after(async () => {
  await pool.end();
});

async function merchantUser(): Promise<string> {
  const s = randomUUID();
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`AuthSec ${s.slice(0, 8)}`],
  );
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'owner') RETURNING id`,
    [m.rows[0]!.id, `${s}@authsec.test`],
  );
  return u.rows[0]!.id;
}

test("bug1: a pending (pre-OTP) session does not authenticate lookupSession", async () => {
  const userId = await merchantUser();
  const raw = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, false, now() + interval '10 minutes')`,
    [userId, sha256Hex(raw)],
  );
  assert.equal(await lookupSession(pool, raw), null);
});

test("bug2: randomDigits is numeric, right length", () => {
  for (let i = 0; i < 50; i++) assert.match(randomDigits(6), /^\d{6}$/);
});

test("bug2: parallel OTP guesses can never exceed max_attempts", async () => {
  const userId = await merchantUser();
  const ch = await pool.query<{ id: string }>(
    `INSERT INTO otp_challenges (merchant_user_id, code_salt, code_hash, expires_at, max_attempts)
     VALUES ($1, 's', $2, now() + interval '5 minutes', 5) RETURNING id`,
    [userId, hashOtpCode("123456", "s")],
  );
  const results = await Promise.all(
    Array.from({ length: 50 }, () => claimOtpAttempt(pool, "otp_challenges", ch.rows[0]!.id)),
  );
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "too_many_attempts"));
  assert.ok(verifyOtpCode("123456", "s", hashOtpCode("123456", "s")));
  assert.ok(!verifyOtpCode("654321", "s", hashOtpCode("123456", "s")));
});

test("bug6: maker-checker compares admin ids, not display names", () => {
  assert.throws(() =>
    assertDistinctApprover({ adminUserId: "a", displayName: "Dana" }, { adminUserId: "a", displayName: "Someone Else" }),
  );
  assert.doesNotThrow(() =>
    assertDistinctApprover({ adminUserId: "a", displayName: "Dana" }, { adminUserId: "b", displayName: "Dana" }),
  );
});

test("invite codes are 12 chars from the alphabet", () => {
  assert.match(generateInviteCode(), /^[A-HJ-NP-Z2-9]{12}$/);
});

test("bug5: delivery signature covers exactly the body bytes sent (jsonb key order)", () => {
  const payload = { zeta: 1, a: { y: 1, x: 2 }, mid: [3, 1] };
  const { body, signature } = signDeliveryBody(payload, "sec");
  const t = /t=(\d+),v1=([0-9a-f]+)/.exec(signature)!;
  const mac = createHmac("sha256", "sec").update(`${t[1]}.${body}`).digest("hex");
  assert.equal(mac, t[2]);
  assert.deepEqual(verifySignature(JSON.parse(body), signature, "sec"), { valid: true });
});

test("bug5: inbound acquirer check needs signature, raw bytes, fresh timestamp, non-empty secret", () => {
  const raw = '{"a": 1,  "b":2}'; // non-canonical spacing: only raw-byte verification works
  const now = 1_800_000_000;
  const sign = (ts: number, secret = "s") =>
    `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex")}`;
  assert.deepEqual(verifyAcquirerCallbackSignature(raw, sign(now), "s", { now }), { valid: true });
  assert.equal(verifyAcquirerCallbackSignature(raw, undefined, "s", { now }).valid, false);
  assert.equal(verifyAcquirerCallbackSignature(raw, sign(now - 4000), "s", { now }).reason, "timestamp_out_of_tolerance");
  assert.equal(verifyAcquirerCallbackSignature(raw, sign(now, ""), "", { now }).valid, false);
});
