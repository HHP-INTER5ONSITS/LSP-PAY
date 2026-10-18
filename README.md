# LSP-Pay

Light real server pay. A rupee wallet you sign into with an email code — no passwords — sign in with GitHub or Google, a payment PIN, and points on everything.

Built to run on a free Render web service with a GitHub repo behind it. Emails go out through Resend.

## What's inside

| Flow | What it does |
| --- | --- |
| Pay a person | Send rupees to anyone with an LSP-Pay account, by email. Lands in their balance instantly. |
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
| Ask LSP-Pay | An assistant in the wallet. Ask about your own spending, about the app, or anything else. |
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

## Sign in with GitHub and Google

Both are optional — without them the app still works on email codes alone, and the buttons simply don't appear. Set up either or both.

### GitHub

1. github.com → **Settings → Developer settings → OAuth Apps → New OAuth App**
2. Homepage URL: `https://lsp-pay.onrender.com`
3. Authorization callback URL: `https://lsp-pay.onrender.com/auth/github/callback`
4. Register, then **Generate a new client secret**

Add to Render: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### Google

1. console.cloud.google.com → create a project
2. **APIs & Services → OAuth consent screen** — External, fill in the app name and your email
3. **Credentials → Create Credentials → OAuth client ID → Web application**
4. Authorised redirect URI: `https://lsp-pay.onrender.com/auth/google/callback`

Add to Render: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Both

Also set `PUBLIC_URL` to `https://lsp-pay.onrender.com`. Without it the callback URL is guessed from request headers, which breaks behind some proxies.

The callback URL must match **character for character** — a trailing slash or `http` instead of `https` and the provider refuses. For local testing, register a second set of credentials against `http://localhost:3000/auth/<provider>/callback`.

**An account is matched by verified email.** If you already have a wallet from an email code and then sign in with GitHub using the same address, it links to that same wallet rather than making a second one. An address the provider has *not* verified is refused outright — otherwise anyone could sign up to a provider claiming your address and walk into your money. Unlinking is always allowed, because an email code is still a way in.

Client secrets go in Render's environment variables, never in the repo.

## LSP OAuth — be a sign-in provider

Separate from the payment gateway. Any account can register an app under **Settings → Developer — LSP OAuth** and put "Sign in with LSP-Pay" on another site, the way you'd use Google. You get a client ID (`lspc_…`, public) and a secret (`lspk_…`, shown once).

```
GET  /oauth/authorize?client_id=…&redirect_uri=…&scope=profile%20email&state=…
POST /oauth/token        code + secret  → access token
GET  /oauth/userinfo     Bearer token   → sub, name, email, balance
```

To see it work before wiring up another site, register an app whose redirect URL is `https://lsp-pay.onrender.com/oauth/playground` and open that page — it plays the third-party app and walks the whole flow, using PKCE so no secret is needed.

Scopes are `profile`, `email` and `wallet:read`. **None of them can move money or read a PIN** — there is no code path from a token to a payment. Redirect URLs must be registered and are matched exactly; codes are single-use and last 60 seconds; reusing one revokes the tokens it produced. Users see every app they've allowed under Settings and can cut it off, which kills live tokens immediately. Full docs at `/developers#lsp-oauth`.

## Ask LSP-Pay — the assistant

Set `GEMINI_API_KEY` in Render (get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)) and a new tile appears at the top of the app. Without a key the tile explains it isn't set up rather than failing silently.

`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` work instead if either is the one present; Gemini wins when more than one is set. Override the model with `GEMINI_MODEL`, `ANTHROPIC_MODEL` or `OPENAI_MODEL`.

Google now issues **authentication keys beginning `AQ.`** and is retiring the older `AIzaSy` ones. Both work here: the key is sent in the `x-goog-api-key` header rather than as a `?key=` query parameter, which is what the current docs specify and what `AQ.` keys require. It also keeps the key out of URLs, where it would otherwise end up in server logs.

The key stays in the environment and every call is made from the server — a key shipped to a page is a key anyone can lift and spend.

**The assistant cannot move money.** It has no tools and no write path: it is given a read-only summary of your own balance and recent activity so "where did my money go?" works, and that is all. It is also told never to ask for a PIN, a code or a card number. A chatbot that can move money is a chatbot that can be talked into moving money.

The assistant recovers from the two things that break on their own. If the configured model no longer exists, it asks your key what it can actually use, prefers a Flash model and carries on. If a model is temporarily full it retries, then tries the next one. `/api/ai/models` still lists what your key supports if you want to pin one with `GEMINI_MODEL`.

## Bot protection

The sign-in endpoint is the expensive door: every request there sends an email through Resend and can mint a wallet. Four layers guard it, none of which makes a person identify traffic lights.

**Proof of work.** The browser must find a nonce whose SHA-256 falls under a ceiling before the server will act. A first-time visitor waits about 150ms. A script pays that for every attempt, which is what turns a flood from free into expensive.

**Adaptive difficulty.** The work rises with recent attempts from an address — roughly 1,000 hashes, then 8,000, 50,000 and 200,000. The top step stays deliberately mild, because difficulty is keyed on address and plenty of real people share one; mobile carriers especially. Measured end to end in a browser: 154ms at the first level, 651ms at the third.

**A honeypot field**, hidden from people and from screen readers. A bot that fills every input gives itself away, and is then answered as though it succeeded — one that knows it was caught adapts, one that thinks it worked keeps wasting its time.

**Disposable-address rejection**, so throwaway inboxes cannot mint wallets in bulk.

Challenges are HMAC-signed so the server stores nothing, expire after five minutes, and may be spent once. Set `SHIELD_SECRET` to pin the signing key across restarts; it falls back to `JWT_SECRET`.

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
src/oauth.js    GitHub and Google sign-in (we are the client)
src/shield.js   proof of work, honeypot and disposable-address checks
src/ai.js       the assistant, and the Gemini/Claude/OpenAI adapters
src/idp.js      LSP OAuth — other apps sign in with LSP-Pay (we are the provider)
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
