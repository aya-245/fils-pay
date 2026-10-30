import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { timingSafeEqualHex } from "../lib/crypto.js";
import { randomDigits } from "../lib/random.js";

/** e.g. generateOtpCode(6) => "042817". */
export function generateOtpCode(length: number): string {
  return randomDigits(length);
}

/**
 * Hashes an OTP code with its per-challenge salt. `code_salt` is a fresh
 * random value per challenge, so the stored `code_hash` is not a bare,
 * unsalted sha256 of a small code space (which would be trivially
 * rainbow-tabled). The raw code is never persisted; it exists only in
 * memory long enough to hash it and hand it to the notifier.
 */
export function hashOtpCode(code: string, salt: string): string {
  return createHash("sha256").update(salt + code).digest("hex");
}

/** Constant-time match of a user-supplied code against a stored challenge. */
export function verifyOtpCode(inputCode: string, salt: string, expectedHash: string): boolean {
  return timingSafeEqualHex(hashOtpCode(inputCode, salt), expectedHash);
}

export interface IssuedOtpChallenge {
  id: string;
  code: string;
  expiresAt: Date;
}

/**
 * Inserts a fresh `otp_challenges` row inside the caller's open transaction
 * and returns the raw code (never stored) so the caller can hand it to the
 * notifier / dev-expose response field.
 */
export async function issueChallenge(
  client: PoolClient,
  params: { merchantUserId: string; ttlMinutes: number; codeLength: number; maxAttempts: number },
): Promise<IssuedOtpChallenge> {
  const code = generateOtpCode(params.codeLength);
  const salt = randomBytes(16).toString("hex");
  const hash = hashOtpCode(code, salt);
  const expiresAt = new Date(Date.now() + params.ttlMinutes * 60_000);

  const result = await client.query<{ id: string }>(
    `INSERT INTO otp_challenges (merchant_user_id, code_salt, code_hash, expires_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.merchantUserId, salt, hash, expiresAt, params.maxAttempts],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("issueChallenge: insert into otp_challenges returned no row");
  }
  return { id: row.id, code, expiresAt };
}

export type OtpTable = "otp_challenges" | "admin_otp_challenges";
export type OtpClaimFailure = "gone" | "too_many_attempts";

/**
 * Atomically spends one guess from a challenge's budget and returns its
 * salt/hash, or says why it can't. The increment happens BEFORE the
 * comparison, in the same statement that checks `attempt_count <
 * max_attempts`, so N parallel guesses can never get more than max_attempts
 * comparisons (read-then-increment lets all of them read attempt_count=0).
 * `table` is a closed union, never user input.
 */
export async function claimOtpAttempt(
  db: Pool | PoolClient,
  table: OtpTable,
  challengeId: string,
): Promise<
  | { ok: true; id: string; codeSalt: string; codeHash: string }
  | { ok: false; reason: OtpClaimFailure }
> {
  const claimed = await db.query<{ id: string; code_salt: string; code_hash: string }>(
    `UPDATE ${table} SET attempt_count = attempt_count + 1
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() AND attempt_count < max_attempts
      RETURNING id, code_salt, code_hash`,
    [challengeId],
  );
  const row = claimed.rows[0];
  if (row) return { ok: true, id: row.id, codeSalt: row.code_salt, codeHash: row.code_hash };

  const state = await db.query<{ attempt_count: number; max_attempts: number; usable: boolean }>(
    `SELECT attempt_count, max_attempts, (consumed_at IS NULL AND expires_at > now()) AS usable
       FROM ${table} WHERE id = $1`,
    [challengeId],
  );
  const s = state.rows[0];
  if (s && s.usable && s.attempt_count >= s.max_attempts) return { ok: false, reason: "too_many_attempts" };
  return { ok: false, reason: "gone" };
}

/** Single use: marks the challenge consumed only if nobody else already did. */
export async function consumeOtpChallenge(
  client: PoolClient,
  table: OtpTable,
  challengeId: string,
): Promise<boolean> {
  const r = await client.query(`UPDATE ${table} SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, [
    challengeId,
  ]);
  return (r.rowCount ?? 0) > 0;
}
