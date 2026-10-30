# Payments audit (payment links, authorize/capture/void, acquirer callbacks)

Truth used: 1 BD = 1000 fils (integer fils); docs/adr are the rules; CLAUDE.md/comments claiming "intentional" were ignored.

## FP-187 | High | apps/api/src/paymentLinks/pay.ts (expiryReferenceTime), routes/paymentLinks.ts, web CheckoutPage.tsx
- What's wrong: public pay endpoint judged expiry against a client-supplied `submittedAt`; the route comment says "ignored unless API-key authenticated" but the route is unauthenticated.
- Why: `expiryReferenceTime(submittedAt)` trusted the body; checkout sent `new Date().toISOString()` and an attacker sends a past one.
- Breaks: any expired link can be paid by anyone who knows the token.
- Fix: expiry always uses server `new Date()`; field removed from route, input and web client.
- Test: paymentLinks.new.test.ts "FP-187"; pay.test.ts updated (see below).

## INCIDENT-2026-05-14 | Critical | pay.ts claim/finalize
- What's wrong: claim UPDATE re-admitted a `reserved` link once `reserved_at` aged past the timeout while the first payment was still running; second buyer paid and finalized first, first buyer's finalize matched 0 rows and the code answered 200 anyway (two captures, one link).
- Why: time-based reservation instead of a real lock; "unreachable" comment was wrong.
- Breaks: double charge of two cardholders for one link.
- Fix: `SELECT ... FOR UPDATE SKIP LOCKED` on the link inside a dedicated txn held through authorize+capture+finalize (lock released on commit/rollback/connection loss). Locked row => 409 payment_link_processing. Stale `reserved` rows (crash) are claimable but first we look for an already-completed `transactions.capture` idempotency key for `paylink:<id>:%` and finalize against it, so a retry under a different Idempotency-Key cannot charge again. A finalize failure now throws instead of lying with 200. In-process semaphore (pool.max - 2) stops lock-holders starving the pool.
- Test: paymentLinks.new.test.ts "incident 2026-05-14", "crash after capture".

## FP-201 | Medium | acquirer/callbacks.ts, db/migrations/0051, routes/acquirerCallbacks.ts
- What's wrong: redelivered callback saved a second note; the "processed_events"/FP-238 unique index never existed. Route also did not validate `outcome` despite its doc comment.
- Fix: migration 0074 dedupes existing rows (keeps earliest) + UNIQUE(callback_id); insert uses ON CONFLICT DO NOTHING; route 400s on unknown outcome.
- Test: paymentLinks.new.test.ts "FP-201".

## PL-CANCEL-IDOR | High | paymentLinks/cancel.ts, routes/paymentLinks.ts
- What's wrong: `assertOwnMerchant` checks only the path merchant; cancel updated/selected by link id alone, so merchant A could cancel (and probe existence/status of) merchant B's link.
- Fix: cancel takes merchantId and scopes UPDATE and SELECT by it (other merchant's link => 404). query.ts (list) already scopes by merchant_id; read/status are public by token and fine.
- Test: "cancel: another merchant cannot cancel my link".

## PL-READ-LEAK | High | paymentLinks/read.ts
- What's wrong: public unauthenticated GET returned `merchantIntegrationId` = `api_keys.key_hash` of the merchant's newest key.
- Fix: removed column and DTO field (unused by web). `merchantPublicKey` (key prefix) kept; existing test expects it.
- Test: "public read does not expose api key hashes".

## PL-DISCOUNT-MISSING | High | paymentLinks/pay.ts
- What's wrong: negotiated discount adjustment applied only in routes/transactions.ts; the payment-link path called captureTransaction directly and the comment claiming capture.ts now does it was false. Link-paid captures never got the discount.
- Fix: pay.ts calls applyCaptureDiscountAdjustment after successful capture (idempotent per capture event).

## DISC-PARSE | Medium | payments/discountAdjustment.ts parsePromotionalDiscountFils
- What's wrong: `Math.round(parseFloat(raw) * 100)` = cents, and float. "1.5" BD gave 150 not 1500.
- Fix: use parseBhdToFils (exact string parse, 1000 per BD, <=3 decimals, rejects negatives). Currently no caller in the repo.
- Test: "parsePromotionalDiscountFils".

## RNG-TOKEN | High | lib/random.ts
- What's wrong: payment-link tokens (the sole bearer credential for read/pay) and OTP digits came from Math.random().
- Fix: node:crypto randomInt for randomDigits/randomFromAlphabet. (CLAUDE.md's "Math.random is fine for payment link slugs" is wrong.)

## CAP-DEAD-UTC | Low | payments/capture.ts recordCaptureMetric
- Unused helper writing merchant_daily_volume by UTC date (would double-count with the reporting consumer, wrong day vs Asia/Bahrain). Removed.

## Existing test changed
- paymentLinks/pay.test.ts: removed "empty string", "valid ISO round-trips exactly" ("offline-terminal contract") and "unparseable" cases, which asserted that a client value is honoured (FP-187); replaced with "always server clock" and "ignores client value".

## Not fixed / noted
- Authorize/capture/void/idempotency reviewed: row lock, integer math, merchant scoping OK. Capture does not check hold expiry (7-day hold flipped only by a job); left as-is, no documented rule.
- withCallbackRetry retries non-transient errors (e.g. 404) 3x; harmless.
- Callback signature verification lives in webhooks/inboundVerify (other worker).
