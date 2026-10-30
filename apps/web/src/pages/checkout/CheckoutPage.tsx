import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse } from "../../types.js";
import { panDigits, validateCard, type CardErrors, type CardField, type CardFormInput } from "./cardValidation.js";
import "./CheckoutPage.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  /** Network failure / 5xx while loading — NOT "not found": the link may be fine. */
  | { kind: "load_error" }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

type Terminal = "paid" | "expired" | "canceled";

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse }
  | { kind: "declined"; message: string }
  /** 409 payment_link_processing: another attempt holds the link right now. */
  | { kind: "processing" }
  | { kind: "terminal"; reason: Terminal };

const EMPTY_CARD: CardFormInput = { pan: "", expiryMonth: "", expiryYear: "", cvv: "" };

function amountText(fils: number): string {
  return `${formatBhd(toFils(fils))} BHD`;
}

function longDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const FIELD_ORDER: CardField[] = ["pan", "expiryMonth", "expiryYear", "cvv"];

export function CheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<CardFormInput>(EMPTY_CARD);
  const [errors, setErrors] = useState<CardErrors>({});
  const [brandHint, setBrandHint] = useState<string | null>(null);
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fieldRefs = useRef<Partial<Record<CardField, HTMLInputElement | null>>>({});

  const loadLink = useCallback(
    async (signal?: { cancelled: boolean }) => {
      if (!token) {
        setLoadState({ kind: "not_found" });
        return;
      }
      try {
        const link = await getPaymentLink(token);
        if (!signal?.cancelled) setLoadState({ kind: "loaded", link });
      } catch (err) {
        if (signal?.cancelled) return;
        // Only a real 404 is "not found" — the API answers it the same way for
        // malformed and unknown tokens (non-disclosure). Anything else (offline,
        // 5xx) is a temporary problem and gets a retry, not a dead end.
        setLoadState(err instanceof ApiError && err.statusCode === 404 ? { kind: "not_found" } : { kind: "load_error" });
      }
    },
    [token],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    void loadLink(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [loadLink]);

  // Move focus to the new heading whenever the screen changes state, so a
  // screen-reader / keyboard user lands on the outcome (success, decline…).
  const screenKey = `${loadState.kind}:${loadState.kind === "loaded" ? loadState.link.status : ""}:${payState.kind}`;
  useEffect(() => {
    if (payState.kind !== "idle" && payState.kind !== "submitting" && payState.kind !== "declined") {
      headingRef.current?.focus();
    }
  }, [screenKey, payState.kind]);

  useEffect(() => {
    if (loadState.kind !== "loaded") return;
    const name = loadState.link.merchantDisplayName;
    document.title =
      payState.kind === "success" ? `Payment received · ${name}` : `Pay ${amountText(loadState.link.amountFils)} · ${name}`;
  }, [loadState, payState.kind]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token || inFlight.current) return; // double-click / double-Enter guard

    const found = validateCard(card);
    setErrors(found);
    const firstInvalid = FIELD_ORDER.find((f) => found[f]);
    if (firstInvalid) {
      fieldRefs.current[firstInvalid]?.focus();
      return;
    }

    // A fresh Idempotency-Key per explicit user action — every click,
    // including a "try again" after a decline, is a new attempt.
    const idempotencyKey = crypto.randomUUID();
    inFlight.current = true;
    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(
        token,
        {
          card: {
            pan: panDigits(card.pan),
            expiryMonth: Number(card.expiryMonth),
            expiryYear: Number(card.expiryYear),
            cvv: card.cvv.trim(),
          },
        },
        idempotencyKey,
      );
      setCard(EMPTY_CARD);
      setPayState({ kind: "success", result });
    } catch (err) {
      if (err instanceof ApiError) {
        const { statusCode, body, code } = err;
        if (statusCode === 402) {
          setPayState({
            kind: "declined",
            message:
              body.stage === "capture"
                ? "Your payment could not be completed and you have not been charged. Please try again or use a different card."
                : "Your card was declined. You have not been charged — check the details or use a different card.",
          });
        } else if (statusCode === 502) {
          setPayState({ kind: "declined", message: "The card network is temporarily unavailable. You have not been charged — please try again." });
        } else if (code === "payment_link_already_paid") {
          setPayState({ kind: "terminal", reason: "paid" });
        } else if (code === "payment_link_canceled") {
          setPayState({ kind: "terminal", reason: "canceled" });
        } else if (statusCode === 410 || code === "payment_link_expired") {
          setPayState({ kind: "terminal", reason: "expired" });
        } else if (code === "payment_link_processing" || statusCode === 409) {
          setPayState({ kind: "processing" });
        } else if (statusCode === 400) {
          setPayState({ kind: "declined", message: "Some card details look wrong. Please check them and try again." });
        } else {
          setPayState({ kind: "declined", message: "Something went wrong and you have not been charged. Please try again." });
        }
      } else {
        setPayState({
          kind: "declined",
          message: "We couldn't reach the payment service. Check your connection — you have not been charged — and try again.",
        });
      }
    } finally {
      inFlight.current = false;
    }
  }

  /** "Check again" from the processing screen: re-read the link's status. */
  async function recheck(): Promise<void> {
    setPayState({ kind: "idle" });
    setLoadState({ kind: "loading" });
    await loadLink();
  }

  function updateField(field: CardField, value: string): void {
    setCard((previous) => ({ ...previous, [field]: value }));
    if (errors[field]) setErrors((previous) => ({ ...previous, [field]: undefined }));
  }

  if (loadState.kind === "loading") {
    return (
      <main className="checkout-page" aria-busy="true">
        <p role="status" className="checkout-muted">
          Loading payment details…
        </p>
      </main>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <main className="checkout-page">
        <h1 ref={headingRef} tabIndex={-1}>
          Payment link not found
        </h1>
        <p>Check that you opened the full link from your invoice or message. If it still doesn&apos;t work, ask the merchant for a new link.</p>
      </main>
    );
  }

  if (loadState.kind === "load_error") {
    return (
      <main className="checkout-page">
        <h1 ref={headingRef} tabIndex={-1}>
          We couldn&apos;t load this payment
        </h1>
        <p role="alert" className="checkout-alert checkout-alert-error">
          The payment service didn&apos;t respond. Check your connection and try again — nothing has been charged.
        </p>
        <button type="button" className="checkout-button" onClick={() => void recheck()}>
          Try again
        </button>
      </main>
    );
  }

  const { link } = loadState;
  const amount = amountText(link.amountFils);

  const summaryFor = (asHeading: boolean) => (
    <div className="checkout-summary">
      {asHeading ? (
        <h1 className="checkout-merchant">{link.merchantDisplayName}</h1>
      ) : (
        <p className="checkout-merchant">{link.merchantDisplayName}</p>
      )}
      <p className="checkout-amount">{amount}</p>
      {link.description ? <p className="checkout-description">{link.description}</p> : null}
      {link.reference ? <p className="checkout-reference">Reference: {link.reference}</p> : null}
    </div>
  );
  // Outcome screens use the outcome as their <h1>; the merchant is context.
  const summary = summaryFor(false);

  if (payState.kind === "success") {
    return (
      <main className="checkout-page">
        {summary}
        <div className="checkout-alert checkout-alert-success" role="status">
          <h1 ref={headingRef} tabIndex={-1}>
            Payment successful
          </h1>
          <p>
            You paid <strong>{amountText(payState.result.amountFils)}</strong> to {link.merchantDisplayName}. Keep
            the details below for your records.
          </p>
        </div>
        <dl className="checkout-dl">
          <dt>Paid at</dt>
          <dd>{longDate(payState.result.paidAt)}</dd>
          <dt>Transaction ID</dt>
          <dd>
            <code>{payState.result.transactionId}</code>
          </dd>
        </dl>
      </main>
    );
  }

  const terminal: Terminal | null =
    payState.kind === "terminal"
      ? payState.reason
      : link.status === "paid" || link.status === "expired" || link.status === "canceled"
        ? link.status
        : null;

  if (terminal) {
    const copy = {
      paid: {
        title: "This invoice has already been paid",
        body: "No further payment is needed. If you think this is wrong, contact the merchant before paying again.",
      },
      expired: {
        title: "This payment link has expired",
        body: `It was valid until ${longDate(link.expiresAt)}. You have not been charged — ask ${link.merchantDisplayName} to send a new link.`,
      },
      canceled: {
        title: "This payment link is no longer available",
        body: `${link.merchantDisplayName} has cancelled this link. You have not been charged — contact them if you still need to pay.`,
      },
    }[terminal];
    return (
      <main className="checkout-page">
        {summary}
        <div className={`checkout-alert ${terminal === "paid" ? "checkout-alert-info" : "checkout-alert-warn"}`} role="status">
          <h1 ref={headingRef} tabIndex={-1}>
            {copy.title}
          </h1>
          <p>{copy.body}</p>
        </div>
      </main>
    );
  }

  if (link.status === "processing" || payState.kind === "processing") {
    return (
      <main className="checkout-page">
        {summary}
        <div className="checkout-alert checkout-alert-info" role="status">
          <h1 ref={headingRef} tabIndex={-1}>
            A payment is already in progress
          </h1>
          <p>
            Someone is paying this link right now (possibly you, in another tab). To avoid paying twice, wait a moment and
            check again before retrying.
          </p>
        </div>
        <button type="button" className="checkout-button" onClick={() => void recheck()}>
          Check payment status
        </button>
      </main>
    );
  }

  // link.status === 'active'
  const submitting = payState.kind === "submitting";
  const errorIds = (field: CardField) => (errors[field] ? `checkout-${field}-error` : undefined);
  const errorCount = FIELD_ORDER.filter((f) => errors[f]).length;

  return (
    <main className="checkout-page">
      {summaryFor(true)}
      <p className="checkout-muted">Link valid until {longDate(link.expiresAt)}.</p>

      <div role="alert" aria-live="assertive" className="checkout-live">
        {payState.kind === "declined" ? <p className="checkout-alert checkout-alert-error">{payState.message}</p> : null}
        {errorCount > 0 ? (
          <p className="checkout-alert checkout-alert-error">
            Please fix {errorCount === 1 ? "the highlighted field" : `the ${errorCount} highlighted fields`} below.
          </p>
        ) : null}
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="checkout-form" noValidate aria-busy={submitting}>
        <h2 className="checkout-form-title">Pay by card</h2>
        <div className="checkout-field">
          <label htmlFor="checkout-pan">Card number</label>
          <input
            id="checkout-pan"
            ref={(el) => {
              fieldRefs.current.pan = el;
            }}
            type="text"
            inputMode="numeric"
            autoComplete="cc-number"
            maxLength={23}
            disabled={submitting}
            aria-invalid={errors.pan ? true : undefined}
            aria-describedby={errorIds("pan")}
            value={card.pan}
            onChange={(e) => {
              const pan = e.target.value;
              updateField("pan", pan);
              const digits = pan.replace(/\D/g, "");
              if (digits.length >= 4) {
                void import("../../utils/helpers.js").then((m) => {
                  setBrandHint(m.formatCardBrandHint(digits));
                });
              } else {
                setBrandHint(null);
              }
            }}
          />
          {brandHint && brandHint !== "unknown" ? <span className="checkout-brand-hint">{brandHint}</span> : null}
          {errors.pan ? (
            <span id="checkout-pan-error" className="checkout-field-error">
              {errors.pan}
            </span>
          ) : null}
        </div>
        <div className="checkout-form-row">
          <div className="checkout-field">
            <label htmlFor="checkout-month">Expiry month</label>
            <input
              id="checkout-month"
              ref={(el) => {
                fieldRefs.current.expiryMonth = el;
              }}
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp-month"
              placeholder="MM"
              maxLength={2}
              disabled={submitting}
              aria-invalid={errors.expiryMonth ? true : undefined}
              aria-describedby={errorIds("expiryMonth")}
              value={card.expiryMonth}
              onChange={(e) => updateField("expiryMonth", e.target.value)}
            />
            {errors.expiryMonth ? (
              <span id="checkout-expiryMonth-error" className="checkout-field-error">
                {errors.expiryMonth}
              </span>
            ) : null}
          </div>
          <div className="checkout-field">
            <label htmlFor="checkout-year">Expiry year</label>
            <input
              id="checkout-year"
              ref={(el) => {
                fieldRefs.current.expiryYear = el;
              }}
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp-year"
              placeholder="YYYY"
              maxLength={4}
              disabled={submitting}
              aria-invalid={errors.expiryYear ? true : undefined}
              aria-describedby={errorIds("expiryYear")}
              value={card.expiryYear}
              onChange={(e) => updateField("expiryYear", e.target.value)}
            />
            {errors.expiryYear ? (
              <span id="checkout-expiryYear-error" className="checkout-field-error">
                {errors.expiryYear}
              </span>
            ) : null}
          </div>
          <div className="checkout-field">
            <label htmlFor="checkout-cvv">CVV</label>
            <input
              id="checkout-cvv"
              ref={(el) => {
                fieldRefs.current.cvv = el;
              }}
              type="password"
              inputMode="numeric"
              autoComplete="cc-csc"
              maxLength={4}
              disabled={submitting}
              aria-invalid={errors.cvv ? true : undefined}
              aria-describedby={errorIds("cvv")}
              value={card.cvv}
              onChange={(e) => updateField("cvv", e.target.value)}
            />
            {errors.cvv ? (
              <span id="checkout-cvv-error" className="checkout-field-error">
                {errors.cvv}
              </span>
            ) : null}
          </div>
        </div>
        <button type="submit" className="checkout-button checkout-button-primary" disabled={submitting}>
          {submitting ? (
            <>
              <span className="checkout-spinner" aria-hidden="true" /> Processing payment…
            </>
          ) : (
            `Pay ${amount}`
          )}
        </button>
        <p role="status" aria-live="polite" className="checkout-muted checkout-center">
          {submitting ? "Processing your payment — please don't close or refresh this page." : ""}
        </p>
      </form>

      <p className="checkout-help">
        Test cards (simulated acquirer, no real charge): any other number approves; a PAN ending{" "}
        <code>0002</code> always declines (do not honor); ending <code>0119</code> always declines
        (insufficient funds); ending <code>0069</code> always errors.
      </p>
    </main>
  );
}
