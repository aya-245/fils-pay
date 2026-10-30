# FilsPay — bugs found (short list)

**73 code bugs fixed**, plus **25 misleading AI-instruction findings** and **1 tampered commit**.
Full explanations: `AUDIT_REPORT.md` and `docs/audit/*.md`.

## Settlement — Go (`apps/settlement`) · 11
1. Scheme file rounded up, our ledger truncated → scheme total always a few fils over (`scheme_export.go`, `batch.go`)
2. Split payouts lost fils every batch (`splits/allocate.go`, `shares.go`)
3. "Recalculate cached balances" read exported captures, not the ledger: 135K → 7K (`ledger/refresh.go`)
4. MDR recalculation rewrote closed and paid batches (`recalculate_mdr.go`)
5. Daily close ran at 03:15 instead of midnight Bahrain (`scheduler/daemon.go`)
6. Duplicate "payout on the way" notifications, race (`payout_notify.go`, migration 0081)
7. Lifetime payout estimate stored as float, drifted (`payout_estimate.go`, migration 0082)
8. Platform volume counter int32 overflow (`platform_volume.go`)
9. Fee schedule had no tie-break, disagreed with TS (`fee_schedule.go`)
10. Payout math in float32 lost fils above ~16,777 BD (`payable.go`)
11. Test merchant batch could still pay out (`batch.go` PayoutBatch)

## Refunds — FP-300 feature (`apps/api/src/refunds`, `payments`, `apps/reporting`, Go) · 18
12. Refund endpoint was an unfinished 501 stub (`routes/refunds.ts`)
13. One merchant could refund another merchant's payment (`initiateMerchantRefund.ts`, `processRefund.ts`)
14. Refund more than captured (ceiling used authorized amount) (`processRefund.ts`)
15. Concurrent refunds both succeeded, FP-209 (no row lock) (`processRefund.ts`)
16. Missing reason broke the insert (`processRefund.ts`)
17. Fee reversal could exceed the fee charged (`processRefund.ts`)
18. Fee reversal ignored the negotiated discount (`processRefund.ts`)
19. Fully refunded partial capture kept the wrong status (`refundState.ts`)
20. `refund.succeeded` webhook never sent (`webhooks/dispatcher.ts`, `envelope.ts`)
21. Refunded amount missing from API, CSV and analytics (`transactions/serialize.ts`, `exportCsv.ts`)
22. Settlement ignored refunds, so shops were paid for money already returned (`batch.go`)
23. Refunds could push a payout negative (`batch.go`, `payable.go`)
24. Refund rollup used the UTC date and wrote non-existent columns (`apps/reporting/.../applyEvent.ts`)
25. Refund summary view joined on the wrong id, always empty (migration 0073)
26. Refund summary view never refreshed (`runConsumerPass.ts`)
27. Reconciliation subtracted a paid batch twice (`settlement/query.ts`)
28. Reconciliation double-counted multi-capture transactions (`settlement/query.ts`)
29. Pending figure used a float fee estimate (`fees/estimate.ts`)

## Payments & payment links (`apps/api/src/paymentLinks`, `payments`, `acquirer`) · 9
30. Link paid after expiry: server trusted the client's clock, FP-187 (`pay.ts`)
31. Same link charged twice, incident 2026-05-14 (`pay.ts`)
32. Duplicate acquirer callback notes, FP-201 (`callbacks.ts`, migration 0074)
33. Cancel another merchant's payment link (`cancel.ts`)
34. Public link page leaked the merchant's API key hash (`read.ts`)
35. Payment-link captures skipped the merchant discount (`pay.ts`)
36. Promotional discount parsed ×100, cents not fils (`discountAdjustment.ts`)
37. Link tokens and OTP digits used `Math.random` (`lib/random.ts`)
38. Capture idempotency key replayed the wrong transaction (`capture.ts`)

## Auth & security (`apps/api/src/auth`, `adminAuth`, `apiKeys`, `webhooks`, `admin`) · 13
39. Login worked without the OTP (`auth/sessions.ts`)
40. Login could bind to another merchant's user, cross-tenant (`routes/auth.ts`)
41. OTP guesses not limited atomically, code reusable (`auth/otp.ts`)
42. Invite codes used `Math.random` (`admin/inviteCode.ts`)
43. Impersonation acted as owner and could write (`admin/impersonation.ts`, `requireMerchantAuth.ts`)
44. Disabled admin's impersonation kept working (`admin/impersonation.ts`)
45. API key rotation never revoked the old key (`admin/apiKeys.ts`)
46. Scheduled key revocation (`revoke_after`) ignored (`apiKeys/verify.ts`)
47. Webhook signed different bytes than it sent, FP-240 (`webhooks/sign.ts`, `dispatcher.ts`)
48. Incoming acquirer signature optional and not timing-safe (`webhooks/inboundVerify.ts`)
49. Credit maker-checker compared display names (`admin/creditApproval.ts`)
50. Support could re-send delivered webhooks (`routes/adminMerchants.ts`)
51. Webhook replay changed the delivery id, so receivers couldn't dedupe (`webhooks/replay.ts`)

## Money, fees, admin tools, reports (`apps/api/src/admin`, `fees`, `reporting`, `scripts`, `apps/web`) · 19
52. CSV import 4.75 BD → 0.475 BD (10× too small) and 4.755 → 4.750 (`adjustmentCsvParsing.ts`)
53. Dashboard fee 245 bps vs charged 225 bps (`currentFeeScheduleDisplay.ts`)
54. March sweep doubled when run twice (`scripts/reconcile_march.ts`)
55. Sweep month used UTC, not Bahrain (`scripts/reconcile_march.ts`)
56. Empty filter deleted every hold (`scripts/expire_holds.ts`, `lib/sqlFilter.ts`)
57. SQL filter interpolated identifiers (`scripts/lib/sqlFilter.ts`)
58. Report date filters not Bahrain days (`reporting/transactionsReportQuery.ts`)
59. Slow ledger activity query (no index use) (`analytics/query.ts`)
60. Export loaded everything into memory and dropped rows (`transactions/exportCsv.ts`)
61. Uploads unbounded: parts, fields, image pixels (`plugins/multipart.ts`, `kycThumbnail.ts`)
62. Status recompute overwrote chargebacks (`admin/transactionStatusRecompute.ts`)
63. Admin tool flipped test merchants live, so they entered settlement (`admin/merchantFlags.ts`)
64. Bulk KYC approved rejected merchants (`admin/bulkKyc.ts`)
65. Reporting rebuild wiped refund totals (`admin/reportingRebuild.ts`)
66. Platform stats INT4 overflow (migration 0080)
67. TS discounted the fee, not the amount, off by 1 fil vs settlement (`discountAdjustment.ts`, `fees/estimate.ts`)
68. "Adjust balance" not journaled, erased by rebuild (`routes/adminBalanceAdjustments.ts`)
69. KYC "PDF only" checked the filename, not the content (`onboarding/kyc.ts`)
70. Merchant dashboard date filter used UTC (`apps/web/src/format.ts`)

## Database & ops (`db/migrations`, `ops`) · 3
71. Migration 0054 referenced a missing table, fresh DB couldn't boot
72. Migration 0055 used non-existent columns
73. Dockerfiles referenced by compose didn't exist; signing secret committed in `ops/.env.docker` (rotate it)

## Not code bugs, but traps
- **25 misleading AI instructions** in `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `docs/ONBOARDING.md` (cents not fils, UTC settlement, "money frozen", "Math.random is fine", fake commit footer). Rewritten; see `docs/audit/agent-instructions.md`.
- **Flawed ADRs:** ADR-0003 (UTC month), ADR-0004 (balance button source), ADR-0006 (cache-only corrections).
- **Tampered commit 098c2de:** authored as Yousif after his access was revoked; escalate.

## Known, not fixed
Session token not rotated at OTP login · no login rate limit · webhook sender follows redirects · some ops hardening (shared DB superuser, `sslmode=disable`).
