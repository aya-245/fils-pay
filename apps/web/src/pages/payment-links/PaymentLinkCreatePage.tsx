import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { localDateTimeToIso, parseBhdInput } from "../../format.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 *
 * Amount is entered in fils — the platform's actual unit, and the same unit
 * the checkout page works in. No decimal-BHD input widget: a second
 * string-to-fils parser in the browser is exactly the kind of place a money
 * bug hides, and `parseBhdToFils` exists in @filspay/money for whenever a
 * phase genuinely wants that UI.
 *
 * The two client-side checks below mirror the server's own two real checks so
 * an obviously-bad value doesn't need a round trip. They are not the
 * validation: `400 invalid_amount` / `400 invalid_expiry` remain the real
 * answer and are rendered verbatim.
 */
export function PaymentLinkCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [amountBhd, setAmountBhd] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  // Default: one week from now, in the browser's local wall time.
  const [expiresAt, setExpiresAt] = useState(() => {
    const d = new Date(Date.now() + 7 * 86_400_000);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Typed in BD (3 decimals) like every other money input; sent as integer
  // fils via @filspay/money's string parser — the wire contract is unchanged.
  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setError(null);

    const parsed = parseBhdInput(amountBhd);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const amount = parsed.fils;
    const expiresAtIso = localDateTimeToIso(expiresAt);
    if (!expiresAtIso) {
      setError("Expiry must be a valid date and time.");
      return;
    }
    if (new Date(expiresAtIso).getTime() <= Date.now()) {
      setError("Expiry must be in the future.");
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amount,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>New payment link</h1>

      <div role="alert" aria-live="assertive" className="dash-live">
        {error ? <p className="dash-error">{error}</p> : null}
      </div>

      <form className="dash-form" noValidate onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Amount (BD)
          <input
            type="text"
            inputMode="decimal"
            required
            placeholder="e.g. 40.000"
            aria-describedby="link-amount-hint"
            value={amountBhd}
            onChange={(e) => setAmountBhd(e.target.value)}
          />
        </label>
        <p id="link-amount-hint" className="dash-muted dash-hint">
          Up to 3 decimals (1 BD = 1000 fils).
        </p>
        <label>
          Reference (optional)
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label>
          Description (optional)
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Expires at
          <input
            type="datetime-local"
            required
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        <button type="submit" className="dash-button" disabled={submitting}>
          {submitting ? "Creating..." : "Create payment link"}
        </button>
      </form>

      <p>
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}
