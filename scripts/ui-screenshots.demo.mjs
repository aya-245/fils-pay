#!/usr/bin/env node
/**
 * The FP-300 refund demo, end to end through the real UIs, as a numbered
 * screenshot sequence (docs/ui/demo/NN-*.png) — the fallback if the live demo
 * fails, and a rehearsal of docs/ui/DEMO.md click for click.
 *
 *   node scripts/ui-screenshots.demo.mjs --web http://localhost:5320 \
 *     --admin http://localhost:5321 --merchant <uuid> --out docs/ui/demo \
 *     [--date YYYY-MM-DD] [--playwright /path/to/playwright/index.mjs]
 *
 * Flow: merchant creates two payment links in the dashboard (40.000 and
 * 25.500 BD) → both are paid on the checkout page → partial refund
 * (15.250 BD) on the first and full refund on the second, via the refund
 * drawer → finance admin runs the settlement close for the business day →
 * merchant settlement pages show the netted refunds. Prints every amount
 * read off the screen so DEMO.md can be checked against it.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WEB = arg("web", "http://localhost:5173");
const ADMIN = arg("admin", "http://localhost:5174");
const OUT = path.resolve(arg("out", "docs/ui/demo"));
const MERCHANT = arg("merchant");
const PW = arg("playwright", "playwright");
const EMAIL = arg("merchant-email", "owner@alpharetail.example");
const PASSWORD = arg("merchant-password", "FilsPaySeed!2026");
const ADMIN_EMAIL = arg("admin-email", "finance@filspay.test");
const ADMIN_PASSWORD = arg("admin-password", "FilsPayAdminSeed!2026");
// Asia/Bahrain business date (UTC+3, no DST).
const DAY = arg("date", new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10));
const NEXT = (() => {
  const d = new Date(`${DAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();
const TAG = Date.now().toString(36).slice(-4).toUpperCase();

if (!MERCHANT) {
  console.error("--merchant <uuid> is required");
  process.exit(2);
}
const { chromium } = await import(PW);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

let n = 0;
async function shot(page, name, opts = {}) {
  await page.waitForTimeout(500);
  n += 1;
  const file = `${String(n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: opts.fullPage ?? true });
  console.log(`  ${file}`);
}

async function otpLogin(page, url, fill) {
  await page.goto(url);
  await fill();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByText(/development code/i).waitFor();
  const code = (await page.locator("code").first().textContent())?.trim() ?? "";
  await page.getByLabel(/one-time code/i).fill(code);
  await page.getByRole("button", { name: /verify/i }).click();
}

/* --- merchant dashboard session --------------------------------------- */
const dash = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const d = await dash.newPage();
d.on("pageerror", (e) => console.log(`  (page error) ${e.message}`));
await otpLogin(d, `${WEB}/dashboard/login`, async () => {
  await d.getByLabel(/merchant id/i).fill(MERCHANT);
  await d.getByLabel(/email/i).fill(EMAIL);
  await d.getByLabel(/password/i).fill(PASSWORD);
});
await d.waitForURL(/\/dashboard\/transactions/);

async function createLink(amount, reference, description, screenshot) {
  await d.goto(`${WEB}/dashboard/payment-links/new`);
  await d.getByLabel(/amount/i).fill(amount);
  await d.getByLabel(/reference/i).fill(reference);
  await d.getByLabel(/description/i).fill(description);
  if (screenshot) await shot(d, "create-payment-link");
  await d.getByRole("button", { name: /create payment link/i }).click();
  await d.waitForURL(/\/dashboard\/payment-links\/[0-9a-f-]{36}$/);
  const url = await d.locator("a[href*='/pay/']").first().getAttribute("href");
  return url;
}

console.log(`demo for business date ${DAY}`);
const linkA = await createLink("40.000", `DEMO-${TAG}-A`, "Consulting — October", true);
const linkB = await createLink("25.500", `DEMO-${TAG}-B`, "Annual support plan", false);

/* --- two paid checkouts (phone viewport) ------------------------------ */
const phone = await browser.newContext({ viewport: { width: 420, height: 860 } });
const c = await phone.newPage();
async function pay(url, label) {
  const local = url.replace(/^https?:\/\/[^/]+/, WEB);
  await c.goto(local);
  await c.getByLabel(/card number/i).fill("4111 1111 1111 1111");
  await c.getByLabel(/expiry month/i).fill("12");
  await c.getByLabel(/expiry year/i).fill(String(new Date().getFullYear() + 2));
  await c.getByLabel(/cvv/i).fill("123");
  if (label === "A") await shot(c, "checkout-A-card-entered");
  await c.getByRole("button", { name: /^pay /i }).click();
  await c.getByRole("heading", { name: /payment successful/i }).waitFor();
  await shot(c, `checkout-${label}-paid`);
  return (await c.locator(".checkout-dl code").textContent())?.trim();
}
const txnA = await pay(linkA, "A");
const txnB = await pay(linkB, "B");
console.log(`  txn A ${txnA}\n  txn B ${txnB}`);

/* --- refunds through the drawer --------------------------------------- */
await d.goto(`${WEB}/dashboard/transactions`);
await d.getByText(`DEMO-${TAG}-A`).waitFor();
await shot(d, "transactions-before-refunds", { fullPage: false });

await d.goto(`${WEB}/dashboard/transactions/${txnA}`);
await d.getByText(/still refundable/i).waitFor();
await shot(d, "transaction-A-before-refund");
await d.getByRole("button", { name: /^refund/i }).click();
await d.getByLabel(/refund amount/i).fill("15.250");
await d.getByLabel(/reason/i).fill("One deliverable cancelled by customer");
await shot(d, "partial-refund-drawer");
await d.getByRole("button", { name: /^refund 15\.250 bhd/i }).click();
await d.getByText(/refunded 15\.250 bhd to the cardholder/i).waitFor();
await shot(d, "transaction-A-after-partial-refund");

await d.goto(`${WEB}/dashboard/transactions/${txnB}`);
await d.getByText(/still refundable/i).waitFor();
await d.getByRole("button", { name: /^refund/i }).click();
await d.getByLabel(/reason/i).fill("Order cancelled — full refund");
await shot(d, "full-refund-drawer");
await d.getByRole("button", { name: /^refund 25\.500 bhd \(full\)/i }).click();
await d.getByText(/refunded 25\.500 bhd to the cardholder/i).waitFor();
await shot(d, "transaction-B-after-full-refund");

await d.goto(`${WEB}/dashboard/transactions`);
await d.getByText(`DEMO-${TAG}-A`).waitFor();
await shot(d, "transactions-after-refunds", { fullPage: false });

await d.goto(`${WEB}/dashboard/transactions/${txnA}`);
await d.getByText(/still refundable/i).waitFor();
await d.getByRole("heading", { name: /event timeline/i }).scrollIntoViewIfNeeded();
await shot(d, "transaction-A-timeline", { fullPage: false });

await d.goto(`${WEB}/dashboard/settlement`);
await d.getByText(/day summary/i).waitFor();
await d.waitForTimeout(800);
await shot(d, "settlement-day-summary-before-close", { fullPage: false });

/* --- finance admin closes the business day ---------------------------- */
const adm = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const a = await adm.newPage();
await otpLogin(a, `${ADMIN}/login`, async () => {
  await a.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await a.getByLabel(/password/i).fill(ADMIN_PASSWORD);
});
await a.waitForURL(/\/merchants/);
await a.goto(`${ADMIN}/settlement`);
await a.getByLabel(/business date/i).fill(DAY);
await a.getByLabel(/merchant id/i).first().fill(MERCHANT);
await a.getByRole("button", { name: /^run batch$/i }).click();
await a.getByText(/batch run for/i).waitFor({ timeout: 30_000 });
const row = (await a.locator(".admin-notice table tbody tr").first().innerText()).replace(/\s+/g, " ");
console.log(`  run-batch row: ${row}`);
await shot(a, "admin-run-batch-result", { fullPage: false });

/* --- merchant sees the netted batch ----------------------------------- */
await d.goto(`${WEB}/dashboard/settlement?d=${DAY}`);
await d.getByRole("link", { name: DAY }).waitFor();
await d.waitForTimeout(800);
await shot(d, "settlement-batches-after-close", { fullPage: false });
await d.getByRole("link", { name: DAY }).click();
await d.getByText(/refunds netted/i).waitFor();
const detail = (await d.locator(".dash-dl").first().innerText()).replace(/\s+/g, " ");
console.log(`  batch detail: ${detail}`);
await shot(d, "settlement-batch-detail");

await d.goto(`${WEB}/dashboard/reconciliation`);
await d.getByLabel(/^from$/i).fill(DAY);
await d.getByLabel(/to \(exclusive\)/i).fill(NEXT);
await d.getByRole("button", { name: /run|apply|show|check/i }).first().click();
await d.waitForTimeout(1500);
await shot(d, "reconciliation");

await a.goto(`${ADMIN}/merchants/${MERCHANT}`);
await a.getByRole("heading", { name: /recent settlement batches/i }).scrollIntoViewIfNeeded();
await a.waitForTimeout(500);
await shot(a, "admin-merchant-recent-batches", { fullPage: false });

await browser.close();
console.log(`done -> ${OUT}`);
