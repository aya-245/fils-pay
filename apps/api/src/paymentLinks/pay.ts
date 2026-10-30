import type { Pool, PoolClient } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

interface LockedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
  status: string;
  expires_at: Date;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/**
 * Expiry is always judged against the server's clock. The buyer's browser is
 * untrusted on a public endpoint: honouring a client-supplied "submittedAt"
 * let anyone pay an expired link by sending a past timestamp (FP-187).
 */
export function expiryReferenceTime(): Date {
  return new Date();
}

/**
 * Bounds how many pay requests may hold a dedicated connection (for the link
 * row lock) at once, so they can never starve the pool of the extra
 * connections authorize/capture need and deadlock. Waiters queue in memory.
 */
const holders = new WeakMap<Pool, { active: number; waiters: Array<() => void> }>();
async function acquireSlot(pool: Pool): Promise<() => void> {
  let state = holders.get(pool);
  if (!state) {
    state = { active: 0, waiters: [] };
    holders.set(pool, state);
  }
  const s = state;
  const poolMax = (pool as unknown as { options?: { max?: number } }).options?.max ?? 5;
  const limit = Math.max(1, poolMax - 2);
  if (s.active >= limit) {
    await new Promise<void>((resolve) => s.waiters.push(resolve));
  } else {
    s.active++;
  }
  return () => {
    const next = s.waiters.shift();
    if (next) next();
    else s.active--;
  };
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency (incident 2026-05-14): the link row is locked with
 * `SELECT ... FOR UPDATE SKIP LOCKED` on a dedicated connection and the lock
 * is held until authorize+capture+finalize are done (COMMIT) or the request
 * dies (ROLLBACK / connection loss). A second buyer can therefore never be
 * admitted while a payment is in flight, however slow it is; the old
 * timestamp-based "reservation timeout" re-claim let a second buyer pay and
 * finalize first. A crash after capture but before finalize is healed by
 * looking for an already-completed capture for this link.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  _config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const expiryCheckTime = expiryReferenceTime();

  const release = await acquireSlot(pool);
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await payLocked(pool, client, acquirer, input, expiryCheckTime);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } finally {
      client.release();
    }
  } finally {
    release();
  }
}

async function payLocked(
  pool: Pool,
  client: PoolClient,
  acquirer: AcquirerSimulator,
  input: PayPaymentLinkInput,
  expiryCheckTime: Date,
): Promise<PayPaymentLinkResult> {
  const lockResult = await client.query<LockedLinkRow>(
    `SELECT id, merchant_id, amount_fils, reference, status, expires_at
       FROM payment_links
      WHERE token = $1
        FOR UPDATE SKIP LOCKED`,
    [input.token],
  );
  const row = lockResult.rows[0];
  if (!row) {
    // Either no such link, or another request holds the lock (in flight).
    return classifyClaimFailure(pool, input.token);
  }
  // 'reserved' here is a stale marker from a crashed attempt (nobody holds the lock).
  if (row.status !== "active" && row.status !== "reserved") {
    return classifyStatus(row.status);
  }
  if (row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }

  const link = {
    id: row.id,
    merchantId: row.merchant_id,
    amountFils: toFils(Number(row.amount_fils)),
    reference: row.reference,
  };

  // Crash recovery: a previous attempt (possibly under a different
  // Idempotency-Key) may have captured but died before finalizing. Never
  // charge again; finalize against the existing capture.
  const prior = await pool.query<{ resource_id: string }>(
    `SELECT resource_id FROM idempotency_keys
      WHERE merchant_id = $1 AND endpoint = 'transactions.capture'
        AND key LIKE $2 AND status = 'completed' AND response_status_code = 200
        AND resource_id IS NOT NULL
      ORDER BY completed_at DESC LIMIT 1`,
    [link.merchantId, `paylink:${link.id}:%`],
  );
  const priorTxn = prior.rows[0]?.resource_id;
  if (priorTxn) {
    return finalize(client, link, priorTxn);
  }

  // Authorize. Keys include link.id so two links can never collide.
  const authorizeKey = `paylink:${link.id}:${input.idempotencyKey}:authorize`;
  const authResult = await authorizeTransaction(pool, acquirer, {
    merchantId: link.merchantId,
    amountFils: link.amountFils,
    card: input.card,
    reference: link.reference ?? undefined,
    idempotencyKey: authorizeKey,
    // No merchant session/API key initiated this — a customer did, via the public link.
    actor: { type: "system" },
  });

  if (authResult.statusCode !== 201) {
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Capture the full amount immediately.
  const captureKey = `paylink:${link.id}:${input.idempotencyKey}:capture`;
  const captureResult = await captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
  });

  if (captureResult.statusCode !== 200) {
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // The transactions route applies the negotiated-discount adjustment after
  // capture; this path used to skip it (the old comment claiming capture.ts
  // does it was wrong). The adjustment is idempotent per capture event.
  await applyCaptureDiscountAdjustment(pool, { merchantId: link.merchantId, transactionId: txnId });

  return finalize(client, link, txnId);
}

async function finalize(
  client: PoolClient,
  link: { id: string; amountFils: number },
  txnId: string,
): Promise<PayPaymentLinkResult> {
  // We hold the row lock, so this cannot lose a race.
  const finalizeResult = await client.query<{ paid_at: Date }>(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL
      WHERE id = $1
      RETURNING paid_at`,
    [link.id, txnId],
  );
  const finalized = finalizeResult.rows[0];
  if (!finalized) {
    throw new Error(`payPaymentLink: link ${link.id} vanished while locked (transaction ${txnId})`);
  }
  return {
    statusCode: 200,
    body: { status: "paid", transactionId: txnId, amountFils: link.amountFils, paidAt: finalized.paid_at.toISOString() },
  };
}

function classifyStatus(status: string): PayPaymentLinkResult {
  if (status === "paid") return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  if (status === "canceled") return { statusCode: 409, body: { error: "payment_link_canceled" } };
  return { statusCode: 409, body: { error: "payment_link_not_payable", status } };
}

/**
 * The lock SELECT matched nothing: unknown token, or the row is locked by an
 * in-flight payment. Plain read, only used to choose the error.
 */
async function classifyClaimFailure(pool: Pool, token: string): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow>(`SELECT status, expires_at FROM payment_links WHERE token = $1`, [
    token,
  ]);
  const row = result.rows[0];
  if (!row) return { statusCode: 404, body: { error: "payment_link_not_found" } };
  if (row.status === "paid" || row.status === "canceled") return classifyStatus(row.status);
  return { statusCode: 409, body: { error: "payment_link_processing" } };
}
