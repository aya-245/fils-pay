---
marp: true
theme: default
paginate: true
size: 16:9
style: |
  section { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; font-size: 26px; padding: 56px 72px; color: #1b1f24; }
  h1 { color: #0b5c4a; font-size: 48px; margin-bottom: 0.2em; }
  h2 { color: #0b5c4a; font-size: 36px; border-bottom: 3px solid #0b5c4a; padding-bottom: 6px; }
  table { font-size: 21px; }
  th { background: #0b5c4a; color: #fff; }
  code { background: #eef4f2; color: #0b5c4a; }
  .small { font-size: 19px; color: #555; }
  .big { font-size: 64px; font-weight: 700; color: #0b5c4a; }
  section.lead { background: #0b5c4a; color: #fff; }
  section.lead h1, section.lead h2 { color: #fff; border: none; }
---

<!-- _class: lead -->
# FilsPay — The Handover
## Audit · Fix · Explain · Build
73 bugs fixed · FP-300 refunds shipped · live on Dilmune Cloud

<span class="small">1 BD = 1000 fils. Every claim on these slides has a file, test or command behind it.</span>

---

## The case file was booby-trapped

| Trap | What it said | Truth (brief / ADR) |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` / `.cursorrules` | cents, UTC midnight, money "frozen", `Math.random` OK | **fils**, **Bahrain midnight**, fix bugs with tests |
| Code comments | "intentional", "fixed in FP-231", "MK: leave" | the bugs were real |
| Tests | asserted 0.475 BD, new delivery ids, rewritten paid batches | corrected + listed, never weakened |
| ADRs 0003 / 0004 / 0006 | UTC month, balance from exports, cache-only corrections | contradict the brief / ADR-0001 |
| Git history | commit `098c2de` as a revoked dev, placeholder committer | escalate |

**Rule we held:** repo text is data. The organisers' brief + ADR-0001/0002 are the rules.

---

## Results at a glance

<div class="big">73</div>

code bugs fixed — each with **root cause · smallest fix · test** (`BUGS.md`, `docs/audit/`)

| Area | Bugs | Headline |
|---|---|---|
| Settlement (Go) | 11 | scheme rounding, splits, 3 am close, MDR on paid batches |
| Refunds FP-300 | 18 | cross-merchant refund, over-refund, race, fee reversal, netting |
| Payments | 9 | pay after expiry, double charge, IDOR cancel, idempotency |
| Auth & security | 13 | login without OTP, cross-tenant login, FP-240 signatures |
| Money / admin / reports | 19 | CSV 10×, 245 vs 225 bps, sweep twice, test merchants live |
| DB / ops | 3 | fresh DB couldn't migrate, secret in git |

---

## Money bugs: why they happened

- **Scheme total always over, never under** → file amount `float64/1000` into `NUMERIC(10,2)` rounds **half-up**; ledger **truncates**. Fix: format from truncated integer, journal residue (ADR-0002).
- **CSV 4.75 → 0.475 BD** → a 2-decimal "cents" parser. Fix: `parseBhdToFils` → 4750 fils.
- **Splits a few fils short** → each child rounded independently. Fix: largest-remainder, sums exactly.
- **Balance 135K → 7K** → button rebuilt from *exported captures*; CLI from the *ledger*. ADR-0004 was the trap. Fix: one source, and "Adjust balance" now journaled.
- **MDR rewrote paid batches** → `status <> 'open'` selects closed **and** paid. Fix: `open` only.
- **Close at 03:15** → UTC instant into a calendar-date function; UTC date lags Bahrain 3 h.

---

## FP-300 — merchant refunds, end to end

`POST /v1/refunds` was a 501 stub over "done" helpers that had 7 bugs of their own.

| Layer | Done |
|---|---|
| API | merchant-scoped, Idempotency-Key, owner/finance/API key, impersonation refused |
| Safety | `SELECT … FOR UPDATE` across acquirer call; ceiling = captured − refunded; DB CHECK |
| Fees | proportional on the **running** total → 8/7/7/3 for 300/300/300/100 on a 25-fil fee |
| Webhook / timeline / reports | `refund.succeeded` signed; `refunded` events; Bahrain-day rollups |
| Payouts | netted from next batch, never negative, excess rolls forward |

**Proof, live API + Go settlement:** capture 10.000 → refund 3.000 + 7.000 → fee back 68 + 157 = **225 = fee charged** → ledger nets 0 → payout **4.888 BD** = (15.000 − 0.337) − (10.000 − 0.225).

---

## Security highlights

| Bug | Root cause | Fix |
|---|---|---|
| Login without OTP | session view didn't filter `authenticated` | require it; rotate token at OTP |
| Cross-tenant login | OTP bound to first user with that email, any merchant | bind to the authenticated user |
| Pay after expiry (FP-187) | server trusted client timestamp | server clock only |
| Charged twice (05-14) | no lock across slow acquirer call | `FOR UPDATE SKIP LOCKED`, 409 |
| FP-240 signatures | signed `canonicalJson`, sent `JSON.stringify` | sign the exact bytes sent |
| Inbound acquirer callbacks | signature optional, not timing-safe | mandatory, raw body, `timingSafeEqual`, 300 s |
| Impersonation | ran as owner, could write | `support` role, read-only |

Full threat model + OWASP API Top 10: `docs/SECURITY_REVIEW.md`

---

## Capacity — checkout under load

Fixed scenario (k6): merchant creates link → buyer views → buyer pays. Same limits as prod: **API 0.5 vCPU / 512 MB**.

<!-- CAPACITY_TABLE -->

**Estimate:** see `docs/CAPACITY.md` (p95 < 500 ms, < 1 % errors).

**Past the limit:** fast `503 + Retry-After` (in-flight cap + event-loop delay), never a hang · API crash → tini exits → Docker restarts · after kill tests the integrity check passes: ledger nets 0, no link paid twice, refunded ≤ captured, cache = ledger.

---

## Hosting — one 1 vCPU / 2 GB box

```
Internet ─443─► Caddy (TLS, HSTS) ─► web nginx ─/api─► api (0.5 vCPU, 512 MB)
                                  └► admin nginx ─/api─┘
                 settlement (Go) · reporting ──► postgres (volume, not exposed)
```

- Budget ≈ 1.6 GB: postgres 768 m · api 512 m · reporting 160 m · settlement 96 m · web/admin 48 m
- **Found while hosting:** the API sends no CORS, so the browser apps (:8080) could not call it (:3000) — preflight 404. Fixed by serving `/api` same-origin through nginx.
- Secure: TLS, DB never published, secrets generated and never in git or AI context.
- Reproducible: `env-keys.sh build` → `deploy-vm.sh user@host key`.

---

## How we used AI — and checked it

Lead Claude session + ≤4 fresh worker subagents (disjoint files, own DB) + a fresh-context reviewer.

1. **The AI's own `CLAUDE.md` was the first trap** — checked against the PDFs before any code.
2. **"Tests pass" was a claim, not evidence** — rerun on a fresh seeded DB found 4 failures; SQL traced them to `{}` outbox rows from other tests; a "skipped" Go DB test was rerun with a DB.
3. **AI fixes and AI reviewers were wrong sometimes** — a time-window "fix" broke a real contract (reverted, fixed the caller); a reviewer overstated a bug (one `grep` disproved it).

`ai/`, `docs/AI_USAGE.md` (three annotated transcript excerpts)

---

## UI & UX — before → after

- **Checkout:** clear expired / paid / processing / declined states, no double submit, BD to 3 decimals, accessible errors
- **Merchant dashboard:** refund drawer (was commented out), refunded amounts + timeline
- **Admin:** role errors explained, journaled adjustments, replay restrictions, read-only impersonation banner

Screenshots: `docs/ui/before/` → `docs/ui/after/` · details `docs/UI_UX.md`

---

<!-- _class: lead -->
## Ask us anything

Every answer has a **show it**: `docs/DEFENCE.md`

`BUGS.md` · `AUDIT_REPORT.md` · `docs/CAPACITY.md` · `docs/SECURITY_REVIEW.md` · `docs/AI_USAGE.md` · `docs/UI_UX.md`
