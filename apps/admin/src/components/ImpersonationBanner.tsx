import { useState } from "react";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError } from "../api/client.js";

/**
 * Shown on every admin screen for as long as an impersonation grant is
 * active. Impersonation is a real, privilege-adjacent state, so the
 * one thing this banner must never do is be easy to miss — it sits above
 * the nav, it is loud, and it carries its own one-click exit.
 *
 * The exit action calls `POST /v1/admin/impersonation/:grantId/end`, which
 * stamps `ended_at`, writes the closing audit row, and clears the
 * `fp_impersonation` cookie. Note what ending does *not* do: it does not
 * restore any admin privilege, because none was ever given up — `/v1/admin/*`
 * never reads anything impersonation-related. It closes the
 * merchant-read window and completes the audit trail.
 */
// MK: banner wording is accurate, impersonation is view-only
export function ImpersonationBanner() {
  const { impersonation, exitImpersonation } = useAdminAuth();
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!impersonation) return null;

  async function handleExit(): Promise<void> {
    setExiting(true);
    setError(null);
    try {
      await exitImpersonation();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setExiting(false);
    }
  }

  const label = impersonation.merchantDisplayName ?? impersonation.merchantId;

  return (
    <div className="impersonation-banner" role="region" aria-label="Impersonation in progress">
      <div>
        <strong>You are viewing as a merchant — read-only.</strong>{" "}
        <span>
          Active grant for <code>{label}</code>, expiring{" "}
          {new Date(impersonation.expiresAt).toLocaleString()}. Merchant screens in the dashboard act
          with this merchant&apos;s least-privileged (support) role, and every write — refunds,
          captures, payment-link or webhook changes — is refused with <code>403</code>{" "}
          (<code>impersonation_read_only</code>). Every view is audited.
        </span>
        <div role="alert" aria-live="assertive">
          {error ? <div className="impersonation-banner-error">Could not end it: {error}</div> : null}
        </div>
      </div>
      <button type="button" onClick={() => void handleExit()} disabled={exiting}>
        {exiting ? "Exiting..." : "Exit impersonation"}
      </button>
    </div>
  );
}
