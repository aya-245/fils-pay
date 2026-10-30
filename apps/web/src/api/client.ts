import type { ApiErrorBody } from "../types.js";
import { messageForApiError, messageForNetworkError } from "./errorMessages.js";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

/** Mirrors apps/api's own uniform `{ error, message? }` body
 *  (lib/errors.ts / plugins/errorHandler.ts) — one error shape end to
 *  end, not reinvented client-side. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly body: ApiErrorBody;

  constructor(statusCode: number, body: ApiErrorBody) {
    // Refund validation failures answer `{ ok: false, code, refundableFils }`
    // (payments/refundValidation.ts) rather than `{ error }`, so fall back to
    // `code` — otherwise the UI had nothing to switch on and showed "undefined".
    const code = body.error ?? (typeof body.code === "string" ? body.code : "unknown_error");
    super(body.message ?? code);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.body = body;
  }
}

/**
 * `credentials: "include"`: the dashboard is cookie-authenticated
 * (`fp_sid`), and apps/web (5173) is not the API origin (3000), so the
 * session cookie only rides along on a request that asks for it. The public
 * checkout flow is unaffected — /pay/:token reads no cookie server-side, so
 * sending one that doesn't exist is a no-op there.
 *
 * `Content-Type: application/json` is sent only when there actually is a
 * body: logout, void and replay take none, and Fastify rejects a request
 * that declares a JSON content type while carrying an empty body
 * (`FST_ERR_CTP_EMPTY_JSON_BODY`). Same fix apps/admin's client.ts already
 * carries, for the same reason.
 */
// FH: credentials include needs allow-credentials CORS on the api. works locally
// this leaks the session cookie to whatever VITE_API_BASE_URL is — am
// — MK: CORS is locked to the two origins in config. fine
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: hasBody
      ? { "Content-Type": "application/json", ...init?.headers }
      : { ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? { error: "unknown_error" });
  }
  return body as T;
}

/** For the routes that answer `204 No Content` (logout, cancel payment
 *  link, delete webhook endpoint) — makes "there is deliberately no body
 *  here" explicit at the call site. */
/**
 * For 204 responses.
 */
export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  await request<unknown>(path, init);
}

/** Human-readable text for anything thrown by `request` — used by every
 *  dashboard page's error banner so a failure (including a server-side
 *  `403` from a role gate) is always shown, never silently swallowed. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return messageForApiError(err.statusCode, err.code, err.body);
  }
  if (err instanceof TypeError) return messageForNetworkError();
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
