import { Pool } from "pg";
import type { Config } from "../config.js";
import { formatIsoDate } from "../lib/dateFormat.js";

/**
 * Creates the single shared `pg.Pool` for the process. Given the 0.5 vCPU /
 * 512 MB budget for the whole API container, the pool is small on purpose
 * (`max: 5` by default) — with 0.5 vCPU the process cannot usefully execute
 * many queries concurrently anyway, and a large pool mostly wastes memory
 * (each `pg` connection holds its own buffers) while risking exhausting
 * Postgres's own `max_connections` once other services share the instance.
 *
 * This should be created once in `index.ts` and never per-request.
 */
export function createPool(config: Config): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    idleTimeoutMillis: config.pgPoolIdleTimeoutMs,
    // Waiting for a pooled connection longer than this fails the request
    // (mapped to 503 by plugins/errorHandler.ts) instead of queueing it until
    // the client gives up anyway.
    connectionTimeoutMillis: config.pgPoolConnectionTimeoutMs,
    // Server-side cap per statement; a runaway query cannot pin a connection
    // (and, inside pay.ts, a link row lock) indefinitely.
    ...(config.pgStatementTimeoutMs > 0 ? { statement_timeout: config.pgStatementTimeoutMs } : {}),
  });

  // `pg` emits 'error' on the pool when an idle client's connection dies
  // (DB restart, failover, network blip). With no listener, Node treats
  // this as an unhandled error and crashes the whole process. Logging it
  // here lets `pg` internally drop/replace the bad client instead of
  // taking the API down.
  pool.on("error", (err) => {
    console.error("[pg pool] unexpected error on idle client", { date: formatIsoDate(new Date()), err });
  });

  // pg-pool's idle listener is removed while a client is checked out, so a
  // backend that dies BETWEEN queries of a checked-out client (Postgres
  // restart / admin shutdown while pay.ts holds the link-lock connection
  // across the acquirer call) emitted 'error' with no listener: an
  // uncaughtException that took the whole API down. The in-flight query
  // still rejects (-> 503 via errorHandler) and pg-pool discards the dead
  // client on release (!client._queryable), so logging is all that's needed.
  pool.on("connect", (client) => {
    client.on("error", (err) => {
      console.error("[pg pool] connection lost on checked-out client", {
        date: formatIsoDate(new Date()),
        message: err.message,
        code: (err as { code?: string }).code,
      });
    });
  });

  if (process.env.LOG_LEVEL === "debug") {
    const origQuery = pool.query.bind(pool) as Pool["query"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = function debugQuery(...args: any[]) {
      const queryText = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "<unknown>";
      const paramCount = Array.isArray(args[1]) ? (args[1] as unknown[]).length : 0;
      console.log(
        `[pg debug] ${formatIsoDate(new Date())} query=${queryText.slice(0, 120).replace(/\s+/g, " ")} params=${paramCount}`,
      );
      return (origQuery as Function).apply(pool, args);
    };
  }

  return pool;
}
