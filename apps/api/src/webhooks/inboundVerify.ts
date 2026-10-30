import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifyAcquirerCallbackFailureReason =
  | "malformed_header"
  | "signature_mismatch"
  | "timestamp_out_of_tolerance";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Verifies the acquirer callback signature. The signature is ALWAYS required
 * (there is no unsigned path), an empty secret never verifies, and the
 * timestamp must be within tolerance so a captured callback cannot be
 * replayed later. `body` should be the exact raw request bytes as a string;
 * a parsed object is accepted for tests and is re-serialised.
 */
export function verifyAcquirerCallbackSignature(
  body: unknown,
  header: string | undefined,
  secret: string,
  options?: { toleranceSeconds?: number; now?: number },
): VerifyAcquirerCallbackResult {
  if (!secret || !header) return { valid: false, reason: "malformed_header" };

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${raw}`).digest("hex");

  if (!constantTimeEquals(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options?.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > (options?.toleranceSeconds ?? 300)) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}
