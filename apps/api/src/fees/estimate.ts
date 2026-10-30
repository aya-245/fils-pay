import { applyRateFils, toFils } from "@filspay/money";

/**
 * Fee for a single capture amount, in integer fils. Same formula as Go
 * settlement's ComputeSettlementFee (the reference) and ARCHITECTURE:
 * the negotiated discount reduces the amount the MDR is charged on.
 * Integer math only; no float rates.
 */
export function estimateFeeFils(
  amountFils: number,
  mdrBps: number,
  discountBps: number,
): number {
  const amount = toFils(amountFils);
  const discountedAmount = toFils(Number(amount) - Number(applyRateFils(amount, discountBps)));
  return Number(applyRateFils(discountedAmount, mdrBps));
}
