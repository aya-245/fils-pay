import { useEffect, useId, useRef, useState } from "react";
import { refundTransaction } from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, bhdAmount, parseBhdInput } from "../../format.js";
import type { RefundResponse, TransactionDto } from "../../types.js";
import { refundableFils, isRefundable } from "./refundable.js";

const MAX_REASON_LENGTH = 500;

interface RefundDrawerProps {
  txn: TransactionDto;
  /** Called after a successful refund; the page refetches the transaction
   *  and its timeline (a refund writes a new transaction_events row). */
  onRefunded: (result: RefundResponse) => Promise<void>;
}

/**
 * FP-212 / FP-300 merchant refunds, full or partial.
 *
 * - Amount is typed in BD (3 decimals) and converted with @filspay/money's
 *   string parser, never parseFloat. It is prefilled with everything still
 *   refundable (captured − already refunded), so a full refund is one click.
 * - Idempotency-Key: one key per distinct request. A retry of the *same*
 *   amount + reason after a network failure or 5xx reuses the key, so the
 *   server replays its stored answer instead of refunding twice; any change
 *   to the request, or a definitive answer, mints a fresh key.
 * - The submit button is disabled while the request is in flight, and a ref
 *   guard stops a fast double-click from sending twice before React re-renders.
 * - Server refusals (refund_exceeds_refundable with the refundable amount,
 *   refunds_on_hold, impersonation_read_only, refund_declined, …) are shown
 *   in an assertive live region next to the form.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;
  const refundable = refundableFils(txn);

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(() => bhdAmount(refundable));
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef(false);
  const idempotency = useRef<{ key: string; signature: string } | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const titleId = `${ids}-title`;
  const hintId = `${ids}-hint`;
  const amountErrorId = `${ids}-amount-error`;

  // Re-prefill when the refundable figure changes (after a refund lands).
  useEffect(() => {
    setAmount(bhdAmount(refundable));
  }, [refundable]);

  useEffect(() => {
    if (open) amountRef.current?.select();
  }, [open]);

  if (!isRefundable(txn)) return null;

  const parsed = parseBhdInput(amount, { maxFils: refundable });
  const isFull = parsed.ok && parsed.fils === refundable;

  function close(): void {
    if (submitting) return;
    setOpen(false);
    setError(null);
    setFieldError(null);
    setAmount(bhdAmount(refundable));
    setReason("");
    idempotency.current = null;
    // Return focus to the control that opened the drawer.
    window.setTimeout(() => openButtonRef.current?.focus(), 0);
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || inFlight.current) return;

    if (!parsed.ok) {
      setFieldError(parsed.message);
      amountRef.current?.focus();
      return;
    }
    setFieldError(null);
    setError(null);

    const trimmedReason = reason.trim();
    const input = {
      transactionId: txn.id,
      amountFils: parsed.fils,
      ...(trimmedReason ? { reason: trimmedReason } : {}),
    };
    const signature = JSON.stringify(input);
    if (!idempotency.current || idempotency.current.signature !== signature) {
      idempotency.current = { key: crypto.randomUUID(), signature };
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const result = await refundTransaction(merchantId, input, idempotency.current.key);
      idempotency.current = null;
      setOpen(false);
      setReason("");
      await onRefunded(result);
    } catch (err) {
      // Network failure / 5xx: the outcome is unknown, keep the key so a
      // retry of the same request is a safe replay. Anything else is a
      // definitive answer — the next attempt is a new request.
      const retryable = !(err instanceof ApiError) || err.statusCode >= 500 || err.code === "request_in_progress";
      if (!retryable) idempotency.current = null;
      setError(describeError(err));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <RequireRole allow={["owner", "finance"]}>
      {open ? (
        <section
          className="dash-drawer"
          role="region"
          aria-labelledby={titleId}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <h2 id={titleId}>Refund this payment</h2>
          <p>
            Up to <strong>{bhd(refundable)}</strong> can be refunded
            {txn.refundedFils > 0 ? (
              <>
                {" "}
                ({bhd(txn.capturedFils)} captured, {bhd(txn.refundedFils)} already refunded)
              </>
            ) : null}
            . The money goes back to the cardholder&apos;s card and cannot be recalled.
          </p>

          <div role="alert" aria-live="assertive" className="dash-live">
            {error ? <p className="dash-error">{error}</p> : null}
          </div>

          <form className="dash-form" noValidate onSubmit={(e) => void handleSubmit(e)}>
            <label>
              Refund amount (BD)
              <input
                ref={amountRef}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                required
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={`${hintId}${fieldError ? ` ${amountErrorId}` : ""}`}
                value={amount}
                disabled={submitting}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setFieldError(null);
                }}
                onBlur={() => {
                  if (!parsed.ok && amount.trim() !== "") setFieldError(parsed.message);
                }}
              />
            </label>
            <p id={hintId} className="dash-muted dash-hint">
              Up to 3 decimals (1 BD = 1000 fils). Prefilled with the full refundable amount — lower
              it for a partial refund.
            </p>
            {fieldError ? (
              <p id={amountErrorId} className="dash-field-error">
                {fieldError}
              </p>
            ) : null}

            <label>
              Reason (optional, shown in your refund records)
              <textarea
                rows={2}
                maxLength={MAX_REASON_LENGTH}
                value={reason}
                disabled={submitting}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <p className="dash-muted dash-hint">
              {reason.length}/{MAX_REASON_LENGTH}
            </p>

            <div className="dash-actions">
              <button type="submit" className="dash-button dash-button-primary" disabled={submitting} aria-busy={submitting}>
                {submitting
                  ? "Refunding…"
                  : parsed.ok
                    ? `Refund ${bhd(parsed.fils)}${isFull ? " (full)" : ""}`
                    : "Refund"}
              </button>
              <button type="button" className="dash-button" disabled={submitting} onClick={close}>
                Cancel
              </button>
            </div>
          </form>
        </section>
      ) : (
        <button
          ref={openButtonRef}
          type="button"
          className="dash-button"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          Refund…
        </button>
      )}
    </RequireRole>
  );
}
