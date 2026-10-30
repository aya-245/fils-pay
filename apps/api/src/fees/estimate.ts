import { applyRateFils, toFils } from "@filspay/money";

/**
 * Fee for a single capture amount, in integer fils. Mirrors the capture path:
 * MDR (basis points) first, then the negotiated discount applied to that fee
 * (discountAdjustment.ts). Integer math only; no float rates.
 */
export function estimateFeeFils(
  amountFils: number,
  mdrBps: number,
  discountBps: number,
): number {
  const feeBeforeDiscount = applyRateFils(toFils(amountFils), mdrBps);
  const discount = applyRateFils(feeBeforeDiscount, discountBps);
  return Number(feeBeforeDiscount) - Number(discount);
}
