import type { FastifyInstance, FastifyRequest } from "fastify";
import { BadRequestError, UnauthorizedError } from "../lib/errors.js";
import { verifyAcquirerCallbackSignature } from "../webhooks/inboundVerify.js";
import { applyAcquirerCallback, withCallbackRetry, type AcquirerCallbackInput } from "../acquirer/callbacks.js";

// header name confirmed with the acquirer's integration guide v3.2 — am
const ACQUIRER_SIGNATURE_HEADER = "acquirer-callback-signature";

/**
 * Body of a fraud_review.completed callback. `outcome` is validated against
 * the AcquirerCallbackInput union ("approved" | "rejected") before it is
 * applied; any other value is a 400.
 */
interface AcquirerCallbackBody {
  callbackId?: string;
  type?: string;
  transactionId?: string;
  occurredAt?: string;
  outcome?: string;
  note?: string;
}

/** Header format: "t=<unix seconds>,v1=<hex hmac>". A repeated header uses the first value. */
function getSignatureHeader(request: FastifyRequest): string | undefined {
  const header = request.headers[ACQUIRER_SIGNATURE_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * The acquirer's own async callback surface: the
 * acquirer simulator's authorize/capture/refund calls
 * (acquirer/simulator.ts) stay fully synchronous request/response, but a
 * delayed fraud-review verdict only ever resolves out of band, so the
 * acquirer posts the result back to us instead. Public — the caller is the
 * acquirer, not a FilsPay merchant session or admin user, so this route
 * carries no requireMerchantAuth/requireAdminSession preHandler.
 * Acquirer-Callback-Signature verification is the only authentication this
 * endpoint has.
 */
export async function acquirerCallbackRoutes(app: FastifyInstance): Promise<void> {
  // Keep the exact bytes received: the acquirer signs those, not our re-serialisation
  // of the parsed body. Scoped to this plugin (encapsulated).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, payload, done) => {
    (request as FastifyRequest & { rawBody?: string }).rawBody = payload as string;
    try {
      done(null, payload === "" ? {} : JSON.parse(payload as string));
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  app.post<{ Body: AcquirerCallbackBody }>("/callbacks", async (request, reply) => {
    const verification = verifyAcquirerCallbackSignature(
      (request as FastifyRequest & { rawBody?: string }).rawBody ?? "",
      getSignatureHeader(request),
      app.config.acquirerCallbackSigningSecret,
    );
    if (!verification.valid) {
      throw new UnauthorizedError("invalid_signature", verification.reason);
    }

    const body = request.body ?? {};
    if (
      !body.callbackId ||
      body.type !== "fraud_review.completed" ||
      !body.transactionId ||
      !body.occurredAt ||
      !body.outcome ||
      !body.note ||
      (body.outcome !== "cleared" && body.outcome !== "confirmed_fraud")
    ) {
      throw new BadRequestError(
        "invalid_request",
        "callbackId, type, transactionId, occurredAt, outcome (cleared | confirmed_fraud), and note are required",
      );
    }

    const callback: AcquirerCallbackInput = {
      callbackId: body.callbackId,
      type: "fraud_review.completed",
      transactionId: body.transactionId,
      occurredAt: body.occurredAt,
      outcome: body.outcome as AcquirerCallbackInput["outcome"],
      note: body.note,
    };

    await withCallbackRetry(() => applyAcquirerCallback(app.db, callback));
    reply.code(200).send({ received: true });
  });
}
