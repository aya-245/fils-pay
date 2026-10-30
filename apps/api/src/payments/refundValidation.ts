import { ZERO_FILS, compareFils, subtractFils, type Fils } from "@filspay/money";

/** The subset of a `transactions` row a refund decision depends on. */
export interface RefundableTransaction {
  id: string;
  merchantId: string;
  status: string;
  /** Cumulative captured amount (`transactions.captured_fils`). */
  capturedFils: Fils;
  /** Cumulative refunded amount (`transactions.refunded_fils`). */
  refundedFils: Fils;
}

export type RefundValidation =
  | { ok: true; amountFils: Fils }
  | { ok: false; code: "transaction_not_refundable"; status: string }
  | { ok: false; code: "refund_amount_invalid" }
  | { ok: false; code: "refund_exceeds_refundable"; refundableFils: Fils };

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

/**
 * How much this transaction may still return: what was CAPTURED minus what
 * has already been refunded. Never the authorized amount: authorized but
 * uncaptured money never left the cardholder, so it cannot be refunded.
 * Clamped at zero so an inconsistent row can never produce a negative ceiling.
 */
export function refundableAmount(txn: RefundableTransaction): Fils {
  if (compareFils(txn.refundedFils, txn.capturedFils) >= 0) return ZERO_FILS;
  return subtractFils(txn.capturedFils, txn.refundedFils);
}

/** Decides whether `requestedAmountFils` may be refunded against `txn`. */
export function validateRefundRequest(
  txn: RefundableTransaction,
  requestedAmountFils?: Fils,
): RefundValidation {
  if (!REFUNDABLE_STATUSES.has(txn.status)) {
    return { ok: false, code: "transaction_not_refundable", status: txn.status };
  }

  if (compareFils(txn.capturedFils, ZERO_FILS) === 0) {
    return { ok: false, code: "transaction_not_refundable", status: txn.status };
  }

  const refundable = refundableAmount(txn);
  const requested = requestedAmountFils ?? refundable;

  if (compareFils(requested, ZERO_FILS) <= 0) {
    return { ok: false, code: "refund_amount_invalid" };
  }
  if (compareFils(requested, refundable) > 0) {
    return { ok: false, code: "refund_exceeds_refundable", refundableFils: refundable };
  }

  return { ok: true, amountFils: requested };
}
