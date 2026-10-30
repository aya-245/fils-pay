-- Additional suspense accounts for future reconciliation lanes.
-- Suspense accounts are modelled as 'asset' (same as scheme_rounding_residue in 0007).

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference', 'asset'),
  ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;
