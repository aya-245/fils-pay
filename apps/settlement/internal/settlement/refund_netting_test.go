package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// --- Pure (no DB) tests -----------------------------------------------------

func TestNetPayableFils_LargeAmountExactToTheFil(t *testing.T) {
	// 16,777.217 BD + change: past float32's 2^24 exact-integer limit.
	cases := []struct{ gross, fee, want money.Fils }{
		{16_777_217, 0, 16_777_217},
		{16_777_219, 2, 16_777_217},
		{123_456_789, 3_086_420, 120_370_369},
		{9_999_999_999, 249_999_999, 9_750_000_000},
	}
	for _, c := range cases {
		if got := NetPayableFils(c.gross, c.fee); got != c.want {
			t.Errorf("NetPayableFils(%d, %d) = %d, want %d", c.gross, c.fee, got, c.want)
		}
	}
}

func TestApplyRefundsToPayout_NetOfRefunds(t *testing.T) {
	// Capture 10.000 BD at 250 bps -> net 9750; partial refund of 4.000 BD
	// with 100 fils fee returned -> deduct 3900.
	r := pendingRefund{id: uuid.New(), amountFils: 4000, feeReversedFils: 100}
	inc, total, net := ApplyRefundsToPayout(NetPayableFils(10_000, 250), []pendingRefund{r})
	if len(inc) != 1 || total != 3900 || net != 5850 {
		t.Fatalf("got included=%d refunds=%d net=%d, want 1/3900/5850", len(inc), total, net)
	}
}

func TestApplyRefundsToPayout_FullRefundNetsToZero(t *testing.T) {
	r := pendingRefund{id: uuid.New(), amountFils: 10_000, feeReversedFils: 250}
	inc, total, net := ApplyRefundsToPayout(NetPayableFils(10_000, 250), []pendingRefund{r})
	if len(inc) != 1 || total != 9750 || net != 0 {
		t.Fatalf("got included=%d refunds=%d net=%d, want 1/9750/0", len(inc), total, net)
	}
}

func TestApplyRefundsToPayout_ExceedingCapturesRollsForward(t *testing.T) {
	a := pendingRefund{id: uuid.New(), amountFils: 3000, feeReversedFils: 75}  // 2925
	b := pendingRefund{id: uuid.New(), amountFils: 8000, feeReversedFils: 200} // 7800, doesn't fit
	c := pendingRefund{id: uuid.New(), amountFils: 100, feeReversedFils: 2}    // fits, but must wait behind b
	inc, total, net := ApplyRefundsToPayout(5000, []pendingRefund{a, b, c})
	if len(inc) != 1 || inc[0].id != a.id {
		t.Fatalf("included = %+v, want only the first refund", inc)
	}
	if total != 2925 || net != 2075 {
		t.Fatalf("refunds=%d net=%d, want 2925/2075", total, net)
	}

	// No captures at all: nothing is batched, payout stays 0, never negative.
	inc, total, net = ApplyRefundsToPayout(0, []pendingRefund{a})
	if len(inc) != 0 || total != 0 || net != 0 {
		t.Fatalf("empty batch: got included=%d refunds=%d net=%d, want 0/0/0", len(inc), total, net)
	}
}

func TestApplyRefundsToPayout_LargeAmountsExact(t *testing.T) {
	// 50,000.001 BD captured, 20,000.003 BD refunded.
	captureNet := NetPayableFils(50_000_001, 1_250_000)
	r := pendingRefund{id: uuid.New(), amountFils: 20_000_003, feeReversedFils: 500_000}
	_, total, net := ApplyRefundsToPayout(captureNet, []pendingRefund{r})
	if total != 19_500_003 || net != 29_249_998 {
		t.Fatalf("refunds=%d net=%d, want 19500003/29249998", total, net)
	}
}

// --- DB-backed tests (skip without DATABASE_URL; need migration 0073) -------

func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeBack money.Fils, occurredAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', $5, 'test', 'merchant_api_key', $6, $7)
		RETURNING id
	`, txnID, merchantID, int64(amount), int64(feeBack), "rf-"+uuid.New().String(), uuid.New(), occurredAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertRefund: %v", err)
	}
	return id
}

func refundBatchID(t *testing.T, pool *pgxpool.Pool, refundID uuid.UUID) *uuid.UUID {
	t.Helper()
	var b *uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&b); err != nil {
		t.Fatalf("read refund batch: %v", err)
	}
	return b
}

func TestCloseBatch_SameDayFullRefundNetsToZero(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, fee := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))
	refundID := insertRefund(t, pool, merchantID, txnID, 10_000, fee, start.Add(2*time.Hour))

	res, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if res.NetPayoutFils != 0 || res.RefundsFils != 10_000-fee || res.RefundCount != 1 {
		t.Fatalf("net=%d refunds=%d count=%d, want 0/%d/1", res.NetPayoutFils, res.RefundsFils, res.RefundCount, 10_000-fee)
	}
	if b := refundBatchID(t, pool, refundID); b == nil || *b != res.BatchID {
		t.Fatalf("refund settlement_batch_id = %v, want %s", b, res.BatchID)
	}
	var stored int64
	if err := pool.QueryRow(context.Background(), `SELECT refunds_fils FROM settlement_batches WHERE id = $1`, res.BatchID).Scan(&stored); err != nil {
		t.Fatalf("read refunds_fils: %v", err)
	}
	if stored != int64(res.RefundsFils) {
		t.Fatalf("refunds_fils = %d, want %d", stored, res.RefundsFils)
	}
	var lines int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM scheme_export_lines WHERE settlement_batch_id = $1`, res.BatchID).Scan(&lines); err != nil {
		t.Fatalf("count scheme lines: %v", err)
	}
	if lines != 1 {
		t.Fatalf("scheme_export_lines = %d, want 1 (capture only, no refund line)", lines)
	}

	// Re-close is a no-op and does not batch the refund twice.
	again, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil || !again.AlreadyClosed || again.RefundsFils != res.RefundsFils {
		t.Fatalf("re-close: %+v err=%v", again, err)
	}
}

func TestCloseBatch_RefundExceedingCapturesRollsForward(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2026, 4, 11, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)
	s1, _ := BusinessDayWindow(day1)
	s2, _ := BusinessDayWindow(day2)

	// Day 0 (before day1): big capture, then refunded on day1.
	bigTxn, bigFee := insertCaptureEvent(t, pool, merchantID, mdrBps, 50_000, s1.Add(-3*time.Hour))
	insertCaptureEvent(t, pool, merchantID, mdrBps, 1_000, s1.Add(time.Hour))
	refundID := insertRefund(t, pool, merchantID, bigTxn, 50_000, bigFee, s1.Add(2*time.Hour))

	r1, err := CloseBatch(context.Background(), pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if r1.RefundCount != 0 || r1.NetPayoutFils != r1.GrossFils-r1.FeeFils {
		t.Fatalf("day1: refunds=%d net=%d, want refund deferred and capture net paid", r1.RefundCount, r1.NetPayoutFils)
	}
	if b := refundBatchID(t, pool, refundID); b != nil {
		t.Fatalf("refund batched on day1 (%s), want NULL", *b)
	}

	// Day 2: enough captures to absorb the earlier-day refund.
	insertCaptureEvent(t, pool, merchantID, mdrBps, 60_000, s2.Add(time.Hour))
	r2, err := CloseBatch(context.Background(), pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if r2.RefundCount != 1 || r2.RefundsFils != 50_000-bigFee || r2.NetPayoutFils != r2.GrossFils-r2.FeeFils-r2.RefundsFils {
		t.Fatalf("day2: %+v", r2)
	}
	if b := refundBatchID(t, pool, refundID); b == nil || *b != r2.BatchID {
		t.Fatalf("refund batch = %v, want day2 batch %s", b, r2.BatchID)
	}
}
