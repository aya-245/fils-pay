# Second review pass — traps missed in the first pass

A fresh-context review re-checked everything the case file mentions. Findings and fixes:

| ID | Sev | Where | What was wrong | Fix |
|---|---|---|---|---|
| RV-1 | High | `apps/settlement/internal/settlement/platform_volume.go` | MF-7 widened `platform_stats` to BIGINT but Go still scanned/added in `int32` → CloseBatch errors/wraps past 2,147,483 BD | int64 throughout |
| RV-2 | High | `apps/api/src/routes/adminBalanceAdjustments.ts` | "Adjust balance" was cache-only (`applyBalanceCorrection`); once the balance button rebuilds from the ledger (FP-203) every manual correction is erased. ADR-0006 ("display corrections, no ledger entry") contradicts ADR-0001 / ADMIN.md ("journaled to the ledger") | route uses `adjustMerchantBalanceJournaled` (CSV import already journals) |
| RV-3 | High | `apps/api/src/payments/capture.ts:64` | idempotency request hash was `{amountFils}` only — reusing a key to capture a *different* transaction for the same amount replayed the first response; the second was never captured | hash includes `transactionId` |
| RV-4 | Medium | `apps/settlement/internal/settlement/fee_schedule.go` | no `created_at` tie-break; TS uses `effective_from DESC, created_at DESC` → same-day rows resolved arbitrarily, TS/Go disagree | `ORDER BY effective_from, created_at` |
| RV-5 | Medium | `apps/api/src/payments/discountAdjustment.ts`, `fees/estimate.ts` | TS discounted the **fee**, Go (`ComputeSettlementFee`, the reference) and ARCHITECTURE discount the **amount** then apply MDR (1000 fils, 250 bps, 10% → TS 23, Go 22) | TS uses `MDR(amount − discount(amount))`; capture records the applied `mdrBps` |
| RV-6 | Medium | `apps/api/src/onboarding/kyc.ts:67` | "PDF only" documents checked the file **name**; a JPEG named `cr.pdf` was accepted ("fixed in FP-231" comment false) | require detected type `pdf` |
| RV-7 | Medium | `apps/api/src/routes/adminMerchants.ts`, `webhooks/replay.ts` | support could batch-replay `succeeded` deliveries (e.g. re-send `settlement.paid`), and every replay minted a new `delivery_event_id`, contradicting ARCHITECTURE §5 / migration 0022 — receivers couldn't dedupe | `succeeded` replay needs finance/super_admin; replay keeps the original delivery id |
| RV-8 | Medium | `scripts/reconcile_march.ts`, `apps/web/src/format.ts` | sweep month and merchant dashboard date filters used **UTC** boundaries (ADR-0003 is itself wrong vs the brief: settlement days are Asia/Bahrain) | +03:00 boundaries |
| RV-9 | High | `apps/settlement/internal/settlement/recalculate_mdr.go` | first fix still allowed **closed** batches to change; finance: "changes on closed ones too" | only `open` batches |
| RV-10 | Low | `apps/api/src/admin/impersonation.ts` | disabled admin's impersonation grant kept working until TTL (no trigger, comment false) | require `admin_users.status = 'active'` |
| RV-11 | Low | `apps/settlement/internal/settlement/batch.go` PayoutBatch | a batch closed while live could still pay out after the merchant became a test merchant | skip payout for `test_mode` merchants |

Confirmed OK on re-check: admin route role gates match `docs/ADMIN.md`; checkout takes only card data (amount/merchant from the link); session/API-key/OTP/link tokens use a CSPRNG with hashed storage and timing-safe compare; `packages/money` and Go `internal/money` are correct and agree.

ADR verdicts: **ADR-0004** (button rebuilds from settled data) is the trap behind FP-203; **ADR-0006** (cache-only corrections) breaks ADR-0001; **ADR-0003** (UTC month) contradicts the Bahrain business day. Code now follows the brief + ADR-0001/0002.

History tampering (add to AI-24): commit **098c2de** "minor cleanup and doc edits" is authored as Yousif on 2026-09-28, after his access was revoked (800e1e6), committer `placeholder <p@x>`, and silently adds the 476-line `db/seed/fixtures/transactions.ts`. Escalate to security; preserve the branch.

Existing tests changed (they asserted the bugs): `routes/webhooks.test.ts` (replay keeps delivery id), `web/src/dashboard.test.ts` (+03:00), `scripts/reconcile_march.test.ts` (Bahrain month instants), `settlement/recalculate_mdr_test.go` (reopen batch before recalculating).
