#!/usr/bin/env node
/**
 * Reproducible UI screenshots for checkout, the merchant dashboard and the
 * admin console (docs/UI_UX.md). The same script drives the "before" build
 * (commit 8b58b0f) and the current build, so the PNGs line up by name.
 *
 *   node scripts/ui-screenshots.mjs \
 *     --web http://localhost:5310 --admin http://localhost:5311 \
 *     --fixture fixture.json --out docs/ui/after \
 *     [--playwright /path/to/node_modules/playwright/index.mjs]
 *
 * Fixture: JSON printed by scripts/ui-screenshots.seed.mjs (tokens + ids).
 * Credentials default to the db/seed fixtures (dev-only, documented there);
 * override with --merchant-email/--merchant-password/--admin-email/
 * --admin-support-email/--admin-password.
 *
 * Each step is best-effort: if a control does not exist in the build being
 * photographed (e.g. the refund drawer in the "before" build), the page is
 * captured as it is and a note is printed — that absence is the evidence.
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WEB = arg("web", "http://localhost:5173");
const ADMIN = arg("admin", "http://localhost:5174");
const OUT = path.resolve(arg("out", "docs/ui/after"));
const FIXTURE = arg("fixture");
const PW = arg("playwright", "playwright");
const MERCHANT_EMAIL = arg("merchant-email", "owner@betadigital.example");
const MERCHANT_PASSWORD = arg("merchant-password", "FilsPaySeed!2026");
const ADMIN_EMAIL = arg("admin-email", "finance@filspay.test");
const ADMIN_SUPPORT_EMAIL = arg("admin-support-email", "support@filspay.test");
const ADMIN_PASSWORD = arg("admin-password", "FilsPayAdminSeed!2026");
const ONLY = arg("only"); // optional comma list of groups: checkout,dashboard,admin

if (!FIXTURE) {
  console.error("--fixture <file> is required (see scripts/ui-screenshots.seed.mjs)");
  process.exit(2);
}
const fx = JSON.parse(await readFile(FIXTURE, "utf8"));
const { chromium } = await import(PW);

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const settle = (page, ms = 700) => page.waitForTimeout(ms);

async function shot(page, name) {
  await settle(page, 400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ${name}.png`);
}

/** Runs `fn`, swallowing a missing-control failure so the shot still happens. */
async function attempt(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`  (note) ${label}: ${String(err.message).split("\n")[0]}`);
  }
}

async function fillCard(page, pan) {
  await page.getByLabel(/card number/i).fill(pan);
  await attempt("expiry month", () => page.getByLabel(/expiry month|month/i).first().fill("12", { timeout: 1500 }));
  await attempt("expiry year", () =>
    page.getByLabel(/expiry year|year/i).first().fill(String(new Date().getFullYear() + 2), { timeout: 1500 }),
  );
  await page.getByLabel(/cvv|security code/i).fill("123");
}

const want = (group) => !ONLY || ONLY.split(",").includes(group);

/* ------------------------------ checkout ------------------------------ */
if (want("checkout")) {
  console.log("checkout");
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  await page.goto(`${WEB}/pay/${fx.openToken}`);
  await settle(page);
  await shot(page, "checkout-open");

  // Invalid input: submit with an empty / bad card — shows field validation.
  await attempt("invalid submit", async () => {
    await page.getByLabel(/card number/i).fill("4111");
    await page.getByRole("button", { name: /pay/i }).click({ timeout: 2000 });
  });
  await shot(page, "checkout-invalid");

  await page.goto(`${WEB}/pay/${fx.successToken}`);
  await settle(page);
  await fillCard(page, "4111111111111111");
  await page.getByRole("button", { name: /pay/i }).click();
  // The simulated acquirer takes 300-600 ms: photograph the in-flight state.
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(OUT, "checkout-submitting.png"), fullPage: true });
  console.log("  checkout-submitting.png");
  await page.waitForTimeout(2500);
  await shot(page, "checkout-success");

  await page.goto(`${WEB}/pay/${fx.declineToken}`);
  await settle(page);
  await fillCard(page, "4000000000000002");
  await page.getByRole("button", { name: /pay/i }).click();
  await page.waitForTimeout(2500);
  await shot(page, "checkout-declined");

  await page.goto(`${WEB}/pay/${fx.paidToken}`);
  await settle(page);
  await shot(page, "checkout-already-paid");

  await page.goto(`${WEB}/pay/${fx.expiredToken}`);
  await settle(page);
  await shot(page, "checkout-expired");

  await page.goto(`${WEB}/pay/plink_doesnotexist0000000`);
  await settle(page);
  await shot(page, "checkout-not-found");

  // Processing (409 payment_link_processing): another tab is mid-payment.
  await page.route("**/v1/payment-links/*/pay", (route) =>
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "payment_link_processing" }) }),
  );
  await page.goto(`${WEB}/pay/${fx.openToken}`);
  await settle(page);
  await fillCard(page, "4111111111111111");
  await page.getByRole("button", { name: /pay/i }).click();
  await page.waitForTimeout(800);
  await shot(page, "checkout-processing");
  await page.unroute("**/v1/payment-links/*/pay");

  // Network failure loading the link: must not masquerade as "not found".
  await page.route("**/v1/payment-links/*", (route) => route.abort("failed"));
  await page.goto(`${WEB}/pay/${fx.openToken}`);
  await settle(page, 1200);
  await shot(page, "checkout-network-error");
  await page.unroute("**/v1/payment-links/*");
  await ctx.close();
}

/* -------------------------- merchant dashboard ------------------------- */
if (want("dashboard")) {
  console.log("dashboard");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => console.log(`  (page error) ${err.message}`));

  await page.goto(`${WEB}/dashboard/login`);
  await settle(page);
  await page.getByLabel(/merchant id/i).fill(fx.merchantId);
  await page.getByLabel(/email/i).fill(MERCHANT_EMAIL);
  await page.getByLabel(/password/i).fill(MERCHANT_PASSWORD);
  await shot(page, "dashboard-login");
  await page.getByRole("button", { name: /continue|sign in/i }).click();
  await page.getByText(/development code/i).waitFor();
  const code = (await page.locator("code").first().textContent())?.trim() ?? "";
  await page.getByLabel(/one-time code/i).fill(code);
  await shot(page, "dashboard-login-otp");
  await page.getByRole("button", { name: /verify/i }).click();
  await page.waitForURL(/\/dashboard\/transactions/);
  await settle(page, 1200);
  await shot(page, "dashboard-transactions");

  await page.goto(`${WEB}/dashboard/transactions?status=partially_refunded`);
  await attempt("filter partially_refunded", async () => {
    await page.getByLabel(/^partially[ _]refunded$/i).check({ timeout: 2000 });
  });
  await settle(page, 1200);
  await shot(page, "dashboard-transactions-refunded");

  // Detail of the paid + partially refunded transaction (timeline has a refund event).
  await page.goto(`${WEB}/dashboard/transactions/${fx.paidTransactionId}`);
  await settle(page, 1200);
  await shot(page, "dashboard-transaction-detail");

  // Refund drawer: open, try an over-refund, then a valid partial refund.
  await attempt("open refund drawer", () => page.getByRole("button", { name: /^refund/i }).first().click({ timeout: 2000 }));
  await shot(page, "dashboard-refund-drawer");
  await attempt("over-refund", async () => {
    await page.getByLabel(/amount/i).fill("40.000", { timeout: 2000 });
    await page.getByLabel(/reason/i).fill("Duplicate order", { timeout: 2000 });
    // Over the refundable amount the button reads plain "Refund"; submit with Enter.
    await page.getByLabel(/amount/i).press("Enter", { timeout: 2000 });
    await page.waitForTimeout(1500);
  });
  await shot(page, "dashboard-refund-error");

  // Server-side refusal: simulate the API's real 422 body for a stale page
  // (someone else refunded meanwhile) so the server-error path is visible.
  await page.route("**/refunds", (route) =>
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, code: "refund_exceeds_refundable", refundableFils: 2_000 }),
    }),
  );
  await attempt("server refund_exceeds_refundable", async () => {
    await page.getByLabel(/amount/i).fill("30.000", { timeout: 2000 });
    await page.getByLabel(/amount/i).press("Enter", { timeout: 2000 });
    await page.waitForTimeout(1200);
  });
  await shot(page, "dashboard-refund-server-error");
  await page.unroute("**/refunds");

  await attempt("valid partial refund", async () => {
    await page.getByLabel(/amount/i).fill("5.500", { timeout: 2000 });
    await page.getByRole("button", { name: /^refund .*bhd|^issue refund|^confirm refund/i }).click({ timeout: 2000 });
    await page.waitForTimeout(2000);
  });
  await shot(page, "dashboard-refund-success");

  await page.goto(`${WEB}/dashboard/payment-links`);
  await settle(page, 1200);
  await shot(page, "dashboard-payment-links");
  await ctx.close();
}

/* ------------------------------- admin -------------------------------- */
async function adminLogin(page, email) {
  await page.goto(`${ADMIN}/login`);
  await settle(page);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /continue|sign in/i }).click();
  await page.getByText(/development code/i).waitFor();
  const code = (await page.locator("code").first().textContent())?.trim() ?? "";
  await page.getByLabel(/one-time code/i).fill(code);
  await page.getByRole("button", { name: /verify/i }).click();
  await page.waitForURL(/\/merchants/);
  await settle(page, 1000);
}

if (want("admin")) {
  console.log("admin");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => console.log(`  (page error) ${err.message}`));

  await page.goto(`${ADMIN}/login`);
  await settle(page);
  await shot(page, "admin-login");
  await adminLogin(page, ADMIN_EMAIL);
  await shot(page, "admin-merchants");

  // Settlement ops; rebuild cached balances from the ledger first so the
  // merchant has a balance row for the adjustment shot below.
  await page.goto(`${ADMIN}/settlement`);
  await settle(page, 1200);
  await shot(page, "admin-settlement");
  await attempt("rebuild balances", async () => {
    await page.getByRole("button", { name: /^rebuild balances$/i }).click({ timeout: 2000 });
    await page.getByRole("button", { name: /yes, rebuild all balances/i }).click({ timeout: 2000 });
    await page.waitForTimeout(2500);
  });
  await shot(page, "admin-settlement-rebuild");

  await page.goto(`${ADMIN}/merchants/${fx.merchantId}`);
  await settle(page, 1200);
  await shot(page, "admin-merchant-detail");

  // Balance adjustment (finance): before = raw fils, after = BD + confirm.
  await attempt("balance adjustment", async () => {
    const bd = page.getByLabel(/adjustment \(bd/i);
    if (await bd.count()) await bd.fill("-2.500");
    else await page.getByLabel(/delta/i).fill("-2500");
    await page.getByLabel(/^reason$/i).first().fill("Duplicate fee charged on 2026-10-28 (ticket SUP-481)");
    await page.getByRole("button", { name: /^adjust balance$|^review adjustment$/i }).click({ timeout: 2000 });
    await page.waitForTimeout(500);
  });
  await page.getByRole("heading", { name: /adjust balance/i }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "admin-balance-confirm.png") });
  console.log("  admin-balance-confirm.png");
  await attempt("confirm adjustment", async () => {
    await page.getByRole("button", { name: /^post .*ledger|^confirm/i }).click({ timeout: 1500 });
  });
  await page.waitForTimeout(1500);
  await page.getByRole("heading", { name: /adjust balance/i }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, "admin-balance-adjusted.png") });
  console.log("  admin-balance-adjusted.png");

  // Impersonation banner (view as merchant) — last, it pauses admin screens.
  await page.goto(`${ADMIN}/merchants/${fx.merchantId}`);
  await settle(page, 1000);
  await attempt("impersonate", async () => {
    const popup = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
    await page.getByRole("button", { name: /view as merchant/i }).click({ timeout: 2000 });
    const p = await popup;
    if (p) await p.close();
    await page.waitForTimeout(1000);
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, "admin-impersonation.png") });
  console.log("  admin-impersonation.png");
  await attempt("exit impersonation", () => page.getByRole("button", { name: /exit impersonation/i }).click({ timeout: 2000 }));
  await ctx.close();

  // Support role: read-only fallbacks + replay of succeeded deliveries (403).
  const sctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const spage = await sctx.newPage();
  await adminLogin(spage, ADMIN_SUPPORT_EMAIL);
  await spage.goto(`${ADMIN}/merchants/${fx.merchantId}`);
  await settle(spage, 1200);
  await spage.getByRole("heading", { name: /adjust balance/i }).scrollIntoViewIfNeeded();
  await spage.screenshot({ path: path.join(OUT, "admin-support-readonly.png") });
  console.log("  admin-support-readonly.png");

  await spage.goto(`${ADMIN}/webhooks/${fx.merchantId}`);
  await settle(spage, 1200);
  await shot(spage, "admin-webhook-replay");
  await attempt("replay succeeded as support", async () => {
    const box = spage.getByLabel(/^succeeded/i);
    if (await box.isDisabled()) throw new Error("succeeded checkbox disabled for support (expected after fix)");
    await box.check({ timeout: 1500 });
    await spage.getByRole("button", { name: /replay/i }).click({ timeout: 1500 });
    await spage.waitForTimeout(1200);
  });
  await shot(spage, "admin-webhook-replay-forbidden");
  await sctx.close();
}

await browser.close();
console.log(`done -> ${OUT}`);
