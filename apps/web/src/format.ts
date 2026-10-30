import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app (1 BD = 1000 fils, always 3 decimals). Never `/1000`,
 * never `toFixed`.
 *
 * Signed on purpose: refund events in the transaction timeline carry a
 * negative amountFils (transactions/events.ts), and reconciliation gaps can
 * be negative. The old non-negative-only `toFils` threw a RangeError there
 * and blanked the whole transaction page for every refunded transaction.
 */
export function bhd(amountFils: number): string {
  return `${bhdAmount(amountFils)} BHD`;
}

/** The BD figure without the currency suffix, for buttons and sentences. */
export function bhdAmount(amountFils: number): string {
  return formatBhd(toFils(amountFils, { allowNegative: true }));
}

export type BhdInputResult = { ok: true; fils: number } | { ok: false; message: string };

const BHD_INPUT = /^\d+(\.\d{1,3})?$/;
const TOO_MANY_DECIMALS = /^\d+\.\d{4,}$/;

/**
 * Validates a user-typed BD amount ("4.75", "4.750", "12") into integer fils
 * through @filspay/money's string parser — never parseFloat. Rejects more
 * than three decimals, signs, zero, and anything above `maxFils`. The
 * messages are written to be read out by an aria-live error region.
 */
export function parseBhdInput(raw: string, opts: { maxFils?: number } = {}): BhdInputResult {
  const text = raw.trim();
  if (text === "") return { ok: false, message: "Enter an amount in BD, for example 4.750." };
  if (!BHD_INPUT.test(text)) {
    return TOO_MANY_DECIMALS.test(text)
      ? { ok: false, message: "BD amounts have at most 3 decimals (1 BD = 1000 fils)." }
      : { ok: false, message: "Enter a positive BD amount using digits and one decimal point, for example 4.750." };
  }
  let fils: number;
  try {
    fils = parseBhdToFils(text);
  } catch {
    return { ok: false, message: "That amount is too large." };
  }
  if (fils <= 0) return { ok: false, message: "The amount must be more than 0.000 BD." };
  if (opts.maxFils !== undefined && fils > opts.maxFils) {
    return { ok: false, message: `The amount cannot be more than ${bhd(opts.maxFils)}.` };
  }
  return { ok: true, fils };
}

/** "partially_refunded" → "Partially refunded" — display only. */
export function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.length === 0 ? spaced : spaced[0]!.toUpperCase() + spaced.slice(1);
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Browser-local rendering, not Asia/Bahrain. */
export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as a full ISO instant at the
 * UTC day boundary — what the `from`/`to` transaction filters take. No
 * timezone picker and no business-day conversion: those filters compare
 * `occurred_at` directly, so pretending otherwise here would invent a
 * precision the endpoint doesn't have.
 */
// Asia/Bahrain day boundary (UTC+3, no DST), matching settlement business days.
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? `${dateValue}T00:00:00.000+03:00` : undefined;
}

/**
 * A `<input type="datetime-local">` value (local wall time, no zone) as an
 * ISO 8601 instant. `new Date(local)` interprets it in the browser's own
 * timezone, which is what the user meant when they typed it.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
