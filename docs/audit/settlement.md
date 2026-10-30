# Settlement (Go) audit notes

## SET-1 — Scheme statement total always a few fils higher than ours
- **Severity:** High (money, reconciliation)
- **Where:** `apps/settlement/internal/settlement/scheme_export.go` (`SchemeAmountBD`), `batch.go` CloseBatch step 12, `LoadSchemeExportLines`
- **What's wrong:** each scheme line's BD text was `float64(gross)/1000` stored into `NUMERIC(10,2)`, which rounds half-up (4.747 BD → 4.75). Our side (`amount_fils`) truncates to 10 fils (4.74). So the file sent to the scheme was ≥ our figure on every line — always over, never under — exactly Finance's symptom. The 0–9 fil residue was also never journaled, contrary to ADR-0002.
- **Why:** two independent conversions of the same amount (truncate for the ledger, round for the file) plus float math on money.
- **What it breaks:** scheme statement never ties to the ledger; the gap grows with volume; the March "sweep" scripts were attempts to paper over it.
- **Fix:** derive the file text from the already-truncated `amount_fils` with integer formatting (`SchemeAmountText`), read it back the same way in `LoadSchemeExportLines`, and journal the residue per line in the same transaction (credit `card_scheme_clearing`, debit `scheme_rounding_residue`, as ADR-0002 specifies).
- **Test:** existing `scheme_export_test.go` / `batch_test.go` green; `go vet` clean.
