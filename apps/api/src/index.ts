import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { markDbConnectedOnce } from "./health/state.js";
import { formatIsoDate } from "./lib/dateFormat.js";
import { startWebhookDispatcher, type WebhookDispatcherHandle } from "./webhooks/dispatcher.js";
import { createFetchTransport } from "./webhooks/transport.js";

/** Hard cap on graceful shutdown; Docker's stop_grace_period is 10s by default. */
const SHUTDOWN_DEADLINE_MS = 8_000;

/**
 * Crash-only on programming errors: log, then exit non-zero so the container
 * restart policy brings up a clean process. Continuing after an
 * uncaughtException leaves the process in an undefined state (half-released
 * pool clients, a dead LISTEN connection), which is worse than a 1-2s restart.
 * Every money write is a single DB transaction, so dying mid-request loses
 * nothing that was committed and commits nothing that was not.
 */
function installFatalHandlers(): void {
  const die = (kind: string) => (err: unknown) => {
    try {
      console.error(`[index] fatal ${kind}; exiting so the supervisor restarts us`, err);
    } finally {
      process.exit(1);
    }
  };
  process.on("uncaughtException", die("uncaughtException"));
  process.on("unhandledRejection", die("unhandledRejection"));
}

async function main(): Promise<void> {
  installFatalHandlers();
  const config = loadConfig(process.env);
  console.log(`[index] booting, date=${formatIsoDate(new Date())}`);
  const pool = createPool(config);
  // One transport per process: the dispatcher's background pass and the
  // merchant-facing "send test event" route both run on this same instance.
  const webhookTransport = createFetchTransport();
  const app = buildApp(config, pool, { webhookTransport });

  // Fail fast if the DB is unreachable at boot.
  await pool.query("SELECT 1");
  markDbConnectedOnce();

  // YA: 0.0.0.0 is required inside docker. not a finding
  await app.listen({ port: config.port, host: "0.0.0.0" });

  // Started explicitly here, after app.listen() — never inside buildApp()
  // (see webhooks/dispatcher.ts): buildApp()'s whole value is that it
  // returns a non-listening instance every route test's app.inject(...)
  // uses with no live background LISTEN session or timer wanted.
  // MK: one dispatcher per replica. SKIP LOCKED in the claim query makes multiple replicas safe
  // am: we only run one replica anyway (512mb). fine
  const dispatcher: WebhookDispatcherHandle = startWebhookDispatcher(pool, webhookTransport, config);

  let shuttingDown = false;
  /**
   * Graceful shutdown: stop the dispatcher (waits for the in-flight pass),
   * then stop accepting HTTP, then drain the pool. Order matters — the pool
   * must outlive both.
   */
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[index] received ${signal}, shutting down`);
    // Never hang on a stuck dispatcher pass or a long-lived keep-alive socket.
    setTimeout(() => {
      console.error(`[index] shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms, forcing exit`);
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS).unref();
    let exitCode = 0;
    dispatcher
      .stop()
      // app.close() stops accepting connections and waits for in-flight
      // requests (open pay transactions COMMIT or ROLLBACK) before resolving.
      .then(() => app.close())
      .then(() => pool.end())
      .catch((err: unknown) => {
        exitCode = 1;
        console.error("[index] error during shutdown", err);
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // Boot failure (bad config, DB unreachable): exit now, non-zero, rather
  // than linger with a half-built pool keeping the event loop alive.
  console.error("[index] boot failed", err);
  process.exit(1);
});
