package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Delta Marketplace-style weights that don't divide the payout evenly: each
// child rounded on its own lost fils every batch.
func TestChildShares_LargestRemainderSumsExactly(t *testing.T) {
	cases := []struct {
		net     money.Fils
		weights []int64
	}{
		{1001, []int64{3333, 3333, 3334}},
		{12_345_677, []int64{3333, 3333, 3334}},
		{99, []int64{2500, 2500, 2500, 2500}},
		{7, []int64{3000, 3000, 4000}},
		{1_000_003, []int64{1, 9999}},
		{500, []int64{3000, 3000}}, // weights not totalling 10000
	}
	for _, tc := range cases {
		children := make([]ChildWeight, len(tc.weights))
		for i, w := range tc.weights {
			children[i] = ChildWeight{WeightBps: w}
		}
		shares := ChildShares(tc.net, children)
		var total money.Fils
		for i, s := range shares {
			if s < 0 {
				t.Fatalf("net %d: negative share %d", tc.net, s)
			}
			// Each share is within 1 fil of its exact proportional value.
			exact := float64(tc.net) * float64(tc.weights[i]) / float64(sum(tc.weights))
			if d := float64(s) - exact; d > 1 || d < -1 {
				t.Errorf("net %d child %d: share %d too far from exact %.3f", tc.net, i, s, exact)
			}
			total += s
		}
		if total != tc.net {
			t.Errorf("net %d weights %v: shares sum %d", tc.net, tc.weights, total)
		}
	}
}

func sum(ws []int64) int64 {
	var t int64
	for _, w := range ws {
		t += w
	}
	return t
}
