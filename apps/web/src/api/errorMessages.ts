import { bhd } from "../format.js";

/**
 * Plain-language text for an API error, keyed on the stable error codes the
 * API publishes (lib/errors.ts, payments/refundValidation.ts). Pure — no
 * `import.meta`, no fetch — so it is unit-testable under `tsx --test`.
 *
 * Every message says what happened and, where there is one, what to do next.
 * Unknown codes fall back to the server's own `message`, then the code.
 */
export function messageForApiError(
  statusCode: number,
  code: string,
  body: { message?: string; [key: string]: unknown },
): string {
  switch (code) {
    // --- refunds (FP-300) ---
    case "refund_exceeds_refundable": {
      const refundable = typeof body.refundableFils === "number" ? body.refundableFils : null;
      return refundable === null
        ? "That amount is more than can still be refunded on this transaction."
        : refundable === 0
          ? "Nothing is left to refund on this transaction — it has already been fully refunded."
          : `That amount is more than can still be refunded. At most ${bhd(refundable)} can be refunded on this transaction.`;
    }
    case "refund_amount_invalid":
      return "Enter a refund amount greater than 0.000 BD.";
    case "transaction_not_refundable":
      return `This transaction can't be refunded in its current state${
        typeof body.status === "string" ? ` (${body.status.replace(/_/g, " ")})` : ""
      }. Only captured payments can be refunded.`;
    case "refund_declined":
      return "The card issuer declined the refund. No money moved — you can try again later.";
    case "refunds_on_hold":
      return "Refunds are on hold for your account. Contact FilsPay support to lift the hold.";
    case "impersonation_read_only":
      return "This is a read-only “view as merchant” session. Changes such as refunds are blocked while a FilsPay admin is viewing your account.";
    case "idempotency_key_reused":
      return "This request was already submitted with different details. Close the form and start again.";
    case "request_in_progress":
      return "This refund is still being processed. Wait a moment and refresh before trying again.";
    case "acquirer_unavailable":
      return "The card network is temporarily unavailable. No money moved — try again in a minute.";
    case "transaction_not_found":
      return "This transaction no longer exists on your account.";
    case "unauthenticated":
      return "Your session has ended. Sign in again to continue.";
    // --- sign-in ---
    case "invalid_credentials":
      return "Those details don't match an account. Check the merchant ID, email and password.";
    case "invalid_code":
      return "That code isn't right. Check the latest code and try again.";
    case "otp_expired":
      return "That code has expired. Use “Resend code” to get a new one.";
    case "too_many_attempts":
      return "Too many incorrect codes. Sign in again to get a new code.";
    case "resend_too_soon":
      return "A code was sent moments ago. Wait a little before asking for another.";
    case "rate_limited":
      return "Too many attempts. Wait a minute and try again.";
    case "no_pending_session":
      return "Your sign-in attempt expired. Start again.";
    case "forbidden":
    case "insufficient_role":
      return "Your role can't do this — ask an owner or finance user on your account.";
    default:
      break;
  }
  if (statusCode === 403) {
    return `${body.message && body.message !== code ? `${body.message}. ` : ""}Your role can't do this — ask an owner or finance user on your account. (${code})`;
  }
  if (statusCode >= 500) {
    return "FilsPay had a problem handling this request. Nothing was changed — try again in a moment.";
  }
  return body.message && body.message !== code ? body.message : code.replace(/_/g, " ");
}

/** fetch() rejects with a TypeError when the network is down or the API is
 *  unreachable; say so instead of echoing "Failed to fetch". */
export function messageForNetworkError(): string {
  return "Couldn't reach FilsPay. Check your connection and try again.";
}
