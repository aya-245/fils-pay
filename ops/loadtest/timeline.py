#!/usr/bin/env python3
"""Per-bucket timeline from a k6 CSV (`run.sh <tag> <stages> --out csv=/out/ts-<tag>.csv`).

    python3 -I ops/loadtest/timeline.py loadtest-out/ts-chaos.csv [bucket_seconds=5]

Prints, per bucket: requests, ok (2xx, and 402/502 simulator declines), shed (503/429/409), failed
(status 0 = connection reset/timeout, other 5xx) and p95 latency of ok
requests. Used for the kill/restart recovery numbers in docs/CAPACITY.md.
"""
import csv
import sys
from collections import defaultdict


def main() -> None:
    path = sys.argv[1]
    bucket = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    samples = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            if r["metric_name"] == "http_req_duration":
                samples.append((float(r["timestamp"]), int(r["status"] or 0), float(r["metric_value"])))
    if not samples:
        sys.exit("no http_req_duration samples")
    t0 = min(s[0] for s in samples)
    buckets = defaultdict(lambda: {"n": 0, "ok": 0, "shed": 0, "fail": 0, "lat": []})
    for ts, status, ms in samples:
        b = buckets[int((ts - t0) // bucket)]
        b["n"] += 1
        if 200 <= status < 300 or status in (402, 502):  # 402/502 = simulated declines
            b["ok"] += 1
            b["lat"].append(ms)
        elif status in (503, 429, 409):
            b["shed"] += 1
        else:
            b["fail"] += 1
    print(f"{'t(s)':>6} {'reqs':>6} {'ok':>6} {'shed':>6} {'fail':>6} {'ok_p95_ms':>10}")
    for i in sorted(buckets):
        b = buckets[i]
        lat = sorted(b["lat"])
        p95 = lat[int(0.95 * (len(lat) - 1))] if lat else 0
        print(f"{i * bucket:6.0f} {b['n']:6d} {b['ok']:6d} {b['shed']:6d} {b['fail']:6d} {p95:10.0f}")


if __name__ == "__main__":
    main()
