import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
    // FP-300: appended last so existing positional consumers keep working.
    formatBhd(toFils(Number(row.refunded_fils ?? 0))),
  ].join(",");
}

const EXPORT_HEADER = "id,status,amount_bhd,captured_bhd,reference,occurred_at,refunded_bhd\n";
const PAGE_SIZE = 1000;

/**
 * Keyset-paginated CSV generator: one page in memory at a time. The cursor
 * is (occurred_at, id) with occurred_at carried as text so Postgres's
 * microsecond precision is never truncated through a JS Date (which would
 * skip or repeat rows) and rows sharing a timestamp are never dropped.
 */
export async function* iterateTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): AsyncGenerator<string> {
  yield EXPORT_HEADER;
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursorAt: string | null = null;
  let cursorId: string | null = null;

  for (;;) {
    const result: { rows: Array<TransactionRow & { occurred_at_text: string }> } = await pool.query(
      `SELECT t.*, t.occurred_at::text AS occurred_at_text FROM transactions t
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5::timestamptz, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [filters.merchantId, filters.from ?? null, filters.to ?? null, statusArray, cursorAt, cursorId, PAGE_SIZE],
    );
    if (result.rows.length > 0) yield result.rows.map((r) => toCsvRow(r) + "\n").join("");
    if (result.rows.length < PAGE_SIZE) return;
    const last = result.rows[result.rows.length - 1]!;
    cursorAt = last.occurred_at_text;
    cursorId = last.id;
  }
}

/** Cursor-paginated export for large date ranges. */
export async function streamTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
  write: (chunk: string) => void,
): Promise<void> {
  for await (const chunk of iterateTransactionsExportCsv(pool, filters)) write(chunk);
}

/**
 * Builds the whole CSV body in memory. Only for small, bounded exports
 * (tests); the HTTP route streams via {@link iterateTransactionsExportCsv}.
 */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  let out = "";
  for await (const chunk of iterateTransactionsExportCsv(pool, filters)) out += chunk;
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}
