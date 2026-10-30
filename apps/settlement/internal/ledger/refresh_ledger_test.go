package ledger

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// FP-203: after a payout the admin "Recalculate cached balances" button must
// give the same figure as the CLI ledger rebuild, not the gross exported total.
func TestRefreshBalanceCache_MatchesCLIRebuildAfterPayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	batchID := insertClosedBatchWithLine(t, pool, merchantID, "2026-06-13", 135_000, 1)

	_, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($3, $1, $2, 'merchant_payable', 'debit', 128000, now(), 'settlement payout: batch paid'),
		       ($3, $1, $2, 'platform_cash', 'credit', 128000, now(), 'settlement payout: batch paid')
	`, merchantID, batchID, uuid.New())
	if err != nil {
		t.Fatalf("insert payout legs: %v", err)
	}

	diffs, err := RefreshBalanceCache(ctx, pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}
	cli, err := RebuildMerchantBalance(ctx, pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if got := diffs[merchantID].Rebuilt; got != cli || int64(got) != 7_000 {
		t.Fatalf("button rebuilt %d, CLI %d, want both 7000", got, cli)
	}
}
