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
