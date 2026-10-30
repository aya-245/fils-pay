import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../auth/passwords.js";
import { claimOtpAttempt, consumeOtpChallenge, issueChallenge, verifyOtpCode } from "../auth/otp.js";
import { requireSession } from "../auth/middleware.js";
import { sendOtpCode } from "../auth/notifier.js";
import {
  createPendingSession,
  lookupPendingSession,
  promoteSession,
  revokeSession,
} from "../auth/sessions.js";
import { withTransaction } from "../db/withTransaction.js";
import { createAuthRateLimiters, enforceRateLimit } from "../auth/rateLimit.js";
import { BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at
 * the same cost parameters this app defaults to. Verified against on every
 * login attempt for an email/merchant pair that doesn't resolve to a real
 * user, so a failed lookup and a failed password check take comparable
 * time — the response is already generic ("invalid_credentials") in every
 * case; this narrows the timing side-channel to match.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

interface LoginBody {
  merchantId?: string;
  email?: string;
  password?: string;
}

interface OtpVerifyBody {
  code?: string;
}

/** One row per (merchant_id, email); the same email may exist under several merchants. */
interface MerchantUserRow {
  id: string;
  merchant_id: string;
  email: string;
  role: "owner" | "finance" | "support";
  password_hash: string;
}

/**
 * Merchant login is two-step: POST /login checks merchantId+email+password
 * and issues a pending session cookie bound to an OTP challenge; POST
 * /otp/verify promotes it. A pending session authenticates nothing until
 * promoted.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Brute-force / credential-stuffing limits (per client IP and per account),
  // checked before any argon2 or OTP work. request.ip honours trustProxy.
  const limits = createAuthRateLimiters(app.config);

  /** POST /v1/auth/login — step 1. */
  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const { merchantId, email, password } = request.body ?? {};
    if (!merchantId || !email || !password) {
      throw new BadRequestError("invalid_request", "merchantId, email and password are required");
    }
    enforceRateLimit(reply, limits.loginIp, request.ip);
    enforceRateLimit(reply, limits.loginAccount, `${String(merchantId)}:${String(email).toLowerCase()}`);

    const userResult = await app.db.query<MerchantUserRow>(
      `SELECT mu.id, mu.merchant_id, mu.email, mu.role, mu.password_hash
         FROM merchant_users mu
         JOIN merchants m ON m.id = mu.merchant_id
        WHERE mu.merchant_id = $1 AND mu.email = $2 AND m.status = 'active'`,
      [merchantId, email],
    );
    const user = userResult.rows[0];

    // timing-safe: hashes against a dummy when the user is missing. correct — FH
    const passwordOk = await verifyPassword(user ? user.password_hash : DUMMY_PASSWORD_HASH, password);

    // The same generic message in every failure case (no row, or wrong
    // password) — the response never discloses which part was wrong.
    if (!user || !passwordOk) {
      throw new UnauthorizedError("invalid_credentials");
    }

    // The OTP and session belong to the user whose password was just verified, never to a same-email user in another merchant.
    const recipient = user;

    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      const challenge = await issueChallenge(client, {
        merchantUserId: recipient.id,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      const session = await createPendingSession(client, {
        merchantUserId: recipient.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.pendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken };
    });

    sendOtpCode(request.log, app.config, { merchantUserId: recipient.id, email: recipient.email }, code);

    reply.setCookie(app.config.cookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.pendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    // dev only — stripped in production builds
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.post<{ Body: OtpVerifyBody }>(
    "/otp/verify",
    async (request, reply) => {
      const code = request.body?.code;
      if (!code) {
        throw new BadRequestError("invalid_request", "code is required");
      }
      enforceRateLimit(reply, limits.otpVerifyIp, request.ip);

      const rawToken = request.cookies[app.config.cookieName];
      if (!rawToken) {
        throw new UnauthorizedError("no_pending_session");
      }
      const pending = await lookupPendingSession(app.db, rawToken);
      if (!pending || !pending.otpChallengeId) {
        throw new UnauthorizedError("no_pending_session");
      }
      // Per account, across sessions: re-logging-in for fresh challenges
      // cannot multiply the per-challenge guess budget without bound.
      enforceRateLimit(reply, limits.otpVerifyAccount, pending.merchantUserId);

      // Spend a guess atomically BEFORE comparing, so parallel requests cannot
      // exceed max_attempts (see claimOtpAttempt).
      const claim = await claimOtpAttempt(app.db, "otp_challenges", pending.otpChallengeId);
      if (!claim.ok) {
        if (claim.reason === "too_many_attempts") {
          await revokeSession(app.db, pending.sessionId);
          throw new TooManyRequestsError("too_many_attempts");
        }
        throw new GoneError("otp_expired");
      }

      if (typeof code !== "string" || !verifyOtpCode(code, claim.codeSalt, claim.codeHash)) {
        throw new UnauthorizedError("invalid_code");
      }

      const { merchantUser: merchantUserResult, rotatedToken } = await withTransaction(app.db, async (client) => {
        if (!(await consumeOtpChallenge(client, "otp_challenges", claim.id))) {
          throw new GoneError("otp_expired");
        }
        // Rotates the token: the pre-OTP cookie value is dead from here on (FP-198).
        const promoted = await promoteSession(client, pending.sessionId, app.config.sessionTtlHours);
        if (!promoted) {
          throw new UnauthorizedError("no_pending_session");
        }
        const result = await client.query<{ merchant_id: string; role: "owner" | "finance" | "support" }>(
          `SELECT merchant_id, role FROM merchant_users WHERE id = $1`,
          [pending.merchantUserId],
        );
        return { merchantUser: result.rows[0], rotatedToken: promoted.rawToken };
      });
      if (!merchantUserResult) {
        throw new Error("otp/verify: merchant_users row disappeared mid-transaction");
      }

      // New token, browser lifetime matching the promoted session.
      reply.setCookie(app.config.cookieName, rotatedToken, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: app.config.sessionTtlHours * 3_600,
      });

      reply.code(200).send({
        authenticated: true,
        merchantId: merchantUserResult.merchant_id,
        role: merchantUserResult.role,
      });
    },
  );

  /**
   * Re-issues the OTP for a pending session. Throttled to one per 30s. The
   * new challenge inherits the previous challenge's attempt_count so a
   * resend never resets the guess budget.
   */
  app.post("/otp/resend", async (request: FastifyRequest, reply: FastifyReply) => {
    enforceRateLimit(reply, limits.otpResendIp, request.ip);
    const rawToken = request.cookies[app.config.cookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }
    enforceRateLimit(reply, limits.otpResendAccount, pending.merchantUserId);

    const existing = await app.db.query<{ id: string; created_at: Date; attempt_count: number }>(
      `SELECT id, created_at, attempt_count FROM otp_challenges WHERE id = $1`,
      [pending.otpChallengeId],
    );
    const existingChallenge = existing.rows[0];
    if (existingChallenge && Date.now() - existingChallenge.created_at.getTime() < 30_000) {
      throw new TooManyRequestsError("resend_too_soon");
    }

    const { code, expiresAt } = await withTransaction(app.db, async (client) => {
      if (existingChallenge) {
        await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [
          existingChallenge.id,
        ]);
      }
      const challenge = await issueChallenge(client, {
        merchantUserId: pending.merchantUserId,
        ttlMinutes: app.config.otpTtlMinutes,
        codeLength: app.config.otpCodeLength,
        maxAttempts: app.config.otpMaxAttempts,
      });
      // Inherit the spent guesses: a resend must never reset the guess budget.
      await client.query(`UPDATE otp_challenges SET attempt_count = $2 WHERE id = $1`, [
        challenge.id,
        existingChallenge?.attempt_count ?? 0,
      ]);
      await client.query(`UPDATE sessions SET otp_challenge_id = $1 WHERE id = $2`, [
        challenge.id,
        pending.sessionId,
      ]);
      return challenge;
    });

    const userResult = await app.db.query<{ email: string }>(
      `SELECT email FROM merchant_users WHERE id = $1`,
      [pending.merchantUserId],
    );
    sendOtpCode(
      request.log,
      app.config,
      { merchantUserId: pending.merchantUserId, email: userResult.rows[0]?.email ?? "" },
      code,
    );

    const responseBody: Record<string, unknown> = { otpRequired: true, otpExpiresAt: expiresAt.toISOString() };
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.get(
    "/me",
    { preHandler: requireSession },
    async (request: FastifyRequest) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      const result = await app.db.query<{
        email: string;
        merchant_id: string;
        display_name: string;
        onboarding_status: string;
      }>(
        `SELECT mu.email, m.id AS merchant_id, m.display_name, m.onboarding_status
           FROM merchant_users mu
           JOIN merchants m ON m.id = mu.merchant_id
          WHERE mu.id = $1`,
        [auth.merchantUserId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new UnauthorizedError("unauthenticated");
      }
      return {
        merchantUserId: auth.merchantUserId,
        email: row.email,
        role: auth.role,
        merchant: {
          id: row.merchant_id,
          displayName: row.display_name,
          onboardingStatus: row.onboarding_status,
        },
      };
    },
  );

  app.post(
    "/logout",
    { preHandler: requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.auth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      await revokeSession(app.db, auth.sessionId);
      reply.setCookie(app.config.cookieName, "", {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: app.config.cookieSecure,
        maxAge: 0,
      });
      reply.code(204).send();
    },
  );
}
