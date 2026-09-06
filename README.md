# LSP-Pay

Light real server pay. A rupee wallet you sign into with an email code — no passwords — with a payment PIN, six ways to spend, and points on everything.

Built to run on a free Render web service with a GitHub repo behind it. Emails go out through Resend.

## What's inside

| Flow | What it does |
| --- | --- |
| Pay a person | Send rupees to anyone with an LSP-Pay account, by email. Lands in their balance instantly. |
| Pay a payment provider | Settle to a gateway by routing code — Razorpay `0001119`, Stripe `0091023`, PayU `0099123`. |
| Recharge a mobile number | Prepaid top-up for Airtel, Jio, Vi or BSNL. |
| Top up FASTag | Toll balance against a tag number and vehicle. |
| Buy a gift card | ₹500 / ₹1,000 / ₹2,000 / ₹5,000 cards at 8% off. The code is emailed to the recipient, who redeems it into their own balance. |
| Debit cards | Save up to five cards, add money to your wallet from one, or pick a card at the moment you pay. |
| Business gateway | Take payments on your own website. Your server creates an order, the customer pays on a hosted page carrying your name, logo and theme, and the money lands in your wallet. UPI, card, netbanking, LSP-Pay wallet and cash. |
| Request money | Ask another user to pay you. They approve or decline; paying clears the request. |
| Spending insights | Where this month's money went, by category, with a CSV statement export. |
| Daily limit | A self-imposed cap. Card payments count towards it too. |
| Split a bill | Divide a total between up to fifteen people; each gets a request for their share. |
| Scheduled and recurring | A one-off payment on a future date, or a standing instruction that repeats. Skipped rather than overdrawn if the balance is short. |
| Bank withdrawals | Save up to three accounts and move money out. Only the last four digits are stored. |
| Saved payees | Anyone you pay is remembered as a quick-pick. |
| Notifications | Payments, requests, sign-ins and automatic payments, in one place. |
| Sign-in history | The last twenty sign-ins with address and device, so a stranger stands out. |
| Points | 5 points per ₹100 spent, on every one of the flows above. |

**Desktop and mobile.** Below 900px it's a single column like a payment app. Above that it becomes a two-pane desktop layout — a nav rail on the left, balance and activity on the right — and sheets become centred dialogs instead of bottom sheets.

**Light and dark.** The app follows your device setting, and the sun/moon button in the header overrides it. Your choice is remembered on that device.

Cards are in **demo mode**: nothing is charged and no bank is contacted. Test with `4111 1111 1111 1111`. Three numbers decline on purpose so you can see the failure paths — `4000 0000 0000 9995` (no funds), `4000 0000 0000 0002` (bank refused), `4000 0000 0000 0069` (expired).

The payment PIN starts at **00000**. Changing it sends a fresh code to your email first.

Every new wallet opens with ₹10,000 so you can test straight away. Change that with the `OPENING_BALANCE` variable.

---

## The business gateway

Open **Business gateway** in the app to create one. You get a **key ID** (`lsp_test_…`, public) and a **secret** (`lsps_…`, private, shown once).

```bash
# From your server. Never from a browser.
curl -X POST https://YOUR-APP.onrender.com/api/v1/orders \
  -u "lsp_test_xxx:lsps_xxx" \
  -H "Content-Type: application/json" \
  -d '{"amount": 499, "description": "Blue shirt", "reference": "your-8821"}'
```

Send the customer to the `checkoutUrl` that comes back, then confirm the result by webhook (HMAC-SHA256 signed) or by polling `GET /api/v1/orders/:id`. Full docs live at `/developers` on your own deployment.

**The secret is a password.** Anyone holding it can create orders in your name, read your customers' email addresses and mark payments as collected. Keep it in a server environment variable — never in HTML, never in JavaScript, never in your repo. If it leaks, reset it in the app and the old one dies instantly.

Never trust the customer's browser to tell you a payment succeeded. Check the API.

**Also in the gateway:** discount codes customers type at checkout (percentage or flat, with minimum spend, use limits and expiry), invoice line items, up to three gateways per account with a switcher, a customer list, printable QR codes for any payment link (`/l/:id/qr.svg`), refunds (full or partial, back to the payer's wallet where possible), shareable payment links that work like Razorpay's payment pages, `Idempotency-Key` support so a retried request never double-charges, webhook retries with backoff, a settlement summary and a CSV export.

**Emails.** Add `"notify": true` and a `customer_email` when creating an order and the customer is emailed the payment link with a Pay button — Razorpay's Payment Links, essentially, so you can charge someone without having a website at all. They also get a receipt once paid, and you get an alert when money arrives. `POST /api/v1/orders/:id/notify` sends the link again. All of it goes through Resend, so verify a domain there before emailing real customers.

## 1. Get a Resend API key

1. Sign up at [resend.com](https://resend.com) and open **API Keys → Create API Key**.
2. Copy the key. It starts with `re_`.
3. Sending address: until you verify a domain, Resend only lets `onboarding@resend.dev` send, **and only to the email you signed up with**. To email anyone else, go to **Domains → Add Domain**, add the DNS records they give you, then set `MAIL_FROM` to something like `LSP-Pay <no-reply@yourdomain.com>`.

## 2. Put the code on GitHub

From this folder:

```bash
git init
git add .
git commit -m "LSP-Pay"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/lsp-pay.git
git push -u origin main
```

Create the empty `lsp-pay` repo on GitHub first, and leave it without a README so the push isn't rejected.

`.gitignore` already keeps `.env`, `node_modules/` and `data/` out of the repo. Never commit your Resend key.

## 3. Deploy on Render

1. [dashboard.render.com](https://dashboard.render.com) → **New → Web Service** → connect your GitHub repo.
2. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
3. Under **Environment**, add:

   | Key | Value |
   | --- | --- |
   | `RESEND_API_KEY` | your `re_…` key |
   | `MAIL_FROM` | `LSP-Pay <onboarding@resend.dev>` |
   | `JWT_SECRET` | a long random string — run `openssl rand -hex 32` |
   | `OPENING_BALANCE` | `10000` |
   | `NODE_ENV` | `production` |

4. **Create Web Service**. First build takes two or three minutes. Your site lands at `https://lsp-pay.onrender.com`.

The repo also has a `render.yaml`, so you can instead pick **New → Blueprint** and Render will read the settings from it. You still paste the Resend key by hand.

### About the free plan

Two things to know:

- **The service sleeps** after 15 minutes idle. The next visit takes ~30 seconds to wake.
- **The disk is wiped on every deploy**, so accounts and balances reset. To keep them, move to the Starter plan and uncomment the `disk` block plus the `DATA_DIR` variable in `render.yaml`. The database is a single SQLite file, so a 1 GB disk is plenty.

## 4. Run it on your own machine

```bash
npm install
cp .env.example .env      # then fill in the values
npm run dev
```

Open `http://localhost:3000`.

Without a Resend key the app still works — the sign-in code prints to your terminal instead of being emailed. Set `SHOW_CODES=true` in `.env` and it shows on screen too. **Leave `SHOW_CODES` off in production**, or anyone can sign in as anyone.

---

## How it's put together

```
src/server.js   all routes, PIN checks, money movement
src/db.js       SQLite schema
src/mail.js     Resend calls and the email templates
src/cards.js    card validation and the demo tokeniser
src/gateway.js  merchant accounts, the public API, checkout and webhooks
public/         the app itself — plain HTML, CSS and JS, no build step
```

Money is stored in **paise as integers**, never floats, so rounding can't leak value. Each payment runs inside a single SQLite transaction: the debit, the credit and the points either all land or none do, and a balance can't go negative partway through.

**No card number is ever stored.** The `cards` table has no column for one. A number is validated, reduced to a brand and last four digits, and discarded — it is never written to disk, never logged, never returned. To go live you replace `tokenise` and `authorise` in `src/cards.js` with real processor calls, and send the card from the browser to the processor directly so it never reaches this server. Storing real card numbers puts you inside PCI DSS and is not something to attempt on a hobby deployment.

PINs and one-time codes are hashed with scrypt and a per-record salt. Codes expire after 10 minutes, die after five wrong guesses, and can't be reused. Five wrong PINs lock payments for 15 minutes. Sessions are signed JWTs in an httpOnly cookie.

### The API

| Method | Path | |
| --- | --- | --- |
| POST | `/api/auth/request-code` | email a sign-in code |
| POST | `/api/auth/verify` | exchange the code for a session |
| GET | `/api/me` | current balance and points |
| POST | `/api/pin/request-code` · `/api/pin/change` | change the payment PIN |
| POST | `/api/pay/user` · `/api/pay/provider` | payments, optionally with `cardId` |
| GET/POST | `/api/cards` · `/default` · `/remove` · `/topup` | the card vault |
| POST | `/api/recharge/mobile` · `/api/recharge/fastag` | recharges |
| GET/POST | `/api/giftcards` · `/buy` · `/redeem` | gift cards |
| GET | `/api/transactions` | last 60 entries |
| POST/GET | `/api/v1/orders` · `/:id` · `/:id/collect` | merchant API (Basic auth) |
| GET/POST | `/api/checkout/:id` · `/pay` | hosted checkout, public |

## One important limit

The gateway blocks double payment, replayed and expired links, tampered webhooks and one merchant reading another's orders — all tested. What no amount of code fixes is the licensing: LSP-Pay moves balances **inside its own database**. It does not touch real money: no bank rails, no UPI, no card network, and the provider codes are LSP-Pay's own routing labels, not live Razorpay, Stripe or PayU accounts. Recharges and FASTag top-ups are recorded, not fulfilled by an operator.

To make any of it real you need a payment aggregator licence or a licensed partner, plus RBI KYC, and each provider's live API keys. Collecting other people's money without that is not something you can quietly ship — start with the provider's sandbox and their compliance team.

MIT licensed.
