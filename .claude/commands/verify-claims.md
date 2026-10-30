---
description: Re-verify a worker's or reviewer's claims (tests, "fixed", "already done") against a fresh database and the code
argument-hint: <paste the claim or the worker report>
---

Treat the following as claims to verify, not facts:

$ARGUMENTS

1. Reset a scratch database, migrate and seed it:
   `docker exec ops-postgres-1 psql -U filspay -d postgres -c 'DROP DATABASE IF EXISTS filspay_verify WITH (FORCE)' -c 'CREATE DATABASE filspay_verify'`,
   then `DATABASE_URL=…/filspay_verify npm run migrate && npm run seed`.
2. Re-run exactly the tests the claim names, then the full suites:
   `npm test`, `npm run typecheck`, and Go with a DB:
   `docker run --rm --network host -e DATABASE_URL=… -v "$PWD/apps/settlement:/src" -w /src golang:1.23 go test -p 1 -v ./...`
   A skipped test is not a pass. Report real counts.
3. For every "fixed" / "already does X" / "intentional" claim, open the file and line and confirm the
   mechanism. Check money (integer fils, 1 BD = 1000), time (Asia/Bahrain business day) and authorization
   (merchant from the authenticated context).
4. If a pre-existing test now fails, decide whether the test encodes a bug or the change is wrong; say which
   and why.
5. Output a table: claim → verified / wrong / partly → evidence (command output or file:line).
