import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listTransactions } from "../../api/transactions.js";
import { describeError } from "../../api/client.js";
import { Pagination } from "../../components/Pagination.js";
import { bhd, dash, dateTime, dayStartIso, humanize } from "../../format.js";
import { refundState } from "./refundable.js";
import { classNames, pluralize, truncateMiddle } from "../../utils/helpers.js";
import type { TransactionDto, TransactionStatus } from "../../types.js";

const STATUSES: TransactionStatus[] = [
  "authorized",
  "captured",
  "partially_captured",
  "voided",
  "partially_refunded",
  "refunded",
  "chargeback",
];

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * `GET /v1/transactions`. Every control here is a real server-side
 * query param — nothing fetches an unfiltered page and narrows it in the
 * browser, which would both lie about the result count and break pagination.
 */
// YA: from/to are UTC day starts, see dayStartIso
export function TransactionListPage() {
  const [statuses, setStatuses] = useState<TransactionStatus[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const [transactions, setTransactions] = useState<TransactionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce only the text box — the checkbox/date controls fire immediately,
  // since those are discrete choices, not a stream of keystrokes.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listTransactions({
          status: statuses.length > 0 ? statuses : undefined,
          from: dayStartIso(from),
          to: dayStartIso(to),
          search: search || undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        setTransactions((previous) =>
          cursor ? [...previous, ...result.transactions] : result.transactions,
        );
        setNextCursor(result.nextCursor);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [statuses, from, to, search],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: TransactionStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  return (
    <section>
      <h1>Transactions</h1>

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

      <fieldset className="dash-filters">
        <legend>Filter</legend>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {/* Exclusive, because the endpoint's own predicate is
              `occurred_at < to` — labelled rather than quietly shifted by a
              day here, which would make this page and the API disagree about
              what a filter means. */}
          To (exclusive)
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Search
          <input
            type="search"
            placeholder="Reference, acquirer reference, or transaction id"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </label>
      </fieldset>

      <div role="alert" aria-live="assertive" className="dash-live">
        {error ? (
          <p className="dash-error">
            {error}{" "}
            <button type="button" className="dash-button" onClick={() => void load(null)}>
              Try again
            </button>
          </p>
        ) : null}
      </div>

      <p role="status" aria-live="polite" className="dash-muted">
        {loading ? "Loading transactions…" : `${pluralize(transactions.length, "transaction")} shown`}
      </p>

      <table className="dash-table" aria-busy={loading}>
        <thead>
          <tr>
            <th scope="col">Occurred</th>
            <th scope="col">Reference</th>
            <th scope="col">Status</th>
            <th scope="col" className="dash-num">Authorized</th>
            <th scope="col" className="dash-num">Captured</th>
            <th scope="col" className="dash-num">Refunded</th>
            <th scope="col">Acquirer reference</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((txn) => {
            const refunds = refundState(txn);
            return (
              <tr key={txn.id}>
                <td>
                  <Link to={`/dashboard/transactions/${txn.id}`}>{dateTime(txn.occurredAt)}</Link>
                </td>
                <td>{dash(txn.reference)}</td>
                <td>
                  <span className={classNames("dash-status", `dash-status-${txn.status}`)}>
                    {humanize(txn.status)}
                  </span>
                </td>
                <td className="dash-num">{bhd(txn.amountFils)}</td>
                <td className="dash-num">{bhd(txn.capturedFils)}</td>
                <td className="dash-num">
                  {refunds === "none" ? (
                    <span className="dash-muted" aria-label="Nothing refunded">—</span>
                  ) : (
                    <span className="dash-amount-negative">
                      {bhd(txn.refundedFils)}
                      {refunds === "full" ? <span className="dash-refund-chip">full</span> : null}
                    </span>
                  )}
                </td>
                <td>
                  <code>{truncateMiddle(txn.acquirerReference, 20)}</code>
                </td>
              </tr>
            );
          })}
          {transactions.length === 0 && !loading && !error ? (
            <tr>
              <td colSpan={7} className="dash-empty">
                No transactions match these filters.
                {statuses.length > 0 || from || to || search ? " Clear a filter to see more." : ""}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <Pagination nextCursor={nextCursor} loading={loading} onLoadMore={() => void load(nextCursor)} />
    </section>
  );
}
