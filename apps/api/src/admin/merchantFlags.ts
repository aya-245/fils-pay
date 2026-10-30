import type { PoolClient } from "pg";

/**
 * Previously cleared `test_mode` whenever a merchant had scanned
 * transactions and no open authorizations -- but a sandbox merchant's whole
 * purpose is to have (test) transactions, and the open-authorization count
 * was always 0, so a status recompute silently promoted every sandbox
 * merchant to live. Going live is an explicit, separately audited action;
 * a recompute never changes merchant flags.
 */
export async function reconcileSandboxFlag(
  _client: PoolClient,
  _merchantId: string,
  _summary: { scanned: number; openAuthorizations: number },
): Promise<string[]> {
  return [];
}
