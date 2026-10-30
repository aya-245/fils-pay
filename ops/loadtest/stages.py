#!/usr/bin/env python3
"""Per-step summary of a k6 `--out json` run of ops/loadtest/checkout.js.

    python3 ops/loadtest/stages.py <k6.json> "10:15:55,25:70:110,..."

Each step is "<label>:<start_s>:<end_s>" relative to the first data point
(use the HOLD part of each stair, not the ramp). Prints req/s, paid/s,
shed % (503 overloaded), other 5xx, and p50/p95 latency of successful steps.
"""
import datetime
import json
import sys


def ts(s: str) -> float:
    s = s.replace("Z", "+00:00")
    if "." in s:
        head, rest = s.split(".", 1)
        cut = max(rest.find("+"), rest.find("-"))
        frac, tz = rest[:cut], rest[cut:]
        s = f"{head}.{frac[:6].ljust(6, '0')}{tz}"
    return datetime.datetime.fromisoformat(s).timestamp()


def pct(values, q):
    if not values:
        return float("nan")
    v = sorted(values)
    return v[min(len(v) - 1, int(q * len(v)))]


def main() -> None:
    path, spec = sys.argv[1], sys.argv[2]
    steps = []
    for part in spec.split(","):
        label, a, b = part.split(":")
        steps.append((label, float(a), float(b)))
    rows = {s[0]: {"req": 0, "paid": 0, "shed": 0, "err": 0, "create": [], "get": [], "pay": []} for s in steps}
    t0 = None
    with open(path) as fh:
        for line in fh:
            o = json.loads(line)
            if o.get("type") != "Point":
                continue
            t = ts(o["data"]["time"])
            if t0 is None:
                t0 = t
            rel = t - t0
            m = o["metric"]
            if m not in ("http_reqs", "http_req_duration"):
                continue
            tags = o["data"]["tags"]
            for label, a, b in steps:
                if not (a <= rel < b):
                    continue
                r = rows[label]
                st = tags.get("status", "")
                step = tags.get("step")
                if m == "http_reqs":
                    r["req"] += 1
                    if step == "pay" and st == "200":
                        r["paid"] += 1
                    if st == "503":
                        r["shed"] += 1
                    elif st.startswith("5") or st == "0":
                        r["err"] += 1
                elif st in ("200", "201") and step in ("create", "get", "pay"):
                    r[step].append(o["data"]["value"])
    print(f"{'VUs':>5} {'req/s':>7} {'paid/s':>7} {'shed%':>6} {'err':>4} {'create p95':>10} {'get p95':>8} {'pay p50':>8} {'pay p95':>8}")
    for label, a, b in steps:
        r, d = rows[label], b - a
        shed = 100 * r["shed"] / r["req"] if r["req"] else 0.0
        print(f"{label:>5} {r['req']/d:7.1f} {r['paid']/d:7.2f} {shed:6.1f} {r['err']:4d} "
              f"{pct(r['create'], .95):10.0f} {pct(r['get'], .95):8.0f} {pct(r['pay'], .5):8.0f} {pct(r['pay'], .95):8.0f}")


if __name__ == "__main__":
    main()
