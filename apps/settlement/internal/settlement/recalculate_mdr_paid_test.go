package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// reopenBatch puts a just-closed batch back to 'open' so a test can exercise
// RecalculateMDR's fee math on a batch it is allowed to change.
func reopenBatch(t *testing.T, pool *pgxpool.Pool, batchID uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `UPDATE settlement_batches SET status = 'open', closed_at = NULL WHERE id = $1`, batchID); err != nil {
		t.Fatalf("reopenBatch: %v", err)
	}
}

// Finance memo: MDR recalculation must not change closed or paid batches.
func TestRecalculateMDR_LeavesClosedAndPaidBatchesAlone(t *testing.T) {
	for _, status := range []string{"closed", "paid"} {
		t.Run(status, func(t *testing.T) {
			pool := mustPool(t)
			ctx := context.Background()
			merchantID := insertActiveMerchant(t, pool, 250)

			businessDate := time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC)
			start, _ := BusinessDayWindow(businessDate)
			insertCaptureEvent(t, pool, merchantID, 250, 4750, start.Add(time.Hour))

			closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
			if err != nil {
				t.Fatalf("CloseBatch: %v", err)
			}
			if status == "paid" {
				if _, err := pool.Exec(ctx, `UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1`, closed.BatchID); err != nil {
					t.Fatalf("mark paid: %v", err)
				}
			}
			if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
				t.Fatalf("update mdr_bps: %v", err)
			}

			from, to := recalcWindow(businessDate)
			result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
			if err != nil {
				t.Fatalf("RecalculateMDR: %v", err)
			}
			if len(result.Adjusted) != 0 {
				t.Fatalf("adjusted %d %s batch(es), want 0", len(result.Adjusted), status)
			}
			var fee, net int64
			if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&fee, &net); err != nil {
				t.Fatalf("read batch: %v", err)
			}
			if fee != int64(closed.FeeFils) || net != int64(closed.NetPayoutFils) {
				t.Fatalf("%s batch changed: fee %d->%d net %d->%d", status, closed.FeeFils, fee, closed.NetPayoutFils, net)
			}
		})
	}
}

// The daemon passes a UTC "now"; late-evening UTC is already the next
// Bahrain day, so the window must be that Bahrain day (close at ~00:15 local, not 03:15).
func TestBusinessDate_UsesBahrainDateOfUTCInstant(t *testing.T) {
	now := time.Date(2026, 6, 10, 21, 30, 0, 0, time.UTC) // 00:30 on 11 June in Bahrain
	if got, want := BusinessDate(now), time.Date(2026, 6, 11, 0, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("BusinessDate = %s, want %s", got, want)
	}
	start, end := BusinessDayWindow(BusinessDate(now))
	wantStart := time.Date(2026, 6, 10, 21, 0, 0, 0, time.UTC) // 11 June 00:00 Bahrain
	if !start.Equal(wantStart) || !end.Equal(wantStart.Add(24*time.Hour)) {
		t.Fatalf("window = [%s, %s), want start %s", start.UTC(), end.UTC(), wantStart)
	}
}
