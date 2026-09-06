'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const { db } = require('./db');
const mail = require('./mail');
const cards = require('./cards');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const IS_PROD = process.env.NODE_ENV === 'production';
const SHOW_CODES = process.env.SHOW_CODES === 'true'; // dev only: returns OTP in the response
const OPENING_BALANCE_P = Math.round(Number(process.env.OPENING_BALANCE || 10000) * 100);
const DEFAULT_PIN = '00000';

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

/* ---------------------------------------------------------------- helpers */

const PROVIDERS = {
  '0001119': { name: 'Razorpay', blurb: 'Cards, UPI and netbanking settlements' },
  '0091023': { name: 'Stripe', blurb: 'International card settlements' },
  '0099123': { name: 'PayU', blurb: 'Domestic collections and payouts' }
};

const OPERATORS = ['Airtel', 'Jio', 'Vi', 'BSNL'];
const GIFT_DISCOUNT = 0.08; // 8% off face value
const GIFT_FACES = [500, 1000, 2000, 5000];

const paise = (rupees) => Math.round(Number(rupees) * 100);
const inr = (p) =>
  '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pointsFor = (amountP) => Math.max(1, Math.floor((amountP / 100) * 0.05));

const reference = () =>
  'LSP' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();

const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const handleFor = (email) => email.split('@')[0].replace(/[^a-z0-9._-]/gi, '').slice(0, 24) || 'user';

function hash(value) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(value), salt, 32).toString('hex');
  return { digest, salt };
}
function verifyHash(value, digest, salt) {
  const candidate = crypto.scryptSync(String(value), salt, 32);
  const known = Buffer.from(digest, 'hex');
  return known.length === candidate.length && crypto.timingSafeEqual(known, candidate);
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

/* ------------------------------------------------------------------- OTPs */

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 45 * 1000;

const insertOtp = db.prepare(
  `INSERT INTO otps (email, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
);
const latestOtp = db.prepare(
  `SELECT * FROM otps WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1`
);

async function issueCode(email, purpose, sender) {
  const recent = latestOtp.get(email, purpose);
  if (recent && Date.now() - recent.created_at < OTP_COOLDOWN_MS && !recent.consumed) {
    const wait = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - recent.created_at)) / 1000);
    return { ok: false, status: 429, message: `Wait ${wait}s before asking for another code.` };
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const { digest, salt } = hash(code);
  insertOtp.run(email, purpose, `${salt}:${digest}`, Date.now() + OTP_TTL_MS, Date.now());

  const result = await sender(email, code);
  return { ok: true, delivered: result.delivered, reason: result.reason, code };
}

function consumeCode(email, purpose, code) {
  const row = latestOtp.get(email, purpose);
  if (!row) return { ok: false, message: 'Ask for a code first.' };
  if (row.consumed) return { ok: false, message: 'That code was already used. Ask for a new one.' };
  if (Date.now() > row.expires_at) return { ok: false, message: 'That code expired. Ask for a new one.' };
  if (row.attempts >= 5) return { ok: false, message: 'Too many wrong tries. Ask for a new code.' };

  const [salt, digest] = row.code_hash.split(':');
  if (!verifyHash(String(code).trim(), digest, salt)) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { ok: false, message: `Wrong code. ${4 - row.attempts} tries left.` };
  }
  db.prepare('UPDATE otps SET consumed = 1 WHERE id = ?').run(row.id);
  return { ok: true };
}

/* --------------------------------------------------------------- accounts */

const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserById = db.prepare('SELECT * FROM users WHERE id = ?');

const createUser = db.transaction((email) => {
  const { digest, salt } = hash(DEFAULT_PIN);
  const info = db
    .prepare('INSERT INTO users (email, handle, pin_hash, pin_salt, balance_p) VALUES (?, ?, ?, ?, ?)')
    .run(email, handleFor(email), digest, salt, OPENING_BALANCE_P);

  if (OPENING_BALANCE_P > 0) {
    db.prepare(
      `INSERT INTO transactions (user_id, kind, direction, amount_p, points, title, detail, reference)
       VALUES (?, 'receive', 'credit', ?, 0, 'Welcome credit', 'Opening balance for your new wallet', ?)`
    ).run(info.lastInsertRowid, OPENING_BALANCE_P, reference());
  }
  return findUserById.get(info.lastInsertRowid);
});

function publicUser(u) {
  return {
    email: u.email,
    handle: u.handle,
    displayName: u.display_name,
    name: u.display_name || u.handle,
    dailyLimit: u.daily_limit_p ? u.daily_limit_p / 100 : null,
    balance: u.balance_p / 100,
    balanceLabel: inr(u.balance_p),
    points: u.points,
    pinIsDefault: verifyHash(DEFAULT_PIN, u.pin_hash, u.pin_salt)
  };
}

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('lsp_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function auth(req, res, next) {
  const token = req.cookies?.lsp_session;
  if (!token) return fail(res, 401, 'Sign in to continue.');
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = findUserById.get(uid);
    if (!user) return fail(res, 401, 'Sign in to continue.');
    req.user = user;
    next();
  } catch {
    return fail(res, 401, 'Your session expired. Sign in again.');
  }
}

/* ------------------------------------------------------------------- PINs */

const pinLocks = new Map(); // userId -> { misses, until }

function checkPin(user, pin) {
  const lock = pinLocks.get(user.id);
  if (lock?.until && Date.now() < lock.until) {
    const mins = Math.ceil((lock.until - Date.now()) / 60000);
    return { ok: false, message: `PIN locked for ${mins} more minute(s).` };
  }
  if (!/^\d{5}$/.test(String(pin || ''))) return { ok: false, message: 'Enter your 5-digit PIN.' };

  if (!verifyHash(String(pin), user.pin_hash, user.pin_salt)) {
    const misses = (lock?.misses || 0) + 1;
    if (misses >= 5) {
      pinLocks.set(user.id, { misses: 0, until: Date.now() + 15 * 60 * 1000 });
      return { ok: false, message: 'Wrong PIN 5 times. Payments locked for 15 minutes.' };
    }
    pinLocks.set(user.id, { misses, until: 0 });
    return { ok: false, message: `Wrong PIN. ${5 - misses} tries left.` };
  }
  pinLocks.delete(user.id);
  return { ok: true };
}

/* --------------------------------------------------------------- payments */

const addTx = db.prepare(
  `INSERT INTO transactions (user_id, kind, direction, amount_p, points, title, detail, reference)
   VALUES (@user_id, @kind, @direction, @amount_p, @points, @title, @detail, @reference)`
);

/**
 * Debits the payer, credits points, and optionally credits a payee.
 * Runs as one SQLite transaction so a balance can never go negative halfway.
 */
const settle = db.transaction((payer, { amountP, kind, title, detail, payee, payeeTitle, card }) => {
  // Wallet payments need a balance. Card payments don't touch it.
  if (!card) {
    const fresh = findUserById.get(payer.id);
    if (fresh.balance_p < amountP) throw new Error('INSUFFICIENT');
  }

  const earned = pointsFor(amountP);
  const ref = reference();

  db.prepare('UPDATE users SET balance_p = balance_p - ?, points = points + ? WHERE id = ?').run(
    card ? 0 : amountP,
    earned,
    payer.id
  );
  addTx.run({
    user_id: payer.id,
    kind,
    direction: 'debit',
    amount_p: amountP,
    points: earned,
    title,
    detail: detail || null,
    reference: ref
  });

  if (payee) {
    db.prepare('UPDATE users SET balance_p = balance_p + ? WHERE id = ?').run(amountP, payee.id);
    addTx.run({
      user_id: payee.id,
      kind: 'receive',
      direction: 'credit',
      amount_p: amountP,
      points: 0,
      title: payeeTitle || `Received from ${payer.handle}`,
      detail: detail || null,
      reference: ref
    });
  }

  return { reference: ref, points: earned, balance_p: findUserById.get(payer.id).balance_p };
});

function amountCheck(raw, { min = 1, max = 200000 } = {}) {
  const rupees = Number(raw);
  if (!Number.isFinite(rupees) || rupees <= 0) return { ok: false, message: 'Enter an amount.' };
  if (rupees < min) return { ok: false, message: `Minimum is ${inr(paise(min))}.` };
  if (rupees > max) return { ok: false, message: `Maximum per payment is ${inr(paise(max))}.` };
  const p = paise(rupees);
  if (p !== Math.round(p)) return { ok: false, message: 'Use at most two decimal places.' };
  return { ok: true, amountP: p };
}

async function runPayment(req, res, { amountP, kind, title, detail, payee, payeeTitle, receiptTitle }) {
  const pinResult = checkPin(req.user, req.body.pin);
  if (!pinResult.ok) return fail(res, 403, pinResult.message);

  // A self-imposed daily cap. Card payments count too — the point is to
  // limit spending, not just wallet drawdown.
  if (req.user.daily_limit_p) {
    const already = spentToday(req.user.id);
    if (already + amountP > req.user.daily_limit_p)
      return fail(res, 403, `That would pass your daily limit of ${inr(req.user.daily_limit_p)}. You have ${inr(Math.max(0, req.user.daily_limit_p - already))} left today.`);
  }

  // Optional: pay straight from a saved card instead of the wallet.
  let card = null;
  if (req.body.cardId) {
    card = findCard.get(Number(req.body.cardId), req.user.id);
    if (!card) return fail(res, 404, 'That card is not on your account.');

    const auth = cards.authorise(card, amountP);
    if (!auth.ok) return fail(res, 402, auth.message);

    detail = [detail, `Paid by ${cards.describe(card)} · ${auth.authCode}`].filter(Boolean).join(' · ');
  }

  let out;
  try {
    out = settle(req.user, { amountP, kind, title, detail, payee, payeeTitle, card });
  } catch (err) {
    if (err.message === 'INSUFFICIENT') return fail(res, 400, 'Not enough balance for this payment.');
    throw err;
  }

  mail
    .sendReceipt(req.user.email, {
      title: receiptTitle || title,
      amountLabel: inr(amountP),
      reference: out.reference,
      detail,
      balanceLabel: inr(out.balance_p),
      points: out.points
    })
    .catch((e) => console.error('[mail] receipt failed:', e.message));

  return res.json({
    ok: true,
    reference: out.reference,
    amountLabel: inr(amountP),
    points: out.points,
    title,
    detail,
    user: publicUser(findUserById.get(req.user.id))
  });
}

/* ------------------------------------------------------------ rate limits */

const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
const payLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

/* ------------------------------------------------------------------ auth  */

app.post('/api/auth/request-code', codeLimiter, async (req, res) => {
  const email = normEmail(req.body.email);
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');

  const out = await issueCode(email, 'login', mail.sendLoginCode);
  if (!out.ok) return fail(res, out.status, out.message);

  const existing = !!findUserByEmail.get(email);
  res.json({
    ok: true,
    email,
    existing,
    delivered: out.delivered,
    note: out.delivered ? null : `Email not sent: ${out.reason}. Check the server logs.`,
    devCode: SHOW_CODES ? out.code : undefined
  });
});

app.post('/api/auth/verify', codeLimiter, (req, res) => {
  const email = normEmail(req.body.email);
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');

  const check = consumeCode(email, 'login', req.body.code);
  if (!check.ok) return fail(res, 400, check.message);

  const user = findUserByEmail.get(email) || createUser(email);
  setSession(res, user);

  const agent = String(req.get('user-agent') || '').slice(0, 160);
  const ip = (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
  db.prepare('INSERT INTO logins (user_id, ip, agent) VALUES (?, ?, ?)').run(user.id, ip, agent);

  const priorCount = db.prepare('SELECT COUNT(*) n FROM logins WHERE user_id = ?').get(user.id).n;
  if (priorCount > 1) notify(user.id, 'New sign-in', `From ${ip || 'an unknown address'}. If this was not you, change your PIN.`);

  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('lsp_session');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ------------------------------------------------------------- 2. the PIN */

app.post('/api/pin/request-code', auth, codeLimiter, async (req, res) => {
  const out = await issueCode(req.user.email, 'pin_change', mail.sendPinChangeCode);
  if (!out.ok) return fail(res, out.status, out.message);
  res.json({
    ok: true,
    delivered: out.delivered,
    note: out.delivered ? null : `Email not sent: ${out.reason}. Check the server logs.`,
    devCode: SHOW_CODES ? out.code : undefined
  });
});

app.post('/api/pin/change', auth, (req, res) => {
  const newPin = String(req.body.newPin || '');
  if (!/^\d{5}$/.test(newPin)) return fail(res, 400, 'Your PIN must be exactly 5 digits.');
  if (/^(\d)\1{4}$/.test(newPin) && newPin !== DEFAULT_PIN)
    return fail(res, 400, 'Pick a PIN that is not the same digit five times.');

  const check = consumeCode(req.user.email, 'pin_change', req.body.code);
  if (!check.ok) return fail(res, 400, check.message);

  const { digest, salt } = hash(newPin);
  db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(digest, salt, req.user.id);
  pinLocks.delete(req.user.id);
  res.json({ ok: true, user: publicUser(findUserById.get(req.user.id)) });
});

/* ------------------------------------------------------ 1. pay a provider */

app.get('/api/providers', auth, (req, res) => {
  res.json({
    providers: Object.entries(PROVIDERS).map(([code, p]) => ({ code, ...p }))
  });
});

app.post('/api/pay/provider', auth, payLimiter, async (req, res) => {
  const code = String(req.body.code || '').trim();
  const provider = PROVIDERS[code];
  if (!provider) return fail(res, 400, 'No provider matches that code.');

  const amt = amountCheck(req.body.amount);
  if (!amt.ok) return fail(res, 400, amt.message);

  return runPayment(req, res, {
    amountP: amt.amountP,
    kind: 'provider',
    title: `${provider.name} settlement`,
    detail: `Provider code ${code}${req.body.note ? ' · ' + String(req.body.note).slice(0, 80) : ''}`
  });
});

/* ------------------------------------------------------- pay another user */

app.get('/api/directory', auth, (req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const rows = db
    .prepare('SELECT email, handle, display_name FROM users WHERE id != ? AND (email LIKE ? OR handle LIKE ? OR display_name LIKE ?) LIMIT 8')
    .all(req.user.id, q, q, q);
  res.json({ people: rows });
});

app.post('/api/pay/user', auth, payLimiter, async (req, res) => {
  const to = normEmail(req.body.to);
  if (!validEmail(to)) return fail(res, 400, 'Enter the receiver\u2019s email address.');
  if (to === req.user.email) return fail(res, 400, 'You cannot pay yourself.');

  const payee = findUserByEmail.get(to);
  if (!payee) return fail(res, 404, 'Nobody uses LSP-Pay with that email yet.');

  const amt = amountCheck(req.body.amount);
  if (!amt.ok) return fail(res, 400, amt.message);

  // Paying someone clears any pending request they sent you.
  const pending = db
    .prepare("SELECT id FROM requests WHERE from_id = ? AND to_id = ? AND status = 'pending' AND amount_p = ? ORDER BY id DESC LIMIT 1")
    .get(payee.id, req.user.id, amt.amountP);
  if (pending) db.prepare("UPDATE requests SET status = 'paid' WHERE id = ?").run(pending.id);

  db.prepare('INSERT OR IGNORE INTO payees (user_id, email) VALUES (?, ?)').run(req.user.id, to);
  notify(payee.id, `${req.user.display_name || req.user.handle} paid you`, inr(amt.amountP));

  const note = String(req.body.note || '').slice(0, 80);
  return runPayment(req, res, {
    amountP: amt.amountP,
    kind: 'send',
    title: `Paid ${payee.display_name || payee.handle}`,
    detail: note || null,
    payee,
    payeeTitle: `Received from ${req.user.display_name || req.user.handle}`,
    receiptTitle: `${payee.handle} (${payee.email})`
  });
});

/* -------------------------------------------------- 3. mobile recharge */

app.post('/api/recharge/mobile', auth, payLimiter, async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  if (!/^[6-9]\d{9}$/.test(phone)) return fail(res, 400, 'Enter a 10-digit Indian mobile number.');

  const operator = OPERATORS.includes(req.body.operator) ? req.body.operator : 'Airtel';
  const amt = amountCheck(req.body.amount, { min: 10, max: 5000 });
  if (!amt.ok) return fail(res, 400, amt.message);

  return runPayment(req, res, {
    amountP: amt.amountP,
    kind: 'mobile',
    title: `${operator} recharge`,
    detail: `${phone.slice(0, 5)} ${phone.slice(5)}`
  });
});

/* -------------------------------------------------- 4. FASTag recharge */

app.post('/api/recharge/fastag', auth, payLimiter, async (req, res) => {
  const tag = String(req.body.tagId || '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z0-9]{8,20}$/.test(tag)) return fail(res, 400, 'Enter a FASTag number of 8 to 20 characters.');

  const vehicle = String(req.body.vehicle || '').toUpperCase().replace(/\s/g, '').slice(0, 12);
  const amt = amountCheck(req.body.amount, { min: 100, max: 20000 });
  if (!amt.ok) return fail(res, 400, amt.message);

  return runPayment(req, res, {
    amountP: amt.amountP,
    kind: 'fastag',
    title: 'FASTag top-up',
    detail: `Tag ${tag}${vehicle ? ' · ' + vehicle : ''}`
  });
});

/* ------------------------------------------------------- 5. gift cards */

app.get('/api/giftcards', auth, (req, res) => {
  const mine = db
    .prepare(
      `SELECT code, face_p, paid_p, recipient, created_at, redeemed_at
       FROM gift_cards WHERE buyer_id = ? ORDER BY id DESC LIMIT 20`
    )
    .all(req.user.id);

  res.json({
    discount: GIFT_DISCOUNT,
    faces: GIFT_FACES.map((face) => ({
      face,
      faceLabel: inr(paise(face)),
      price: Math.round(face * (1 - GIFT_DISCOUNT)),
      priceLabel: inr(Math.round(paise(face) * (1 - GIFT_DISCOUNT))),
      saveLabel: inr(paise(face) - Math.round(paise(face) * (1 - GIFT_DISCOUNT)))
    })),
    cards: mine.map((c) => ({
      code: c.code,
      faceLabel: inr(c.face_p),
      paidLabel: inr(c.paid_p),
      recipient: c.recipient,
      createdAt: c.created_at,
      redeemed: !!c.redeemed_at
    }))
  });
});

app.post('/api/giftcards/buy', auth, payLimiter, async (req, res) => {
  const face = Number(req.body.face);
  if (!GIFT_FACES.includes(face)) return fail(res, 400, 'Pick one of the listed gift card values.');

  const recipient = normEmail(req.body.recipient);
  if (!validEmail(recipient)) return fail(res, 400, 'Enter the receiver\u2019s email address.');

  const faceP = paise(face);
  const priceP = Math.round(faceP * (1 - GIFT_DISCOUNT));
  const message = String(req.body.message || '').slice(0, 140);

  const pinResult = checkPin(req.user, req.body.pin);
  if (!pinResult.ok) return fail(res, 403, pinResult.message);

  const code = 'LSPG-' + crypto.randomBytes(4).toString('hex').toUpperCase().match(/.{4}/g).join('-');

  let card = null;
  let detail = `Sent to ${recipient}`;
  if (req.body.cardId) {
    card = findCard.get(Number(req.body.cardId), req.user.id);
    if (!card) return fail(res, 404, 'That card is not on your account.');
    const authed = cards.authorise(card, priceP);
    if (!authed.ok) return fail(res, 402, authed.message);
    detail += ` · Paid by ${cards.describe(card)} · ${authed.authCode}`;
  }

  let out;
  try {
    out = settle(req.user, {
      amountP: priceP,
      kind: 'giftcard',
      title: `${inr(faceP)} gift card`,
      detail,
      card
    });
  } catch (err) {
    if (err.message === 'INSUFFICIENT') return fail(res, 400, 'Not enough balance for this gift card.');
    throw err;
  }

  db.prepare(
    'INSERT INTO gift_cards (code, face_p, paid_p, buyer_id, recipient) VALUES (?, ?, ?, ?, ?)'
  ).run(code, faceP, priceP, req.user.id, recipient);

  const delivery = await mail.sendGiftCard(recipient, {
    code,
    faceLabel: inr(faceP),
    buyer: req.user.handle,
    message
  });

  res.json({
    ok: true,
    code,
    reference: out.reference,
    points: out.points,
    faceLabel: inr(faceP),
    amountLabel: inr(priceP),
    savedLabel: inr(faceP - priceP),
    recipient,
    delivered: delivery.delivered,
    note: delivery.delivered ? null : `Email not sent: ${delivery.reason}. The code above still works.`,
    user: publicUser(findUserById.get(req.user.id))
  });
});

app.post('/api/giftcards/redeem', auth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const card = db.prepare('SELECT * FROM gift_cards WHERE code = ?').get(code);

  if (!card) return fail(res, 404, 'No gift card matches that code.');
  if (card.redeemed_at) return fail(res, 400, 'That gift card was already redeemed.');
  if (card.recipient !== req.user.email)
    return fail(res, 403, 'That card was sent to a different email address.');

  db.transaction(() => {
    db.prepare('UPDATE users SET balance_p = balance_p + ? WHERE id = ?').run(card.face_p, req.user.id);
    db.prepare('UPDATE gift_cards SET redeemed_by = ?, redeemed_at = datetime(\'now\') WHERE id = ?').run(
      req.user.id,
      card.id
    );
    addTx.run({
      user_id: req.user.id,
      kind: 'receive',
      direction: 'credit',
      amount_p: card.face_p,
      points: 0,
      title: 'Gift card redeemed',
      detail: card.code,
      reference: reference()
    });
  })();

  res.json({
    ok: true,
    creditedLabel: inr(card.face_p),
    user: publicUser(findUserById.get(req.user.id))
  });
});

/* --------------------------------------------------------- debit cards */

const findCard = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?');

const publicCard = (c) => ({
  id: c.id,
  brand: c.brand,
  last4: c.last4,
  label: c.label,
  expiry: `${String(c.exp_month).padStart(2, '0')}/${String(c.exp_year).slice(-2)}`,
  isDefault: !!c.is_default,
  display: cards.describe(c)
});

app.get('/api/cards', auth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM cards WHERE user_id = ? ORDER BY is_default DESC, id DESC')
    .all(req.user.id);
  res.json({ cards: rows.map(publicCard), maxPerCharge: 50000 });
});

app.post('/api/cards', auth, payLimiter, (req, res) => {
  const check = cards.inspect(req.body);
  if (!check.ok) return fail(res, 400, check.message);

  const mine = db.prepare('SELECT COUNT(*) n FROM cards WHERE user_id = ?').get(req.user.id).n;
  if (mine >= 5) return fail(res, 400, 'You can save up to five cards. Remove one first.');

  const dupe = db
    .prepare('SELECT id FROM cards WHERE user_id = ? AND last4 = ? AND brand = ? AND exp_month = ? AND exp_year = ?')
    .get(req.user.id, check.last4, check.brand, check.expMonth, check.expYear);
  if (dupe) return fail(res, 400, 'That card is already saved.');

  // The token is all we keep. check.digits goes out of scope here and is
  // never written anywhere.
  const token = cards.tokenise();
  const label = String(req.body.label || '').slice(0, 24) || null;

  const info = db
    .prepare(
      `INSERT INTO cards (user_id, token, brand, last4, exp_month, exp_year, label, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, token, check.brand, check.last4, check.expMonth, check.expYear, label, mine === 0 ? 1 : 0);

  res.json({ ok: true, card: publicCard(findCard.get(info.lastInsertRowid, req.user.id)) });
});

app.post('/api/cards/default', auth, (req, res) => {
  const card = findCard.get(Number(req.body.cardId), req.user.id);
  if (!card) return fail(res, 404, 'That card is not on your account.');

  db.transaction(() => {
    db.prepare('UPDATE cards SET is_default = 0 WHERE user_id = ?').run(req.user.id);
    db.prepare('UPDATE cards SET is_default = 1 WHERE id = ?').run(card.id);
  })();
  res.json({ ok: true });
});

app.post('/api/cards/remove', auth, (req, res) => {
  const card = findCard.get(Number(req.body.cardId), req.user.id);
  if (!card) return fail(res, 404, 'That card is not on your account.');

  db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
  const next = db.prepare('SELECT id FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(req.user.id);
  if (card.is_default && next) db.prepare('UPDATE cards SET is_default = 1 WHERE id = ?').run(next.id);

  res.json({ ok: true });
});

/** Add money to the wallet from a saved card. */
app.post('/api/cards/topup', auth, payLimiter, (req, res) => {
  const card = findCard.get(Number(req.body.cardId), req.user.id);
  if (!card) return fail(res, 404, 'That card is not on your account.');

  const amt = amountCheck(req.body.amount, { min: 100, max: 50000 });
  if (!amt.ok) return fail(res, 400, amt.message);

  const pinResult = checkPin(req.user, req.body.pin);
  if (!pinResult.ok) return fail(res, 403, pinResult.message);

  const authed = cards.authorise(card, amt.amountP);
  if (!authed.ok) return fail(res, 402, authed.message);

  const ref = reference();
  db.transaction(() => {
    db.prepare('UPDATE users SET balance_p = balance_p + ? WHERE id = ?').run(amt.amountP, req.user.id);
    addTx.run({
      user_id: req.user.id,
      kind: 'topup',
      direction: 'credit',
      amount_p: amt.amountP,
      points: 0,
      title: 'Added money',
      detail: `${cards.describe(card)} · ${authed.authCode}`,
      reference: ref
    });
  })();

  res.json({
    ok: true,
    reference: ref,
    amountLabel: inr(amt.amountP),
    card: cards.describe(card),
    user: publicUser(findUserById.get(req.user.id))
  });
});

/* --------------------------------------------------- 6. history & points */

app.get('/api/transactions', auth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 60')
    .all(req.user.id);

  res.json({
    transactions: rows.map((t) => ({
      kind: t.kind,
      direction: t.direction,
      amountLabel: (t.direction === 'debit' ? '-' : '+') + inr(t.amount_p),
      points: t.points,
      title: t.title,
      detail: t.detail,
      reference: t.reference,
      createdAt: t.created_at
    }))
  });
});

/* ------------------------------------------------- profile & safeguards */

app.post('/api/profile', auth, (req, res) => {
  const name = String(req.body.displayName || '').trim().slice(0, 40);
  if (name && name.length < 2) return fail(res, 400, 'Use at least two characters, or leave it empty.');

  let limitP = null;
  if (req.body.dailyLimit !== undefined && req.body.dailyLimit !== '' && req.body.dailyLimit !== null) {
    const rupees = Number(req.body.dailyLimit);
    if (!Number.isFinite(rupees) || rupees <= 0) return fail(res, 400, 'The daily limit must be a positive amount.');
    limitP = paise(rupees);
  }

  db.prepare('UPDATE users SET display_name = ?, daily_limit_p = ? WHERE id = ?')
    .run(name || null, limitP, req.user.id);

  res.json({ ok: true, user: publicUser(findUserById.get(req.user.id)) });
});

/** Total spent since midnight, used to enforce the daily limit. */
function spentToday(userId) {
  return db
    .prepare(
      `SELECT COALESCE(SUM(amount_p), 0) t FROM transactions
       WHERE user_id = ? AND direction = 'debit' AND created_at >= date('now')`
    )
    .get(userId).t;
}

app.get('/api/analytics', auth, (req, res) => {
  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) n, SUM(amount_p) t FROM transactions
       WHERE user_id = ? AND direction = 'debit' AND created_at >= date('now','start of month')
       GROUP BY kind ORDER BY t DESC`
    )
    .all(req.user.id);

  const month = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='debit' THEN amount_p END),0) out_p,
         COALESCE(SUM(CASE WHEN direction='credit' THEN amount_p END),0) in_p
       FROM transactions WHERE user_id = ? AND created_at >= date('now','start of month')`
    )
    .get(req.user.id);

  const LABELS = {
    send: 'People', provider: 'Providers', mobile: 'Mobile', fastag: 'FASTag',
    giftcard: 'Gift cards', topup: 'Top-ups', receive: 'Received'
  };

  res.json({
    spentLabel: inr(month.out_p),
    receivedLabel: inr(month.in_p),
    todayLabel: inr(spentToday(req.user.id)),
    limitLabel: req.user.daily_limit_p ? inr(req.user.daily_limit_p) : null,
    byKind: byKind.map((r) => ({ kind: LABELS[r.kind] || r.kind, count: r.n, label: inr(r.t), amount: r.t / 100 }))
  });
});

/** Your own statement, as CSV. */
app.get('/api/statement.csv', auth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 5000')
    .all(req.user.id);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const csv = [
    'date,type,direction,amount_inr,points,title,detail,reference',
    ...rows.map((t) =>
      [t.created_at, t.kind, t.direction, (t.amount_p / 100).toFixed(2), t.points, t.title, t.detail, t.reference]
        .map(cell).join(',')
    )
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lsp-statement-${Date.now()}.csv"`);
  res.send(csv);
});

/* ------------------------------------------------------- money requests */

app.get('/api/requests', auth, (req, res) => {
  const incoming = db
    .prepare(
      `SELECT r.*, u.email, u.handle, u.display_name FROM requests r
       JOIN users u ON u.id = r.from_id
       WHERE r.to_id = ? AND r.status = 'pending' ORDER BY r.id DESC LIMIT 20`
    )
    .all(req.user.id);

  const outgoing = db
    .prepare(
      `SELECT r.*, u.email, u.handle, u.display_name FROM requests r
       JOIN users u ON u.id = r.to_id
       WHERE r.from_id = ? ORDER BY r.id DESC LIMIT 20`
    )
    .all(req.user.id);

  const shape = (r) => ({
    id: r.id,
    amountLabel: inr(r.amount_p),
    amount: r.amount_p / 100,
    note: r.note,
    status: r.status,
    who: r.display_name || r.handle,
    email: r.email,
    createdAt: r.created_at
  });

  res.json({ incoming: incoming.map(shape), outgoing: outgoing.map(shape) });
});

app.post('/api/requests', auth, payLimiter, async (req, res) => {
  const to = normEmail(req.body.to);
  if (!validEmail(to)) return fail(res, 400, 'Enter their email address.');
  if (to === req.user.email) return fail(res, 400, 'You cannot request money from yourself.');

  const target = findUserByEmail.get(to);
  if (!target) return fail(res, 404, 'Nobody uses LSP-Pay with that email yet.');

  const amt = amountCheck(req.body.amount);
  if (!amt.ok) return fail(res, 400, amt.message);

  const note = String(req.body.note || '').slice(0, 80) || null;
  db.prepare('INSERT INTO requests (from_id, to_id, amount_p, note) VALUES (?, ?, ?, ?)')
    .run(req.user.id, target.id, amt.amountP, note);

  notify(target.id, `${req.user.display_name || req.user.handle} requested ${inr(amt.amountP)}`, note);

  mail
    .sendMoneyRequest(target.email, {
      who: req.user.display_name || req.user.handle,
      amountLabel: inr(amt.amountP),
      note
    })
    .catch((e) => console.error('[mail] request failed:', e.message));

  res.json({ ok: true });
});

app.post('/api/requests/decline', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM requests WHERE id = ? AND to_id = ?').get(Number(req.body.id), req.user.id);
  if (!row) return fail(res, 404, 'No such request.');
  db.prepare("UPDATE requests SET status = 'declined' WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------- saved payees (1) */

app.get('/api/payees', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.email, p.label, u.display_name, u.handle FROM payees p
       LEFT JOIN users u ON u.email = p.email
       WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 40`
    )
    .all(req.user.id);

  res.json({
    payees: rows.map((p) => ({ email: p.email, label: p.label || p.display_name || p.handle || p.email }))
  });
});

app.post('/api/payees', auth, (req, res) => {
  const email = normEmail(req.body.email);
  if (!validEmail(email)) return fail(res, 400, 'Enter a valid email address.');
  if (email === req.user.email) return fail(res, 400, 'That is your own address.');

  db.prepare('INSERT OR REPLACE INTO payees (user_id, email, label) VALUES (?, ?, ?)')
    .run(req.user.id, email, String(req.body.label || '').slice(0, 40) || null);
  res.json({ ok: true });
});

app.post('/api/payees/remove', auth, (req, res) => {
  db.prepare('DELETE FROM payees WHERE user_id = ? AND email = ?').run(req.user.id, normEmail(req.body.email));
  res.json({ ok: true });
});

/* ------------------------------------------------------- split bill (2) */

/** Sends the same request to several people at once, splitting a total. */
app.post('/api/split', auth, payLimiter, async (req, res) => {
  const emails = [...new Set((Array.isArray(req.body.emails) ? req.body.emails : [])
    .map(normEmail).filter(validEmail).filter((e) => e !== req.user.email))];
  if (!emails.length) return fail(res, 400, 'Add at least one other person.');
  if (emails.length > 15) return fail(res, 400, 'Split between at most fifteen people.');

  const amt = amountCheck(req.body.total);
  if (!amt.ok) return fail(res, 400, amt.message);

  // Include yourself in the split unless told otherwise.
  const shares = req.body.includeMe === false ? emails.length : emails.length + 1;
  const each = Math.floor(amt.amountP / shares);
  if (each < 100) return fail(res, 400, 'Each share works out under ₹1. Use a bigger total.');

  const note = String(req.body.note || '').slice(0, 80) || null;
  const missing = [];
  let sent = 0;

  for (const email of emails) {
    const target = findUserByEmail.get(email);
    if (!target) { missing.push(email); continue; }

    db.prepare('INSERT INTO requests (from_id, to_id, amount_p, note) VALUES (?, ?, ?, ?)')
      .run(req.user.id, target.id, each, note);
    notify(target.id, `${req.user.display_name || req.user.handle} split a bill with you`, `Your share is ${inr(each)}${note ? ' · ' + note : ''}`);
    mail.sendMoneyRequest(target.email, {
      who: req.user.display_name || req.user.handle,
      amountLabel: inr(each),
      note
    }).catch(() => {});
    sent++;
  }

  res.json({
    ok: true,
    sent,
    eachLabel: inr(each),
    shares,
    missing,
    note: missing.length ? `${missing.length} of them are not on LSP-Pay yet.` : null
  });
});

/* ------------------------------------------- scheduled & recurring (3,4) */

app.get('/api/scheduled', auth, (req, res) => {
  const one = db
    .prepare("SELECT * FROM scheduled WHERE user_id = ? AND status = 'pending' ORDER BY run_at LIMIT 30")
    .all(req.user.id);
  const subs = db
    .prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 30')
    .all(req.user.id);

  res.json({
    scheduled: one.map((s) => ({
      id: s.id, to: s.to_email, amountLabel: inr(s.amount_p), note: s.note,
      runAt: new Date(s.run_at).toISOString()
    })),
    subscriptions: subs.map((s) => ({
      id: s.id, to: s.to_email, amountLabel: inr(s.amount_p), everyDays: s.interval_days,
      note: s.note, active: !!s.active, runs: s.runs, maxRuns: s.max_runs,
      nextAt: new Date(s.next_at).toISOString(), lastError: s.last_error
    }))
  });
});

app.post('/api/scheduled', auth, (req, res) => {
  const to = normEmail(req.body.to);
  if (!validEmail(to)) return fail(res, 400, 'Enter their email address.');
  if (to === req.user.email) return fail(res, 400, 'You cannot schedule a payment to yourself.');
  if (!findUserByEmail.get(to)) return fail(res, 404, 'Nobody uses LSP-Pay with that email yet.');

  const amt = amountCheck(req.body.amount);
  if (!amt.ok) return fail(res, 400, amt.message);

  const days = Number(req.body.inDays);
  if (!Number.isFinite(days) || days < 1 || days > 365) return fail(res, 400, 'Pick between 1 and 365 days from now.');

  const pinResult = checkPin(req.user, req.body.pin);
  if (!pinResult.ok) return fail(res, 403, pinResult.message);

  db.prepare('INSERT INTO scheduled (user_id, to_email, amount_p, note, run_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, to, amt.amountP, String(req.body.note || '').slice(0, 80) || null,
      Date.now() + Math.floor(days) * 86400000);

  res.json({ ok: true });
});

app.post('/api/scheduled/cancel', auth, (req, res) => {
  db.prepare("UPDATE scheduled SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(Number(req.body.id), req.user.id);
  res.json({ ok: true });
});

app.post('/api/subscriptions', auth, (req, res) => {
  const to = normEmail(req.body.to);
  if (!validEmail(to)) return fail(res, 400, 'Enter their email address.');
  if (to === req.user.email) return fail(res, 400, 'You cannot subscribe to yourself.');
  if (!findUserByEmail.get(to)) return fail(res, 404, 'Nobody uses LSP-Pay with that email yet.');

  const amt = amountCheck(req.body.amount, { max: 100000 });
  if (!amt.ok) return fail(res, 400, amt.message);

  const every = Number(req.body.everyDays);
  if (!Number.isFinite(every) || every < 1 || every > 365) return fail(res, 400, 'Repeat between every 1 and 365 days.');

  const pinResult = checkPin(req.user, req.body.pin);
  if (!pinResult.ok) return fail(res, 403, pinResult.message);

  const maxRuns = Number(req.body.maxRuns) > 0 ? Math.floor(Number(req.body.maxRuns)) : null;
  const startNow = req.body.startNow !== false;

  db.prepare(
    'INSERT INTO subscriptions (user_id, to_email, amount_p, interval_days, note, next_at, max_runs) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    req.user.id, to, amt.amountP, Math.floor(every),
    String(req.body.note || '').slice(0, 80) || null,
    startNow ? Date.now() : Date.now() + Math.floor(every) * 86400000,
    maxRuns
  );

  res.json({ ok: true });
});

app.post('/api/subscriptions/stop', auth, (req, res) => {
  db.prepare('UPDATE subscriptions SET active = 0 WHERE id = ? AND user_id = ?').run(Number(req.body.id), req.user.id);
  res.json({ ok: true });
});

/**
 * Moves money for a due schedule or subscription. Deliberately silent on
 * failure beyond a notification: an automated payment must never surprise
 * someone by overdrawing them, so it simply doesn't run.
 */
function runAutoPayment(userId, toEmail, amountP, title) {
  const payer = findUserById.get(userId);
  const payee = findUserByEmail.get(toEmail);
  if (!payer || !payee) return { ok: false, error: 'The other account no longer exists.' };
  if (payer.balance_p < amountP) return { ok: false, error: 'Not enough balance.' };

  if (payer.daily_limit_p && spentToday(payer.id) + amountP > payer.daily_limit_p)
    return { ok: false, error: 'It would pass the daily limit.' };

  const earned = pointsFor(amountP);
  const ref = reference();

  db.transaction(() => {
    db.prepare('UPDATE users SET balance_p = balance_p - ?, points = points + ? WHERE id = ?')
      .run(amountP, earned, payer.id);
    addTx.run({
      user_id: payer.id, kind: 'send', direction: 'debit', amount_p: amountP, points: earned,
      title, detail: `Automatic · to ${payee.display_name || payee.handle}`, reference: ref
    });
    db.prepare('UPDATE users SET balance_p = balance_p + ? WHERE id = ?').run(amountP, payee.id);
    addTx.run({
      user_id: payee.id, kind: 'receive', direction: 'credit', amount_p: amountP, points: 0,
      title: `Received from ${payer.display_name || payer.handle}`, detail: 'Automatic payment', reference: ref
    });
  })();

  return { ok: true, reference: ref };
}

// Sweeps both queues every minute.
setInterval(() => {
  const now = Date.now();

  db.prepare("SELECT * FROM scheduled WHERE status = 'pending' AND run_at <= ?").all(now).forEach((s) => {
    const out = runAutoPayment(s.user_id, s.to_email, s.amount_p, s.note || `Scheduled payment to ${s.to_email}`);
    db.prepare('UPDATE scheduled SET status = ?, last_error = ? WHERE id = ?')
      .run(out.ok ? 'sent' : 'failed', out.error || null, s.id);
    notify(s.user_id,
      out.ok ? `Scheduled payment sent` : `Scheduled payment failed`,
      `${inr(s.amount_p)} to ${s.to_email}${out.ok ? '' : ' — ' + out.error}`);
  });

  db.prepare('SELECT * FROM subscriptions WHERE active = 1 AND next_at <= ?').all(now).forEach((s) => {
    const out = runAutoPayment(s.user_id, s.to_email, s.amount_p, s.note || `Recurring payment to ${s.to_email}`);
    const runs = s.runs + (out.ok ? 1 : 0);
    const done = s.max_runs !== null && runs >= s.max_runs;

    db.prepare('UPDATE subscriptions SET runs = ?, next_at = ?, last_error = ?, active = ? WHERE id = ?')
      .run(runs, now + s.interval_days * 86400000, out.error || null, done ? 0 : 1, s.id);

    notify(s.user_id,
      out.ok ? 'Recurring payment sent' : 'Recurring payment failed',
      `${inr(s.amount_p)} to ${s.to_email}${out.ok ? '' : ' — ' + out.error + '. It will try again next cycle.'}`);
  });
}, 60000).unref();

/* ------------------------------------------- bank accounts & payouts (5) */

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

app.get('/api/banks', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bank_accounts WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  const payouts = db
    .prepare('SELECT * FROM payouts WHERE user_id = ? ORDER BY rowid DESC LIMIT 10')
    .all(req.user.id);

  res.json({
    banks: rows.map((b) => ({
      id: b.id, holder: b.holder, last4: b.last4, ifsc: b.ifsc, bank: b.bank,
      display: `${b.bank || 'Account'} ••••${b.last4}`
    })),
    payouts: payouts.map((p) => ({
      id: p.id, amountLabel: inr(p.amount_p), status: p.status, createdAt: p.created_at
    }))
  });
});

app.post('/api/banks', auth, (req, res) => {
  const number = String(req.body.number || '').replace(/\s/g, '');
  if (!/^\d{9,18}$/.test(number)) return fail(res, 400, 'An account number is 9 to 18 digits.');

  const ifsc = String(req.body.ifsc || '').toUpperCase().replace(/\s/g, '');
  if (!IFSC.test(ifsc)) return fail(res, 400, 'That IFSC does not look right — it is 11 characters, like HDFC0001234.');

  const holder = String(req.body.holder || '').trim().slice(0, 60);
  if (holder.length < 2) return fail(res, 400, 'Enter the name on the account.');

  const mine = db.prepare('SELECT COUNT(*) n FROM bank_accounts WHERE user_id = ?').get(req.user.id).n;
  if (mine >= 3) return fail(res, 400, 'You can save up to three bank accounts.');

  // Only the last four digits are kept, same reasoning as cards.
  db.prepare('INSERT INTO bank_accounts (user_id, holder, last4, ifsc, bank) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, holder, number.slice(-4), ifsc, ifsc.slice(0, 4) + ' Bank');

  res.json({ ok: true });
});

app.post('/api/banks/remove', auth, (req, res) => {
  db.prepare('DELETE FROM bank_accounts WHERE id = ? AND user_id = ?').run(Number(req.body.id), req.user.id);
  res.json({ ok: true });
});

/** Withdraw to a bank. Demo: the money leaves the wallet, nothing arrives. */
app.post('/api/payouts', auth, payLimiter, (req, res) => {
  const bank = db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?')
    .get(Number(req.body.bankId), req.user.id);
  if (!bank) return fail(res, 404, 'That account is not on your profile.');

  const amt = amountCheck(req.body.amount, { min: 100, max: 200000 });
  if (!amt.ok) return fail(res, 400, amt.message);

  const pinResult = checkPin(req.user, req.body.pin);
  if (!pinResult.ok) return fail(res, 403, pinResult.message);

  const fresh = findUserById.get(req.user.id);
  if (fresh.balance_p < amt.amountP) return fail(res, 400, 'Not enough balance to withdraw that.');

  const id = 'pout_' + crypto.randomBytes(7).toString('hex');
  db.transaction(() => {
    db.prepare('UPDATE users SET balance_p = balance_p - ? WHERE id = ?').run(amt.amountP, req.user.id);
    db.prepare('INSERT INTO payouts (id, user_id, bank_id, amount_p) VALUES (?, ?, ?, ?)')
      .run(id, req.user.id, bank.id, amt.amountP);
    addTx.run({
      user_id: req.user.id, kind: 'send', direction: 'debit', amount_p: amt.amountP, points: 0,
      title: 'Withdrawn to bank', detail: `${bank.bank} ••••${bank.last4}`, reference: id
    });
  })();

  notify(req.user.id, 'Withdrawal started', `${inr(amt.amountP)} to ${bank.bank} ••••${bank.last4}. Demo mode — no money actually moves.`);

  res.json({
    ok: true, id, amountLabel: inr(amt.amountP),
    bank: `${bank.bank} ••••${bank.last4}`,
    user: publicUser(findUserById.get(req.user.id))
  });
});

/* ------------------------------------------------- notifications (6) */

function notify(userId, title, body) {
  try {
    db.prepare('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)').run(userId, title, body || null);
  } catch (err) {
    console.error('[notify]', err.message);
  }
}

app.get('/api/notifications', auth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 40')
    .all(req.user.id);
  const unread = rows.filter((n) => !n.seen).length;

  res.json({
    unread,
    notifications: rows.map((n) => ({
      id: n.id, title: n.title, body: n.body, seen: !!n.seen, createdAt: n.created_at
    }))
  });
});

app.post('/api/notifications/seen', auth, (req, res) => {
  db.prepare('UPDATE notifications SET seen = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ---------------------------------------------- sign-in history (7) */

app.get('/api/logins', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM logins WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.json({
    logins: rows.map((l) => ({ ip: l.ip, agent: l.agent, createdAt: l.created_at }))
  });
});

/* ------------------------------------------------------------- gateway */

// Attaches req.lspUser when a session cookie is present, without demanding
// one — the checkout page is public but offers wallet pay to signed-in users.
app.use((req, res, next) => {
  const token = req.cookies?.lsp_session;
  if (token) {
    try {
      req.lspUser = findUserById.get(jwt.verify(token, JWT_SECRET).uid) || null;
    } catch { req.lspUser = null; }
  }
  next();
});

require('./gateway')(app, {
  db, auth, fail, inr, paise, reference, publicUser, findUserById, addTx, checkPin, cards, mail, rateLimit
});

/* ------------------------------------------------------------------ misc */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mail: process.env.RESEND_API_KEY ? 'resend' : 'console', time: new Date().toISOString() });
});

// Hosted checkout and the developer docs are their own pages.
app.get('/pay/:id', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'checkout.html'))
);
app.get('/developers', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'developers.html'))
);

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: IS_PROD ? '1h' : 0 }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return fail(res, 404, 'No such endpoint.');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  fail(res, 500, 'Something broke on our side. Try again.');
});

app.listen(PORT, () => {
  console.log(`LSP-Pay listening on http://localhost:${PORT}`);
  if (!process.env.RESEND_API_KEY) console.log('RESEND_API_KEY missing — codes will print here instead.');
  if (!process.env.JWT_SECRET) console.log('JWT_SECRET missing — sessions reset on restart.');
});
