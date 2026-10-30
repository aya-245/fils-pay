package settlement

import (
	"context"
	"sync"
	"testing"
	"time"
)

// INCIDENT 2026-08-21: concurrent enqueuers must still produce exactly one
// settlement.paid per batch.
func TestEnqueuePayoutNotifications_ConcurrentRunsEnqueueOnce(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	batchID := insertBatch(t, pool, merchantID, time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC), "paid", 12_345)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := EnqueuePayoutNotifications(context.Background(), pool); err != nil {
				t.Errorf("EnqueuePayoutNotifications: %v", err)
			}
		}()
	}
	wg.Wait()

	if n := countPaidEvents(t, pool, batchID); n != 1 {
		t.Fatalf("settlement.paid events for batch = %d, want 1", n)
	}
}
