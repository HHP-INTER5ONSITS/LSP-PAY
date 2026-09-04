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
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

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
