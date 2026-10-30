import type { TransactionDto } from "../../types.js";

/** The statuses payments/refundValidation.ts accepts. */
const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

/** What can still go back to the cardholder: captured − refunded, clamped at
 *  zero — the same rule as the API's refundableAmount(). Display/UX only; the
 *  server re-checks under a row lock. */
export function refundableFils(txn: Pick<TransactionDto, "capturedFils" | "refundedFils">): number {
  const refunded = txn.refundedFils ?? 0;
  return txn.capturedFils > refunded ? txn.capturedFils - refunded : 0;
}

export function isRefundable(txn: Pick<TransactionDto, "status" | "capturedFils" | "refundedFils">): boolean {
  return REFUNDABLE_STATUSES.has(txn.status) && refundableFils(txn) > 0;
}

/** Refund state for list/detail display. */
export function refundState(
  txn: Pick<TransactionDto, "capturedFils" | "refundedFils">,
): "none" | "partial" | "full" {
  const refunded = txn.refundedFils ?? 0;
  if (refunded <= 0) return "none";
  return refunded >= txn.capturedFils ? "full" : "partial";
}
