import type { SettlementBatchDto } from "../../types.js";

export interface BatchBreakdown {
  /** gross − MDR fee: what the batch's captures alone would pay out. */
  captureNetFils: number;
  /** What refunds took back from this payout: refunds − fee reversed. Derived
   *  as (gross − fee) − net, which is exactly how apps/settlement nets them
   *  (payable.go ApplyRefundsToPayout), so it is correct even while the batch
   *  DTO doesn't carry refunds_fils / refund_fee_reversed_fils. */
  refundsNettedFils: number;
  /** Present only when the API exposes the stored columns. */
  refundsFils: number | null;
  refundFeeReversedFils: number | null;
}

/**
 * Before refunds existed, `netPayoutFils === grossFils − feeFils` always held
 * and the pages showed only gross/fee/net. Since FP-300 the Go settlement
 * close nets succeeded refunds (minus the MDR they reverse) out of the
 * payout, so a batch with refunds showed a net that silently didn't add up.
 * This makes the missing term explicit.
 */
export function batchBreakdown(
  batch: Pick<SettlementBatchDto, "grossFils" | "feeFils" | "netPayoutFils"> &
    Partial<Pick<SettlementBatchDto, "refundsFils" | "refundFeeReversedFils">>,
): BatchBreakdown {
  const captureNetFils = batch.grossFils - batch.feeFils;
  const hasColumns = typeof batch.refundsFils === "number" && typeof batch.refundFeeReversedFils === "number";
  return {
    captureNetFils,
    refundsNettedFils: hasColumns
      ? (batch.refundsFils as number) - (batch.refundFeeReversedFils as number)
      : captureNetFils - batch.netPayoutFils,
    refundsFils: hasColumns ? (batch.refundsFils as number) : null,
    refundFeeReversedFils: hasColumns ? (batch.refundFeeReversedFils as number) : null,
  };
}

/** Today's Asia/Bahrain business date (UTC+3, no DST) as YYYY-MM-DD. */
export function bahrainToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** The YYYY-MM-DD after `date` (for an exclusive `to`). */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
