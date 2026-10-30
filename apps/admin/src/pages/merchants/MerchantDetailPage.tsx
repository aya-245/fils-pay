import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { parseBhdToFils } from "@filspay/money";
import { getMerchant, recomputeTransactionStatuses, submitKycReview } from "../../api/merchants.js";
import { adjustBalance } from "../../api/balanceAdjustments.js";
import { issueCredit } from "../../api/credits.js";
import { rotateApiKey } from "../../api/apiKeys.js";
import { startImpersonation } from "../../api/impersonation.js";
import { describeError, WEB_BASE_URL } from "../../api/client.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { Badge } from "../../components/Badge.js";
import { ArrowLeftIcon } from "../../components/Icons.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, parseSignedBhdInput, refundsNettedFils, signedBhd } from "../../format.js";
import type {
  AdminMerchantDetail,
  BalanceAdjustmentResult,
  CreditReasonCode,
  RotatedApiKey,
} from "../../types.js";

// browser local date not bahrain, fine for bahrain staff — am
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

export function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { rememberImpersonation, admin } = useAdminAuth();

  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kycNotes, setKycNotes] = useState("");
  const [busy, setBusy] = useState(false);

  /** Which key the operator has asked to rotate and not yet confirmed. */
  const [pendingRotation, setPendingRotation] = useState<string | null>(null);
  const [rotationLabel, setRotationLabel] = useState("");
  /** Shown exactly once: `rawKey` exists in the rotate response and nowhere else. */
  const [rotatedKey, setRotatedKey] = useState<RotatedApiKey | null>(null);

  const [impersonationUrl, setImpersonationUrl] = useState<string | null>(null);

  const [creditAmountBhd, setCreditAmountBhd] = useState("");
  const [creditReason, setCreditReason] = useState<CreditReasonCode>("goodwill");
  const [creditMemo, setCreditMemo] = useState("");
  const [creditReverseFee, setCreditReverseFee] = useState(false);
  const [creditEffectiveDate, setCreditEffectiveDate] = useState(todayIso());

  const [adjustAmountBhd, setAdjustAmountBhd] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  /** Set once the operator has reviewed the figures and not yet confirmed. */
  const [pendingAdjust, setPendingAdjust] = useState<{ deltaFils: number; reason: string } | null>(null);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustResult, setAdjustResult] = useState<BalanceAdjustmentResult | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      setDetail(await getMerchant(id));
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleKycReview(outcome: "approved" | "rejected"): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await submitKycReview(id, {
        outcome,
        notes: kycNotes.trim() ? kycNotes.trim() : undefined,
      });
      setNotice(
        `KYC ${outcome}. Onboarding status is now ${result.onboardingStatus} (kycPassed: ${String(
          result.kycPassed,
        )}).`,
      );
      setKycNotes("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** The old key keeps working for a 24h overlap window, then stops. */
  async function handleRotate(keyId: string): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const rotated = await rotateApiKey(id, keyId, {
        label: rotationLabel.trim() ? rotationLabel.trim() : undefined,
      });
      setRotatedKey(rotated);
      setPendingRotation(null);
      setRotationLabel("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Step 1: validate the BD figure and show a review panel. Nothing is sent. */
  function handleReviewAdjustment(event: React.FormEvent): void {
    event.preventDefault();
    setAdjustError(null);
    setAdjustResult(null);
    const parsed = parseSignedBhdInput(adjustAmountBhd);
    if (!parsed.ok) {
      setAdjustError(parsed.message);
      return;
    }
    if (!adjustReason.trim()) {
      setAdjustError("Enter a reason — it is written to the ledger journal and the admin audit log.");
      return;
    }
    setPendingAdjust({ deltaFils: parsed.fils, reason: adjustReason.trim() });
  }

  /** Step 2: post it. The API journals the delta to the ledger (balanced
   *  legs) and moves the cached balance in the same transaction (FP-203), so
   *  a later "Rebuild balances" keeps the correction instead of erasing it. */
  async function handleConfirmAdjustment(): Promise<void> {
    if (!id || !pendingAdjust) return;
    setBusy(true);
    setAdjustError(null);
    try {
      const result = await adjustBalance(id, pendingAdjust);
      setAdjustResult(result);
      setPendingAdjust(null);
      setAdjustAmountBhd("");
      setAdjustReason("");
      await load();
    } catch (err) {
      setAdjustError(describeError(err, admin?.role));
    } finally {
      setBusy(false);
    }
  }

  async function handleIssueCredit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      // BD in, integer fils out, via the platform's own string-based parser —
      // never parseFloat, which cannot represent the third decimal exactly.
      const baseAmountFils = parseBhdToFils(creditAmountBhd);
      const record = await issueCredit(id, {
        baseAmountFils,
        reasonCode: creditReason,
        effectiveDate: creditEffectiveDate,
        reverseFee: creditReverseFee,
        memo: creditMemo.trim() ? creditMemo.trim() : undefined,
      });
      setNotice(
        record.status === "posted"
          ? `Credit of ${bhd(record.postedAmountFils)} posted to the ledger (entry group ${
              record.ledgerEntryGroupId ?? "unknown"
            }).`
          : `Credit of ${bhd(record.postedAmountFils)} raised and awaiting a second approver — see Credits.`,
      );
      setCreditAmountBhd("");
      setCreditMemo("");
      setCreditReverseFee(false);
      await load();
    } catch (err) {
      setActionError(err instanceof RangeError ? err.message : describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRecomputeStatuses(): Promise<void> {
    if (!id) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await recomputeTransactionStatuses(id);
      setNotice(
        `Scanned ${result.scanned} transaction${result.scanned === 1 ? "" : "s"}; ` +
          `${result.updated} status${result.updated === 1 ? "" : "es"} updated.`,
      );
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // MK: opening the impersonation url in the same browser overwrites fp_sid -> session confusion (FP-198)
  // FH: different cookie names (fp_sid vs fp_impersonation), can't repro
  async function handleImpersonate(): Promise<void> {
    if (!id || !detail) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const grant = await startImpersonation(id);
      rememberImpersonation({ ...grant, merchantDisplayName: detail.merchant.displayName });
      // The grant rides an httpOnly cookie set for apps/api's domain, which
      // apps/web already sends with `credentials: 'include'` — so the
      // merchant dashboard just works, unaware of how it was authenticated.
      // Opened in a second tab on purpose: this tab keeps showing the
      // impersonation banner and its exit action, which is the whole point
      // of the banner existing.
      const opened = window.open(WEB_BASE_URL, "_blank", "noopener");
      if (!opened) setImpersonationUrl(WEB_BASE_URL);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section>
        <p className="admin-error">{loadError}</p>
        <Link to="/merchants">Back to merchants</Link>
      </section>
    );
  }

  if (!detail) {
    return <p>Loading merchant...</p>;
  }

  const { merchant } = detail;
  const profile = detail.businessProfile;
  const apiKeys = detail.apiKeys ?? [];
  const webhookEndpoints = detail.webhookEndpoints ?? [];
  const kycReviews = detail.kycReviews ?? [];
  const batches = detail.recentSettlementBatches ?? [];

  return (
    <section>
      <Link to="/merchants" className="admin-backlink">
        <ArrowLeftIcon /> Merchants
      </Link>
      <div className="admin-page-header">
        <div>
          <h1>{merchant.displayName}</h1>
          <p className="admin-muted">
            <code>{merchant.id}</code>
          </p>
        </div>
        <div className="admin-actions-inline">
          <Badge value={merchant.status} />
          <Badge value={merchant.onboardingStatus} />
          <Badge value={merchant.testMode ? "test" : "live"} />
        </div>
      </div>

      <div className="admin-stats">
        <div className="admin-stat">
          <div className="admin-stat-label">Cached payable</div>
          <div className="admin-stat-value">
            {detail.balance ? bhd(detail.balance.cachedPayableFils) : "—"}
          </div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">MDR</div>
          <div className="admin-stat-value">{(merchant.mdrBps / 100).toFixed(2)}%</div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">KYC</div>
          <div className="admin-stat-value">{merchant.kycPassed ? "Passed" : "Not passed"}</div>
        </div>
        <div className="admin-stat">
          <div className="admin-stat-label">API keys</div>
          <div className="admin-stat-value">{apiKeys.filter((k) => !k.revokedAt).length} active</div>
        </div>
      </div>

      <div role="alert" aria-live="assertive" className="admin-live">
        {actionError ? <p className="admin-error">{actionError}</p> : null}
      </div>
      <div role="status" aria-live="polite" className="admin-live">
        {notice ? <p className="admin-notice">{notice}</p> : null}
      </div>

      <h2>Profile</h2>
      <dl className="admin-dl">
        <dt>Status</dt>
        <dd>{merchant.status}</dd>
        <dt>Onboarding status</dt>
        <dd>{merchant.onboardingStatus}</dd>
        <dt>KYC</dt>
        <dd>{merchant.kycPassed ? "passed" : "not passed"}</dd>
        <dt>MDR</dt>
        <dd>
          {(merchant.mdrBps / 100).toFixed(2)}% ({merchant.mdrBps} bps)
        </dd>
        <dt>Current negotiated rate</dt>
        <dd>
          {detail.currentFeeSchedule
            ? `${(detail.currentFeeSchedule.mdrBps / 100).toFixed(2)}% (${detail.currentFeeSchedule.mdrBps} bps), effective ${new Date(detail.currentFeeSchedule.effectiveFrom).toLocaleDateString()}`
            : "no negotiated schedule on file (uses MDR above)"}
        </dd>
        <dt>Mode</dt>
        <dd>{merchant.testMode ? "test" : "live"}</dd>
        <dt>Created</dt>
        <dd>{new Date(merchant.createdAt).toLocaleString()}</dd>
        {profile ? (
          <>
            <dt>Legal name</dt>
            <dd>{profile.legalName}</dd>
            <dt>Registration number</dt>
            <dd>{profile.registrationNumber}</dd>
            <dt>Business type</dt>
            <dd>{profile.businessType}</dd>
            <dt>Contact</dt>
            <dd>
              {profile.contactEmail} / {profile.contactPhone}
            </dd>
            <dt>Address</dt>
            <dd>
              {profile.addressLine1}
              {profile.addressLine2 ? `, ${profile.addressLine2}` : ""}, {profile.city}
              {profile.postalCode ? ` ${profile.postalCode}` : ""}, {profile.country}
            </dd>
          </>
        ) : null}
      </dl>
      {!profile ? <p className="admin-muted">No business profile submitted yet.</p> : null}

      <h2>Balance</h2>
      {detail.balance ? (
        <p>
          Cached payable: <strong>{bhd(detail.balance.cachedPayableFils)}</strong> (updated{" "}
          {new Date(detail.balance.updatedAt).toLocaleString()}). The ledger remains authoritative;
          this figure is a cache, rebuildable from Settlement ops.
        </p>
      ) : (
        <p className="admin-muted">No cached balance row yet.</p>
      )}

      <h2 id="adjust-balance">Adjust balance</h2>
      <p className="admin-muted">
        A correction to this merchant&apos;s payable balance, for when support has confirmed the
        figure on screen is wrong. It is <strong>journaled to the ledger</strong> (balanced
        adjustment legs) and recorded in the admin audit log, so a later balance rebuild keeps it.
        Requires the <code>finance</code> or <code>super_admin</code> role.
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-readonly" role="note">
            <strong>Read-only for your role ({admin?.role.replace(/_/g, " ")}).</strong> Balance
            corrections need a finance or super admin — the server refuses them with 403 for other
            roles.
          </p>
        }
      >
        <div role="alert" aria-live="assertive" className="admin-live">
          {adjustError ? <p className="admin-error">{adjustError}</p> : null}
        </div>
        <div role="status" aria-live="polite" className="admin-live">
          {adjustResult ? (
            <div className="admin-notice">
              <p>
                <strong>Adjustment journaled to the ledger: {signedBhd(adjustResult.deltaFils)}.</strong>
              </p>
              <p>
                Cached payable {bhd(adjustResult.cachedPayableFilsBefore)} →{" "}
                <strong>{bhd(adjustResult.cachedPayableFilsAfter)}</strong>. The entry is in the
                ledger and the admin audit log.
              </p>
            </div>
          ) : null}
        </div>

        {pendingAdjust ? (
          <div className="admin-confirm" role="group" aria-labelledby="adjust-confirm-title">
            <p id="adjust-confirm-title">
              <strong>
                Post a {signedBhd(pendingAdjust.deltaFils)} adjustment to {merchant.displayName}?
              </strong>
            </p>
            <dl className="admin-dl">
              <dt>Current cached payable</dt>
              <dd>{detail.balance ? bhd(detail.balance.cachedPayableFils) : "no balance row"}</dd>
              {detail.balance ? (
                <>
                  <dt>After adjustment</dt>
                  <dd>
                    <strong>{bhd(detail.balance.cachedPayableFils + pendingAdjust.deltaFils)}</strong>
                  </dd>
                </>
              ) : null}
              <dt>Reason</dt>
              <dd>{pendingAdjust.reason}</dd>
            </dl>
            <p className="admin-muted">
              This writes balanced ledger legs and cannot be deleted — a mistake is fixed with an
              opposite adjustment.
            </p>
            <button type="button" disabled={busy} onClick={() => void handleConfirmAdjustment()}>
              {busy ? "Posting..." : "Post adjustment to ledger"}
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => setPendingAdjust(null)}>
              Back
            </button>
          </div>
        ) : (
          <form className="admin-form" noValidate onSubmit={handleReviewAdjustment}>
            <label>
              Adjustment (BD, up to 3 decimals; negative to reduce)
              <input
                value={adjustAmountBhd}
                onChange={(e) => setAdjustAmountBhd(e.target.value)}
                inputMode="decimal"
                placeholder="-2.500"
                aria-describedby="adjust-hint"
              />
            </label>
            <p id="adjust-hint" className="admin-muted admin-hint">
              1 BD = 1000 fils. Example: <code>-2.500</code> removes 2.500 BHD from the payable balance.
            </p>
            <label>
              Reason
              <input
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="e.g. duplicate fee charged on 2026-10-28 (ticket SUP-481)"
              />
            </label>
            <div>
              <button type="submit" disabled={busy}>
                Review adjustment
              </button>
            </div>
          </form>
        )}
      </RequireRole>

      <h2>Issue credit</h2>
      <p className="admin-muted">
        Journals a manual credit to this merchant&apos;s payable balance. Above the approval limit
        it waits in <Link to="/credits">Credits</Link> for a second finance operator; at or below
        it, it posts immediately. The effective date is the accounting date the ledger legs are
        booked against.
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-readonly">
            Your role cannot issue credits. Ask a finance admin.
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleIssueCredit(e)}>
          <label>
            Amount (BD, up to 3 decimals)
            <input
              type="text"
              required
              placeholder="50.000"
              value={creditAmountBhd}
              onChange={(e) => setCreditAmountBhd(e.target.value)}
            />
          </label>
          <label>
            Reason
            <select
              value={creditReason}
              onChange={(e) => setCreditReason(e.target.value as CreditReasonCode)}
            >
              <option value="goodwill">Goodwill</option>
              <option value="dispute_resolution">Dispute resolution</option>
              <option value="correction">Correction</option>
            </select>
          </label>
          <label>
            Effective date
            <input
              type="date"
              required
              value={creditEffectiveDate}
              onChange={(e) => setCreditEffectiveDate(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={creditReverseFee}
              onChange={(e) => setCreditReverseFee(e.target.checked)}
            />{" "}
            Also reverse the MDR on this amount ({(merchant.mdrBps / 100).toFixed(2)}%)
          </label>
          <label>
            Memo (optional)
            <textarea value={creditMemo} onChange={(e) => setCreditMemo(e.target.value)} rows={2} />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Submitting..." : "Issue credit"}
          </button>
        </form>
      </RequireRole>

      <h2>KYC review</h2>
      <p className="admin-muted">
        Approving or rejecting requires the <code>finance</code> or <code>super_admin</code> role;
        the API enforces it and answers <code>403</code> otherwise.
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-readonly">
            Your role is read-only for KYC decisions. Ask a finance admin to review.
          </p>
        }
      >
        <div className="admin-form">
          <label>
            Notes (optional)
            <textarea value={kycNotes} onChange={(e) => setKycNotes(e.target.value)} rows={3} />
          </label>
          <div>
            <button type="button" disabled={busy} onClick={() => void handleKycReview("approved")}>
              Approve KYC
            </button>{" "}
            <button
              type="button"
              className="admin-btn-danger"
              disabled={busy}
              onClick={() => void handleKycReview("rejected")}
            >
              Reject KYC
            </button>
          </div>
        </div>
      </RequireRole>

      <h3>Review history</h3>
      {kycReviews.length === 0 ? (
        <p className="admin-muted">No reviews recorded.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Outcome</th>
              <th>Reviewer</th>
              <th>Notes</th>
              <th>Reviewed at</th>
            </tr>
          </thead>
          <tbody>
            {kycReviews.map((review) => (
              <tr key={review.id}>
                <td>{review.outcome}</td>
                <td>{review.reviewerIdentifier}</td>
                <td>{review.notes ?? "-"}</td>
                <td>{new Date(review.reviewedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>API keys</h2>
      {rotatedKey ? (
        <div className="admin-notice">
          <p>
            <strong>New key issued — copy it now.</strong> This value is shown once and is not
            recoverable afterwards.
          </p>
          <p>
            <code>{rotatedKey.rawKey}</code>
          </p>
          <p className="admin-muted">
            New key id <code>{rotatedKey.id}</code>, replacing previous key{" "}
            <code>{rotatedKey.previousKeyId}</code>.
          </p>
          <button type="button" onClick={() => setRotatedKey(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {apiKeys.length === 0 ? (
        <p className="admin-muted">No API keys.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Revoked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apiKeys.map((key) => (
              <tr key={key.id}>
                <td>
                  <code>{key.prefix}</code>
                </td>
                <td>{key.label ?? "-"}</td>
                <td>{new Date(key.createdAt).toLocaleDateString()}</td>
                <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}</td>
                <td>{key.revokedAt ? new Date(key.revokedAt).toLocaleString() : "-"}</td>
                <td>
                  {key.revokedAt ? null : (
                    <RequireRole
                      allow={["finance", "super_admin"]}
                      fallback={<span className="admin-muted">finance role required</span>}
                    >
                      <button type="button" onClick={() => setPendingRotation(key.id)}>
                        Rotate
                      </button>
                    </RequireRole>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendingRotation ? (
        <div className="admin-confirm">
          <p>
            <strong>Rotate this API key?</strong> The current key is revoked and a replacement is
            issued in the same transaction, so the merchant is never left without a working key —
            but any integration still sending the old key will start failing immediately.
          </p>
          <label>
            Label for the new key (optional)
            <input
              type="text"
              value={rotationLabel}
              onChange={(e) => setRotationLabel(e.target.value)}
            />
          </label>
          <button type="button" disabled={busy} onClick={() => void handleRotate(pendingRotation)}>
            {busy ? "Rotating..." : "Yes, rotate it"}
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              setPendingRotation(null);
              setRotationLabel("");
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}

      <h2>Webhook endpoints</h2>
      {webhookEndpoints.length === 0 ? (
        <p className="admin-muted">No endpoints registered.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th>Secret prefix</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {webhookEndpoints.map((endpoint) => (
              <tr key={endpoint.id}>
                <td>{endpoint.url}</td>
                <td>{endpoint.status}</td>
                <td>
                  <code>{endpoint.secretPrefix}</code>
                </td>
                <td>{new Date(endpoint.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <Link to={`/webhooks/${merchant.id}`}>Replay a batch of deliveries for this merchant</Link>
      </p>

      <h2>Recent settlement batches</h2>
      {batches.length === 0 ? (
        <p className="admin-muted">No batches yet.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Gross</th>
              <th>Fee</th>
              <th title="Refunds minus the MDR fee they reverse">Refunds netted</th>
              <th>Net payout</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <tr key={batch.id}>
                <td>{batch.batchDate}</td>
                <td>{batch.status}</td>
                <td>{bhd(batch.grossFils)}</td>
                <td>{bhd(batch.feeFils)}</td>
                <td>{refundsNettedFils(batch) === 0 ? "—" : bhd(-refundsNettedFils(batch))}</td>
                <td>{bhd(batch.netPayoutFils)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Recompute transaction statuses</h2>
      <p className="admin-muted">
        Re-derives this merchant&apos;s transaction statuses from their own captured/refunded
        amounts. Rows written before the refunds release can carry a status that predates the
        derivation rule; this backfills them. Rows that already agree are left alone.
      </p>
      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-readonly">
            Your role cannot run this backfill. Ask a finance admin.
          </p>
        }
      >
        <button type="button" disabled={busy} onClick={() => void handleRecomputeStatuses()}>
          {busy ? "Working..." : "Recompute statuses"}
        </button>
      </RequireRole>

      <h2>View as merchant</h2>
      <p className="admin-muted">
        Starts a short-lived, audited impersonation grant. It always acts with this merchant&apos;s
        least-privileged <code>support</code> role — never with your admin role — and it expires on
        its own. It is <strong>read-only</strong>: refunds, captures and every other write are
        refused with 403 while impersonating. A banner stays on screen until you exit it.
      </p>
      <button type="button" disabled={busy} onClick={() => void handleImpersonate()}>
        View as merchant
      </button>
      {impersonationUrl ? (
        <p>
          Your browser blocked the new tab —{" "}
          <a href={impersonationUrl} target="_blank" rel="noreferrer">
            open the merchant dashboard
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}
