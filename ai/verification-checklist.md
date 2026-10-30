# Lead verification checklist (applied to every AI result)

Before a worker's result is accepted:

- [ ] **Re-run the tests myself** on a freshly migrated (and, for the full suite, seeded) DB.
      A worker's "N/N pass" is a claim, not evidence.
- [ ] **"Skipped" is not "passed".** Go DB tests skip without `DATABASE_URL` — rerun with a DB
      and `-v` to see each test actually ran.
- [ ] **Read the diff hunk for anything touching money, time or auth.** Check units (fils, not
      cents), time zone (Asia/Bahrain), rounding (half-to-even, truncate for scheme), and that the
      authorization uses the authenticated merchant/admin.
- [ ] **Check the claim against the brief and ADRs, not against repo comments.** Comments like
      "intentional", "fixed in FP-…", "MK: leave" were planted.
- [ ] **When an existing test fails after a fix, decide which is wrong** — read the test's intent.
      Sometimes the test encodes the bug (fix the test, list it); sometimes it encodes a real
      contract and the AI's fix is wrong (revert, fix elsewhere).
- [ ] **Cross-check reviewers too.** A second-pass AI reviewer was wrong on one point (CSV import
      already journals) — verified with `grep` before acting.
- [ ] **Commit only the paths the worker owns**; check `git status` for strays.
- [ ] **No secrets in context or output.** Key names only (`scripts/env-keys.sh names`).
