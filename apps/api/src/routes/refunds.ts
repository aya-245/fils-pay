import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { toFils, type Fils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "../lib/errors.js";

/**
 * FP-212 / FP-300: merchant refunds, full and partial.
 *
 * Served on two paths by the same handler:
 *   POST /v1/refunds                         (canonical; merchant from auth)
 *   POST /v1/merchants/:merchantId/refunds   (dashboard; path must match auth)
 *
 * Body: { transactionId: uuid, amountFils?: positive integer fils, reason?: string }
 * Header: Idempotency-Key (required). The key is the CLIENT's: a retry with
 * the same key and body replays the stored response and never refunds twice.
 *
 * Auth: merchant API key, or a merchant session with role owner/finance.
 * Admin impersonation sessions are refused: impersonation is read-only, and
 * refunds.created_by_type cannot attribute a write to an admin.
 */

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

interface MerchantIdParams {
  merchantId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.trim() === "") {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestError("invalid_request", "Idempotency-Key header is too long");
  }
  return key;
}

const refuseImpersonation: preHandlerHookHandler = async (request) => {
  const auth = request.merchantAuth;
  if (!auth) throw new UnauthorizedError("unauthenticated");
  if (auth.actorType === "admin_impersonation") {
    throw new ForbiddenError("impersonation_read_only", "refunds cannot be issued while impersonating a merchant");
  }
};

const preHandler = [requireMerchantAuth, refuseImpersonation, requireMerchantRole("owner", "finance")];

interface ParsedRefundBody {
  transactionId: string;
  amountFils?: Fils;
  reason?: string;
}

function parseBody(body: RefundBody | undefined): ParsedRefundBody {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("invalid_request", "request body is required");
  }
  const { transactionId, amountFils, reason } = body;
  if (typeof transactionId !== "string" || !UUID_PATTERN.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId must be a UUID");
  }

  let parsedAmount: Fils | undefined;
  if (amountFils !== undefined && amountFils !== null) {
    if (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0) {
      throw new BadRequestError("invalid_request", "amountFils must be a positive integer number of fils");
    }
    parsedAmount = toFils(amountFils);
  }

  let parsedReason: string | undefined;
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== "string") {
      throw new BadRequestError("invalid_request", "reason must be a string");
    }
    const trimmed = reason.trim();
    if (trimmed.length > MAX_REASON_LENGTH) {
      throw new BadRequestError("invalid_request", `reason must be at most ${MAX_REASON_LENGTH} characters`);
    }
    parsedReason = trimmed === "" ? undefined : trimmed;
  }

  return { transactionId, amountFils: parsedAmount, reason: parsedReason };
}

async function handleRefund(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.merchantAuth!;
  const idempotencyKey = getIdempotencyKey(request);
  const body = parseBody(request.body as RefundBody | undefined);

  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    merchantId: auth.merchantId,
    transactionId: body.transactionId,
    amountFils: body.amountFils,
    idempotencyKey,
    actor: requireMerchantWriterActor(auth),
    reason: body.reason,
  });
  reply.code(result.statusCode).send(result.body);
}

/** Registered with prefix '/v1/refunds'. */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>("/", { preHandler }, async (request, reply) => {
    await handleRefund(app, request, reply);
  });
}

/** Registered with prefix '/v1/merchants'. */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      await handleRefund(app, request, reply);
    },
  );
}
