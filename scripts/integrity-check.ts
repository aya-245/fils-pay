#!/usr/bin/env -S npx tsx
/**
 * Post-incident / post-load-test data integrity check. Read-only.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/integrity-check.ts [--paid-log <file>]... [--strict-cache]
 *
 * --paid-log  k6 output of ops/loadtest/checkout.js run with LOG_PAID=1. Every
 *             "PAID <transactionId> <token>" line is a checkout the CLIENT was
 *             told succeeded; each must be a committed, captured transaction
 *             that its payment link points to (no lost acknowledged writes).
 * --strict-cache  merchant_balances.cached_payable_fils must equal the ledger.
 *             Off by default: that cache is refreshed by apps/settlement
 *             (refresh/rebuild), not on every capture, so drift between
 *             refreshes is expected; it is reported as WARN.
 *
 * Exit code 1 iff any FAIL. Never writes.
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";

type Level = "PASS" | "WARN" | "FAIL";
interface Result {
  level: Level;
  name: string;
  detail: string;
}

/** Each query returns violating rows; zero rows = PASS. */
const CHECKS: Array<{ name: string; level: Level; describe: string; sql: string }> = [
  {
    name: "ledger_groups_balance",
    level: "FAIL",
    describe: "every ledger entry group nets to 0 (debits = credits)",
    sql: `SELECT entry_group_id,
                 SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END) AS net
            FROM ledger_entries GROUP BY entry_group_id
          HAVING SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END) <> 0`,
  },
  {
    name: "link_single_capture",
    level: "FAIL",
    describe: "no payment link has more than one captured transaction (no double charge)",
    sql: `SELECT pl.id, pl.status, array_agg(DISTINCT ik.resource_id) AS captured_txns
            FROM payment_links pl
            JOIN idempotency_keys ik
              ON ik.merchant_id = pl.merchant_id AND ik.endpoint = 'transactions.capture'
             AND ik.key LIKE 'paylink:%' AND split_part(ik.key, ':', 2) = pl.id::text
             AND ik.status = 'completed' AND ik.response_status_code = 200 AND ik.resource_id IS NOT NULL
           GROUP BY pl.id, pl.status
          HAVING COUNT(DISTINCT ik.resource_id) > 1`,
  },
  {
    name: "paid_link_points_at_its_capture",
    level: "FAIL",
    describe: "a paid link's transaction_id is the transaction its pay flow captured",
    sql: `SELECT pl.id, pl.transaction_id, ik.resource_id
            FROM payment_links pl
            JOIN idempotency_keys ik
              ON ik.merchant_id = pl.merchant_id AND ik.endpoint = 'transactions.capture'
             AND ik.key LIKE 'paylink:%' AND split_part(ik.key, ':', 2) = pl.id::text
             AND ik.status = 'completed' AND ik.response_status_code = 200 AND ik.resource_id IS NOT NULL
           WHERE pl.status = 'paid' AND pl.transaction_id <> ik.resource_id`,
  },
  {
    name: "paid_link_transaction_captured",
    level: "FAIL",
    describe: "every paid link's transaction exists, belongs to the merchant and captured the link amount",
    sql: `SELECT pl.id, pl.amount_fils, t.id AS txn, t.status, t.captured_fils, t.merchant_id = pl.merchant_id AS same_merchant
            FROM payment_links pl
            LEFT JOIN transactions t ON t.id = pl.transaction_id
           WHERE pl.status = 'paid'
             AND (t.id IS NULL OR t.merchant_id <> pl.merchant_id OR t.captured_fils <> pl.amount_fils
                  OR t.status NOT IN ('captured', 'refunded', 'chargeback'))`,
  },
  {
    name: "transaction_single_capture_journal",
    level: "FAIL",
    describe: "a fully captured pay-link transaction has exactly one gross capture journal",
    sql: `SELECT t.id, COUNT(DISTINCT le.entry_group_id) AS capture_groups
            FROM payment_links pl
            JOIN transactions t ON t.id = pl.transaction_id
            LEFT JOIN ledger_entries le
              ON le.transaction_id = t.id AND le.account_id = 'merchant_payable'
             AND le.direction = 'credit' AND le.description = 'capture: gross'
           WHERE pl.status = 'paid'
           GROUP BY t.id
          HAVING COUNT(DISTINCT le.entry_group_id) <> 1`,
  },
  {
    name: "refunded_le_captured",
    level: "FAIL",
    describe: "transactions.refunded_fils <= captured_fils",
    sql: `SELECT id, captured_fils, refunded_fils FROM transactions WHERE refunded_fils > captured_fils`,
  },
  {
    name: "captured_but_link_unpaid",
    level: "WARN",
    describe: "captures whose link was not finalized (crash between capture and finalize; pay.ts heals on the next attempt)",
    sql: `SELECT pl.id, pl.status, ik.resource_id
            FROM payment_links pl
            JOIN idempotency_keys ik
              ON ik.merchant_id = pl.merchant_id AND ik.endpoint = 'transactions.capture'
             AND ik.key LIKE 'paylink:%' AND split_part(ik.key, ':', 2) = pl.id::text
             AND ik.status = 'completed' AND ik.response_status_code = 200 AND ik.resource_id IS NOT NULL
           WHERE pl.status <> 'paid'`,
  },
];

const CACHE_SQL = `
  WITH ledger AS (
    SELECT merchant_id,
           SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS payable
      FROM ledger_entries WHERE account_id = 'merchant_payable' GROUP BY merchant_id
  )
  SELECT COALESCE(l.merchant_id, b.merchant_id) AS merchant_id,
         COALESCE(l.payable, 0) AS ledger_payable, COALESCE(b.cached_payable_fils, 0) AS cached
    FROM ledger l FULL JOIN merchant_balances b ON b.merchant_id = l.merchant_id
   WHERE COALESCE(l.payable, 0) <> COALESCE(b.cached_payable_fils, 0)`;

function parseArgs(argv: string[]): { paidLogs: string[]; strictCache: boolean } {
  const paidLogs: string[] = [];
  let strictCache = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--paid-log") {
      const v = argv[++i];
      if (!v) throw new Error("--paid-log needs a file");
      paidLogs.push(v);
    } else if (argv[i] === "--strict-cache") strictCache = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { paidLogs, strictCache };
}

const UUID_RE = /PAID ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) (\S+?)["\s]/g;

export function parsePaidLog(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(UUID_RE)) out.set(m[1]!, m[2]!);
  return out;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("integrity-check: DATABASE_URL is not set");
  const { paidLogs, strictCache } = parseArgs(process.argv.slice(2));

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const results: Result[] = [];
  try {
    // One snapshot for every check, so concurrent traffic cannot make them disagree.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const totals = await client.query<{ links_paid: string; txns_captured: string; ledger_rows: string }>(
      `SELECT (SELECT count(*) FROM payment_links WHERE status = 'paid') AS links_paid,
              (SELECT count(*) FROM transactions WHERE captured_fils > 0) AS txns_captured,
              (SELECT count(*) FROM ledger_entries) AS ledger_rows`,
    );
    const t = totals.rows[0]!;
    console.log(`integrity-check: ${t.links_paid} paid links, ${t.txns_captured} captured transactions, ${t.ledger_rows} ledger rows`);

    for (const c of CHECKS) {
      const r = await client.query(c.sql);
      results.push({
        level: r.rowCount === 0 ? "PASS" : c.level,
        name: c.name,
        detail: r.rowCount === 0 ? c.describe : `${r.rowCount} violation(s): ${JSON.stringify(r.rows.slice(0, 3))}`,
      });
    }

    const drift = await client.query(CACHE_SQL);
    results.push({
      level: drift.rowCount === 0 ? "PASS" : strictCache ? "FAIL" : "WARN",
      name: "merchant_balances_cache",
      detail:
        drift.rowCount === 0
          ? "merchant_balances.cached_payable_fils equals ledger merchant_payable for every merchant"
          : `${drift.rowCount} merchant(s) differ (cache refreshed by settlement, not per capture): ${JSON.stringify(drift.rows.slice(0, 3))}`,
    });

    if (paidLogs.length > 0) {
      const paid = new Map<string, string>();
      for (const f of paidLogs) for (const [k, v] of parsePaidLog(readFileSync(f, "utf8"))) paid.set(k, v);
      const ids = [...paid.keys()];
      const r = await client.query<{ id: string }>(
        `SELECT t.id FROM transactions t
           JOIN payment_links pl ON pl.transaction_id = t.id AND pl.status = 'paid'
          WHERE t.id = ANY($1::uuid[]) AND t.captured_fils > 0 AND pl.token = ANY($2::text[])`,
        [ids, [...paid.values()]],
      );
      const found = new Set(r.rows.map((row) => row.id));
      const missing = ids.filter((id) => !found.has(id));
      results.push({
        level: missing.length === 0 ? "PASS" : "FAIL",
        name: "acknowledged_pays_committed",
        detail:
          missing.length === 0
            ? `all ${ids.length} pays the client saw as 200 paid are committed, captured, and their link is paid`
            : `${missing.length} of ${ids.length} acknowledged pays missing: ${missing.slice(0, 5).join(", ")}`,
      });
    }
    await client.query("COMMIT");
  } finally {
    await client.end();
  }

  for (const r of results) console.log(`${r.level.padEnd(4)}  ${r.name.padEnd(36)} ${r.detail}`);
  const failed = results.filter((r) => r.level === "FAIL").length;
  console.log(failed === 0 ? "integrity-check: OK" : `integrity-check: ${failed} FAILED`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
