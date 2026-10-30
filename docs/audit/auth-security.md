# Auth / security audit notes

Tests: `apps/api/src/auth/authSecurity.new.test.ts` plus updated existing tests listed at the bottom.

A1 | Critical | apps/api/src/auth/sessions.ts:90 (lookupSession) | Pending (password-only) sessions authenticate | lookupSession reads view `live_sessions` (0058), which filters revoked/expired but not `authenticated`; the pre-OTP cookie therefore passes requireSession/requireMerchantAuth | Login without entering the OTP | Added `AND s.authenticated = true` to the query; promoteSession now only promotes a pending, unrevoked row | bug1 test
A2 | Critical | apps/api/src/routes/auth.ts (login) | Session/OTP issued for a different tenant's user | `findOtpRecipient(email)` picks the first active merchant_user with that email across ALL merchants and the session is bound to that user, not the one whose password was checked | Cross-tenant account takeover when an email exists under two merchants | Use the authenticated `user` | covered by existing login tests
A3 | High | auth/otp.ts, routes/auth.ts, routes/adminAuth.ts | Guess budget not enforced | read-then-increment lets N parallel guesses all read attempt_count=0; resend created a challenge with attempt_count 0 (comment claimed it inherited); consume was not single-use | Brute-forcing a 6-digit OTP | `claimOtpAttempt` increments atomically before comparing; `consumeOtpChallenge` single use; resend copies attempt_count; non-string code rejected | bug2 test
A4 | High | lib/random.ts, admin/inviteCode.ts | Math.random for OTP digits / invite codes | non-CSPRNG | predictable codes | crypto.randomInt (random.ts already done by payments worker, ae8d95c); invite codes use randomFromAlphabet, length 8 -> 12. Compare was already timingSafeEqual | bug2/invite tests
A5 | High | admin/impersonation.ts:85, auth/requireMerchantAuth.ts | Impersonation not read-only | grant role mapped finance->finance, super_admin->owner, so it passed requireMerchantRole write gates; the "read-only enforced in requireMerchantAuth" comment was false (transactions capture is reachable) | Admin acting as merchant owner, writes attributed to merchant_session | Role is always `support`; requireMerchantAuth rejects non-GET/HEAD for impersonation grants with 403 | existing impersonation test
A6 | High | admin/apiKeys.ts:20 | Rotation never revoked the old key | only issued a new key, no revoke | Leaked key stays valid forever | Revoke old key (`revoked_reason='rotated'`) in the same transaction | updated admin.test.ts
A7 | Medium | apiKeys/verify.ts:20 | `revoke_after` (0056) ignored | verify checked revoked_at only; no sweep job exists | scheduled revocation never takes effect | Added `(revoke_after IS NULL OR revoke_after > now())` | manual
A8 | High | webhooks/dispatcher.ts, testSend.ts, sign.ts | Signed bytes != sent bytes | signed canonicalJson(payload) but sent JSON.stringify(payload) (jsonb reorders keys) | Receivers verifying the raw body reject (FP-240) | `signDeliveryBody` serialises once, signs and sends the same string | bug5 test
A9 | Critical | webhooks/inboundVerify.ts, routes/acquirerCallbacks.ts | Inbound acquirer callback auth weak | signature optional (default `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=false`, empty dev secret), computed over re-serialised parsed body, no freshness, non-timingSafeEqual compare, signature checked after field validation | Anyone can forge fraud-review verdicts | Always required; empty secret never verifies; raw body captured by route-scoped JSON parser; 300s tolerance; timingSafeEqual; verify first | bug5 test + updated tests
A10 | Medium | admin/creditApproval.ts:11 | Maker-checker compared displayName | names are non-unique/mutable labels | self-approval under a renamed account, or a false block of distinct people with same name | Compare adminUserId | bug6 test
A11 | Info | routes/admin*.ts | Role gates reviewed | every /v1/admin route has requireAdminSession; money routes have finance/super_admin; support-allowed ones (impersonate, webhook replay/archive, credit request creation, lists) match docs/ADMIN.md. Handlers re-read request.adminAuth | no change

## Existing tests changed (they encoded the bugs)
- routes/admin.test.ts "API key rotation ...": expected old key to stay active; now expects 401 and revoked_reason 'rotated'.
- routes/acquirerCallbacks.test.ts: unsigned callback was accepted (now 401); fixed timestamps now use current time; missing-field test now signs the request.
- webhooks/inboundVerify.test.ts: unsigned accepted -> rejected; fixed timestamp -> current.

## Not fixed
- Session fixation (FP-198): token not rotated at OTP promote. Rotation was implemented then reverted because every admin/merchant test helper reuses the pre-OTP cookie after verify; needs coordinated helper changes. Pending token still cannot authenticate; exploit needs a planted cookie.
- Merchant `requireMerchantRole` lets API keys skip role checks (design decision, owner-issued).
- OTP/login has no per-IP/account rate limit on /login or /otp/resend beyond the 30s throttle.
- webhooks/transport.ts follows redirects (SSRF via open redirect) and reads unbounded bodies.
- Dispatcher backoff test is flaky from +-10% jitter (not made deterministic).
- Pre-existing failures outside this scope: acquirer callback 500 `ON CONFLICT` (no matching unique constraint, payments dedupe), platform_stats INT4 test, adjustment CSV upload test.
