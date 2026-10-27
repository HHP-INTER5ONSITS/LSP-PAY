'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// On Render, mount a persistent disk and set DATA_DIR to its mount path
// (e.g. /var/data). Without a disk the file lives on ephemeral storage and
// resets on every deploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'lsp-pay.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL UNIQUE,
  handle       TEXT NOT NULL,
  pin_hash     TEXT NOT NULL,
  pin_salt     TEXT NOT NULL,
  balance_p    INTEGER NOT NULL DEFAULT 0,   -- balance in paise
  points       INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  daily_limit_p INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Money requests between people: "you owe me ₹400 for dinner".
CREATE TABLE IF NOT EXISTS requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id      INTEGER NOT NULL REFERENCES users(id),
  to_id        INTEGER NOT NULL REFERENCES users(id),
  amount_p     INTEGER NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | declined
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_to ON requests(to_id, status);

CREATE TABLE IF NOT EXISTS otps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL,
  purpose      TEXT NOT NULL,                -- 'login' | 'pin_change'
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  consumed     INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email, purpose);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL,                -- send | receive | provider | mobile | fastag | giftcard
  direction    TEXT NOT NULL,                -- debit | credit
  amount_p     INTEGER NOT NULL,
  points       INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL,
  detail       TEXT,
  reference    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC);

-- Saved cards. This table deliberately has no column for a card number.
-- We keep only what is safe to store: the processor's token, the last four
-- digits, brand and expiry. A leak of this table gives an attacker nothing
-- they can charge.
CREATE TABLE IF NOT EXISTS cards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  token        TEXT NOT NULL,
  brand        TEXT NOT NULL,
  last4        TEXT NOT NULL,
  exp_month    INTEGER NOT NULL,
  exp_year     INTEGER NOT NULL,
  label        TEXT,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);

-- A merchant account: one business, one set of API credentials.
-- key_id is public and may be embedded in a website. secret_hash is a
-- hashed password — the plaintext secret is shown once and never stored.
CREATE TABLE IF NOT EXISTS merchants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  logo_url      TEXT,
  theme         TEXT NOT NULL DEFAULT 'dark',
  methods       TEXT NOT NULL DEFAULT 'upi,card,netbanking',
  webhook_url   TEXT,
  notify_email  INTEGER NOT NULL DEFAULT 1,
  webhook_secret TEXT,
  key_id        TEXT NOT NULL UNIQUE,
  secret_hash   TEXT NOT NULL,
  secret_salt   TEXT NOT NULL,
  live          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_merchants_owner ON merchants(owner_id);

-- One payment request. Created by the merchant's server, paid by their
-- customer on the hosted checkout page.
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
  amount_p      INTEGER NOT NULL,
  description   TEXT,
  reference     TEXT,
  customer_email TEXT,
  status        TEXT NOT NULL DEFAULT 'created',  -- created | paid | awaiting_cash | failed | expired | refunded
  refunded_p    INTEGER NOT NULL DEFAULT 0,
  link_id       TEXT,
  idem_key      TEXT,
  method        TEXT,
  payer_note    TEXT,
  auth_code     TEXT,
  expires_at    INTEGER NOT NULL,
  paid_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON orders(merchant_id, idem_key) WHERE idem_key IS NOT NULL;

-- A link that can be shared and paid more than once: Razorpay's Payment
-- Pages. amount_p NULL means the payer chooses the amount.
CREATE TABLE IF NOT EXISTS payment_links (
  id           TEXT PRIMARY KEY,
  merchant_id  INTEGER NOT NULL REFERENCES merchants(id),
  title        TEXT NOT NULL,
  description  TEXT,
  amount_p     INTEGER,
  min_p        INTEGER NOT NULL DEFAULT 100,
  max_p        INTEGER NOT NULL DEFAULT 20000000,
  usage_limit  INTEGER,
  used_count   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  expires_at   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_links_merchant ON payment_links(merchant_id);

CREATE TABLE IF NOT EXISTS refunds (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  merchant_id  INTEGER NOT NULL REFERENCES merchants(id),
  amount_p     INTEGER NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

-- Queued webhook attempts, so a merchant's server being briefly down does
-- not lose the notification.
CREATE TABLE IF NOT EXISTS webhook_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id  INTEGER NOT NULL REFERENCES merchants(id),
  url          TEXT NOT NULL,
  event        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER NOT NULL,
  delivered    INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_pending ON webhook_jobs(delivered, next_at);

-- Line items, so an order can be a proper invoice rather than one figure.
CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  name         TEXT NOT NULL,
  qty          INTEGER NOT NULL DEFAULT 1,
  unit_p       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- Discount codes a customer types at checkout.
CREATE TABLE IF NOT EXISTS coupons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id  INTEGER NOT NULL REFERENCES merchants(id),
  code         TEXT NOT NULL,
  percent_off  INTEGER,
  amount_off_p INTEGER,
  min_spend_p  INTEGER NOT NULL DEFAULT 0,
  max_uses     INTEGER,
  used_count   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  expires_at   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_code ON coupons(merchant_id, code);

-- A standing instruction: pay this person this much, this often.
CREATE TABLE IF NOT EXISTS subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  to_email     TEXT NOT NULL,
  amount_p     INTEGER NOT NULL,
  interval_days INTEGER NOT NULL,
  note         TEXT,
  next_at      INTEGER NOT NULL,
  runs         INTEGER NOT NULL DEFAULT 0,
  max_runs     INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_due ON subscriptions(active, next_at);

-- A single payment queued for a future date.
CREATE TABLE IF NOT EXISTS scheduled (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  to_email     TEXT NOT NULL,
  amount_p     INTEGER NOT NULL,
  note         TEXT,
  run_at       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | cancelled
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled(status, run_at);

-- Saved payees, so you don't retype an address every time.
CREATE TABLE IF NOT EXISTS payees (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  email        TEXT NOT NULL,
  label        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payee_unique ON payees(user_id, email);

-- Bank accounts for withdrawals. Like cards, no full number is kept:
-- only the last four digits and the IFSC.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  holder       TEXT NOT NULL,
  last4        TEXT NOT NULL,
  ifsc         TEXT NOT NULL,
  bank         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payouts (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  bank_id      INTEGER NOT NULL REFERENCES bank_accounts(id),
  amount_p     INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'processing',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  body         TEXT,
  seen         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, seen);

-- Sign-in history, so someone can spot a session they don't recognise.
CREATE TABLE IF NOT EXISTS logins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  ip           TEXT,
  agent        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logins_user ON logins(user_id, id DESC);

-- A public pay handle, like a UPI ID. Share it anywhere; anyone pays it.
CREATE TABLE IF NOT EXISTS pay_handles (
  user_id      INTEGER NOT NULL UNIQUE REFERENCES users(id),
  handle       TEXT NOT NULL UNIQUE,
  auto_accept  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A payment offered to a handle's owner, who accepts or declines (unless
-- they have auto-accept on, in which case it settles at once).
CREATE TABLE IF NOT EXISTS handle_offers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payer_id     INTEGER NOT NULL REFERENCES users(id),
  receiver_id  INTEGER NOT NULL REFERENCES users(id),
  amount_p     INTEGER NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | declined | cancelled | failed
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offers_recv ON handle_offers(receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_offers_payer ON handle_offers(payer_id, status);

-- A card payment waiting to be approved on the redirect screen. No PIN:
-- the person authorises it there instead, the way an OAuth consent works.
CREATE TABLE IF NOT EXISTS pay_intents (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  spec         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | done | cancelled
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_cards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  face_p         INTEGER NOT NULL,
  paid_p         INTEGER NOT NULL,
  buyer_id       INTEGER NOT NULL REFERENCES users(id),
  recipient      TEXT NOT NULL,
  redeemed_by    INTEGER REFERENCES users(id),
  redeemed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = { db, DATA_DIR };
