package settlement

import (
	"context"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// High-volume merchants: the lifetime estimate must stay exact past 2^24 fils.
func TestUpdateLifetimePayoutMonitoringEstimate_LargeValuesExact(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	const n, payout = 40, 999_999 // 40 x 999.999 BD = 39,999,960 fils
	for i := 0; i < n; i++ {
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, money.Fils(payout)); err != nil {
			t.Fatalf("update: %v", err)
		}
	}
	var got int64
	if err := tx.QueryRow(ctx, `SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1`, merchantID).Scan(&got); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got != n*payout {
		t.Fatalf("estimate = %d, want %d", got, n*payout)
	}
}
