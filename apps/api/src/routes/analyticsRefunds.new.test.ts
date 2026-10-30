/** FP-300: GET /v1/analytics/volumes exposes refund count, refund gross and net per day. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("analyticsRefunds.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

test("volumes points carry refundCount, refundGrossFils and netGrossFils", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Analytics Refunds ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "a" });
  await pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ('reporting', 1, now())
     ON CONFLICT (consumer_name) DO UPDATE SET updated_at = now()`,
  );
  await pool.query(
    `INSERT INTO merchant_daily_volume
       (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count, refund_count, refund_gross_fils)
     VALUES ($1, '2026-01-10', 3, 9000, 0, 2, 2500), ($1, '2026-01-11', 1, 1000, 0, 0, 0)`,
    [merchantId],
  );

  const res = await app.inject({
    method: "GET",
    url: "/v1/analytics/volumes?from=2026-01-01&to=2026-02-01",
    headers: { authorization: `Bearer ${rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const points = (res.json() as { points: Array<Record<string, unknown>> }).points;
  assert.deepEqual(points, [
    {
      date: "2026-01-10",
      capturedCount: 3,
      capturedGrossFils: 9_000,
      voidedCount: 0,
      refundCount: 2,
      refundGrossFils: 2_500,
      netGrossFils: 6_500,
    },
    {
      date: "2026-01-11",
      capturedCount: 1,
      capturedGrossFils: 1_000,
      voidedCount: 0,
      refundCount: 0,
      refundGrossFils: 0,
      netGrossFils: 1_000,
    },
  ]);
});
