import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";

/** Signed BD display, always 3 decimals (1 BD = 1000 fils). */
export function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

/** "+2.500 BHD" / "-2.500 BHD" — for a delta, where the sign is the point. */
export function signedBhd(fils: number): string {
  return fils > 0 ? `+${bhd(fils)}` : bhd(fils);
}

/**
 * What refunds took back from a batch payout: (gross − fee) − net, i.e.
 * refunds − MDR fee reversed — exactly how apps/settlement nets them
 * (payable.go ApplyRefundsToPayout). The admin wire shapes carry only
 * gross/fee/net, so without this a batch with refunds showed a net that
 * didn't equal gross − fee and nothing explained the difference.
 */
export function refundsNettedFils(batch: { grossFils: number; feeFils: number; netPayoutFils: number }): number {
  return batch.grossFils - batch.feeFils - batch.netPayoutFils;
}

export type SignedBhdResult = { ok: true; fils: number } | { ok: false; message: string };

/**
 * A signed BD correction ("-2.5", "+10.250", "3") → integer fils, via
 * @filspay/money's string parser (never parseFloat). Zero is rejected: the
 * API refuses a zero delta, and so should the form, before it is sent.
 */
export function parseSignedBhdInput(raw: string): SignedBhdResult {
  const text = raw.trim().replace(/^\+/, "");
  if (text === "") return { ok: false, message: "Enter the correction in BD, e.g. -2.500 or 10.000." };
  if (!/^-?\d+(\.\d{1,3})?$/.test(text)) {
    return /^-?\d+\.\d{4,}$/.test(text)
      ? { ok: false, message: "BD amounts have at most 3 decimals (1 BD = 1000 fils)." }
      : { ok: false, message: "Use digits, an optional leading minus and one decimal point, e.g. -2.500." };
  }
  let fils: number;
  try {
    fils = parseBhdToFils(text);
  } catch {
    return { ok: false, message: "That amount is too large." };
  }
  if (fils === 0) return { ok: false, message: "A correction must be non-zero." };
  return { ok: true, fils };
}
