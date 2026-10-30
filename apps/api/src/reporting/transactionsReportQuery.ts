import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/**
 * Report predicate. `merchantId` is always overwritten by the route with the
 * authenticated merchant before this reaches runTransactionsReport, so a
 * value supplied in the saved filter body is ignored.
 */
export interface TransactionReportFilter {
  merchantId: string;
  status?: string;
  from?: string;
  to?: string;
}

/** Money is pre-formatted as BD strings with 3 decimals (formatBhd), unlike the rest of the API which returns fils. */
export interface TransactionReportRow {
  id: string;
  merchantId: string;
  status: string;
  amountBhd: string;
  capturedBhd: string;
  reference: string | null;
  occurredAt: string;
}

interface TransactionReportQueryRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  reference: string | null;
  occurred_at: Date;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalises a saved-filter bound to an ISO instant. A bare date is a
 * Bahrain business day boundary (ADR-0003, daily windows: fixed UTC+3), not
 * a session-timezone midnight. Anything unparseable is rejected rather than
 * passed to the database.
 */
function boundToInstant(name: string, raw: unknown): string {
  if (typeof raw !== "string") throw new RangeError(`transactions report: ${name} must be a string`);
  const text = DATE_ONLY.test(raw) ? `${raw}T00:00:00+03:00` : raw;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new RangeError(`transactions report: invalid ${name} "${raw}"`);
  return new Date(ms).toISOString();
}

export async function runTransactionsReport(
  pool: Pool,
  filter: TransactionReportFilter,
): Promise<TransactionReportRow[]> {
  const params: unknown[] = [filter.merchantId];
  const conditions: string[] = ["merchant_id = $1"];
  if (filter.status) {
    if (typeof filter.status !== "string") throw new RangeError("transactions report: status must be a string");
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filter.from) {
    params.push(boundToInstant("from", filter.from));
    conditions.push(`occurred_at >= $${params.length}::timestamptz`);
  }
  if (filter.to) {
    params.push(boundToInstant("to", filter.to));
    conditions.push(`occurred_at < $${params.length}::timestamptz`);
  }

  const result = await pool.query<TransactionReportQueryRow>(
    `SELECT id, merchant_id, status, amount_fils, captured_fils, reference, occurred_at
       FROM transactions
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC
      LIMIT 500`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    status: row.status,
    amountBhd: formatBhd(toFils(Number(row.amount_fils))),
    capturedBhd: formatBhd(toFils(Number(row.captured_fils))),
    reference: row.reference,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
