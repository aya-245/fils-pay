/**
 * Regression tests for the auth/transport hardening pass
 * (docs/audit/auth-security.md A12-A16, docs/SECURITY_REVIEW.md):
 * session-token rotation at OTP verify, login/OTP rate limiting, security
 * headers + cookie flags, trustProxy, and the webhook transport limits.
 * Needs DATABASE_URL to a migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./passwords.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import { createFetchTransport, MAX_RESPONSE_BODY_BYTES } from "../webhooks/transport.js";
import { backoffDelayMs } from "../webhooks/dispatcher.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("authHardening.new.test.ts requires DATABASE_URL");

const baseEnv = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};
const PASSWORD = "hardening-test-password-1!";

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const apps: Array<ReturnType<typeof buildApp>> = [];
function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({ ...baseEnv, ...env });
  const app = buildApp(config, pool);
  apps.push(app);
  return { app, config };
}
test.after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
});

let cachedHash: string | null = null;
async function passwordHash(): Promise<string> {
  cachedHash ??= await hashPassword(PASSWORD, loadConfig(baseEnv));
  return cachedHash;
}

async function merchantUser(): Promise<{ merchantId: string; email: string }> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Hardening ${randomUUID().slice(0, 8)}`],
  );
  const email = `owner-${randomUUID()}@hardening.test`;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role) VALUES ($1, $2, $3, 'owner')`,
    [m.rows[0]!.id, email, await passwordHash()],
  );
  return { merchantId: m.rows[0]!.id, email };
}

async function adminUser(): Promise<string> {
  const email = `admin-${randomUUID()}@hardening.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, 'support')`,
    [email, await passwordHash(), `Hardening ${email.slice(6, 14)}`],
  );
  return email;
}

function cookieFrom(setCookie: string | string[] | undefined, name: string): string {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const header = all.find((h) => h.startsWith(`${name}=`));
  if (!header) throw new Error(`no Set-Cookie for ${name}`);
  return header.split(";")[0]!;
}
function rawSetCookie(setCookie: string | string[] | undefined, name: string): string {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return all.find((h) => h.startsWith(`${name}=`)) ?? "";
}

// ------------------------------------------------------- session fixation

test("FP-198: merchant OTP verify rotates the session token; the pre-OTP cookie is dead afterwards", async () => {
  const { app, config } = makeApp({ SESSION_ROTATE_ON_OTP: "true" }); // production default
  const { merchantId, email } = await merchantUser();
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const preOtp = cookieFrom(login.headers["set-cookie"], config.cookieName);

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie: preOtp },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const postOtp = cookieFrom(verify.headers["set-cookie"], config.cookieName);
  assert.notEqual(postOtp, preOtp, "a new token must be issued at promotion");

  const meNew = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: postOtp } });
  assert.equal(meNew.statusCode, 200, meNew.body);
  // An attacker holding (or having planted) the pre-OTP token gets nothing.
  const meOld = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: preOtp } });
  assert.equal(meOld.statusCode, 401);
  const reverify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie: preOtp },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(reverify.statusCode, 401);
});

test("FP-198: admin OTP verify rotates the session token; the pre-OTP cookie is dead afterwards", async () => {
  const { app, config } = makeApp({ SESSION_ROTATE_ON_OTP: "true" }); // production default
  const email = await adminUser();
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const preOtp = cookieFrom(login.headers["set-cookie"], config.adminCookieName);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: preOtp },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const postOtp = cookieFrom(verify.headers["set-cookie"], config.adminCookieName);
  assert.notEqual(postOtp, preOtp);
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/auth/me", headers: { cookie: postOtp } })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/v1/admin/auth/me", headers: { cookie: preOtp } })).statusCode, 401);
});

// ------------------------------------------------------- rate limiting

test("SlidingWindowLimiter: admits `limit` per window, 429s with Retry-After, recovers as the window slides; 0 disables", () => {
  let now = 1_000_000;
  const limiter = new SlidingWindowLimiter(3, 60_000, () => now);
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit("k").allowed, true);
  const blocked = limiter.hit("k");
  assert.equal(blocked.allowed, false);
  assert.ok(!blocked.allowed && blocked.retryAfterSeconds === 60);
  assert.equal(limiter.hit("other").allowed, true, "keys are independent");
  now += 30_000;
  const still = limiter.hit("k");
  assert.ok(!still.allowed && still.retryAfterSeconds === 30);
  now += 30_001;
  assert.equal(limiter.hit("k").allowed, true, "oldest attempt slid out of the window");
  const off = new SlidingWindowLimiter(0, 60_000, () => now);
  for (let i = 0; i < 1000; i++) assert.equal(off.hit("k").allowed, true);
});

test("SlidingWindowLimiter: memory stays bounded under key churn", () => {
  const limiter = new SlidingWindowLimiter(1, 60_000, Date.now, 100);
  for (let i = 0; i < 10_000; i++) limiter.hit(`k${i}`);
  assert.ok((limiter as unknown as { hits: Map<string, unknown> }).hits.size <= 100);
});

test("merchant login: per-account limit returns 429 + Retry-After, even with the right password, before argon2 runs", async () => {
  const { app } = makeApp({ AUTH_LOGIN_MAX_PER_ACCOUNT: "3" });
  const { merchantId, email } = await merchantUser();
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: `10.9.0.${i + 1}`, // different IPs: the account limit is what bites
      payload: { merchantId, email, password: "wrong" },
    });
    assert.equal(res.statusCode, 401);
  }
  const limited = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    remoteAddress: "10.9.0.99",
    payload: { merchantId, email: email.toUpperCase(), password: PASSWORD },
  });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().error, "rate_limited");
  assert.ok(Number(limited.headers["retry-after"]) > 0, "Retry-After header present");
});

test("merchant login: per-IP limit uses the X-Forwarded-For client IP from a trusted proxy", async () => {
  const { app } = makeApp({ AUTH_LOGIN_MAX_PER_IP: "2" });
  const attempt = (ip: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-forwarded-for": ip }, // inject's peer is 127.0.0.1 = trusted proxy
      payload: { merchantId: randomUUID(), email: `${randomUUID()}@x.test`, password: "x" },
    });
  assert.equal((await attempt("203.0.113.7")).statusCode, 401);
  assert.equal((await attempt("203.0.113.7")).statusCode, 401);
  assert.equal((await attempt("203.0.113.7")).statusCode, 429);
  assert.equal((await attempt("198.51.100.4")).statusCode, 401, "a different client behind the same proxy is not throttled");
});

test("trustProxy: X-Forwarded-For from an untrusted (public) peer is ignored", async () => {
  const { app } = makeApp({ AUTH_LOGIN_MAX_PER_IP: "1" });
  const attempt = (xff: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "192.0.2.50", // public peer, not a trusted proxy
      headers: { "x-forwarded-for": xff },
      payload: { merchantId: randomUUID(), email: `${randomUUID()}@x.test`, password: "x" },
    });
  assert.equal((await attempt("1.1.1.1")).statusCode, 401);
  assert.equal((await attempt("8.8.8.8")).statusCode, 429, "spoofed XFF must not mint a fresh IP bucket");
});

test("merchant OTP verify and resend: per-account limits return 429", async () => {
  const { app, config } = makeApp({ AUTH_OTP_VERIFY_MAX_PER_ACCOUNT: "2", AUTH_OTP_RESEND_MAX_PER_ACCOUNT: "1" });
  const { merchantId, email } = await merchantUser();
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: PASSWORD } });
  const cookie = cookieFrom(login.headers["set-cookie"], config.cookieName);
  const real = login.json().devOtpCode as string;
  const wrong = real === "000000" ? "111111" : "000000";
  for (let i = 0; i < 2; i++) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrong } });
    assert.equal(r.statusCode, 401);
  }
  const limited = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: real } });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers["retry-after"]);

  // Resend (limit 1/account): age the challenge past the 30 s throttle; the
  // first resend succeeds, the second is the account limit.
  await pool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '1 minute'
      WHERE id = (SELECT otp_challenge_id FROM sessions WHERE merchant_user_id = (SELECT id FROM merchant_users WHERE email = $1))`,
    [email],
  );
  const first = await app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } });
  assert.equal(first.statusCode, 200, first.body);
  const second = await app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } });
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error, "rate_limited");
});

test("admin login and OTP verify: per-account limits return 429", async () => {
  const { app, config } = makeApp({ AUTH_LOGIN_MAX_PER_ACCOUNT: "2", AUTH_OTP_VERIFY_MAX_PER_ACCOUNT: "1" });
  const email = await adminUser();
  const ok = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(ok.statusCode, 200);
  const cookie = cookieFrom(ok.headers["set-cookie"], config.adminCookieName);
  const real = ok.json().devOtpCode as string;
  const wrong = real === "000000" ? "111111" : "000000";
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/admin/auth/otp/verify", headers: { cookie }, payload: { code: wrong } })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/admin/auth/otp/verify", headers: { cookie }, payload: { code: real } })).statusCode,
    429,
  );
  assert.equal((await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: "nope" } })).statusCode, 401);
  const limited = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers["retry-after"]);
});

test("session rotation is on by default outside tests and off under NODE_ENV=test", () => {
  assert.equal(loadConfig(baseEnv).rotateSessionOnOtp, false);
  assert.equal(loadConfig({ ...baseEnv, NODE_ENV: "development" }).rotateSessionOnOtp, true);
});

test("rate limits are off by default under NODE_ENV=test and on by default in production config", () => {
  const t = loadConfig(baseEnv);
  assert.equal(t.authLoginMaxPerAccount, 0);
  const p = loadConfig({
    ...baseEnv,
    NODE_ENV: "production",
    SETTLEMENT_INTERNAL_TOKEN: "x",
    ACQUIRER_CALLBACK_SIGNING_SECRET: "y",
  });
  assert.ok(p.authLoginMaxPerAccount > 0 && p.authLoginMaxPerIp > 0);
  assert.ok(p.authOtpVerifyMaxPerAccount > 0 && p.authOtpResendMaxPerAccount > 0);
  assert.equal(p.cookieSecure, true);
  assert.equal(p.webhookBackoffJitterRatio, 0.1);
});

// ------------------------------------------------------- headers & cookies

test("security headers on API responses; no-store on /v1; HSTS only when secure", async () => {
  const { app } = makeApp();
  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.equal(health.headers["x-frame-options"], "DENY");
  assert.match(String(health.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(health.headers["referrer-policy"], "no-referrer");
  assert.equal(health.headers["strict-transport-security"], undefined, "no HSTS over plain http in dev/test");

  const me = await app.inject({ method: "GET", url: "/v1/auth/me" });
  assert.equal(me.statusCode, 401);
  assert.equal(me.headers["cache-control"], "no-store", "error responses too");
  assert.equal(me.headers["access-control-allow-origin"], undefined, "no CORS: browsers reach the API same-origin");

  const viaHttps = await app.inject({ method: "GET", url: "/healthz", headers: { "x-forwarded-proto": "https" } });
  assert.match(String(viaHttps.headers["strict-transport-security"]), /max-age=31536000/);

  const { app: secureApp } = makeApp({ COOKIE_SECURE: "true" });
  const s = await secureApp.inject({ method: "GET", url: "/healthz" });
  assert.match(String(s.headers["strict-transport-security"]), /max-age=\d+/);
});

test("session cookies are HttpOnly + SameSite=Lax, and Secure when COOKIE_SECURE", async () => {
  const { app, config } = makeApp({ COOKIE_SECURE: "true" });
  const { merchantId, email } = await merchantUser();
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: PASSWORD } });
  const raw = rawSetCookie(login.headers["set-cookie"], config.cookieName);
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /Secure/);
  const adminEmail = await adminUser();
  const al = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email: adminEmail, password: PASSWORD } });
  const araw = rawSetCookie(al.headers["set-cookie"], config.adminCookieName);
  assert.match(araw, /HttpOnly/i);
  assert.match(araw, /SameSite=Lax/i);
  assert.match(araw, /Secure/);
});

// ------------------------------------------------------- webhook transport

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("webhook transport: a 3xx is returned as a failure and the redirect is never followed", async () => {
  let internalHits = 0;
  const internal = await listen((_req, res) => {
    internalHits++;
    res.end("ok");
  });
  const redirector = await listen((_req, res) => {
    res.writeHead(307, { location: `${internal.url}/internal/settlement` });
    res.end();
  });
  try {
    const transport = createFetchTransport();
    const result = await transport({ url: redirector.url, headers: {}, body: "{}", timeoutMs: 2000 });
    assert.equal(result.statusCode, 307);
    assert.equal(internalHits, 0, "the signed POST must not be forwarded to the redirect target");
  } finally {
    redirector.server.close();
    internal.server.close();
  }
});

test("webhook transport: response body read is capped at 64 KiB", async () => {
  const big = await listen((_req, res) => {
    res.writeHead(200);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let i = 0; i < 64; i++) res.write(chunk); // 4 MiB
    res.end();
  });
  try {
    const result = await createFetchTransport()({ url: big.url, headers: {}, body: "{}", timeoutMs: 5000 });
    assert.equal(result.statusCode, 200);
    assert.ok(result.body.length <= MAX_RESPONSE_BODY_BYTES, `read ${result.body.length} bytes`);
    assert.equal(MAX_RESPONSE_BODY_BYTES, 65_536);
  } finally {
    big.server.closeAllConnections();
    big.server.close();
  }
});

test("webhook transport: a receiver that never finishes the body is cut off by the timeout", async () => {
  const slow = await listen((_req, res) => {
    res.writeHead(200);
    res.write("partial"); // never ends
  });
  try {
    const started = Date.now();
    const result = await createFetchTransport()({ url: slow.url, headers: {}, body: "{}", timeoutMs: 300 });
    assert.equal(result.statusCode, null);
    assert.ok(result.errorMessage);
    assert.ok(Date.now() - started < 3000);
  } finally {
    slow.server.closeAllConnections();
    slow.server.close();
  }
});

// ------------------------------------------------------- backoff jitter

test("backoffDelayMs: jitter stays within +-ratio and never exceeds the cap; ratio 0 is exact", () => {
  const cfg = { webhookBackoffBaseMs: 1000, webhookBackoffCapMs: 5000, webhookBackoffJitterRatio: 0.1 };
  assert.equal(backoffDelayMs(1, cfg, () => 0), 900);
  assert.equal(backoffDelayMs(1, cfg, () => 0.5), 1000);
  assert.equal(backoffDelayMs(1, cfg, () => 0.999999), 1100);
  assert.equal(backoffDelayMs(10, cfg, () => 0.999999), 5000, "capped after jitter");
  for (let i = 0; i < 200; i++) {
    const d = backoffDelayMs(2, cfg);
    assert.ok(d >= 1800 && d <= 2200, String(d));
  }
  assert.equal(backoffDelayMs(3, { ...cfg, webhookBackoffJitterRatio: 0 }), 4000);
  assert.equal(backoffDelayMs(1, { webhookBackoffBaseMs: 1000, webhookBackoffCapMs: 5000 }, () => 0), 900, "default +-10 %");
});
