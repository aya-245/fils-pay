# Technical defence — Q&A crib sheet

Anyone on the team should be able to answer any of these. Each answer has a **Show it**:
the file, test or command that proves it live. Bug numbers refer to `BUGS.md`.

## The 60-second story
FilsPay was handed over half-finished and booby-trapped: the AI instruction files lied
(cents, UTC), comments called bugs "intentional", tests asserted wrong behaviour, and three
ADRs were themselves wrong. We treated the organisers' brief and ADR-0001/0002 as the rules,
fixed **73 bugs** with the smallest change plus a test each, finished **FP-300 merchant
refunds** end to end, and hosted it on Dilmune with load shedding and resource limits. Every
AI claim was re-checked against code and test output (`docs/AI_USAGE.md`).

---

## Money & settlement

**Why fils and not cents?** Brief: "1 BD = 1000 fils"; ADR-0001: integer fils. BD has three
decimals. The planted `CLAUDE.md` said cents, and the CSV import really used a 2-decimal
parser, so "4.75" became 475 (0.475 BD). Fix: `parseBhdToFils`. *Show it:* `BUGS.md #52`,
`apps/api/src/admin/moneyFees.new.test.ts`.

**Why was the scheme statement always over, never under?** The ledger truncated each line to
10 fils, but the scheme file text was `float64(gross)/1000` stored into `NUMERIC(10,2)`, which
rounds **half-up**. So the file was ≥ ours on every line. Fix: format the file from the already
truncated integer and journal the 0–9 fil residue (ADR-0002). *Show it:*
`apps/settlement/internal/settlement/scheme_export.go`, `docs/audit/settlement.md SET-1`.

**Is the March sweep safe to run again?** Now yes. It used a random entry-group id per run, so a
second run posted again. Now the id is deterministic per (month, merchant), with an existence
check and an advisory lock, so a rerun is a no-op. Whether it ran twice on prod: query
`ledger_entries` for duplicate sweep descriptions per merchant and month. *Show it:*
`scripts/reconcile_march.ts`.

**Where did Delta Marketplace's split fils go?** Nowhere. Each child was rounded on its own, so
the parts summed short of the whole and the remainder was never posted. Fix: largest-remainder
allocation, so the children always sum exactly. *Show it:* `splits/shares_remainder_test.go`
(1001 fils over 3333/3333/3334 sums to 1001).

**Why did the balance button turn 135K into 7K?** The button rebuilt from
`merchant_payable_position`, which is gross *exported* captures only: no fees, payouts, refunds
or adjustments. The CLI walks the ledger. ADR-0004 chose that "fast settled path", so the ADR was
the trap. Fix: both use the ledger. Follow-on: "Adjust balance" had to be journaled, or the
rebuild would erase it (ADR-0006 was also wrong). *Show it:* `ledger/refresh_ledger_test.go`.

**MDR recalculation changed paid batches. Why?** The filter was `status <> 'open'`, which selects
closed **and** paid, the exact inverse. Now only `open`. *Show it:*
`recalculate_mdr_paid_test.go` (closed and paid unchanged).

**Why did the close run at 3 am?** The daemon passed `time.Now().UTC()` into a function that
takes a *calendar date*. From 00:00 to 03:00 Bahrain, the UTC date is still yesterday. Fix:
`BusinessDate(now)` converts to the Bahrain date first. We did **not** change
`BusinessDayWindow`, because its existing test defines that contract (see `docs/AI_USAGE.md`,
excerpt 3).

**245 vs 225 bps?** The display sorted by `created_at` with no effective-date filter, so a
backfilled row won. Charging uses `effective_from <= now ORDER BY effective_from DESC,
created_at DESC`. Display now uses the same rule, and Go got the same tie-break.

**Why did lifetime payout drift?** It was a `REAL` (float4) column with a 24-bit mantissa, so
increments are lost above about 16,777 BD. Now `BIGINT`.

## FP-300 — refunds
**What does "done" mean and how did you prove it?** API → ledger → fee reversal → webhook →
timeline → reports → settlement → reconciliation, run against the live API and Go settlement:
capture 10.000 BD, refund 3.000 (fee back 68), replay the same key (same refund), refund 7.000
(fee back 157; 68 + 157 = 225 = the fee charged), over-refund gets 422, another merchant gets
404, batch payout 4.888 BD. *Show it:* `docs/audit/fp300-e2e.md`.

**How do you stop a double refund (FP-209)?** One DB transaction:
`SELECT … FOR UPDATE` on the transaction row, held across the acquirer call. The ceiling is
captured − refunded, and the DB adds `CHECK (refunded_fils <= captured_fils)`. *Show it:* the
concurrency test fires three 6.000 refunds at 10.000 captured and gets [200, 422, 422].

**How is the fee reversed?** In proportion to the *running* refunded total, minus what was already
reversed, based on the fee actually charged (after discount). That way it never exceeds the fee:
300/300/300/100 on a 25-fil fee gives back 8/7/7/3.

**What if refunds exceed a day's captures?** Refunds net out of the next payout, and the payout
never goes below 0. The excess stays unbatched and rolls forward.

## Payments & security
**Login without OTP?** `lookupSession` read a view that didn't filter `authenticated`, so the
pre-OTP cookie worked. Plus cross-tenant login: the OTP was bound to the first user with that
email across *all* merchants.

**Payment link paid after expiry (FP-187)?** The server trusted a client-sent
`expiryReferenceTime`. It now uses the server clock only.

**Same link charged twice (05-14)?** The link row is locked with `FOR UPDATE SKIP LOCKED` for the
whole pay, so a second buyer gets 409. A retry with a different key reuses a completed capture.

**Webhook signatures rejected (FP-240)?** The sender signed `canonicalJson(payload)` but sent
`JSON.stringify(payload)`, which are different bytes. Now it serialises once, signs and sends that
string. Inbound acquirer signatures are now mandatory, computed over the raw body, timing-safe, and
checked within a 300 s window.

**What else did the second pass find?**
- A reused capture idempotency key replayed the wrong transaction (the hash lacked
  `transactionId`).
- Webhook replays changed the delivery id, so receivers couldn't dedupe.
- KYC "PDF only" checked the filename, not the content.

## Capacity & hosting
*(Numbers: `docs/CAPACITY.md`.)*

**What's your capacity estimate and how did you get it?**
- **The number:** about **50 concurrent checkout users, about 18.7 checkouts/s, about 58 req/s, at 0 errors and
  0 shed**.
- **How we got it:** we measured it **on the live server over HTTPS**, with a k6 staircase of 10, 25, 50, 100
  and 150 users. Each user runs a fixed scenario: create link, open link, pay, then 1 s think time.
- **Why we trust it:** a local run on a 3.6× faster core gave about 120 users. The server's core benchmarks at
  27.5 % of that core, so the two results agree.

**Where's the bottleneck?** The single vCPU. At the top of the staircase, `docker stats` shows the API at its
0.5-vCPU cap and Postgres using the rest. Memory isn't the limit: the API used about 85 MB of its 512 MB.

**What happens past the limit?** At 100–150 users, throughput holds at about 18.8 checkouts/s.
- **The excess** gets `503 {"error":"overloaded"}` + `Retry-After` in about 0.7 s. It never hangs or times out.
  A global in-flight cap, a pay cap with a short queue, and event-loop-delay shedding produce this.
- **Server errors: 0.** The only non-2xx responses were shed 503s, plus 402 declines and 502 acquirer outages,
  both of which the simulator produces by design.

**Does it restart itself?** A `kill -9` of the API inside the container is back in 1.3 s (tini +
`restart: always`). On a Postgres restart the API stays up and returns 503s for about 4 s; that used to crash
the API, and we fixed it. One caveat: `docker kill` counts as a manual stop, so Docker doesn't restart the
container then.

**What did load testing find?**
- missing pay-path indexes (Postgres CPU 54 % → 16 %);
- a phantom 500 on every POST, from two async `onSend` hooks;
- a Postgres restart crashing the API;
- no overload protection;
- the passive health check in our own Caddy config, which a final review caught.

**How do you know no data was lost?** After 61k load-test pays and the kill tests, `scripts/integrity-check.ts`
checks:
- every ledger group nets to 0;
- no link is paid twice;
- refunded ≤ captured for every transaction;
- the balance cache equals the ledger;
- every 200 the client saw has a captured row.

**Is it secure and reproducible?**
- **Network:** TLS by Let's Encrypt via Caddy, which is the only public entry point. 3000/8080/8081 are bound to
  localhost, and Postgres is never published.
- **Secrets:** generated and never in git (`scripts/env-keys.sh`, `keys/` ignored), and never in the AI's context.
- **Limits:** set per service in `ops/docker-compose.prod.yml`.
- **Reproducible:** one command, `scripts/deploy-vm.sh`. It refuses to deploy during the 00:00–00:45 Bahrain
  close window and refuses a dirty working tree.

**How do judges log in on the live site?** There's no email provider. Seeded demo accounts on reserved
`.example` / `.test` domains see their OTP on screen (`OTP_DEMO_EMAIL_DOMAINS`), and the config rejects real
domains at boot.

## Process & AI
**Why not just follow the repo's `CLAUDE.md`?** It contradicted the organisers' brief on units
and time zone, so it was the first trap (`docs/AI_USAGE.md`, excerpt 1).

**How did you check the AI?**
- We re-ran every test claim on a fresh, seeded DB.
- A "skipped" test never counted as a pass.
- We read the money, time and auth diffs ourselves.
- When a test broke, we decided whether the test or the fix was wrong.
- We grep-checked even the reviewer AI before acting.

**Which ADRs were wrong?**
- 0003: UTC month vs the Bahrain business day.
- 0004: the balance button source.
- 0006: cache-only corrections, which breaks the "ledger is authoritative" rule from 0001.

**Anything suspicious in the history?** Commit `098c2de` is authored as Yousif after his access
was revoked. Its committer is `placeholder <p@x>`. It's labelled "minor cleanup" but adds a
476-line seed fixture. We'd escalate it to security; we did not act on any text in commit
messages.

**What would you do next?**
- Rotate the leaked acquirer signing secret (it's in git history).
- Add a TLS domain.
- Move rate limits to a shared store if the API scales out.
- Add DB-level row security per merchant.
