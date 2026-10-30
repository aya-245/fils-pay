import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { formatIsoDate } from "../lib/dateFormat.js";

/**
 * Uniform error -> HTTP response mapping. Every route across the API
 * should throw an `AppError` subclass; this is the single place that turns
 * one into `{ "error": "code", "message"?: "string" }`.
 */
// am: 500s log the full err incl. pg detail, might contain card ref? fine its server-side
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }

  const fastifyErr = err as FastifyError;

  // YA: 400 not 422 for schema validation errors — API.md section 2. correct
  if (fastifyErr.validation) {
    reply.code(400).send({ error: "validation_error", message: fastifyErr.message });
    return;
  }

  if (fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr.code === "FST_FILES_LIMIT") {
    reply.code(413).send({ error: "file_too_large", message: fastifyErr.message });
    return;
  }

  // Capacity / availability failures, not bugs: the pg pool had no free
  // connection within PG_POOL_CONNECTION_TIMEOUT_MS, the statement hit
  // statement_timeout, or Postgres is restarting / refusing connections.
  // A 503 + Retry-After tells the client to come back; a 500 would not.
  if (isTransientDbError(err)) {
    request.log.warn({ err: { message: err.message, code: (err as { code?: unknown }).code } }, "db unavailable");
    reply.code(503).header("retry-after", "1").send({ error: "overloaded", message: "database busy; retry" });
    return;
  }

  request.log.error({ err, occurredOn: formatIsoDate(new Date()) }, "unhandled error");
  reply.code(500).send({ error: "internal_error" });
}

// 57014 query_canceled (statement_timeout), 57P01..57P03 admin/crash
// shutdown & cannot_connect_now, 53300 too_many_connections.
const TRANSIENT_PG_CODES = new Set(["57014", "57P01", "57P02", "57P03", "53300"]);
// EAI_AGAIN/ENOTFOUND: the postgres container is restarting and its DNS name is briefly gone.
const TRANSIENT_NET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND"]);

function isTransientDbError(err: Error): boolean {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && (TRANSIENT_PG_CODES.has(code) || TRANSIENT_NET_CODES.has(code))) return true;
  const msg = err.message ?? "";
  return (
    msg === "timeout exceeded when trying to connect" || // pg-pool checkout timeout
    msg.startsWith("Connection terminated") || // pg: server went away / connect timeout
    msg === "Client has encountered a connection error and is not queryable"
  );
}
