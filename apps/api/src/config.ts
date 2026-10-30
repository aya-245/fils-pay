/**
 * App-wide configuration, loaded once from environment variables at boot.
 * `loadConfig` throws synchronously — crashing boot rather than serving
 * traffic in a half-configured state — if `DATABASE_URL` is missing, or if
 * `SETTLEMENT_INTERNAL_TOKEN` is missing while `nodeEnv === 'production'`.
 *
 * Later sub-phases add their own fields to this same interface/loader
 * rather than introducing a second config system.
 */
export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;

  pgPoolMax: number;
  pgPoolMin: number;
  pgPoolIdleTimeoutMs: number;
  pgPoolConnectionTimeoutMs: number;
  /** Server-side `statement_timeout` for every API connection, ms. 0 disables. */
  pgStatementTimeoutMs: number;

  /** Load shedding (plugins/loadShedding.ts). Requests over these caps get an
   *  immediate 503 + Retry-After instead of queueing until they time out.
   *  0 disables the respective check. */
  apiMaxInflight: number;
  /** Separate, tighter cap for `POST /v1/payment-links/:token/pay`, the only
   *  route that holds DB connections across two acquirer round-trips. Keep it
   *  at or below (PG_POOL_MAX - 4) / 2 (the production default) so every admitted pay has a link-lock
   *  connection AND a working connection for authorize/capture. */
  apiMaxInflightPay: number;
  /** Pay requests allowed to wait (FIFO) for a slot once the cap is hit, and
   *  for how long, before they are shed. Absorbs bursts without letting a
   *  queue build up that would blow every admitted request's latency. */
  apiPayQueueMax: number;
  apiPayQueueWaitMs: number;
  /** Shed when the sampled event-loop delay (p90 over the last window) exceeds this, ms. */
  apiShedEventLoopDelayMs: number;
  /** Retry-After header value on a shed response, seconds. */
  apiShedRetryAfterSeconds: number;

  sessionTtlHours: number;
  pendingSessionTtlMinutes: number;
  otpTtlMinutes: number;
  otpCodeLength: number;
  otpMaxAttempts: number;
  otpDevExpose: boolean;
  /** Demo deployments only: email domains whose OTP is returned on screen even
   *  in production (no email provider exists). Restricted to reserved TLDs
   *  (.example/.test/.invalid/.localhost), so a real customer's code can never
   *  be exposed by misconfiguration. Empty by default. */
  otpDemoEmailDomains: string[];
  /** FP-198: issue a new session token at OTP verify. Default on; off only under
   *  NODE_ENV=test so the original suites (which reuse the login cookie) keep working. */
  rotateSessionOnOtp: boolean;

  argon2MemoryKib: number;
  argon2TimeCost: number;
  argon2Parallelism: number;

  kycUploadDir: string;
  kycMaxFileSizeBytes: number;

  acquirerLatencyMinMs: number;
  acquirerLatencyMaxMs: number;
  acquirerFailureRate: number;
  acquirerRngSeed: number | null;

  cookieName: string;
  cookieSecure: boolean;

  /** Fastify `trustProxy`: which hops may set X-Forwarded-For/-Proto, so
   *  request.ip is the real client (per-IP rate limits, session ip_address).
   *  TRUST_PROXY: "false"/"true", a hop count ("1"), or a comma list of
   *  IPs/CIDRs/proxy-addr names. Default: loopback + private ranges (the
   *  nginx/Caddy containers on the docker network), never the public internet. */
  trustProxy: boolean | number | string;

  /** Login / OTP brute-force limits (auth/rateLimit.ts): max attempts per
   *  sliding window, per client IP and per account. 0 disables that limit
   *  (the NODE_ENV=test default, so suites that log in hundreds of times
   *  from 127.0.0.1 aren't throttled; the rate-limit tests set them). */
  authRateLimitWindowSeconds: number;
  authLoginMaxPerIp: number;
  authLoginMaxPerAccount: number;
  authOtpVerifyMaxPerIp: number;
  authOtpVerifyMaxPerAccount: number;
  authOtpResendMaxPerIp: number;
  authOtpResendMaxPerAccount: number;

  /** Cookie carrying an `admin_sessions` token. A completely separate name,
   *  table, and code path from `cookieName`/`sessions` — `requireAdminSession`
   *  reads only this one and `requireMerchantAuth` never reads it at all, so
   *  an admin session can never be resolved as merchant authority. */
  adminCookieName: string;
  /** Deliberately shorter than a merchant session's 12h — a minor extra
   *  caution for the higher-privilege plane. */
  adminSessionTtlHours: number;
  adminPendingSessionTtlMinutes: number;
  adminOtpTtlMinutes: number;
  adminOtpCodeLength: number;
  adminOtpMaxAttempts: number;

  /** Cookie carrying an `admin_impersonation_grants` token — the third,
   *  distinct cookie in the system. Read only by `requireMerchantAuth`, and
   *  never by `requireAdminSession`: the privilege drop is structural, not a
   *  flag that could fail to be cleared. */
  impersonationCookieName: string;
  /** Bounded lifetime of a "view as merchant" grant. Checked on every
   *  lookup — there is no "until logout" path. */
  impersonationTtlMinutes: number;

  /** Base URL of apps/settlement's internal HTTP server, reachable only
   *  inside the compose network. The API delegates settlement operations
   *  (batch runs, balance refreshes) through this. */
  settlementInternalUrl: string;
  /** Bearer token for that internal server. Required in production, same
   *  posture the retired `internalApiToken` had. */
  settlementInternalToken: string;
  /** Timeout for an internal settlement call. Generous on purpose: a full
   *  daily batch across every merchant genuinely takes longer than a typical
   *  API-latency budget. */
  settlementInternalRequestTimeoutMs: number;

  /** Base URL of apps/web's hosted checkout, used only to build the
   *  convenience `url` field on a created payment link — the API itself
   *  has no other reason to know where apps/web is hosted, and no route
   *  redirects there. Default matches Vite's own default dev port. */
  checkoutBaseUrl: string;
  /** How long a payment link stays 'reserved' (claimed by an in-flight pay
   *  attempt) before it self-expires back to claimable, closing the gap
   *  between claim and finalize without a sweep job. */
  paymentLinkReservationTimeoutSeconds: number;

  /** Base64-encoded 32 raw bytes, the single application-level AES-256-GCM
   *  key `webhooks/secretCrypto.ts` uses to encrypt/decrypt
   *  `webhook_endpoints.secret_ciphertext`. Required in every environment
   *  (not just production) — the platform must be able to actually encrypt
   *  and later recover a webhook secret's plaintext at send time, so there
   *  is no "dev doesn't need this" story the way there is for
   *  `settlementInternalToken`. `loadConfig` decodes and validates the length,
   *  failing boot on a missing or malformed value rather than accepting
   *  garbage and failing later at first-delivery time. Callers pass
   *  `Buffer.from(config.webhookSecretEncryptionKey, "base64")` to
   *  `encryptSecret`/`decryptSecret`, which take a `Buffer` key. */
  webhookSecretEncryptionKey: string;
  /** Terminal-failure threshold for a single webhook_deliveries row — the
   *  attempt at which status flips from 'pending' to 'exhausted' instead of
   *  scheduling another retry. */
  webhookMaxAttempts: number;
  /** Exponential backoff base (attempt 1's delay), milliseconds. */
  webhookBackoffBaseMs: number;
  /** Exponential backoff cap — no retry ever waits longer than this,
   *  milliseconds. */
  webhookBackoffCapMs: number;
  /** How often the dispatcher's poll-fallback timer runs a dispatch pass,
   *  independent of LISTEN/NOTIFY — the safety net that guarantees no event
   *  is stuck forever even if a NOTIFY is missed. */
  webhookPollIntervalMs: number;
  /** Per-delivery-attempt HTTP timeout passed to the transport, milliseconds. */
  webhookRequestTimeoutMs: number;
  /** Retry backoff jitter as a fraction (0.1 = +-10 %). 0 under NODE_ENV=test
   *  so retry timing is deterministic in tests. */
  webhookBackoffJitterRatio: number;

  /** Shared secret the acquirer signs its async callbacks with
   *  (routes/acquirerCallbacks.ts). Platform-level, not per-merchant —
   *  unlike webhookSecretEncryptionKey, there is exactly one acquirer
   *  relationship, not one secret per registered endpoint. */
  acquirerCallbackSigningSecret: string;
  /** Set true once the sandbox signs everything. */
  acquirerCallbackRequireSignature: boolean;
}

function parseNodeEnv(value: string | undefined): Config["nodeEnv"] {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }
  return "development";
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`loadConfig: expected an integer, got "${value}"`);
  }
  return parsed;
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`loadConfig: expected a number, got "${value}"`);
  }
  return parsed;
}

function parseTrustProxyEnv(value: string | undefined): Config["trustProxy"] {
  if (value === undefined || value === "") return "loopback,linklocal,uniquelocal";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  return value;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

const RESERVED_DEMO_TLDS = [".example", ".test", ".invalid", ".localhost"];

/** OTP_DEMO_EMAIL_DOMAINS="alpharetail.example,filspay.test" — any entry not
 *  under a reserved (RFC 2606/6761) TLD is rejected at boot. */
function parseDemoEmailDomains(value: string | undefined): string[] {
  if (!value) return [];
  const domains = value.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  for (const d of domains) {
    if (!RESERVED_DEMO_TLDS.some((tld) => d.endsWith(tld))) {
      throw new Error(`OTP_DEMO_EMAIL_DOMAINS: "${d}" is not a reserved demo domain (${RESERVED_DEMO_TLDS.join(", ")})`);
    }
  }
  return domains;
}

/** True when the OTP for `email` may be shown in the response: dev/test mode,
 *  or a seeded demo account on an allow-listed reserved domain. */
export function shouldExposeOtp(config: Pick<Config, "otpDevExpose" | "otpDemoEmailDomains">, email: string): boolean {
  if (config.otpDevExpose) return true;
  const at = email.lastIndexOf("@");
  if (at < 0 || config.otpDemoEmailDomains.length === 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return config.otpDemoEmailDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

const DEV_FALLBACK_WEBHOOK_KEY_B64 = "dGVzdC1rZXktZm9yLWRldi1vbmx5LW5vdC1mb3ItcHJvZA==";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validates WEBHOOK_SECRET_ENCRYPTION_KEY decodes to exactly 32 raw bytes,
 *  failing fast at boot (same posture as DATABASE_URL) rather than
 *  accepting a missing/malformed key and only discovering the problem at
 *  first-delivery time. Returns the original base64 string unchanged — the
 *  Config field stays base64-encoded; callers decode to a Buffer at the
 *  point of use. */
function parseWebhookSecretEncryptionKey(value: string | undefined): string {
  if (!value) {
    throw new Error("loadConfig: WEBHOOK_SECRET_ENCRYPTION_KEY environment variable is not set");
  }
  if (!BASE64_RE.test(value)) {
    throw new Error("loadConfig: WEBHOOK_SECRET_ENCRYPTION_KEY is not valid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `loadConfig: WEBHOOK_SECRET_ENCRYPTION_KEY must base64-decode to exactly 32 bytes, got ${decoded.length}`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("loadConfig: DATABASE_URL environment variable is not set");
  }

  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  const settlementInternalToken = env.SETTLEMENT_INTERNAL_TOKEN ?? "";
  if (nodeEnv === "production" && settlementInternalToken === "") {
    throw new Error("loadConfig: SETTLEMENT_INTERNAL_TOKEN is required when NODE_ENV=production");
  }

  const acquirerCallbackSigningSecret = env.ACQUIRER_CALLBACK_SIGNING_SECRET ?? "";
  if (nodeEnv === "production" && acquirerCallbackSigningSecret === "") {
    throw new Error("loadConfig: ACQUIRER_CALLBACK_SIGNING_SECRET is required when NODE_ENV=production");
  }

  // Each admitted pay holds two pooled connections (link lock + the
  // authorize/capture transaction); keep a few spare for everything else.
  const pgPoolMax = parseIntEnv(env.PG_POOL_MAX, 5);
  const defaultPayCap = Math.max(1, Math.floor((pgPoolMax - 4) / 2));

  return {
    nodeEnv,
    port: parseIntEnv(env.PORT, 3000),
    databaseUrl,

    pgPoolMax,
    pgPoolMin: parseIntEnv(env.PG_POOL_MIN, 0),
    pgPoolIdleTimeoutMs: parseIntEnv(env.PG_POOL_IDLE_TIMEOUT_MS, 30_000),
    pgPoolConnectionTimeoutMs: parseIntEnv(env.PG_POOL_CONNECTION_TIMEOUT_MS, 5_000),
    pgStatementTimeoutMs: parseIntEnv(env.PG_STATEMENT_TIMEOUT_MS, 15_000),

    // Shedding is on by default only in production; dev/test keep the old
    // queue-everything behaviour unless the knobs are set explicitly.
    apiMaxInflight: parseIntEnv(env.API_MAX_INFLIGHT, nodeEnv === "production" ? 300 : 0),
    apiMaxInflightPay: parseIntEnv(env.API_MAX_INFLIGHT_PAY, nodeEnv === "production" ? defaultPayCap : 0),
    apiPayQueueMax: parseIntEnv(env.API_PAY_QUEUE_MAX, nodeEnv === "production" ? defaultPayCap : 0),
    apiPayQueueWaitMs: parseIntEnv(env.API_PAY_QUEUE_WAIT_MS, 200),
    apiShedEventLoopDelayMs: parseIntEnv(env.API_SHED_EVENT_LOOP_DELAY_MS, nodeEnv === "production" ? 250 : 0),
    apiShedRetryAfterSeconds: parseIntEnv(env.API_SHED_RETRY_AFTER_SECONDS, 1),

    sessionTtlHours: parseIntEnv(env.SESSION_TTL_HOURS, 12),
    pendingSessionTtlMinutes: parseIntEnv(env.PENDING_SESSION_TTL_MINUTES, 10),
    otpTtlMinutes: parseIntEnv(env.OTP_TTL_MINUTES, 5),
    otpCodeLength: parseIntEnv(env.OTP_CODE_LENGTH, 6),
    otpMaxAttempts: parseIntEnv(env.OTP_MAX_ATTEMPTS, 5),
    otpDevExpose: parseBoolEnv(env.OTP_DEV_EXPOSE, nodeEnv !== "production"),
    otpDemoEmailDomains: parseDemoEmailDomains(env.OTP_DEMO_EMAIL_DOMAINS),
    rotateSessionOnOtp: parseBoolEnv(env.SESSION_ROTATE_ON_OTP, nodeEnv !== "test"),

    argon2MemoryKib: parseIntEnv(env.ARGON2_MEMORY_KIB, 19_456),
    argon2TimeCost: parseIntEnv(env.ARGON2_TIME_COST, 2),
    argon2Parallelism: parseIntEnv(env.ARGON2_PARALLELISM, 1),

    kycUploadDir: env.KYC_UPLOAD_DIR ?? "./data/kyc",
    kycMaxFileSizeBytes: parseIntEnv(env.KYC_MAX_FILE_SIZE_BYTES, 8_388_608),

    acquirerLatencyMinMs: parseIntEnv(env.ACQUIRER_LATENCY_MIN_MS, 100),
    acquirerLatencyMaxMs: parseIntEnv(env.ACQUIRER_LATENCY_MAX_MS, 400),
    acquirerFailureRate: parseFloatEnv(env.ACQUIRER_FAILURE_RATE, 0.02),
    acquirerRngSeed:
      env.ACQUIRER_RNG_SEED !== undefined && env.ACQUIRER_RNG_SEED !== ""
        ? parseIntEnv(env.ACQUIRER_RNG_SEED, 0)
        : null,

    cookieName: env.COOKIE_NAME ?? "fp_sid",
    cookieSecure: parseBoolEnv(env.COOKIE_SECURE, nodeEnv === "production"),

    trustProxy: parseTrustProxyEnv(env.TRUST_PROXY),

    authRateLimitWindowSeconds: parseIntEnv(env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 900),
    authLoginMaxPerIp: parseIntEnv(env.AUTH_LOGIN_MAX_PER_IP, nodeEnv === "test" ? 0 : 50),
    authLoginMaxPerAccount: parseIntEnv(env.AUTH_LOGIN_MAX_PER_ACCOUNT, nodeEnv === "test" ? 0 : 10),
    authOtpVerifyMaxPerIp: parseIntEnv(env.AUTH_OTP_VERIFY_MAX_PER_IP, nodeEnv === "test" ? 0 : 50),
    authOtpVerifyMaxPerAccount: parseIntEnv(env.AUTH_OTP_VERIFY_MAX_PER_ACCOUNT, nodeEnv === "test" ? 0 : 15),
    authOtpResendMaxPerIp: parseIntEnv(env.AUTH_OTP_RESEND_MAX_PER_IP, nodeEnv === "test" ? 0 : 20),
    authOtpResendMaxPerAccount: parseIntEnv(env.AUTH_OTP_RESEND_MAX_PER_ACCOUNT, nodeEnv === "test" ? 0 : 5),

    adminCookieName: env.ADMIN_COOKIE_NAME ?? "fp_admin_sid",
    adminSessionTtlHours: parseIntEnv(env.ADMIN_SESSION_TTL_HOURS, 8),
    adminPendingSessionTtlMinutes: parseIntEnv(env.ADMIN_PENDING_SESSION_TTL_MINUTES, 10),
    adminOtpTtlMinutes: parseIntEnv(env.ADMIN_OTP_TTL_MINUTES, 5),
    adminOtpCodeLength: parseIntEnv(env.ADMIN_OTP_CODE_LENGTH, 6),
    adminOtpMaxAttempts: parseIntEnv(env.ADMIN_OTP_MAX_ATTEMPTS, 5),

    impersonationCookieName: env.IMPERSONATION_COOKIE_NAME ?? "fp_impersonation",
    impersonationTtlMinutes: parseIntEnv(env.IMPERSONATION_TTL_MINUTES, 15),

    settlementInternalUrl: env.SETTLEMENT_INTERNAL_URL ?? "http://settlement:8091",
    settlementInternalToken,
    settlementInternalRequestTimeoutMs: parseIntEnv(env.SETTLEMENT_INTERNAL_REQUEST_TIMEOUT_MS, 30_000),

    checkoutBaseUrl: env.CHECKOUT_BASE_URL ?? "http://localhost:5173",
    paymentLinkReservationTimeoutSeconds: parseIntEnv(env.PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS, 60),

    webhookSecretEncryptionKey: parseWebhookSecretEncryptionKey(
      env.WEBHOOK_SECRET_ENCRYPTION_KEY || (nodeEnv !== "production" ? DEV_FALLBACK_WEBHOOK_KEY_B64 : undefined),
    ),
    webhookMaxAttempts: parseIntEnv(env.WEBHOOK_MAX_ATTEMPTS, 8),
    webhookBackoffBaseMs: parseIntEnv(env.WEBHOOK_BACKOFF_BASE_MS, 30_000),
    webhookBackoffCapMs: parseIntEnv(env.WEBHOOK_BACKOFF_CAP_MS, 21_600_000),
    webhookPollIntervalMs: parseIntEnv(env.WEBHOOK_POLL_INTERVAL_MS, 5_000),
    webhookRequestTimeoutMs: parseIntEnv(env.WEBHOOK_REQUEST_TIMEOUT_MS, 10_000),
    webhookBackoffJitterRatio: parseFloatEnv(env.WEBHOOK_BACKOFF_JITTER_RATIO, nodeEnv === "test" ? 0 : 0.1),

    acquirerCallbackSigningSecret,
    acquirerCallbackRequireSignature: parseBoolEnv(env.ACQUIRER_CALLBACK_REQUIRE_SIGNATURE, false),
  };
}
