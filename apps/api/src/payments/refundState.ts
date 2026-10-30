import { ZERO_FILS, compareFils, type Fils } from "@filspay/money";

/**
 * The `transactions.status` a row should carry once a refund has been
 * applied to it.
 *
 * Status on this platform is derived from the money columns rather than
 * transitioned by hand: `capture.ts` computes it from `captured_fils` against
 * `amount_fils` at the end of every capture, and this is the same idea for
 * the refund side.
 */

/**
 * "refunded" means refunded_fils >= captured_fils; "partially_refunded"
 * means 0 < refunded_fils < captured_fils. With nothing refunded the row
 * keeps its capture status. A transaction is never left in a capture status
 * once any of its captured amount has been returned.
 */
export type PostRefundStatus = "captured" | "partially_captured" | "partially_refunded" | "refunded";

export interface PostRefundStatusInput {
  /** The authorized amount. */
  amountFils: Fils;
  capturedFils: Fils;
  /** The refunded total *after* the refund being applied, not the delta. */
  refundedTotalFils: Fils;
}

/**
 * FP-300 / finance rule (Huda): "a transaction is refunded when every fils we
 * captured went back". This holds for partial captures too: authorize 10000,
 * capture 4000, refund 4000 => `refunded`. The caller (processRefund) releases
 * the remaining authorization hold when the row leaves the capture statuses,
 * so the uncaptured headroom is not stranded on an active hold.
 */
export function nextStatusAfterRefund(input: PostRefundStatusInput): PostRefundStatus {
  if (compareFils(input.refundedTotalFils, ZERO_FILS) <= 0) {
    return compareFils(input.capturedFils, input.amountFils) < 0 ? "partially_captured" : "captured";
  }
  if (compareFils(input.refundedTotalFils, input.capturedFils) < 0) {
    return "partially_refunded";
  }
  return "refunded";
}
