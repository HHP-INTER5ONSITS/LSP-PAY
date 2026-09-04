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
| Points | 5 points per ₹100 spent, on every one of the flows above. |

The payment PIN starts at **00000**. Changing it sends a fresh code to your email first.

Every new wallet opens with ₹10,000 so you can test straight away. Change that with the `OPENING_BALANCE` variable.

---

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
public/         the app itself — plain HTML, CSS and JS, no build step
```

Money is stored in **paise as integers**, never floats, so rounding can't leak value. Each payment runs inside a single SQLite transaction: the debit, the credit and the points either all land or none do, and a balance can't go negative partway through.

PINs and one-time codes are hashed with scrypt and a per-record salt. Codes expire after 10 minutes, die after five wrong guesses, and can't be reused. Five wrong PINs lock payments for 15 minutes. Sessions are signed JWTs in an httpOnly cookie.

### The API

| Method | Path | |
| --- | --- | --- |
| POST | `/api/auth/request-code` | email a sign-in code |
| POST | `/api/auth/verify` | exchange the code for a session |
| GET | `/api/me` | current balance and points |
| POST | `/api/pin/request-code` · `/api/pin/change` | change the payment PIN |
| POST | `/api/pay/user` · `/api/pay/provider` | payments |
| POST | `/api/recharge/mobile` · `/api/recharge/fastag` | recharges |
| GET/POST | `/api/giftcards` · `/buy` · `/redeem` | gift cards |
| GET | `/api/transactions` | last 60 entries |

## One important limit

LSP-Pay moves balances **inside its own database**. It does not touch real money: no bank rails, no UPI, no card network, and the provider codes are LSP-Pay's own routing labels, not live Razorpay, Stripe or PayU accounts. Recharges and FASTag top-ups are recorded, not fulfilled by an operator.

To make any of it real you need a payment aggregator licence or a licensed partner, plus RBI KYC, and each provider's live API keys. Collecting other people's money without that is not something you can quietly ship — start with the provider's sandbox and their compliance team.

MIT licensed.
