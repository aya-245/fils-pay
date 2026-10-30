# FilsPay — Security Review

Date: 2026-10-30 · Branch `worktree-filspay-audit` · Reviewer: AI-assisted audit (Worker 3), building on the
earlier audit passes in `AUDIT_REPORT.md`, `BUGS.md` and `docs/audit/*.md`.

## 1. Scope

| In scope | Out of scope |
|---|---|
| `apps/api` (merchant, checkout, admin planes; webhook dispatcher/transport; acquirer callbacks) | Acquirer's systems, real card data (simulator only) |
| `apps/reporting` consumer, `apps/settlement` internal API (reviewed in earlier passes) | Front-end UX (`apps/web`, `apps/admin`), except where they enforce auth |
| Deploy surface: `ops/` compose, nginx `/api` proxy, Caddy TLS front door | Host OS / cloud account hardening |
| Production npm dependencies | Dev-only dependencies |

Source of truth for intended behaviour: `docs/ARCHITECTURE.md`, `docs/ADMIN.md`, `docs/adr/*`. Repo-embedded
"agent instructions" (CLAUDE.md, AGENTS.md, code comments) were treated as untrusted (see AI-01…AI-25).

## 2. Method

1. **Manual review** of every route's `preHandler` chain, every merchant-scoped SQL query, session/OTP/API-key
   lifecycle, outbound/inbound webhook signing, and config defaults.
2. **Tests as evidence**: each fix has a regression test that fails on the old code. This pass added
   `apps/api/src/auth/authHardening.new.test.ts` (16 tests) and `apps/reporting/src/consumer/poisonEvent.new.test.ts`.
   The full suite runs green on one migrated + seeded Postgres (§7).
3. **Dependency audit**: `npm audit --omit=dev` (§6).
4. **Threat model** (§3) mapped to OWASP API Security Top 10 2023 (§4).

## 3. Threat model

| Asset | Threat | Control | Status / evidence |
|---|---|---|---|
| Merchant session | Login without OTP | `lookupSession` requires `authenticated = true` (`apps/api/src/auth/sessions.ts:104`) | ✅ A1, `authSecurity.new.test.ts` "bug1" |
| Merchant/admin session | Session fixation: a planted pre-OTP cookie rides the authenticated session | Token rotated at promotion (`auth/sessions.ts:58`, `adminAuth/sessions.ts:69`). Routes set the new cookie | ✅ A12, "FP-198: merchant/admin OTP verify rotates the session token" |
| Accounts | Password spraying / credential stuffing | Per-IP + per-account sliding window before argon2 (`routes/auth.ts:63-64`, `routes/adminAuth.ts:65-66`, `auth/rateLimit.ts`) | ✅ A13, "merchant login: per-account limit…", "…per-IP limit…" |
| OTP | Brute force (parallel guesses, reuse, re-login for fresh budgets) | Atomic `claimOtpAttempt`, single-use consume (A3). Per-account OTP verify/resend limits (`routes/auth.ts:132-212`, `routes/adminAuth.ts:124-134`) | ✅ A3 + A13, "bug2: parallel OTP guesses…", "merchant OTP verify and resend…", "admin login and OTP verify…" |
| OTP / tokens | Predictable randomness | `crypto.randomInt` / `randomBytes` (`lib/random.ts`, `lib/crypto.ts`) | ✅ A4 / RNG-TOKEN |
| Tenant data | Cross-tenant login (same email, two merchants) | Session bound to the password-verified user (`routes/auth.ts`) | ✅ A2 |
| Tenant data | BOLA on `:merchantId` routes | `merchantAuth.merchantId !== params.merchantId` → 403 (`routes/paymentLinks.ts:50`, `routes/webhooks.ts:45`, `routes/apiKeys.ts:21`, `routes/refunds.ts:130`) | ✅ existing route tests |
| Refunds | Refunding another merchant's payment | `WHERE id = $1 AND merchant_id = $2` (`refunds/initiateMerchantRefund.ts:66`, `payments/processRefund.ts:143`) | ✅ BUGS #13, `refunds.new.test.ts` |
| Payment links | Cancel another merchant's link | Merchant-scoped update (`paymentLinks/cancel.ts:22,30`) | ✅ PL-CANCEL-IDOR, `paymentLinks.new.test.ts` |
| Payment links | Public read leaks secrets | Public serializer has no key hash | ✅ PL-READ-LEAK |
| Admin plane | Function-level authz (support doing finance actions) | `requireAdminRole('finance','super_admin')` on money routes (`routes/admin.ts:112…`). Roles match `docs/ADMIN.md` | ✅ A11, `admin.test.ts` role-gating block |
| Admin plane | Impersonation used to write as owner | Grant role always `support`. Non-GET/HEAD refused (`auth/requireMerchantAuth.ts:91`). Disabled admin's grants die | ✅ A5, BUGS #43/#44 |
| Admin plane | Maker-checker bypass | Compare admin ids, not names (`admin/creditApproval.ts`) | ✅ A10 |
| API keys | Leaked key valid forever | Rotation revokes. `revoke_after` honoured. Only sha256 stored (`apiKeys/issue.ts`) | ✅ A6/A7 |
| Webhook receivers | Signature mismatch / forgery | Sign exactly the bytes sent, HMAC-SHA256 | ✅ A8 / FP-240 |
| Acquirer callbacks | Forged fraud verdicts | Signature mandatory, raw body, 300 s window, `timingSafeEqual` (`webhooks/inboundVerify.ts:45`) | ✅ A9 |
| Internal network | SSRF via webhook URL / open redirect | https-only in prod (`webhooks/create.ts`). `redirect:"manual"` (`webhooks/transport.ts:88`) | ✅ A15 (redirect). ⚠ residual: https URL resolving to an internal https host |
| API process | Memory / CPU exhaustion | 64 KiB webhook response cap (`transport.ts:33`). Request timeout. Upload limits (MF-5). Rate limit before argon2. Load shedding (`plugins/loadShedding.ts`) | ✅ A15, A13, MF-5 |
| Browser clients | Clickjacking, MIME sniffing, caching of authenticated JSON | `plugins/securityHeaders.ts` (registered `app.ts:64`) | ✅ A16, "security headers on API responses…" |
| Browser clients | CSRF | Cookies are `SameSite=Lax` + `HttpOnly`, and `Secure` when `COOKIE_SECURE` (default true in production). State changes are POST JSON. No CORS headers are sent, so no cross-origin reads | ✅ "session cookies are HttpOnly + SameSite=Lax…" |
| Client IP integrity | Per-IP limits defeated by the proxy (one bucket) or by spoofed XFF | `trustProxy` = loopback + private ranges by default (`TRUST_PROXY`, `app.ts:50`) | ✅ A14, "trustProxy: X-Forwarded-For from an untrusted (public) peer is ignored" |
| Secrets | Committed secrets | `ops/.env.docker` untracked (OPS-1) | ⚠ still in git history: **rotate `ACQUIRER_CALLBACK_SIGNING_SECRET`** |
| Transport | Plain HTTP | Caddy TLS front door with HSTS (`ops/Caddyfile`). API also sends HSTS when `COOKIE_SECURE` | ✅ deploy. ⚠ Postgres `sslmode=disable` in compose (OPS-3) |
| Reporting integrity | One malformed outbox row stops all rollups | Fail-stop kept on purpose (exactly-once, never drop money events). The error now names the row | 📝 A19, `poisonEvent.new.test.ts` |

## 4. OWASP API Security Top 10 (2023) mapping

| OWASP | FilsPay findings | Status |
|---|---|---|
| **API1 BOLA** | Refund cross-merchant (BUGS #13), payment-link cancel IDOR (PL-CANCEL-IDOR), cross-tenant login (A2). Every `:merchantId` route compares against the authenticated context. Lookups are `AND merchant_id = $n` | ✅ fixed and tested |
| **API2 Broken authentication** | OTP bypass (A1), OTP brute force / reuse (A3), Math.random codes (A4), session fixation (A12), no login/OTP rate limit (A13), inbound callback signature optional (A9) | ✅ fixed. Rate limits are per process (§5) |
| **API3 Broken object property level auth** | Public link read leaked `api_key_hash` (PL-READ-LEAK). Signup/business-profile insert explicit columns only: `role` is hard-coded `'owner'`, and status/MDR never come from the body (`onboarding/signup.ts:79`) | ✅ |
| **API4 Unrestricted resource consumption** | Export buffered everything / uploads unbounded (MF-5). Webhook response unbounded (A15). Login argon2 floods (A13). API overload (load shedding) | ✅ |
| **API5 BFLA** | Support could resend delivered webhooks (BUGS #50). Impersonation as owner with writes (A5). Money routes gated to finance/super_admin (A11). *Note:* CLAUDE.md claims `/admin/impersonate` is super_admin-gated. Per `docs/ADMIN.md` any admin role may "view as a merchant", and the grant itself is read-only `support` scope | ✅ |
| **API6 Unrestricted access to sensitive business flows** | Payment link double-pay (INC-2026-05-14) and paid-after-expiry (FP-187). Concurrent refunds (FP-209). Credit maker-checker (A10) | ✅ |
| **API7 SSRF** | Webhook transport followed redirects (A15) | ✅ redirect. ⚠ DNS-level egress filtering not implemented |
| **API8 Security misconfiguration** | No security headers (A16). Secret in git (OPS-1). Shared Postgres superuser, `sslmode=disable`, settlement internal server on all interfaces (OPS-2…OPS-9). `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` default false now ignored (A9). trustProxy unset (A14) | ✅ headers/trustProxy/signature. 📝 ops items |
| **API9 Improper inventory management** | Dead `v1/routes/transactions.ts` tree still in the repo (not registered). Misleading agent docs (AI-01…25) | 📝 remove dead tree |
| **API10 Unsafe consumption of APIs** | Acquirer callbacks verified on raw bytes with freshness (A9). Settlement internal calls use a bearer token with a timeout | ✅ |

## 5. Residual risks (accepted or open)

1. **Rate limits are in memory, per process.** This is correct for the single API replica (the dispatcher already
   requires one replica). Scaling out needs a shared store (Postgres table or Redis). A restart resets the windows.
2. **Per-account lockout can be abused for targeted DoS**: an attacker who knows a merchant's id+email can keep that
   account at its 10 logins / 15 min limit. Mitigations if needed: count failures only, add CAPTCHA or step-up,
   or alert on it.
3. **SSRF to internal https services**: https-only + no redirects closes the plain-http internal targets and the
   open-redirect bypass, but not `https://<internal-host>`. Fix: resolve and pin the IP, deny private ranges in
   production, or send webhooks through an egress proxy.
4. **trustProxy default trusts private ranges.** Clients whose packets arrive from a private address can spoof
   `X-Forwarded-For`. Browsers reach the API through nginx (and Caddy), but `ops/docker-compose.prod.yml:121` also
   publishes `API_HOST_PORT:3000` on the host. Public clients reaching it keep their public source IP (DNAT), so they
   are not trusted. Connections through docker-proxy (from the host itself) appear as the bridge gateway and are
   trusted. Recommendation: drop that port mapping or bind it to `127.0.0.1`. Set `TRUST_PROXY` to the exact proxy addresses or hop count when the topology is fixed.
   nginx forwards `X-Forwarded-Proto $scheme` (= http behind Caddy), so API-side HSTS relies on `COOKIE_SECURE=true`.
   Caddy also sends HSTS.
5. **Secret history**: `ACQUIRER_CALLBACK_SIGNING_SECRET` remains in git history (OPS-1). Rotate it, and consider
   a history rewrite.
6. **Ops hardening open** (OPS-2…OPS-9): shared DB superuser, `sslmode=disable`, settlement binds 0.0.0.0, `/readyz`
   checks the DB at boot only.
7. **Dependencies** (§6): 1 high (`sharp`/libvips, used for KYC thumbnails on untrusted images), 4 moderate.
8. **Reporting poison message** (A19): fail-stop by design. Needs an alert on a stuck cursor and a dead-letter procedure.
9. **API keys skip merchant role checks** (design decision, keys are owner-issued). **Tampered commit 098c2de**
   (AI-24) needs escalation.

## 6. Dependency audit — `npm audit --omit=dev` (2026-10-30)

5 vulnerabilities (1 high, 4 moderate):

| Package | Severity | Issue | Exposure / action |
|---|---|---|---|
| `sharp` ≤ 0.35.5-rc.1 | High | libvips / libheif / librsvg CVEs | Processes **untrusted KYC uploads** (`onboarding/kycThumbnail.ts`). Upgrade to 0.35.5 (breaking, so retest thumbnails). Magic-byte + pixel limits (MF-5) reduce exposure |
| `fastify` ≤ 5.12.5 | Moderate | HTTP/2 trailer DoS; header validation `propertyNames` case bypass | HTTP/1.1 only and no header schemas, so low exposure. `npm audit fix` (non-breaking) |
| `fast-uri` | Moderate | Host/scheme normalisation issues (via ajv) | No user-controlled URI validation through ajv. `npm audit fix` |
| `react-router` / `react-router-dom` 6.x | Moderate | Open redirect via backslash in `<Link>`/`useNavigate`; SSR hydration issue | SPA only, no SSR. Upgrade path is 7.x (breaking) |

## 7. Test evidence (this pass)

Full `npm test` on a freshly migrated and seeded database (`filspay_c`), run sequentially:

| Workspace | Result |
|---|---|
| packages/events | 4/4 |
| packages/money | 40/40 |
| apps/api | 438/438 (incl. 16 new in `auth/authHardening.new.test.ts`) |
| apps/reporting | 17/17 (incl. `poisonEvent.new.test.ts`. 5 of these failed before this pass in a shared DB) |
| apps/web | 8/8 |
| scripts | 4/4 |

`npm run typecheck`: clean in every workspace + db + scripts. Before this pass: API 413/414 (flaky backoff test) and
reporting 11/16.

## 8. Configuration reference (new in this pass)

| Env | Default (prod) | NODE_ENV=test | Meaning |
|---|---|---|---|
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | same | Peers allowed to set `X-Forwarded-*`. Also `true`, `false`, a hop count, or a CIDR list |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | 900 | 900 | Sliding window |
| `AUTH_LOGIN_MAX_PER_IP` / `_PER_ACCOUNT` | 50 / 10 | 0 (off) | Login attempts |
| `AUTH_OTP_VERIFY_MAX_PER_IP` / `_PER_ACCOUNT` | 50 / 15 | 0 (off) | OTP verify attempts |
| `AUTH_OTP_RESEND_MAX_PER_IP` / `_PER_ACCOUNT` | 20 / 5 | 0 (off) | OTP resends |
| `WEBHOOK_BACKOFF_JITTER_RATIO` | 0.1 | 0 | Retry jitter (±) |
| `COOKIE_SECURE` | true | false | Secure cookies + API HSTS |
