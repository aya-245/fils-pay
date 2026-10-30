package settlement

import (
	"context"
	"testing"
	"time"
)

// A paid batch's fee and net must never change on MDR recalculation; the
// payout based on them has already left the platform.
func TestRecalculateMDR_LeavesPaidBatchesAlone(t *testing.T) {
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
	if _, err := pool.Exec(ctx, `UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1`, closed.BatchID); err != nil {
		t.Fatalf("mark paid: %v", err)
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
		t.Fatalf("adjusted %d batch(es), want 0 for a paid batch", len(result.Adjusted))
	}
	var fee, net int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != int64(closed.FeeFils) || net != int64(closed.NetPayoutFils) {
		t.Fatalf("paid batch changed: fee %d->%d net %d->%d", closed.FeeFils, fee, closed.NetPayoutFils, net)
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
