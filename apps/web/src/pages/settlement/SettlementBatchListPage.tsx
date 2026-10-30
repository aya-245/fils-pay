import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getSettlementSummary, listSettlementBatches } from "../../api/settlement.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dateTime, humanize } from "../../format.js";
import type { SettlementBatchDto, SettlementBatchStatus, SettlementSummaryDto } from "../../types.js";
import { bahrainToday, batchBreakdown, nextDay } from "./batchBreakdown.js";

const STATUSES: SettlementBatchStatus[] = ["open", "closed", "paid"];
const PAGE_SIZE = 25;

/**
 * `GET /v1/settlement/batches` — `requireMerchantAuth` with no role
 * restriction — a batch list is not as sensitive as the reconciliation
 * report.
 *
 * `from`/`to` bound `batch_date`, a plain DATE column, so the raw YYYY-MM-DD
 * value from the date input goes through unchanged — no instant conversion,
 * because there is no timezone in the column to convert against.
 *
 * Since FP-300 a batch nets refunds out of its payout, so the table shows
 * the "Refunds netted" term that makes gross − fee − refunds = net add up,
 * and an owner/finance period summary (captures vs refunds) sits on top.
 */
export function SettlementBatchListPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<SettlementBatchStatus[]>([]);
  const [batches, setBatches] = useState<SettlementBatchDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listSettlementBatches({
          from: from || undefined,
          to: to || undefined,
          status: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setBatches((previous) => (cursor ? [...previous, ...result.batches] : result.batches));
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [from, to, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: SettlementBatchStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section>
      <h1>Settlement batches</h1>

      <RequireRole allow={["owner", "finance"]}>
        <SettlementSummaryCard />
      </RequireRole>

      <fieldset className="dash-filters">
        <legend>Batch date</legend>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To (exclusive)
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="dash-filters">
        <legend>Status</legend>
        {STATUSES.map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {humanize(status)}
          </label>
        ))}
      </fieldset>

      <div role="alert" aria-live="assertive" className="dash-live">
        {error ? <p className="dash-error">{error}</p> : null}
      </div>

      <table className="dash-table" aria-busy={loading}>
        <thead>
          <tr>
            <th scope="col">Batch date</th>
            <th scope="col">Status</th>
            <th scope="col" className="dash-num">Gross</th>
            <th scope="col" className="dash-num">Fee</th>
            <th scope="col" className="dash-num" title="Refunds minus the MDR fee they reverse">
              Refunds netted
            </th>
            <th scope="col" className="dash-num">Net payout</th>
            <th scope="col">Closed</th>
            <th scope="col">Paid</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const { refundsNettedFils } = batchBreakdown(batch);
            return (
              <tr key={batch.id}>
                <td>
                  <Link to={`/dashboard/settlement/${batch.id}`}>{batch.batchDate}</Link>
                </td>
                <td>
                  <span className={`dash-status dash-status-${batch.status}`}>{humanize(batch.status)}</span>
                </td>
                <td className="dash-num">{bhd(batch.grossFils)}</td>
                <td className="dash-num">{bhd(batch.feeFils)}</td>
                <td className={`dash-num${refundsNettedFils !== 0 ? " dash-amount-negative" : ""}`}>
                  {refundsNettedFils === 0 ? <span className="dash-muted">—</span> : bhd(-refundsNettedFils)}
                </td>
                <td className="dash-num">
                  <strong>{bhd(batch.netPayoutFils)}</strong>
                </td>
                <td>{dateTime(batch.closedAt)}</td>
                <td>{dateTime(batch.paidAt)}</td>
              </tr>
            );
          })}
          {batches.length === 0 && !loading ? (
            <tr>
              <td colSpan={8} className="dash-empty">
                No settlement batches match these filters.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="dash-muted dash-hint">
        Net payout = gross − fee − refunds netted (each refund minus the share of MDR fee it
        reverses). Refunds are netted in the first batch closed after they succeed.
      </p>

      {loading ? (
        <p role="status" className="dash-muted">
          Loading…
        </p>
      ) : null}

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}

/** Captures vs refunds for a business-date window (default: today, Bahrain). */
function SettlementSummaryCard() {
  const [day, setDay] = useState(() => bahrainToday());
  const [summary, setSummary] = useState<SettlementSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!day) return;
    let cancelled = false;
    setError(null);
    getSettlementSummary({ from: day, to: nextDay(day) })
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [day]);

  return (
    <section className="dash-summary" aria-labelledby="settlement-summary-title">
      <div className="dash-summary-head">
        <h2 id="settlement-summary-title">Day summary</h2>
        <label>
          Business date (Bahrain){" "}
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
      </div>
      {error ? (
        <p className="dash-error" role="alert">
          {error}
        </p>
      ) : summary ? (
        <dl className="dash-summary-grid">
          <div>
            <dt>Captured</dt>
            <dd>{bhd(summary.totalCapturedFils)}</dd>
            <dd className="dash-muted">
              {summary.transactionCount} transaction{summary.transactionCount === 1 ? "" : "s"}
            </dd>
          </div>
          <div>
            <dt>Refunded</dt>
            <dd className={summary.totalRefundedFils > 0 ? "dash-amount-negative" : undefined}>
              {bhd(-summary.totalRefundedFils)}
            </dd>
            <dd className="dash-muted">
              {summary.refundCount} refund{summary.refundCount === 1 ? "" : "s"}
            </dd>
          </div>
          <div>
            <dt>Net sales (before fees)</dt>
            <dd>
              <strong>{bhd(summary.netFils)}</strong>
            </dd>
            <dd className="dash-muted">captured − refunded</dd>
          </div>
        </dl>
      ) : (
        <p role="status" className="dash-muted">
          Loading summary…
        </p>
      )}
    </section>
  );
}
