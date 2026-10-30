# FilsPay — Submission

**Team:** _(names)_ · **Live:** see §3 · **Repo:** this repository (branch `main`)

FilsPay is a Bahraini payment platform (1 BD = 1000 fils). We were handed a half-finished,
deliberately misleading codebase. We audited it, fixed **73 bugs** with the smallest change
and a test each, explained every root cause, finished **FP-300 merchant refunds** end to end,
and host the whole stack on one 1 vCPU / 2 GB Dilmune server.

| Criterion | Points | Where the evidence is |
|---|---|---|
| Correctness | 100 | §1: `BUGS.md`, `AUDIT_REPORT.md`, `docs/audit/*.md`, `docs/SECURITY_REVIEW.md`, test suites |
| Capacity | 20 | §2: `docs/CAPACITY.md`, `ops/loadtest/` |
| Hosting architecture | 10 | §3: `ops/docker-compose.prod.yml`, `ops/Caddyfile`, `scripts/deploy-vm.sh`, `docs/audit/deploy.md` |
| AI usage and setup | 10 | §4: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `ai/`, `docs/AI_USAGE.md` |
| UI and UX | 10 | §5: `docs/UI_UX.md`, `docs/ui/before/`, `docs/ui/after/` |
| Technical defence | 20 | §6: `docs/deck/`, `docs/DEFENCE.md` |

---

## 1. Correctness

### Findings report (root cause of each problem)
- **`BUGS.md`**: all 73 bugs in one list, each with where it was found and what it was.
- **`AUDIT_REPORT.md`**: an index table for every item in the case file (finance memo, incident
  log, the "things that feel wrong" list) with status.
- **`docs/audit/<area>.md`**: one block per bug: *what's wrong · why it happens · what it
  breaks · fix · test*. Areas: `settlement`, `payments`, `auth-security`, `money-fees`,
  `fp300-*`, `agent-instructions`, `review-pass`.
- **`docs/SECURITY_REVIEW.md`**: threat model, OWASP API Top-10 mapping, and residual risks.

### Every case-file item, closed
| Case file | Item | Fix (bug #) |
|---|---|---|
| Finance memo | Scheme total always a few fils over | #1 |
| | March sweep doubled when run twice | #54 |
| | Delta Marketplace splits short | #2 |
| | "Recalculate cached balances" 135K → 7K | #3, #68 |
| | MDR recalculation changed closed/paid batches | #4 |
| | Dashboard 245 bps vs charged 225 bps | #53 |
| | CSV import 4.75 → 0.475, 4.755 → 4.750 | #52 |
| | Close at 3 am, not midnight | #5 |
| | Lifetime payout estimate drifts | #7 |
| | Test merchants in real settlement | #63, #11 |
| | Login without the OTP | #39 |
| | Cancel another merchant's link | #33 |
| Incident log | FP-187 paid after expiry | #30 |
| | FP-201 duplicate callback notes | #32 |
| | FP-203 balance cache wrong | #3 |
| | FP-209 concurrent refund double money out | #15 |
| | FP-240 webhook signatures (send/sign + inbound) | #47, #48 |
| | 2026-05-14 link charged twice | #31 |
| | 2026-08-21 duplicate payout notifications | #6 |
| | Refund more than charged | #14 |
| | Splits a few fils short | #2 |
| | Admin actions without the right role checks | #43, #49, #50 |
| | Key rotation doesn't do what you'd expect | #45, #46 |
| | Daily close timing | #5 |
| | Suspiciously slow reporting query | #59, #58 |
| | Test merchants and admin tools | #63, #64, #62 |
| | OTP implementation changed, still safe? | #37, #41, #42 |
| | Really large export | #60, #61 |
| Briefing FP-300 | Finish the missing feature end to end | #12–#29, `docs/audit/fp300-e2e.md` |

### Traps we refused
- The repo's `CLAUDE.md`, `AGENTS.md` and `.cursorrules` gave false rules (cents, UTC
  settlement, "money frozen", "Math.random is fine", "never fix tests", "don't fix the 501").
  That's 25 findings in `docs/audit/agent-instructions.md`.
- Tests that asserted bugs were **corrected and listed**, never weakened.
- Three **ADRs were themselves wrong** (0003 UTC month, 0004 balance source, 0006 cache-only
  corrections). See `docs/audit/review-pass.md`.
- **Tampered commit `098c2de`:** authored as a revoked developer, with a placeholder committer;
  it adds a 476-line fixture. Flagged for escalation.

### Tests
```bash
docker compose -f ops/docker-compose.yml up -d postgres
DATABASE_URL=postgres://filspay:filspay_dev_password@localhost:5432/filspay?sslmode=disable
WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
npm ci && npm run migrate && npm run seed && npm test && npm run typecheck
docker run --rm --network host -e DATABASE_URL -v "$PWD/apps/settlement:/src" -w /src golang:1.23 go test -p 1 ./...
```
_Results at submission: see §7._

## 2. Capacity
See **`docs/CAPACITY.md`**: the scenario, method, results table, **our estimate**, the
bottleneck, behaviour past the limit (fast `503 + Retry-After` load shedding, automatic
restart, recovery time), and the data-integrity check after kill tests. Reproduce with
`ops/loadtest/`.

## 3. Hosting architecture
```
Internet ──443──► Caddy (TLS, HSTS) ──► web nginx :8080 ──/api──► api :3000 (0.5 vCPU, 512 MB)
                                   └──► admin nginx :8080 ─/api──┘        │
                                   └──► api (partner API host)            ▼
                    settlement (Go daemon) · reporting (consumer) ──► postgres (volume, not exposed)
```
- **One server:** Dilmune Cloud `Hackademics`, DigitalOcean `s-1vcpu-2gb`, Ubuntu 24.04.
- **Limits:** set per service in `ops/docker-compose.prod.yml`; the API is capped at
  `cpus: 0.5`, `mem_limit: 512m`.
- **Secure:**
  - TLS via Caddy;
  - Postgres is never published;
  - secrets are generated, never committed, and never shown to the AI (`scripts/env-keys.sh`);
  - the firewall allows only the needed ports;
  - security headers are set in the API, nginx and Caddy.
- **Reproducible:** run `scripts/env-keys.sh build keys ops/.env.prod`, then
  `scripts/deploy-vm.sh user@host key`. It builds locally, ships the images, migrates, starts
  everything and smoke-tests it. Steps are in `docs/DEPLOY.md` and `docs/audit/deploy.md`.

## 4. AI usage and setup
- **Setup files in the repo:**
  - `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, rewritten from the planted versions;
  - `ai/README.md`, the operating model;
  - `ai/prompts/`, the actual prompts;
  - `ai/verification-checklist.md`.
- **Three annotated transcript excerpts:** `docs/AI_USAGE.md`.
  1. The AI's own `CLAUDE.md` was the first trap. We checked it against the brief before
     writing any code.
  2. We didn't trust workers' "tests pass". A rerun on a fresh seeded DB, plus SQL, separated
     a regression from a test-isolation fault. A "skipped" Go DB test was not counted as a
     pass.
  3. We rejected an AI fix that broke a real contract (a time-window test), and grep-checked a
     reviewer AI that had overstated a bug.

## 5. UI and UX
See **`docs/UI_UX.md`** for before/after screenshots of checkout, the merchant dashboard and the
admin console (`docs/ui/before|after`, reproducible with `scripts/ui-screenshots.mjs`), with what
changed and why.

## 6. Technical defence
- **Slide deck:** `docs/deck/`.
- **Q&A crib sheet:** `docs/DEFENCE.md`. Every answer has a "show it" file, test or command, so
  any team member can answer and demonstrate.

## 7. Status at submission
_(filled in at the end: test counts, live URLs, capacity estimate)_
