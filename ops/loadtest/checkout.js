// FilsPay fixed checkout scenario for k6 (https://k6.io). See ops/loadtest/README.md.
//
// One iteration = one checkout by one user:
//   1. merchant (API key) creates a payment link   POST /v1/merchants/:id/payment-links
//   2. buyer opens the hosted checkout             GET  /v1/payment-links/:token
//   3. buyer pays with the approved test card      POST /v1/payment-links/:token/pay
//   4. think time (THINK_S, default 1s), then the next checkout
//
// Outcome classes (counted separately, never mixed):
//   ok        201 / 200 / 200 paid with the right amount
//   declined  402 / 502 from the pay step: the acquirer simulator's
//             ACQUIRER_FAILURE_RATE (2% default) declines/errors, a correct
//             business answer, not a server failure
//   shed      503 (load shedding / DB busy, always carries Retry-After), 429,
//             409 payment_link_processing - the server refused work quickly
//   error     anything else: 5xx other than 502/503, timeouts, wrong body
//
// Env:
//   BASE_URL   default http://api:3000 (via the web nginx: http://web:8080/api)
//   MERCHANTS  required, "merchantId:apiKey,merchantId:apiKey,..."
//   STAGES     "30s:10,60s:10,10s:0" (duration:targetVUs, ramping-vus) - default below
//   THINK_S    seconds between checkouts per user (default 1)
//   AMOUNT_FILS  link amount (default 4750 = 4.750 BD; 1 BD = 1000 fils)
//   LOG_PAID   "1" -> log "PAID <txnId> <token>" per approved pay (integrity check input)
//   TAG        name used for the summary file /out/summary-<TAG>.json
//   TIMEOUT    per-request timeout (default 10s)

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import exec from "k6/execution";

const BASE_URL = __ENV.BASE_URL || "http://api:3000";
const THINK_S = Number(__ENV.THINK_S || "1");
const AMOUNT_FILS = Number(__ENV.AMOUNT_FILS || "4750");
const TIMEOUT = __ENV.TIMEOUT || "10s";
const LOG_PAID = __ENV.LOG_PAID === "1";
const TAG = __ENV.TAG || "run";

const MERCHANTS = (__ENV.MERCHANTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(":");
    return { id: s.slice(0, i), key: s.slice(i + 1) };
  });
if (MERCHANTS.length === 0) throw new Error("MERCHANTS env is required: merchantId:apiKey,...");

function parseStages(spec) {
  return spec.split(",").map((p) => {
    const [duration, target] = p.split(":");
    return { duration, target: Number(target) };
  });
}

const STAGES = parseStages(__ENV.STAGES || "30s:10,60s:10,30s:20,60s:20,10s:0");

export const options = {
  scenarios: {
    checkout: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: STAGES,
      gracefulRampDown: "15s",
      gracefulStop: "15s",
    },
  },
  // Do not abort on threshold failure: the past-the-limit runs exist to show
  // how the server degrades, so they must run to the end.
  thresholds: {
    "http_req_duration{step:create}": ["p(95)<500"],
    "http_req_duration{step:get}": ["p(95)<500"],
    // The pay step is bounded below by two simulated acquirer round-trips
    // (ACQUIRER_LATENCY 100-400 ms each => p95 ~705 ms with zero server time).
    "http_req_duration{step:pay}": ["p(95)<1000"],
    checkout_duration: ["p(95)<1500"],
    checkout_errors: ["rate<0.01"],
    checkout_shed: ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  discardResponseBodies: false,
  noConnectionReuse: false,
};

const checkoutDuration = new Trend("checkout_duration", true);
const shedLatency = new Trend("shed_latency", true);
const checkoutErrors = new Rate("checkout_errors");
const checkoutShed = new Rate("checkout_shed");
const checkoutDeclined = new Rate("checkout_declined");
const paidOk = new Counter("checkouts_paid");
const shedCount = new Counter("shed_responses");
const errorCount = new Counter("error_responses");
const errorByStatus = {};

function uuid() {
  // RFC4122-ish v4 from Math.random: an idempotency key, not a secret.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function isShed(res) {
  if (res.status === 503 || res.status === 429) return true;
  if (res.status === 409) {
    try {
      return res.json("error") === "payment_link_processing";
    } catch (_e) {
      return false;
    }
  }
  return false;
}

/** Returns "ok" | "shed" | "error"; records shed/error counters. */
function classify(res, step, expected) {
  if (res.status === expected) return "ok";
  if (isShed(res)) {
    shedCount.add(1, { step });
    shedLatency.add(res.timings.duration, { step });
    return "shed";
  }
  const key = `${step}:${res.status}`;
  errorCount.add(1, { step, status: String(res.status) });
  if (!errorByStatus[key]) {
    errorByStatus[key] = true;
    console.warn(`unexpected ${key} ${res.error || ""} ${String(res.body).slice(0, 200)}`);
  }
  return "error";
}

function finish(outcome, started) {
  checkoutErrors.add(outcome === "error");
  checkoutShed.add(outcome === "shed");
  checkoutDeclined.add(outcome === "declined");
  if (outcome === "ok" || outcome === "declined") checkoutDuration.add(Date.now() - started);
}

export default function () {
  const m = MERCHANTS[(exec.vu.idInTest - 1) % MERCHANTS.length];
  const started = Date.now();
  const ref = `load-${TAG}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`;

  // 1. merchant creates the link
  const createRes = http.post(
    `${BASE_URL}/v1/merchants/${m.id}/payment-links`,
    JSON.stringify({
      amountFils: AMOUNT_FILS,
      reference: ref,
      description: "k6 checkout",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
    {
      headers: { "content-type": "application/json", authorization: `Bearer ${m.key}` },
      tags: { step: "create", name: "create_link" },
      timeout: TIMEOUT,
    },
  );
  let c = classify(createRes, "create", 201);
  let token = null;
  if (c === "ok") {
    token = createRes.json("token");
    if (!check(createRes, { "create: token present": () => typeof token === "string" })) c = "error";
  }
  if (c !== "ok") {
    finish(c, started);
    sleep(THINK_S);
    return;
  }

  // 2. buyer opens the checkout page
  const getRes = http.get(`${BASE_URL}/v1/payment-links/${token}`, {
    tags: { step: "get", name: "get_link" },
    timeout: TIMEOUT,
  });
  c = classify(getRes, "get", 200);
  if (c === "ok" && !check(getRes, { "get: amount matches": (r) => Number(r.json("amountFils")) === AMOUNT_FILS })) {
    c = "error";
  }
  if (c !== "ok") {
    finish(c, started);
    sleep(THINK_S);
    return;
  }

  // 3. buyer pays
  const payRes = http.post(
    `${BASE_URL}/v1/payment-links/${token}/pay`,
    JSON.stringify({ card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } }),
    {
      headers: { "content-type": "application/json", "idempotency-key": uuid() },
      tags: { step: "pay", name: "pay_link" },
      timeout: TIMEOUT,
    },
  );
  let outcome;
  if (payRes.status === 402 || payRes.status === 502) {
    outcome = "declined";
  } else {
    outcome = classify(payRes, "pay", 200);
    if (outcome === "ok") {
      const ok = check(payRes, {
        "pay: status paid": (r) => r.json("status") === "paid",
        "pay: amount matches": (r) => Number(r.json("amountFils")) === AMOUNT_FILS,
      });
      if (!ok) outcome = "error";
      else {
        paidOk.add(1);
        if (LOG_PAID) console.log(`PAID ${payRes.json("transactionId")} ${token}`);
      }
    }
  }
  finish(outcome, started);
  sleep(THINK_S);
}

function metric(data, name, stat) {
  const m = data.metrics[name];
  if (!m) return null;
  return m.values[stat] ?? null;
}

export function handleSummary(data) {
  const r = (x, d = 1) => (x === null || x === undefined ? "-" : Number(x).toFixed(d));
  const durationS = data.state.testRunDurationMs / 1000;
  const iters = metric(data, "iterations", "count") || 0;
  const paid = metric(data, "checkouts_paid", "count") || 0;
  const reqs = metric(data, "http_reqs", "count") || 0;
  const line = (step) =>
    `  ${step.padEnd(7)} p50=${r(metric(data, `http_req_duration{step:${step}}`, "med"))}ms ` +
    `p95=${r(metric(data, `http_req_duration{step:${step}}`, "p(95)"))}ms ` +
    `p99=${r(metric(data, `http_req_duration{step:${step}}`, "p(99)"))}ms`;
  const failed = Object.entries(data.metrics)
    .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok))
    .map(([k]) => k);
  const text =
    `\n=== FilsPay checkout [${TAG}] ${r(durationS, 0)}s, max VUs ${metric(data, "vus_max", "max")}\n` +
    `  http reqs ${reqs} (${r(reqs / durationS)} req/s), checkouts started ${iters}, paid ${paid} (${r(paid / durationS, 2)}/s)\n` +
    `  checkout p50=${r(metric(data, "checkout_duration", "med"))}ms p95=${r(metric(data, "checkout_duration", "p(95)"))}ms ` +
    `p99=${r(metric(data, "checkout_duration", "p(99)"))}ms\n` +
    `${line("create")}\n${line("get")}\n${line("pay")}\n` +
    `  error rate ${r(100 * (metric(data, "checkout_errors", "rate") || 0), 2)}%  ` +
    `shed rate ${r(100 * (metric(data, "checkout_shed", "rate") || 0), 2)}%  ` +
    `declined ${r(100 * (metric(data, "checkout_declined", "rate") || 0), 2)}%  ` +
    `shed responses ${metric(data, "shed_responses", "count") || 0} (p95 ${r(metric(data, "shed_latency", "p(95)"))}ms)  ` +
    `errors ${metric(data, "error_responses", "count") || 0}\n` +
    `  thresholds: ${failed.length === 0 ? "ALL PASSED" : "FAILED " + failed.join(", ")}\n`;
  return {
    stdout: text,
    [`/out/summary-${TAG}.json`]: JSON.stringify(data, null, 1),
  };
}
