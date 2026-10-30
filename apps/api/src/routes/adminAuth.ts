import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "../adminAuth/passwords.js";
import { issueAdminChallenge, verifyOtpCode } from "../adminAuth/otp.js";
import { claimOtpAttempt, consumeOtpChallenge } from "../auth/otp.js";
import { sendAdminOtpCode } from "../adminAuth/notifier.js";
import { requireAdminSession } from "../adminAuth/middleware.js";
import {
  createPendingAdminSession,
  lookupPendingAdminSession,
  promoteAdminSession,
  revokeAdminSession,
  type AdminRole,
} from "../adminAuth/sessions.js";
import { withTransaction } from "../db/withTransaction.js";
import { createAuthRateLimiters, enforceRateLimit } from "../auth/rateLimit.js";
import { BadRequestError, GoneError, TooManyRequestsError, UnauthorizedError } from "../lib/errors.js";

/**
 * A pre-computed argon2id hash of a fixed, never-used dummy password, at the
 * same cost parameters this app defaults to. Verified against on every login
 * attempt for an email that doesn't resolve to an active admin, so a failed
 * lookup and a failed password check take comparable time.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$/yKuaUqm4SW+pPt2oGNj4A$j5oxu/MdJJP86dClo0LJ0wsekKwkSbr1yA0uZSZgQcc";

interface LoginBody {
  email?: string;
  password?: string;
}

interface OtpVerifyBody {
  code?: string;
}

/** status 'disabled' blocks login and kills existing sessions (requireAdminSession re-reads it). */
interface AdminUserRow {
  id: string;
  email: string;
  role: AdminRole;
  password_hash: string;
}

/**
 * Registered with prefix '/v1/admin/auth'. Structurally identical to the
 * merchant login (password -> OTP -> authenticated session), with one
 * simplification the schema makes possible: `admin_users.email` is globally
 * unique, so unlike merchant login there is no tenant id to disambiguate
 * with — the lookup is unambiguous by construction.
 *
 * Admin login requires OTP deliberately: this is the plane where the most
 * dangerous operations live, so it must not have a weaker login factor than
 * an ordinary merchant dashboard user.
 */
export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  // Same per-IP / per-account brute-force limits as merchant login, with
  // their own state (a merchant flood never locks staff out, and vice versa).
  const limits = createAuthRateLimiters(app.config);

  app.post<{ Body: LoginBody }>("/login", async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      throw new BadRequestError("invalid_request", "email and password are required");
    }
    enforceRateLimit(reply, limits.loginIp, request.ip);
    enforceRateLimit(reply, limits.loginAccount, String(email).toLowerCase());

    const userResult = await app.db.query<AdminUserRow>(
      `SELECT id, email, role, password_hash FROM admin_users WHERE email = $1 AND status = 'active'`,
      [email],
    );
    const user = userResult.rows[0];

    const passwordOk = await verifyPassword(user ? user.password_hash : DUMMY_PASSWORD_HASH, password);

    // The same generic error in every failure case (no row, disabled
    // account, or wrong password) — the response never discloses which.
    if (!user || !passwordOk) {
      throw new UnauthorizedError("invalid_credentials");
    }

    const { code, expiresAt, rawToken } = await withTransaction(app.db, async (client) => {
      const challenge = await issueAdminChallenge(client, {
        adminUserId: user.id,
        ttlMinutes: app.config.adminOtpTtlMinutes,
        codeLength: app.config.adminOtpCodeLength,
        maxAttempts: app.config.adminOtpMaxAttempts,
      });
      const session = await createPendingAdminSession(client, {
        adminUserId: user.id,
        otpChallengeId: challenge.id,
        ttlMinutes: app.config.adminPendingSessionTtlMinutes,
        ipAddress: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
      return { code: challenge.code, expiresAt: challenge.expiresAt, rawToken: session.rawToken };
    });

    sendAdminOtpCode(request.log, app.config, { adminUserId: user.id, email: user.email }, code);

    reply.setCookie(app.config.adminCookieName, rawToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.adminPendingSessionTtlMinutes * 60,
    });

    const responseBody: Record<string, unknown> = {
      otpRequired: true,
      otpExpiresAt: expiresAt.toISOString(),
    };
    if (app.config.otpDevExpose) {
      responseBody.devOtpCode = code;
    }
    reply.code(200).send(responseBody);
  });

  app.post<{ Body: OtpVerifyBody }>("/otp/verify", async (request, reply) => {
    const code = request.body?.code;
    if (!code) {
      throw new BadRequestError("invalid_request", "code is required");
    }
    enforceRateLimit(reply, limits.otpVerifyIp, request.ip);

    const rawToken = request.cookies[app.config.adminCookieName];
    if (!rawToken) {
      throw new UnauthorizedError("no_pending_session");
    }
    const pending = await lookupPendingAdminSession(app.db, rawToken);
    if (!pending || !pending.otpChallengeId) {
      throw new UnauthorizedError("no_pending_session");
    }
    enforceRateLimit(reply, limits.otpVerifyAccount, pending.adminUserId);

    // Spend a guess atomically BEFORE comparing (see claimOtpAttempt).
    const claim = await claimOtpAttempt(app.db, "admin_otp_challenges", pending.otpChallengeId);
    if (!claim.ok) {
      if (claim.reason === "too_many_attempts") {
        await revokeAdminSession(app.db, pending.adminSessionId);
        throw new TooManyRequestsError("too_many_attempts");
      }
      throw new GoneError("otp_expired");
    }

    if (typeof code !== "string" || !verifyOtpCode(code, claim.codeSalt, claim.codeHash)) {
      throw new UnauthorizedError("invalid_code");
    }

    const { adminUser, rotatedToken } = await withTransaction(app.db, async (client) => {
      if (!(await consumeOtpChallenge(client, "admin_otp_challenges", claim.id))) {
        throw new GoneError("otp_expired");
      }
      // Rotates the token: the pre-OTP cookie value is dead from here on (FP-198).
      const promoted = await promoteAdminSession(client, pending.adminSessionId, app.config.adminSessionTtlHours);
      if (!promoted) {
        throw new UnauthorizedError("no_pending_session");
      }
      const result = await client.query<{ role: AdminRole }>(
        `SELECT role FROM admin_users WHERE id = $1`,
        [pending.adminUserId],
      );
      return { adminUser: result.rows[0], rotatedToken: promoted.rawToken };
    });
    if (!adminUser) {
      throw new Error("admin otp/verify: admin_users row disappeared mid-transaction");
    }

    // New token, browser lifetime matching the promoted session.
    reply.setCookie(app.config.adminCookieName, rotatedToken, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: app.config.cookieSecure,
      maxAge: app.config.adminSessionTtlHours * 3_600,
    });

    reply.code(200).send({
      authenticated: true,
      adminUserId: pending.adminUserId,
      role: adminUser.role,
    });
  });

  app.get("/me", { preHandler: requireAdminSession }, async (request: FastifyRequest) => {
    const auth = request.adminAuth;
    if (!auth) {
      throw new UnauthorizedError("unauthenticated");
    }
    return { adminUserId: auth.adminUserId, email: auth.email, role: auth.role };
  });

  app.post(
    "/logout",
    { preHandler: requireAdminSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = request.adminAuth;
      if (!auth) {
        throw new UnauthorizedError("unauthenticated");
      }
      await revokeAdminSession(app.db, auth.adminSessionId);
      reply.setCookie(app.config.adminCookieName, "", {
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
