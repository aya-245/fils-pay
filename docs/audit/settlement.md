# Settlement (Go) audit notes

## SET-1 — Scheme statement total always a few fils higher than ours
- **Severity:** High (money, reconciliation)
- **Where:** `apps/settlement/internal/settlement/scheme_export.go` (`SchemeAmountBD`), `batch.go` CloseBatch step 12, `LoadSchemeExportLines`
- **What's wrong:** each scheme line's BD text was `float64(gross)/1000` stored into `NUMERIC(10,2)`, which rounds half-up (4.747 BD → 4.75). Our side (`amount_fils`) truncates to 10 fils (4.74). So the file sent to the scheme was ≥ our figure on every line — always over, never under — exactly Finance's symptom. The 0–9 fil residue was also never journaled, contrary to ADR-0002.
- **Why:** two independent conversions of the same amount (truncate for the ledger, round for the file) plus float math on money.
- **What it breaks:** scheme statement never ties to the ledger; the gap grows with volume; the March "sweep" scripts were attempts to paper over it.
- **Fix:** derive the file text from the already-truncated `amount_fils` with integer formatting (`SchemeAmountText`), read it back the same way in `LoadSchemeExportLines`, and journal the residue per line in the same transaction (credit `card_scheme_clearing`, debit `scheme_rounding_residue`, as ADR-0002 specifies).
- **Test:** existing `scheme_export_test.go` / `batch_test.go` green; `go vet` clean.

## SET-2 — Delta Marketplace split payouts: children don't add up to the parent
- **Severity:** High (money disappears every batch)
- **Where:** `apps/settlement/internal/splits/allocate.go` (`PayoutSplitBatch`), `shares.go` (`ChildShares`)
- **What's wrong:** each child's share was `ApplyRateFils(net, weightBps)`, i.e. rounded independently. The per-child rounding errors don't cancel, so the children sum to a few fils (tens with many children) less than `net_payout_fils`. The remainder was never posted anywhere — that's why Finance "can't find them in the ledger". The cache was also reduced by the smaller allocated total, so it drifted from the batch.
- **Why:** independent rounding of parts of a whole; the existing test only used weights that divide evenly.
- **What it breaks:** parent shows a residual payable that never pays out; children are underpaid every batch.
- **Fix:** largest-remainder allocation (floor each share, hand the leftover fils to the largest remainders). Shares always sum exactly to the batch net; weights not totalling 10000 still allocate the whole payout proportionally. `PayoutSplitBatch` now uses `ChildShares`.
- **Test:** `splits/shares_remainder_test.go` (1001 fils over 3333/3333/3334, 7 fils, 99 fils over 4 children, etc.).

## SET-3 (FP-203) — "Recalculate cached balances" gives a different number than the CLI
- **Severity:** Critical (merchant balance shown as 7K instead of 135K)
- **Where:** `apps/settlement/internal/ledger/refresh.go` (`RefreshBalanceCache`, used by the admin button via `internalapi/server.go`) vs `ledger/rebuild.go` (CLI)
- **What's wrong:** the button rebuilt from the view `merchant_payable_position`, which is the SUM of gross `scheme_export_lines` — exported captures only. It ignores fees, payouts, refunds, manual adjustments and unexported (not yet batched) captures. The CLI sums the `merchant_payable` account in `ledger_entries`, which is what the cache means.
- **Why:** ADR-0004 chose a "faster settled-data path", but that path computes a different quantity; its "they agree whenever the cache is consistent" consequence is false.
- **What it breaks:** pressing the button overwrites every merchant's balance with a wrong figure; Yousif had to run the CLI to repair it.
- **Fix:** the button uses the same ledger source as the CLI (`merchant_payable` credit − debit), in one transaction.
- **Test:** `ledger/refresh_ledger_test.go` (button == CLI after a payout). Existing `refresh_test.go` helper changed: it seeded export lines with **no ledger legs** (impossible for a real batch, and it encoded the bug) — it now posts the matching balanced capture legs; expectations unchanged.
