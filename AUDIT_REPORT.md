# FilsPay — Security & Code Audit, Fixes, FP-300

Workshop case file: audit, fix (smallest change), explain, and finish the missing
feature (FP-300) for FilsPay, a Bahraini payment platform (1 BD = 1000 fils).

Ground rules used throughout: the workshop brief and `docs/adr/*` / `docs/ARCHITECTURE.md`
are the source of truth. The repo's `CLAUDE.md`, `AGENTS.md` and `.cursorrules` contained
planted misleading guidance (cents, UTC settlement, "money package frozen", "Math.random is
fine", "never fix tests"); they were audited as findings (AI-01…AI-25) and rewritten.

Detailed per-bug notes (what's wrong · why it happens · what it breaks · fix · test) live in
`docs/audit/`. This file is the index. **Short list of all 73 bugs: `BUGS.md`.** A second,
fresh-context review pass (traps missed the first time, flawed ADRs 0003/0004/0006, tampered
commit 098c2de) is in `docs/audit/review-pass.md`.

---

## 1. FP-300 — Merchant refunds (the unfinished feature)

The last developer left `POST /v1/refunds` returning 501 and the helpers half-built and buggy.
It now works end-to-end:

| Layer | What was done | Notes |
|---|---|---|
| API | `POST /v1/refunds` and `POST /v1/merchants/:id/refunds`; owner/finance sessions + API keys; `Idempotency-Key` required; impersonation refused | `docs/audit/fp300-api.md` |
| Money rules | merchant-scoped lookup (was cross-merchant), ceiling = captured − refunded (was authorized), one DB transaction with `SELECT … FOR UPDATE` across the acquirer call, `CHECK (refunded_fils <= captured_fils)` | fp300-api #2–#4 |
| Fees | fee reversed proportionally on the running refunded total, from the fee actually charged incl. negotiated discount; never exceeds it (300/300/300/100 on a 25-fil fee → 8/7/7/3) | fp300-api #6–#7 |
| Ledger | balanced entry groups to the fil; status `partially_refunded` → `refunded`, hold released | fp300-e2e §1 |
| Webhook | `refund.succeeded` envelope + eligible type; signed bytes == sent bytes | fp300-api #9, auth A8 |
| Timeline / reports | `refunded` events, `refundedFils` on DTO/CSV/analytics; reporting consumer rollups (Bahrain date); `refund_merchant_summary` fixed and refreshed | `docs/audit/fp300-reporting.md` |
| Payouts (Go) | `CloseBatch` nets refunds (amount − fee returned) out of the next payout, never below 0, excess rolls forward; refunds not in the scheme file; int64 payout math | `docs/audit/fp300-settlement.md` |
| Reconciliation | pending figure nets unbatched refunds, integer fee math, multi-capture double-count and paid-batch double-subtract fixed | fp300-reporting |

**Verified end-to-end against the running API + Go settlement** (`docs/audit/fp300-e2e.md`):
capture 10,000 → refund 3,000 (fee back 68) → replay same key (same refund) → refund 7,000
(fee back 157; 68+157 = 225 = fee charged) → over-refund 422 → other merchant 404. Ledger nets
0; two signed `refund.succeeded` webhooks; batch payout 4,888 = (15,000−337)−(10,000−225).

---

## 2. Findings summary

Severity: C = Critical, H = High, M = Medium, L = Low. Status: ✅ fixed · 📝 documented (not fixed).

### Finance memo & incident log items
| ID | Sev | Area | Finding | Status | Notes |
|---|---|---|---|---|---|
| SET-1 | H | Settlement | Scheme total always a few fils **over** ours: file amount rounded half-up from gross while ledger truncated; residue never journaled (ADR-0002) | ✅ | settlement.md |
| MF-3 | H | Scripts | March sweep not idempotent (random entry group id) → ran twice, gap doubled | ✅ | money-fees.md |
| SET-2 | H | Settlement | Delta Marketplace split children don't sum to parent (independent rounding) | ✅ | settlement.md |
| SET-3 / FP-203 | C | Settlement | "Recalculate cached balances" read gross exported captures, CLI read the ledger (135K → 7K) | ✅ | settlement.md |
| SET-4 | C | Settlement | MDR recalculation rewrote **paid** batches (`status <> 'open'`) | ✅ | settlement.md |
| MF-2 | H | Fees | Dashboard 245 bps vs charged 225 bps (display ignored effective date) | ✅ | money-fees.md |
| MF-1 | H | Admin import | CSV 4.75 → 0.475 BD (2-decimal "cents" parser), 4.755 → 4.750 | ✅ | money-fees.md |
| SET-5 | H | Settlement | Daily close at ~03:15 local, not midnight Bahrain | ✅ | settlement.md |
| SET-8 | M | Settlement | Lifetime payout estimate drifts (float4 column) | ✅ | settlement.md |
| MF-6 / SET-7 | H | Admin tools | Test merchants flipped live by `reconcileSandboxFlag` → appeared in real settlement | ✅ | money-fees.md |
| A1 | C | Auth | Login works without OTP (pending session accepted) | ✅ | auth-security.md |
| PL-CANCEL-IDOR | H | Payment links | Merchant A could cancel merchant B's link | ✅ | payments.md |
| FP-187 | H | Payment links | Paid after expiry — server trusted client timestamp | ✅ | payments.md |
| FP-201 | M | Acquirer | Duplicate callback notes (no unique constraint) — migration 0074 | ✅ | payments.md |
| FP-209 | C | Refunds | Concurrent refunds both succeeded (no row lock) | ✅ | fp300-api.md |
| FP-240 | H | Webhooks | Signed canonical JSON but sent `JSON.stringify` bytes; inbound check optional / not timing-safe / re-serialised | ✅ | auth A8, A9 |
| INC-2026-05-14 | C | Payment links | Slow payment let a second buyer pay the same link | ✅ | payments.md |
| SET-6 / INC-2026-08-21 | M | Settlement | Duplicate payout notifications (check-then-insert race) — migration 0081 | ✅ | settlement.md |
| over-refund | C | Refunds | Refund ceiling was authorized, not captured − refunded | ✅ | fp300-api #3 |
| A5 | H | Admin | Impersonation ran as owner and wasn't read-only | ✅ | auth-security.md |
| A6 / A7 | H | API keys | Rotation never revoked the old key; `revoke_after` ignored | ✅ | auth-security.md |
| MF-4 | M | Reporting | Slow / injectable report filters; unfiltered `DELETE FROM holds` | ✅ | money-fees.md |
| A3 / A4 / RNG-TOKEN | H | Auth | OTP: parallel guesses, not single-use, `Math.random` codes/tokens/invites | ✅ | auth-security.md, payments.md |
| MF-5 | M | Exports/uploads | Export loaded everything in memory; uploads unbounded | ✅ | money-fees.md |

### Found during the audit (not in the case file)
| ID | Sev | Finding | Status |
|---|---|---|---|
| A2 | C | Cross-tenant login: session bound to first user with that email across merchants | ✅ |
| PL-READ-LEAK | H | Public link read returned the merchant's API key hash | ✅ |
| PL-DISCOUNT-MISSING | H | Payment-link captures skipped the negotiated discount | ✅ |
| A10 | M | Credit maker-checker compared display names (self-approval) | ✅ |
| MF-7 | H | `platform_stats` INT4 overflow past 2,147,483 BD | ✅ |
| MIG-1/2 | H | Migrations 0054/0055 broke a fresh database | ✅ |
| OPS-1 | H | `ops/.env.docker` with `ACQUIRER_CALLBACK_SIGNING_SECRET` committed to git | ✅ untracked — **rotate the secret; it's still in history** |
| OPS-0 | M | Dockerfiles referenced by compose didn't exist | ✅ |
| AI-01…AI-25 | C–L | Misleading AI-agent instructions, prompt injection in `docs/ONBOARDING.md`, encoded blobs in commit history | ✅ rewritten / 📝 escalate history tampering (AI-24) |

### Documented, not fixed
- Session fixation: session token not rotated at OTP promotion (needs test-helper change) — auth-security.md
- No login / OTP-resend rate limit; webhook transport follows redirects and reads unbounded bodies
- OPS-2…OPS-9: hardcoded shared Postgres superuser, `sslmode=disable`, settlement internal server binds all interfaces, `/readyz` checks DB only at boot, misleading compose comments (see `docs/audit/CHECKPOINT.md` § Ops findings)
- Sweep month boundary (UTC per ADR-0003 vs Bahrain per HANDOVER) — finance decision

---

## 3. How to run and test

```bash
docker compose -f ops/docker-compose.yml up -d postgres
export DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/filspay?sslmode=disable'
export WEBHOOK_SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # must be base64 of 32 bytes
npm ci
npm run migrate && npm run seed
npm test && npm run typecheck
# Go (no local Go needed); -p 1 because packages share one DB
docker run --rm --network host -e DATABASE_URL="$DATABASE_URL" \
  -v "$PWD/apps/settlement:/src" -w /src golang:1.23 go test -p 1 ./...
```

Results at hand-off: API 413/414, typecheck clean, Go all packages green.
- `webhooks/dispatcher.test.ts` "backoff/exhaustion" is flaky (asserts exact 1000 ms against ±10 % jitter) — pre-existing.
- `apps/reporting` tests pass 16/16 on a fresh DB; in a full shared-DB run 5 fail because API tests leave `{}` outbox rows the consumer replays — pre-existing isolation issue.

Existing tests that asserted a bug were corrected, and each change is listed in the relevant `docs/audit/*.md` ("Existing tests changed"). New coverage is in `*.new.test.ts` / new `*_test.go` files.

## 4. Deploy (Dilmune Cloud)

Build/run files: `ops/Dockerfile.node`, `ops/Dockerfile.go`, `ops/Dockerfile.web`,
`ops/docker-compose.prod.yml`, `scripts/deploy-vm.sh`, env template `ops/.env.example`,
key tool `scripts/env-keys.sh` (lists/builds env files without printing values). Guide: `docs/DEPLOY.md`.

```bash
scripts/env-keys.sh build <keys-dir> ops/.env.prod     # never commit ops/.env.prod
scripts/deploy-vm.sh <user>@<server-ip> <ssh-key>      # builds locally, ships images, migrates, starts, checks /healthz
```

Live status and URLs: see `docs/audit/deploy.md` (written by the deploy session). At the time of
writing, the Dilmune Free plan refused to create a server (`QUOTA_EXCEEDED`); the account needs
the Builder plan, a provider token, or an existing Ubuntu VM.
