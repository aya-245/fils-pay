import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

/** Stored when the caller gives no reason; 0070 makes refunds.reason NOT NULL for new rows. */
export const DEFAULT_REFUND_REASON = "unspecified";

export interface ProcessRefundInput {
  transactionId: string;
  /** The AUTHENTICATED merchant. Every lookup is scoped by it. */
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/**
 * The MDR this transaction was actually charged, net, read from the ledger:
 * every platform_fee_revenue credit (capture fee legs) minus every
 * platform_fee_revenue debit (negotiated-discount adjustments), excluding the
 * refund reversals themselves. Read from the ledger rather than recomputed
 * from the merchant's current mdr_bps, so a later rate change can never
 * alter what a refund reverses.
 */
async function readNetFeeChargedFils(client: PoolClient, transactionId: string): Promise<Fils> {
  const result = await client.query<{ fee_fils: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS fee_fils
       FROM ledger_entries
      WHERE transaction_id = $1
        AND account_id = 'platform_fee_revenue'
        AND description NOT LIKE 'refund:%'`,
    [transactionId],
  );
  const fee = Number(result.rows[0]?.fee_fils ?? 0);
  return toFils(Math.max(0, fee));
}

/** What earlier refunds of this transaction have already handed back. */
async function readFeeAlreadyReversedFils(client: PoolClient, transactionId: string): Promise<Fils> {
  const result = await client.query<{ reversed: string }>(
    `SELECT COALESCE(SUM(fee_reversed_fils), 0)::text AS reversed
       FROM refunds
      WHERE transaction_id = $1 AND status = 'succeeded'`,
    [transactionId],
  );
  return toFils(Number(result.rows[0]?.reversed ?? 0));
}

/**
 * Cumulative proportional fee reversal. The running total reversed after this
 * refund is round(fee * refundedTotal / captured); this refund reverses the
 * delta from what earlier refunds already reversed. Summed over any sequence
 * of partials the reversal therefore equals exactly the fee when the capture
 * is fully refunded, and never exceeds it (independent per-partial rounding
 * could, e.g. 2+8+8+8 = 26 > 25).
 */
export function cumulativeFeeReversalFils(input: {
  capturedFils: Fils;
  feeChargedFils: Fils;
  refundedTotalAfterFils: Fils;
  feeAlreadyReversedFils: Fils;
}): Fils {
  if (compareFils(input.capturedFils, ZERO_FILS) <= 0) return ZERO_FILS;
  const refundedCapped =
    compareFils(input.refundedTotalAfterFils, input.capturedFils) > 0 ? input.capturedFils : input.refundedTotalAfterFils;
  const target = calculateRefundFee(input.capturedFils, input.feeChargedFils, refundedCapped);
  const delta = subtractFils(target, input.feeAlreadyReversedFils);
  if (compareFils(delta, ZERO_FILS) <= 0) return ZERO_FILS;
  const headroom = subtractFils(input.feeChargedFils, input.feeAlreadyReversedFils);
  if (compareFils(headroom, ZERO_FILS) <= 0) return ZERO_FILS;
  return compareFils(delta, headroom) > 0 ? headroom : delta;
}

/**
 * Refund business logic, mirroring capture.ts: one DB transaction holding a
 * `SELECT ... FOR UPDATE` lock on the merchant's transaction row from
 * validation, through the awaited acquirer call, to the journal. Two
 * concurrent refunds of the same transaction (with different idempotency
 * keys) serialize on the row lock, so the second validates against the
 * refunded total the first committed and cannot over-refund.
 */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });
  const reason = input.reason ?? DEFAULT_REFUND_REASON;

  return withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody };
    }

    // Row lock first, scoped to the authenticated merchant. Another
    // merchant's transaction is indistinguishable from a missing one.
    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { statusCode: 404, body };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));

    const validation = validateRefundRequest(
      { id: txn.id, merchantId: txn.merchant_id, status: txn.status, capturedFils, refundedFils },
      input.amountFils,
    );
    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { statusCode, body: validation };
    }
    const requestedAmount = validation.amountFils;

    const feeChargedFils = await readNetFeeChargedFils(client, txn.id);
    const feeAlreadyReversedFils = await readFeeAlreadyReversedFils(client, txn.id);

    // Acquirer call with the row lock still held (same rationale as capture.ts).
    const acquirerResult = await acquirer.refund({
      acquirerReference: txn.acquirer_reference,
      amountFils: requestedAmount,
      idempotencyKey: `${claim.row.id}:${claim.row.attemptCount}`,
    });

    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, claim.row.id, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    const newRefundedTotal = addFils(refundedFils, requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: amountAuthorized,
      capturedFils,
      refundedTotalFils: newRefundedTotal,
    });
    const feeReversedFils = cumulativeFeeReversalFils({
      capturedFils,
      feeChargedFils,
      refundedTotalAfterFils: newRefundedTotal,
      feeAlreadyReversedFils,
    });

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        txn.id,
        txn.merchant_id,
        requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        reason,
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    await client.query(`UPDATE transactions SET refunded_fils = $2, status = $3 WHERE id = $1`, [
      txn.id,
      newRefundedTotal,
      newStatus,
    ]);

    // Once any captured money has gone back, the row has left the capture
    // statuses and no further capture can draw on the authorization, so the
    // remaining hold (only ever active on a partial capture) is released.
    if (newStatus === "refunded" || newStatus === "partially_refunded") {
      await client.query(`UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND status = 'active'`, [
        txn.id,
      ]);
    }

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign. Both pairs balance individually.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'refund: gross')`,
      [entryGroupId, txn.merchant_id, txn.id, requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, txn.merchant_id, txn.id, feeReversedFils],
      );
    }

    const eventType = compareFils(newRefundedTotal, capturedFils) >= 0 ? "refunded" : "refund_partial";
    await recordTransactionEvent(client, {
      transactionId: txn.id,
      eventType,
      amountFils: toFils(-requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: {
        refundId: refund.id,
        feeReversedFils,
        acquirerReference: acquirerResult.acquirerReference,
      },
    });

    const occurredAt = refund.occurred_at.toISOString();
    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: txn.id,
      payload: {
        merchantId: txn.merchant_id,
        transactionId: txn.id,
        refundId: refund.id,
        amountFils: requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
        reason,
        occurredAt,
      },
    });

    const body = {
      id: refund.id,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountFils: requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      reason,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt,
    };
    await completeIdempotencyKey(client, claim.row.id, {
      statusCode: 200,
      body,
      resourceId: refund.id,
    });
    return { statusCode: 200, body };
  });
}
