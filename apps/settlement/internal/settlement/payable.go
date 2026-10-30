package settlement

import (
	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
// Pure int64 fils arithmetic: exact to the fil at any realistic amount
// (the previous float32 BD round-trip lost fils above ~16,777 BD).
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}

// pendingRefund is one succeeded, not-yet-batched refunds row.
type pendingRefund struct {
	id              uuid.UUID
	amountFils      money.Fils
	feeReversedFils money.Fils
}

// netFils is what the refund takes back from the merchant's payout: the
// refunded amount minus the share of the MDR fee returned to them.
func (r pendingRefund) netFils() money.Fils {
	return r.amountFils - r.feeReversedFils
}

// ApplyRefundsToPayout nets refunds (oldest first, as given) out of a
// batch's capture net payout. Refunds are taken strictly in order; the
// first refund that would push the payout below zero, and every refund
// after it, is left out so it rolls forward to the next batch in the same
// order. Returns the refunds to stamp with this batch, their gross
// refunded total, the MDR fee handed back for them, and the resulting
// payout = captureNet - refundsFils + feeReversedFils (always >= 0 when
// captureNet >= 0).
func ApplyRefundsToPayout(captureNet money.Fils, refunds []pendingRefund) (included []pendingRefund, refundsFils, feeReversedFils, netPayout money.Fils) {
	netPayout = captureNet
	for _, r := range refunds {
		n := r.netFils()
		if n > netPayout {
			break
		}
		netPayout -= n
		refundsFils += r.amountFils
		feeReversedFils += r.feeReversedFils
		included = append(included, r)
	}
	return included, refundsFils, feeReversedFils, netPayout
}
