# Live demo: a full and a partial refund, end to end (FP-300)

This is a click-by-click script for the pitch, with the amount you should see on screen at each step. Every amount is in BD with 3 decimals (1 BD = 1000 fils).

If the live demo fails, show the screenshots in [`demo/`](demo). They are numbered in the same order as the steps below. They were captured by running this exact flow against the real API and the Go settlement service, by `scripts/ui-screenshots.demo.mjs`.

## Expected numbers (cheat sheet)

The merchant is **Alpha Retail Co** (`9972daab-2c86-459f-9d78-3fe1be4e3280`). Its negotiated MDR is 2.25% (225 bps), with no discount.

| | Payment A (partial refund) | Payment B (full refund) | Batch total |
|---|---:|---:|---:|
| Captured (gross) | 40.000 | 25.500 | **65.500** |
| MDR fee (2.25%) | 0.900 | 0.574 ¹ | **1.474** |
| Refunded | 15.250 | 25.500 | **40.750** (2 refunds) |
| MDR fee reversed ² | 0.343 | 0.574 | **0.917** |
| Refunds netted (refund − fee reversed) | 15.250 − 0.343 = 14.907 | 25.500 − 0.574 = 24.926 | **39.833** |
| **Net payout** | 40.000 − 0.900 − 14.907 = **24.193** | 25.500 − 0.574 − 24.926 = **0.000** | **24.193** |

¹ 25.500 × 2.25% = 0.57375 BD, which rounds to 0.574 under the fee engine's rounding rule (`applyRateFils`).
² A refund reverses the MDR fee in the same proportion as the refund: 0.900 × 15.250 / 40.000 = 0.343125, which rounds to 0.343.

Check: gross − fee − (refunds − fee reversed) = 65.500 − 1.474 − (40.750 − 0.917) = **24.193 BD**. This is the value the Go service stores in `settlement_batches`: `gross_fils` 65500, `fee_fils` 1474, `refunds_fils` 40750, `refund_fee_reversed_fils` 917, `net_payout_fils` 24193.

The dashboard's *Day summary* shows net sales **before fees**: 65.500 − 40.750 = **24.750 BD**. The payout is 24.193 BD. The 0.557 BD difference is the fee kept by FilsPay: 1.474 charged − 0.917 reversed.

## Before you start (5 minutes before the pitch)

1. Start the stack the way [`UI_UX.md`](UI_UX.md#reproducing-the-screenshots) describes:
   - Postgres
   - `npm run migrate && npm run seed`
   - the Go settlement `daemon` with `SETTLEMENT_INTERNAL_TOKEN`
   - the API with `OTP_DEV_EXPOSE=true` (so the dev OTP code appears on screen)
   - the web app and the admin app
2. Open three browser windows side by side:
   - **Dashboard**: `/dashboard/login`
   - **Checkout**: a narrow, phone-width window
   - **Admin**: `/login`
3. The business day must still be **open** for the merchant: today's batch must not be closed yet. The settlement close runs once per merchant per business day. If you rehearsed today with Alpha, either use the screenshots, or run the live demo with another seeded merchant that has no refunds yet, such as Gamma Hospitality Group (`owner@gammahospitality.example`). Its fee rate differs, so read the fee off the screen instead of using the cheat sheet.

Logins (dev seed only, from `db/seed/generate.ts`):

| Role | Login | Password |
|---|---|---|
| Merchant | Merchant ID `9972daab-2c86-459f-9d78-3fe1be4e3280`, `owner@alpharetail.example` | `FilsPaySeed!2026` |
| Admin | `finance@filspay.test` | `FilsPayAdminSeed!2026` |

Both logins ask for a one-time code. In development the code is shown on the page as "Development code".

## The script

### Part 1: two paid checkouts

1. **Dashboard → Payment links → New payment link.**
   - Amount (BD): `40.000`
   - Reference: `DEMO-A`
   - Description: `Consulting — October`
   - Click **Create payment link**. ([01](demo/01-create-payment-link.png))
2. Do the same for a second link with Amount `25.500`, Reference `DEMO-B` and Description `Annual support plan`.
3. Open link A's URL in the **Checkout** window. It shows **Alpha Retail Co, 40.000 BHD**.
   - Enter card `4111 1111 1111 1111`, expiry month `12`, a year in the future, and CVV `123`. ([02](demo/02-checkout-A-card-entered.png))
   - Click **Pay 40.000 BHD**. The page shows **Payment successful**: "You paid **40.000 BHD** to Alpha Retail Co". ([03](demo/03-checkout-A-paid.png))
   - *Talking point:* the Pay button locks while the payment is processing, so a double click can't charge twice.
4. Open link B and pay the same way. The page shows **Payment successful: 25.500 BHD**. ([04](demo/04-checkout-B-paid.png))
5. **Dashboard → Transactions.** DEMO-A and DEMO-B both show **Captured**, with Refunded "—". ([05](demo/05-transactions-before-refunds.png))

### Part 2: partial refund (payment A)

6. Click the DEMO-A row. The page shows: Captured **40.000 BHD**, Refunded **Nothing refunded**, Still refundable **40.000 BHD**. ([06](demo/06-transaction-A-before-refund.png))
7. Click **Refund…**. The drawer says "Up to **40.000 BHD** can be refunded", and the amount field is prefilled with `40.000`.
   - Change the amount to `15.250`.
   - Reason: `One deliverable cancelled by customer`.
   - The button now reads **Refund 15.250 BHD**. ([07](demo/07-partial-refund-drawer.png))
   - *Talking point:* typing `40.001` or `1.2345` shows an inline error, and nothing is sent.
8. Click **Refund 15.250 BHD**. The page shows:
   - Notice: "Refunded **15.250 BHD** to the cardholder. Total refunded on this payment: **15.250 BHD**."
   - Status: **Partially refunded**. Refunded: **15.250 BHD** (with a "partially refunded" chip). Still refundable: **24.750 BHD**.
   - Timeline: a new row, **Refunded (partial) −15.250 BHD**. ([08](demo/08-transaction-A-after-partial-refund.png))

### Part 3: full refund (payment B)

9. **Transactions → DEMO-B → Refund…**. The amount is prefilled with `25.500`.
   - Reason: `Order cancelled — full refund`.
   - The button reads **Refund 25.500 BHD (full)**. ([09](demo/09-full-refund-drawer.png))
10. Click the button. The page shows:
    - Notice: "Refunded **25.500 BHD**… Total refunded: **25.500 BHD**."
    - Status: **Refunded**. Refunded: **25.500 BHD** (with a "fully refunded" chip). Still refundable: **0.000 BHD**.
    - The **Refund…** button disappears.
    - Timeline: **Refunded (full) −25.500 BHD**. ([10](demo/10-transaction-B-after-full-refund.png))
11. **Transactions.** DEMO-A shows Partially refunded with Refunded **15.250 BHD**. DEMO-B shows Refunded with **25.500 BHD** and a "full" chip. ([11](demo/11-transactions-after-refunds.png))
12. *Optional:* open DEMO-A and scroll to the timeline. It shows Authorized —, Captured **40.000 BHD**, Refunded (partial) **−15.250 BHD**, with the refund id and the actor "Merchant session". ([12](demo/12-transaction-A-timeline.png))

### Part 4: the settlement report

13. **Dashboard → Settlement.** The **Day summary** for today (Bahrain business date) shows:
    - Captured **65.500 BHD** (2 transactions)
    - Refunded **−40.750 BHD** (2 refunds)
    - Net sales (before fees) **24.750 BHD**

    ([13](demo/13-settlement-day-summary-before-close.png))
14. **Admin → Settlement ops → Re-run a daily batch.**
    - Business date: today.
    - Merchant id: `9972daab-2c86-459f-9d78-3fe1be4e3280`.
    - Click **Run batch**. The result row shows: Gross **65.500 BHD**, Fee **1.474 BHD**, Refunds netted **−39.833 BHD**, Net payout **24.193 BHD**. ([14](demo/14-admin-run-batch-result.png))
    - *Talking point:* the Go settlement service computes this. TypeScript only displays it. The refunds are netted out of the payout, together with the share of fee they give back.
15. **Dashboard → Settlement** (reload). Today's batch row shows: Gross 65.500, Fee 1.474, Refunds netted **−39.833**, Net payout **24.193 BHD**. ([15](demo/15-settlement-batches-after-close.png))
16. Click the batch date. The detail page shows:
    - Gross captured **65.500**
    - MDR fee **−1.474**
    - Captures net of fee **64.026**
    - Refunds netted **−39.833**
    - **Net payout 24.193 BHD**
    - Included transactions: DEMO-A and DEMO-B. ([16](demo/16-settlement-batch-detail.png))
17. **Dashboard → Reconciliation.** Set From to today and To (exclusive) to tomorrow, then click **Run report**. It shows:
    - Ledger merchant payable (net) **24.193 BHD**
    - Settlement net payout **24.193 BHD**
    - Pending **0.000**
    - Gap **0.000**, with the badge **Reconciled — no gap**. ([17](demo/17-reconciliation.png))
18. **Admin → Merchants → Alpha Retail Co → Recent settlement batches.** Today's batch shows the same 65.500 / 1.474 / −39.833 / 24.193 BHD. ([18](demo/18-admin-merchant-recent-batches.png))

## If something goes wrong

| Symptom | What to do |
|---|---|
| Run batch shows "Already closed: yes" with the old figures | Today's batch for this merchant was already closed during a rehearsal. Show the screenshots, or switch to a fresh merchant. |
| Run batch error "settlement internal call … fetch failed" | The Go daemon isn't running, or the API's `SETTLEMENT_INTERNAL_URL` / `SETTLEMENT_INTERNAL_TOKEN` don't match it. |
| Refund drawer error "At most X BHD can be refunded" | Expected if the transaction was already refunded. Pick the other transaction. |
| Refund error "read-only 'view as merchant' session" | You are in an admin impersonation session, which is read-only. Log in as the merchant instead. |
| Net payout differs from the cheat sheet by a few fils | A different fee schedule or volume-tier bonus applies. Trust the screen: gross − fee − refunds netted must still equal net. |

## Re-capturing the screenshots

```bash
node scripts/ui-screenshots.demo.mjs --web http://localhost:5320 --admin http://localhost:5321 \
  --merchant 9972daab-2c86-459f-9d78-3fe1be4e3280 --out docs/ui/demo \
  --playwright /path/to/node_modules/playwright/index.mjs
```

The script prints every figure it read off the screen, so you can check them against the cheat sheet. In the recorded run, the run-batch row was `65.500 · 1.474 · −39.833 · 24.193 BHD`.

## What was fixed for this demo (UI only)

- **Merchant Settlement pages.** Since FP-300, `netPayoutFils` is no longer gross − fee, and the pages showed only gross, fee and net, so a batch with refunds didn't add up on screen. There is now a **Refunds netted** column and row, derived as (gross − fee) − net. If the API ever starts sending `refundsFils` and `refundFeeReversedFils`, the page uses them instead. The new **Day summary** card shows captured vs refunded, from `GET /v1/settlement/summary` (owner and finance only).
- **Batch detail page.** A fake "progress bar" that used `grossFils / 10000` as a percentage was removed.
- **Admin.** The Run-batch result table and the merchant's Recent batches table both have the **Refunds netted** column.
- **New payment link form.** The amount is now entered in **BD** (it used to be raw fils), and the expiry defaults to +7 days.
- **Tests.** `apps/web/src/settlement.new.test.ts` and `apps/admin/src/settlement.new.test.ts` use these demo figures.
- **Left for the API owner.** `serializeBatch` in `apps/api/src/settlement/query.ts` doesn't send `refunds_fils` or `refund_fee_reversed_fils`. Sending them would let the batch detail page show "40.750 refunded − 0.917 fee reversed" instead of only the netted total.
