/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** Receivers only need to answer 2xx; nothing past this many bytes of the
 *  response is ever stored (response_body_excerpt keeps 2,000 chars). */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

export interface FetchTransportOptions {
  /** Response bytes read before the rest is discarded. Default 64 KiB. */
  maxResponseBodyBytes?: number;
}

/**
 * Reads at most `maxBytes` of the body, then cancels the stream, so a
 * receiver streaming gigabytes (or never ending the body) cannot exhaust the
 * API's memory. The caller's abort signal still bounds total time.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Real transport: Node's global fetch, used by index.ts's production wiring.
 *
 * - `redirect: "manual"`: a 3xx is returned as-is and the dispatcher records
 *   it as a failed (non-2xx) attempt. Following redirects would let a
 *   merchant-registered https URL bounce the signed POST to an internal
 *   http address (e.g. http://settlement:8091), bypassing the https-only
 *   check in create.ts (SSRF via open redirect).
 * - The body read is capped at MAX_RESPONSE_BODY_BYTES.
 * - The AbortController timeout stays armed until the body has been read,
 *   so a slow-drip body is bounded by timeoutMs too.
 */
export function createFetchTransport(options: FetchTransportOptions = {}): WebhookTransport {
  const maxBytes = options.maxResponseBodyBytes ?? MAX_RESPONSE_BODY_BYTES;
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        redirect: "manual",
      });
      const body = await readBodyCapped(response, maxBytes);
      return { statusCode: response.status, body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
