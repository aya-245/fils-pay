package splits

import (
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights using
// the largest-remainder method: every child gets floor(net*w/W), then the
// leftover fils go one each to the children with the largest remainders
// (ties to the earlier child). The shares always sum to netPayout exactly —
// rounding each child independently loses or invents fils every batch.
// W is the sum of the weights, so weights that don't total 10000 bps still
// allocate the whole payout proportionally.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	var totalWeight int64
	for _, c := range children {
		totalWeight += c.WeightBps
	}
	if totalWeight <= 0 || netPayout <= 0 {
		return out
	}

	remainders := make([]int64, len(children))
	var allocated int64
	for i, c := range children {
		num := int64(netPayout) * c.WeightBps
		out[i] = money.Fils(num / totalWeight)
		remainders[i] = num % totalWeight
		allocated += int64(out[i])
	}

	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })
	for k := 0; allocated < int64(netPayout); k++ {
		out[order[k%len(order)]]++
		allocated++
	}
	return out
}
