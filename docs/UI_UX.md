# UI / UX: checkout, merchant dashboard, admin console

These are before and after screenshots of the three front ends. Both sets were
taken by the same script, against the same API, the same database and the same
kind of data:

- **Before**: the original frontend at commit `8b58b0f`, built from a separate
  `git worktree`.
- **After**: the current `apps/web` and `apps/admin`.

Each screenshot has the same file name in [`ui/before/`](ui/before) and
[`ui/after/`](ui/after), so they can be compared side by side. Bug numbers such
as `#21` refer to [`BUGS.md`](../BUGS.md). FP-numbers refer to feature tickets.

Money is always shown in BD with 3 decimals (1 BD = 1000 fils). Every amount
that goes over the wire is still integer fils, and no API contract changed.

---

## Checkout (`/pay/:token`, 420 px phone viewport)

| Before | After | What changed and why |
|---|---|---|
| ![](ui/before/checkout-open.png) | ![](ui/after/checkout-open.png) | **Layout.** The before page is 588 px wide on a 420 px phone: the Expiry/CVV row overflowed, so the page scrolled sideways. The row is now a 3-column grid that always fits. The amount sits in a summary card with the merchant, description and reference. The page now says how long the link is valid. The card fields have `autocomplete` (`cc-number`, `cc-exp-*`, `cc-csc`) and the CVV is masked. |
| ![](ui/before/checkout-invalid.png) | ![](ui/after/checkout-invalid.png) | **Validation.** Before, only the browser's own `required` bubble appeared, and it doesn't show up in a screenshot. A 4-digit card number went to the acquirer and came back as a decline. Now each field gets its own error text (linked to the input with `aria-describedby` and marked `aria-invalid`). A summary appears in an `aria-live` alert, and focus moves to the first bad field. |
| ![](ui/before/checkout-submitting.png) | ![](ui/after/checkout-submitting.png) | **Double submit.** Before, the button was disabled, but only once React re-rendered. Now a `ref` guard blocks a second click or Enter before that render. The inputs are locked while the payment is in flight, the button shows a spinner (no animation when `prefers-reduced-motion` is set), and a polite live region says "don't close or refresh". |
| ![](ui/before/checkout-success.png) | ![](ui/after/checkout-success.png) | **Success.** Before, the page showed a raw ISO timestamp and no amount. Now it shows the amount paid, the merchant, a localised paid-at time and the transaction ID. Focus moves to the "Payment successful" heading. |
| ![](ui/before/checkout-declined.png) | ![](ui/after/checkout-declined.png) | **Decline.** Before, the error was plain red text that screen readers didn't announce. Now it is an assertive live alert that says *you have not been charged* and what to do next. The capture-stage and authorize-stage declines have different wording. |
| ![](ui/before/checkout-processing.png) | ![](ui/after/checkout-processing.png) | **409 `payment_link_processing`** (the server now refuses a concurrent pay, `#31`). Before, the page said "try again shortly" right next to an active Pay button, which invited a second charge. Now there is a dedicated "A payment is already in progress" screen with **Check payment status**, which re-reads the link instead of paying again. |
| ![](ui/before/checkout-already-paid.png) | ![](ui/after/checkout-already-paid.png) | **Already paid.** The screen keeps the invoice context (merchant, amount, reference) and tells the payer not to pay again. |
| ![](ui/before/checkout-expired.png) | ![](ui/after/checkout-expired.png) | **Expired** (expired links can't be paid, `#30`). The screen says when the link expired, that the payer has not been charged, and to ask the named merchant for a new link. A `410` on pay leads to the same screen. |
| ![](ui/before/checkout-not-found.png) | ![](ui/after/checkout-not-found.png) | **Not found.** The text now says what to do. It still doesn't distinguish a malformed token from an unknown one, because the API deliberately doesn't either. |
| ![](ui/before/checkout-network-error.png) | ![](ui/after/checkout-network-error.png) | **Bug fixed.** Before, any load failure (offline, 5xx) showed **"Payment link not found"**, which told a payer that a valid invoice didn't exist. Now only a real `404` is "not found". Anything else gets "We couldn't load this payment", says nothing was charged, and offers **Try again**. |

## Merchant dashboard (`/dashboard/*`)

| Before | After | What changed and why |
|---|---|---|
| ![](ui/before/dashboard-login.png) | ![](ui/after/dashboard-login.png) | Errors and notices now sit in live regions. Each server code has its own text: for example `invalid_credentials` gets "Those details don't match…", and `otp_expired`, `too_many_attempts` and `resend_too_soon` each get their own message. |
| ![](ui/before/dashboard-login-otp.png) | ![](ui/after/dashboard-login-otp.png) | Same treatment for the OTP step. A "Skip to content" link and a visible `:focus-visible` outline were added across the dashboard. |
| ![](ui/before/dashboard-transactions.png) | ![](ui/after/dashboard-transactions.png) | **New Refunded column** (`#21`: the API now sends `refundedFils`). Full refunds get a "full" chip. Statuses are readable ("Partially refunded", not `partially_refunded`). Money columns are right-aligned with tabular digits, so 3-decimal amounts line up. The result count is a live `role=status`, the table sets `aria-busy` while loading, and the empty state suggests clearing a filter. Errors come with **Try again**. |
| ![](ui/before/dashboard-transactions-refunded.png) | ![](ui/after/dashboard-transactions-refunded.png) | Filtered to *Partially refunded*: the refunded amount is visible without opening each row. |
| ![](ui/before/dashboard-transaction-detail.png) | ![](ui/after/dashboard-transaction-detail.png) | **Crash fixed.** Before, any refunded transaction showed *"Unexpected Application Error: toFils: expected a non-negative amount, got -12250"*. Refund events carry negative fils, and `format.ts` `bhd()` used non-negative `toFils`. `bhd()` now formats signed amounts. The detail page now shows **Refunded** (with a partial/full chip) and **Still refundable**. The timeline labels events as "Refunded (partial)" or "Refunded (full)", shows the refund ID, highlights refund rows, and shows amounts as `-12.250 BHD`. |
| ![](ui/before/dashboard-refund-drawer.png) | ![](ui/after/dashboard-refund-drawer.png) | **FP-212 / FP-300 RefundDrawer enabled.** Before, there was no refund control at all. The drawer was commented out, and it posted fils from a `type=number` input. Now the amount is entered in **BD with up to 3 decimals** and parsed by `@filspay/money`'s string parser (never `parseFloat`). It is prefilled with the full refundable amount (captured − refunded). An optional reason is limited to 500 characters with a counter. The button states exactly what will happen ("Refund 33.500 BHD (full)"). Focus moves to the amount field when the drawer opens and returns to the opener on Cancel or Esc. Only owner and finance users see the drawer, and the server enforces the same rule. |
| ![](ui/before/dashboard-refund-error.png) | ![](ui/after/dashboard-refund-error.png) | **Client-side validation.** An amount over the refundable figure, more than 3 decimals, zero, or text is caught next to the field, with `aria-invalid` and `aria-describedby`, before anything is sent. |
| ![](ui/before/dashboard-refund-server-error.png) | ![](ui/after/dashboard-refund-server-error.png) | **Server-side refusal.** In this shot the API's real `422` body `{code:"refund_exceeds_refundable", refundableFils}` was injected, to simulate a stale page where someone else refunded in the meantime. The drawer shows *"At most 2.000 BHD can be refunded"* in an assertive alert. Before, `ApiError` read only `body.error`, which this body doesn't have, so the code was `undefined`. `refunds_on_hold`, `impersonation_read_only`, `refund_declined`, `acquirer_unavailable`, `idempotency_key_reused` and `request_in_progress` all have their own messages. |
| ![](ui/before/dashboard-refund-success.png) | ![](ui/after/dashboard-refund-success.png) | **A real 5.500 BHD partial refund.** It goes through `POST /v1/merchants/:id/refunds` with an `Idempotency-Key`: one key per distinct request. The key is kept for a retry of the same amount and reason after a network error or 5xx, so the server replays its answer and never refunds twice. Any change, or a definitive answer, generates a new key. The button is disabled while submitting, and a ref guard stops double clicks. Afterwards the page reloads: a live notice says "Refunded 5.500 BHD… total 17.750 BHD", and the new event appears in the timeline. |
| ![](ui/before/dashboard-payment-links.png) | ![](ui/after/dashboard-payment-links.png) | **Expired links showed as "active".** The list returns the stored status, so a link past its expiry, which the server now refuses to take payment on (`#30`), looked payable. The list and detail pages now show **Expired** whenever an active or reserved link is past `expiresAt`. Filters still use the stored status, as the API does. |

Not in the screenshots: the capture form also takes BD with 3 decimals now, instead of raw fils. Transaction pages show success and error in live regions and offer **Try again** when loading fails. `describeError` turns any `403` into "Your role can't do this — ask an owner or finance user", and `TypeError` network failures into "Couldn't reach FilsPay".

## Admin console

| Before | After | What changed and why |
|---|---|---|
| ![](ui/before/admin-login.png) | ![](ui/after/admin-login.png) | Same sign-in error text and focus styles as the dashboard. |
| ![](ui/before/admin-merchants.png) | ![](ui/after/admin-merchants.png) | Unchanged list, plus a visible `:focus-visible` outline on every control. |
| ![](ui/before/admin-settlement.png) | ![](ui/after/admin-settlement.png) | When an admin's role can't use a section, the explanation used to be small grey print (`admin-muted`). It is now a visible read-only note (`admin-readonly`). |
| ![](ui/before/admin-settlement-rebuild.png) | ![](ui/after/admin-settlement-rebuild.png) | Rebuild balances, run against the Go settlement service, so that every merchant has a balance row. |
| ![](ui/before/admin-merchant-detail.png) | ![](ui/after/admin-merchant-detail.png) | Page-level notices and errors are now live regions. "View as merchant" now says the session is **read-only** (writes get a `403`). |
| ![](ui/before/admin-balance-confirm.png) | ![](ui/after/admin-balance-confirm.png) | **Balance adjustment** (`#68`: now journaled). Before, the operator typed raw signed **fils** ("50000"), and one click posted immediately with no review. Now the amount is entered in **BD with 3 decimals** ("-2.500", parsed with `parseBhdToFils`) and goes to a **review step** first. The review shows the current cached payable, the balance after the adjustment, and the reason. It also warns that ledger legs can't be deleted and that a mistake is fixed with an opposite adjustment. **Post adjustment to ledger** confirms. |
| ![](ui/before/admin-balance-adjusted.png) | ![](ui/after/admin-balance-adjusted.png) | **Confirmation.** Before, the result notice was rendered at the *top* of a long page, off screen, so the form looked like nothing had happened. If the merchant had no balance row, the bare `404` was shown off screen too. Now the confirmation sits right under the form in a live region: *"Adjustment journaled to the ledger: -2.500 BHD. Cached payable 5049.277 → 5046.777 BHD…"*. `merchant_balance_not_found` explains how to fix it ("Run Rebuild balances first"). |
| ![](ui/before/admin-impersonation.png) | ![](ui/after/admin-impersonation.png) | **Impersonation banner** (`#43`: now read-only). The banner now says **read-only**, lists what is refused (refunds, captures, payment-link and webhook changes, `403 impersonation_read_only`), and notes that every view is audited. It used to be `role=alert` and was re-announced on every render. It is now a labelled region, and only the exit error is an alert. |
| ![](ui/before/admin-support-readonly.png) | ![](ui/after/admin-support-readonly.png) | **Support role.** Before, a muted grey sentence was easy to miss. Now a read-only note names the role and says the server refuses with a 403. The same note is used for credits, KYC, recompute, settlement and imports. |
| ![](ui/before/admin-webhook-replay.png) | ![](ui/after/admin-webhook-replay.png) | **Replay restrictions.** For support, the `succeeded` checkbox is disabled, with a note: *"succeeded is locked for your role (support)… the server refuses it with 403"*. For finance and super admin, the note warns that replaying a succeeded delivery resends events the receiver already accepted. |
| ![](ui/before/admin-webhook-replay-forbidden.png) | ![](ui/after/admin-webhook-replay-forbidden.png) | **403 text.** Before, support could tick `succeeded` and got *"Not permitted (forbidden) — your admin role does not allow this action."*, which dropped the server's reason. Now the option can't be selected. If a 403 comes back anyway, `describeError` keeps the server's message and names the operator's role: *"Not permitted: replaying succeeded deliveries requires finance or super_admin. Your role (support) can't do this…"*. |

## Accessibility notes

- **Live regions.** Errors use `role="alert"` (assertive) and successes use `role="status"` (polite). They stay mounted, so screen readers announce changes, and take up no space when empty (`:empty { display:none }`).
- **Forms.** Every input has a `<label>` (the checkout uses `htmlFor`/`id`). Invalid fields are marked `aria-invalid` and point to their error text through `aria-describedby`. Focus moves to the first invalid field on submit.
- **Focus.**
  - Checkout outcome screens move focus to their `<h1>`.
  - The refund drawer focuses the amount field on open and returns focus to its opener on close. Esc closes it.
  - There is a 3 px `:focus-visible` outline on every control in all three apps, and a "Skip to content" link in the dashboard.
- **Busy states.** `aria-busy` is set on the checkout form, the refund button and the transactions table while they load. Inputs are disabled during payment.
- **Headings.** The checkout has one `<h1>`: the merchant name on the pay screen, the outcome on result screens. The form is an `<h2>`. Tables use `scope="col"`, and the timeline has a visually hidden caption.
- **Motion and colour.** The spinner respects `prefers-reduced-motion`. Refund amounts are marked by the minus sign and the "Refunded (partial)" label as well as by colour.
- **Not done.** There is no full WCAG contrast audit; the existing palette was kept. There is no focus trap in the refund drawer (it is inline, not modal). Dates still use browser-local time.

## Tests

- `npm test -w apps/web`: 17 tests pass. 9 are new in `apps/web/src/ux.new.test.ts`. They cover signed `bhd`, `parseBhdInput` (3 decimals, limits), the `refund_exceeds_refundable` text with the BD amount, `refundableFils`/`refundState`, `validateCard`, `displayLinkStatus` and `humanize`.
- `npm test -w apps/admin`: 5 tests pass. A test script was added to `apps/admin/package.json`, and `node` types to its tsconfig. The tests are in `apps/admin/src/ux.new.test.ts` and cover the signed BD parser and the 403 text with the server reason and role.
- `npm run typecheck` passes for all workspaces, `db` and `scripts`.

## Reproducing the screenshots

What you need: Docker Postgres (`ops-postgres-1`), Node 22, and either the Docker image
`mcr.microsoft.com/playwright:v1.55.0-noble` or a local `playwright@1.55.0`.

```bash
# 1. Database and current API (port 3310). The Go settlement service is optional;
#    it is used for "Rebuild balances".
docker exec ops-postgres-1 psql -U filspay -d postgres -c 'CREATE DATABASE filspay_ui'
export DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/filspay_ui?sslmode=disable'
npm run migrate && npm run seed            # prints a merchant API key per merchant
SETTLEMENT_INTERNAL_TOKEN=dev SETTLEMENT_INTERNAL_PORT=8391 ./settlement daemon &   # go build ./cmd/settlement
NODE_ENV=development PORT=3310 OTP_DEV_EXPOSE=true COOKIE_SECURE=false ACQUIRER_FAILURE_RATE=0 \
  SETTLEMENT_INTERNAL_URL=http://localhost:8391 SETTLEMENT_INTERNAL_TOKEN=dev \
  npx tsx apps/api/src/index.ts &

# 2. Build each frontend same-origin (empty API base) and serve it with the /v1 proxy.
git worktree add /tmp/ui-before 8b58b0f && (cd /tmp/ui-before && npm ci)   # "before" only
(cd apps/web   && VITE_API_BASE_URL= npx vite build --outDir /tmp/after-web)
(cd apps/admin && VITE_ADMIN_API_BASE_URL= VITE_WEB_BASE_URL=http://localhost:5320 npx vite build --outDir /tmp/after-admin)
node scripts/ui-screenshots.serve.mjs --dir /tmp/after-web   --port 5320 --api http://localhost:3310 &
node scripts/ui-screenshots.serve.mjs --dir /tmp/after-admin --port 5321 --api http://localhost:3310 &

# 3. Data through the public API: an open link, a paid link with a 12.250 BHD
#    partial refund, an expired link, a webhook endpoint.
node scripts/ui-screenshots.seed.mjs --api http://localhost:3310 \
  --merchant <Beta Digital Services id> --key <its fp_test_ key> > /tmp/fixture.json

# 4. Screenshots (the same script for before and after).
docker run --rm --network host --user 1000:1000 -e HOME=/tmp -v "$PWD":/repo -v /tmp:/job \
  mcr.microsoft.com/playwright:v1.55.0-noble node /repo/scripts/ui-screenshots.mjs \
  --web http://localhost:5320 --admin http://localhost:5321 --fixture /job/fixture.json \
  --out /repo/docs/ui/after --playwright /job/pw/node_modules/playwright/index.mjs
```

The "before" set uses the same commands, with the `/tmp/ui-before` builds served on ports 5310 and 5311 and `--out docs/ui/before`.

The script logs in with the `db/seed` fixture accounts (dev-only passwords documented in `db/seed/generate.ts`) and reads the dev OTP from the page.

Each step is best-effort. If a control doesn't exist in the build being photographed, such as the refund drawer before this change, the script prints a `(note)` and still takes the screenshot, because that absence is the evidence.

Two states are simulated with Playwright `route()`: the 409 "processing" screen and the server-side refund refusal. The network-error screen is produced by aborting the request. Everything else is real API traffic.
