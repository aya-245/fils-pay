#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released just sits in
 * the table past its expires_at forever — nothing else in the platform
 * expires a holds row (authorize.ts inserts one, capture.ts/void.ts
 * release one; nothing sweeps one). Run once a night from cron/the host's
 * own scheduler.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

/** Single atomic statement: flips holds that outlived their authorization
 *  window from 'active' to 'expired'. Holds are never deleted (HANDOVER,
 *  0005_holds.sql); a hold captured/released between a SELECT and a write
 *  can not be touched because the status guard is evaluated in the UPDATE. */
export function buildExpireHoldsUpdate(): { text: string; values: unknown[] } {
  return {
    text: `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now() RETURNING id`,
    values: [],
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { text, values } = buildExpireHoldsUpdate();
    const result = await client.query(text, values);
    console.log(`expire_holds: marked ${result.rowCount ?? 0} abandoned hold(s) expired`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
