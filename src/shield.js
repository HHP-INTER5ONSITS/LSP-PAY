'use strict';

/**
 * Bot protection for the doors that cost something.
 *
 * The expensive door is sign-in: every request there sends an email through
 * Resend and, if it succeeds, can mint a new wallet. A script hitting it in
 * a loop burns the mail quota, fills strangers' inboxes with codes they did
 * not ask for, and creates junk accounts.
 *
 * Four layers, none of which asks a person to identify traffic lights:
 *
 *   1. Proof of work. The browser must find a nonce whose SHA-256 begins
 *      with N zeros before the server will act. A person waits a moment;
 *      a bot pays that moment for every single attempt, which is what makes
 *      a flood expensive instead of free.
 *   2. Adaptive difficulty. The first attempt from an address is trivial.
 *      Difficulty climbs with recent attempts, so normal use stays instant
 *      and sustained hammering gets slower and slower.
 *   3. A honeypot field, hidden from people and irresistible to the kind of
 *      bot that fills in every input it finds.
 *   4. Disposable-address rejection, so throwaway inboxes cannot be used to
 *      mint wallets in bulk.
 *
 * Challenges are HMAC-signed, so the server does not have to remember every
 * one it issued, and each may be spent once, so a solved challenge cannot be
 * replayed.
 */

const crypto = require('crypto');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SECRET = process.env.SHIELD_SECRET || process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

/**
 * Difficulty is an expected number of hashes, not leading zeros: whole
 * zeros move in steps of 16x, which jumped straight from imperceptible to
 * several seconds. A browser batching SHA-256 manages roughly 150 hashes a
 * millisecond, so these come out at about 7ms, 60ms, 350ms and 1.4s.
 *
 * The top step stays deliberately mild. Difficulty is keyed on address, and
 * plenty of real people share one — mobile carriers in particular — so a
 * busy address must never become a wall for the person behind it.
 */
const DIFFICULTY_STEPS = [
  { after: 0, work: 1000 },
  { after: 3, work: 8000 },
  { after: 6, work: 50000 },
  { after: 13, work: 200000 }
];

// The solver matches the first 24 bits of the digest against a ceiling.
const SPACE = 0xFFFFFF;
const ceilingFor = (work) => Math.max(1, Math.floor(SPACE / work));

// Throwaway inbox providers. Not exhaustive — nothing is — but it stops the
// bulk case, which is what matters for free-wallet abuse.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com',
  'sharklasers.com', 'trashmail.com', 'getnada.com', 'dispostable.com',
  'maildrop.cc', 'fakeinbox.com', 'mintemail.com', 'mohmal.com',
  'spamgourmet.com', 'tempinbox.com', 'emailondeck.com', 'burnermail.io',
  'moakt.com', 'tempr.email', 'luxusmail.org', 'inboxkitten.com'
]);

const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

module.exports = function mountShield(app, deps) {
  const { db, fail, rateLimit } = deps;

  db.exec(`
    -- Spent challenges, so a solved one cannot be submitted twice.
    CREATE TABLE IF NOT EXISTS shield_spent (
      token      TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    -- Recent attempts per address, which set the difficulty.
    CREATE TABLE IF NOT EXISTS shield_attempts (
      ip         TEXT NOT NULL,
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shield_ip ON shield_attempts(ip, at);
  `);

  const ipOf = (req) => (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim() || 'unknown';

  function recentAttempts(ip) {
    return db
      .prepare('SELECT COUNT(*) n FROM shield_attempts WHERE ip = ? AND at > ?')
      .get(ip, Date.now() - 60 * 60 * 1000).n;
  }

  function difficultyFor(ip) {
    const n = recentAttempts(ip);
    let work = DIFFICULTY_STEPS[0].work;
    for (const step of DIFFICULTY_STEPS) if (n >= step.after) work = step.work;
    return work;
  }

  /** Hands out a signed challenge. Cheap, so it can be rate limited loosely. */
  app.get('/api/shield/challenge', rateLimit({ windowMs: 60 * 1000, limit: 30, legacyHeaders: false, standardHeaders: true }), (req, res) => {
    const ip = ipOf(req);
    const ceiling = ceilingFor(difficultyFor(ip));
    const nonce = crypto.randomBytes(16).toString('hex');
    const expires = Date.now() + CHALLENGE_TTL_MS;

    // The server keeps nothing: the signature proves we issued this, with
    // this ceiling, before this time.
    const payload = `${nonce}.${ceiling}.${expires}`;
    res.json({ challenge: nonce, ceiling, expires, token: `${payload}.${sign(payload)}` });
  });

  /**
   * Checks a solved challenge. Returns null when fine, or a message when not.
   * Deliberately vague to the caller about which check failed — a bot author
   * reading precise errors learns how to pass next time.
   */
  function verify(req) {
    const token = String(req.body?.shieldToken || '');
    const solution = String(req.body?.shieldSolution || '');

    const parts = token.split('.');
    if (parts.length !== 4) return 'Your browser did not complete the security check. Reload and try again.';

    const [nonce, ceilingRaw, expiresRaw, mac] = parts;
    const payload = `${nonce}.${ceilingRaw}.${expiresRaw}`;

    const expected = sign(payload);
    const a = Buffer.from(expected);
    const b = Buffer.from(mac);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return 'That security check was not issued by this site.';

    if (Date.now() > Number(expiresRaw))
      return 'The security check expired. Reload and try again.';

    // One use only.
    const spent = db.prepare('SELECT 1 FROM shield_spent WHERE token = ?').get(nonce);
    if (spent) return 'That security check was already used. Reload and try again.';

    const ceiling = Number(ceilingRaw);
    if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > SPACE)
      return 'That security check was not issued by this site.';

    const digest = crypto.createHash('sha256').update(`${nonce}:${solution}`).digest();
    if (digest.readUIntBE(0, 3) > ceiling)
      return 'The security check did not pass. Reload and try again.';

    db.prepare('INSERT OR REPLACE INTO shield_spent (token, expires_at) VALUES (?, ?)')
      .run(nonce, Number(expiresRaw));
    return null;
  }

  /**
   * Express middleware for a door worth protecting. Runs the honeypot and
   * timing checks first, since they cost nothing.
   */
  function guard(req, res, next) {
    const ip = ipOf(req);

    // A hidden field no person can see, let alone fill in.
    if (String(req.body?.website || '').trim()) {
      console.warn('[shield] honeypot filled from', ip);
      // Answer as though it worked. A bot that knows it was caught adapts;
      // one that thinks it succeeded keeps wasting its time.
      return res.json({ ok: true, email: String(req.body?.email || ''), existing: false, delivered: true });
    }

    const problem = verify(req);
    if (problem) return fail(res, 400, problem);

    db.prepare('INSERT INTO shield_attempts (ip, at) VALUES (?, ?)').run(ip, Date.now());
    next();
  }

  /** Rejects throwaway inboxes being used to mint wallets in bulk. */
  function emailAllowed(email) {
    const domain = String(email || '').split('@')[1]?.toLowerCase();
    if (!domain) return false;
    return !DISPOSABLE.has(domain);
  }

  // Housekeeping: neither table needs to grow for ever.
  setInterval(() => {
    const now = Date.now();
    db.prepare('DELETE FROM shield_spent WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM shield_attempts WHERE at < ?').run(now - 24 * 60 * 60 * 1000);
  }, 10 * 60 * 1000).unref();

  return { guard, verify, emailAllowed, difficultyFor, ipOf };
};
