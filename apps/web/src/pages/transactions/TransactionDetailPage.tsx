import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  captureTransaction,
  getTransaction,
  getTransactionEvents,
  voidTransaction,
} from "../../api/transactions.js";
import { ApiError, describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, dash, dateTime, humanize, parseBhdInput } from "../../format.js";
import type { RefundResponse, TransactionDto, TransactionEventDto } from "../../types.js";
import { RefundDrawer } from "./RefundDrawer.js";
import { refundableFils, refundState } from "./refundable.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; txn: TransactionDto };

/** Timeline wording: event types are API codes, the merchant reads sentences. */
const EVENT_LABELS: Record<string, string> = {
  authorized: "Authorized",
  captured: "Captured",
  partially_captured: "Partially captured",
  voided: "Voided",
  refunded: "Refunded (full)",
  refund_partial: "Refunded (partial)",
};

function isRefundEvent(eventType: string): boolean {
  return eventType === "refunded" || eventType === "refund_partial";
}

/**
 * `GET /v1/transactions/:id` plus its event timeline on the same page — one
 * feature, so one view, not two navigable routes.
 *
 * A `404` renders a plain "not found" state and never tries to distinguish
 * "doesn't exist" from "not yours": the API deliberately answers the same way
 * for both (a `403` would confirm a foreign transaction's existence), and
 * this page does not undo that by guessing.
 */
export function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [events, setEvents] = useState<TransactionEventDto[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureAmount, setCaptureAmount] = useState("");

  const load = useCallback(async () => {
    if (!id) {
      setState({ kind: "not_found" });
      return;
    }
    try {
      // Two independent reads — the events route does its own merchant-scoped
      // existence check, so neither depends on the other's result.
      const [txn, timeline] = await Promise.all([getTransaction(id), getTransactionEvents(id)]);
      setState({ kind: "loaded", txn });
      setEvents(timeline);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        setState({ kind: "not_found" });
      } else {
        setState({ kind: "error", message: describeError(err) });
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCapture(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!id) return;
    const trimmed = captureAmount.trim();
    // Left blank, `amountFils` is omitted entirely and capture.ts captures
    // everything still outstanding — its own documented default. Otherwise
    // the amount is BD with up to 3 decimals, like every other money input.
    let input: { amountFils?: number } = {};
    if (trimmed !== "") {
      const parsed = parseBhdInput(trimmed);
      if (!parsed.ok) {
        setActionError(parsed.message);
        return;
      }
      input = { amountFils: parsed.fils };
    }
    setSubmitting(true);
    setActionError(null);
    setNotice(null);
    try {
      // A fresh Idempotency-Key per click, including a retry after a decline —
      // same discipline as the checkout page's submit handler.
      await captureTransaction(id, input, crypto.randomUUID());
      setCaptureOpen(false);
      setCaptureAmount("");
      setNotice("Capture recorded.");
      // Refetch rather than patch: a capture wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  /** Only offered while status is authorized. */
  async function handleVoid(): Promise<void> {
    if (!id) return;
    if (!window.confirm("Void this authorization? The held funds are released and cannot be captured afterwards.")) {
      return;
    }
    setSubmitting(true);
    setActionError(null);
    setNotice(null);
    try {
      await voidTransaction(id);
      setNotice("Authorization voided.");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRefunded(result: RefundResponse): Promise<void> {
    setActionError(null);
    await load();
    setNotice(
      `Refunded ${bhd(result.amountFils)} to the cardholder. Total refunded on this payment: ${bhd(
        result.refundedTotalFils,
      )}.`,
    );
  }

  if (state.kind === "loading") {
    return (
      <p role="status" className="dash-muted">
        Loading transaction…
      </p>
    );
  }
  if (state.kind === "not_found") {
    return (
      <section>
        <h1>Transaction not found</h1>
        <p>
          No transaction with this id exists on your account.{" "}
          <Link to="/dashboard/transactions">Back to transactions</Link>
        </p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section>
        <h1>Transaction</h1>
        <p className="dash-error" role="alert">
          {state.message}
        </p>
        <button type="button" className="dash-button" onClick={() => void load()}>
          Try again
        </button>
      </section>
    );
  }

  const { txn } = state;
  const capturable = txn.status === "authorized" || txn.status === "partially_captured";
  const voidable = txn.status === "authorized";
  const refunds = refundState(txn);
  const remaining = refundableFils(txn);

  return (
    <section>
      <p>
        <Link to="/dashboard/transactions">&larr; Transactions</Link>
      </p>
      <h1>
        Transaction {txn.reference ? <span className="dash-muted">· {txn.reference}</span> : null}
      </h1>
      <p className="dash-muted">
        <code>{txn.id}</code>
      </p>

      <div aria-live="polite" role="status" className="dash-live">
        {notice ? <p className="dash-notice">{notice}</p> : null}
      </div>

      <dl className="dash-dl">
        <dt>Status</dt>
        <dd>
          <span className={`dash-status dash-status-${txn.status}`}>{humanize(txn.status)}</span>
        </dd>
        <dt>Authorized amount</dt>
        <dd className="dash-num">{bhd(txn.amountFils)}</dd>
        <dt>Captured amount</dt>
        <dd className="dash-num">{bhd(txn.capturedFils)}</dd>
        <dt>Refunded</dt>
        <dd className="dash-num">
          {refunds === "none" ? (
            <span className="dash-muted">Nothing refunded</span>
          ) : (
            <>
              {bhd(txn.refundedFils)}{" "}
              <span className="dash-refund-chip">{refunds === "full" ? "fully refunded" : "partially refunded"}</span>
            </>
          )}
        </dd>
        {txn.capturedFils > 0 ? (
          <>
            <dt>Still refundable</dt>
            <dd className="dash-num">{bhd(remaining)}</dd>
          </>
        ) : null}
        <dt>Currency</dt>
        <dd>{txn.currency}</dd>
        <dt>Reference</dt>
        <dd>{dash(txn.reference)}</dd>
        <dt>Acquirer reference</dt>
        <dd>
          <code>{txn.acquirerReference}</code>
        </dd>
        <dt>Occurred at</dt>
        <dd>{dateTime(txn.occurredAt)}</dd>
        <dt>Created at</dt>
        <dd>{dateTime(txn.createdAt)}</dd>
      </dl>

      {/* Capture and void are hidden from `support` as a UX choice — a support
          agent looks things up, they don't move money. Unlike the
          reconciliation page, this hide is NOT backed by a matching
          server-side role check: the API gates capture/void at "any
          authenticated merchant actor". Do not mistake a hidden button here for a security
          boundary. Refunds ARE role-gated server-side (owner/finance). */}
      <RequireRole allow={["owner", "finance"]}>
        <div className="dash-actions">
          <div role="alert" aria-live="assertive" className="dash-live">
            {actionError ? <p className="dash-error">{actionError}</p> : null}
          </div>

          {capturable ? (
            captureOpen ? (
              <form className="dash-form dash-form-inline" onSubmit={(e) => void handleCapture(e)}>
                <label>
                  Capture amount in BD (blank captures everything outstanding)
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="e.g. 4.750"
                    value={captureAmount}
                    onChange={(e) => setCaptureAmount(e.target.value)}
                  />
                </label>
                <button type="submit" className="dash-button" disabled={submitting}>
                  {submitting ? "Capturing…" : "Capture"}
                </button>
                <button
                  type="button"
                  className="dash-button"
                  disabled={submitting}
                  onClick={() => setCaptureOpen(false)}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <button type="button" className="dash-button" onClick={() => setCaptureOpen(true)}>
                Capture
              </button>
            )
          ) : null}

          {voidable ? (
            <button
              type="button"
              className="dash-button"
              disabled={submitting}
              onClick={() => void handleVoid()}
            >
              Void
            </button>
          ) : null}
        </div>
      </RequireRole>

      <RefundDrawer txn={txn} onRefunded={handleRefunded} />

      <h2>Event timeline</h2>
      <table className="dash-table">
        <caption className="dash-sr-only">Events for this transaction, oldest first</caption>
        <thead>
          <tr>
            <th scope="col">Occurred</th>
            <th scope="col">Event</th>
            <th scope="col" className="dash-num">
              Amount
            </th>
            <th scope="col">Actor</th>
          </tr>
        </thead>
        <tbody>
          {/* Already ordered oldest-first by the endpoint — never re-sorted
              here, so the page can't disagree with the API about history. */}
          {events.map((event) => {
            const refund = isRefundEvent(event.eventType);
            const refundId = typeof event.metadata?.refundId === "string" ? event.metadata.refundId : null;
            return (
              <tr key={event.id} className={refund ? "dash-row-refund" : undefined}>
                <td>{dateTime(event.occurredAt)}</td>
                <td>
                  {EVENT_LABELS[event.eventType] ?? humanize(event.eventType)}
                  {refundId ? (
                    <div className="dash-muted">
                      Refund <code>{refundId}</code>
                    </div>
                  ) : null}
                </td>
                <td className={`dash-num${refund ? " dash-amount-negative" : ""}`}>
                  {event.amountFils === null ? "—" : bhd(event.amountFils)}
                </td>
                <td>
                  {humanize(event.actorType)}
                  {event.actorId ? (
                    <div className="dash-muted">
                      <code>{event.actorId}</code>
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
          {events.length === 0 ? (
            <tr>
              <td colSpan={4}>No events recorded.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
