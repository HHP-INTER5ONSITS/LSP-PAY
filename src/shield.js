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
 *   5. Cloudflare Turnstile, when TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY
 *      are set. Cloudflare sees traffic across millions of sites, so its
 *      judgement of a visitor is far better than anything inferable from one
 *      address here. When it is on, the proof of work drops to a token cost:
 *      two defences doing the same job twice only taxes real people.
 *
 * Challenges are HMAC-signed, so the server does not have to remember every
 * one it issued, and each may be spent once, so a solved challenge cannot be
 * replayed.
 */

const crypto = require('crypto');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const turnstile = () => ({
  siteKey: process.env.TURNSTILE_SITE_KEY || null,
  secret: process.env.TURNSTILE_SECRET_KEY || null
});
const turnstileOn = () => Boolean(turnstile().siteKey && turnstile().secret);

/**
 * Checks a Turnstile token with Cloudflare. Tokens last five minutes and may
 * be spent once; Cloudflare enforces both, so there is nothing to track here.
 */
async function checkTurnstile(token, ip) {
  const { secret } = turnstile();
  if (!token || typeof token !== 'string' || token.length > 2048)
    return { ok: false, why: 'missing-token' };

  try {
    const res = await fetch(TURNSTILE_VERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' })
    });
    if (!res.ok) return { ok: false, why: `http-${res.status}` };

    const body = await res.json();
    return body.success
      ? { ok: true }
      : { ok: false, why: (body['error-codes'] || []).join(',') || 'rejected' };
  } catch (err) {
    // Cloudflare being unreachable must not lock everyone out: the proof of
    // work and the other checks still stand on their own.
    console.error('[shield] turnstile unreachable:', err.message);
    return { ok: true, degraded: true };
  }
}
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

    -- Failed security checks per address. Enough of them in a short window
    -- earns a hard block: a real person fails the odd check, a bot fails
    -- every one.
    CREATE TABLE IF NOT EXISTS shield_strikes (
      ip         TEXT NOT NULL,
      at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shield_strike ON shield_strikes(ip, at);
  `);

  const ipOf = (req) => (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim() || 'unknown';

  // A hard block after this many failed checks in the window. The window is
  // short and strikes age out of it, so a block lifts on its own — there is
  // no list to maintain and an unlucky real person is not banned for good.
  const STRIKE_WINDOW_MS = 15 * 60 * 1000;
  const STRIKE_LIMIT = 8;

  const strike = (ip) => db.prepare('INSERT INTO shield_strikes (ip, at) VALUES (?, ?)').run(ip, Date.now());

  function isBlocked(ip) {
    const n = db
      .prepare('SELECT COUNT(*) n FROM shield_strikes WHERE ip = ? AND at > ?')
      .get(ip, Date.now() - STRIKE_WINDOW_MS).n;
    return n >= STRIKE_LIMIT;
  }

  /**
   * Seconds until this address is clear. The block lifts when enough strikes
   * have aged out of the window to drop under the limit, so the honest answer
   * is when the (LIMIT-th newest) strike finally expires — not a fixed timer.
   */
  function blockSecondsLeft(ip) {
    const rows = db
      .prepare('SELECT at FROM shield_strikes WHERE ip = ? AND at > ? ORDER BY at DESC')
      .all(ip, Date.now() - STRIKE_WINDOW_MS);
    if (rows.length < STRIKE_LIMIT) return 0;
    // Once the strike at index LIMIT-1 (the oldest one still counting) ages
    // out, the count drops below the limit and sign-in is allowed again.
    const clearsAt = rows[STRIKE_LIMIT - 1].at + STRIKE_WINDOW_MS;
    return Math.max(0, Math.ceil((clearsAt - Date.now()) / 1000));
  }

  // The block page asks how long is really left, instead of guessing.
  app.get('/api/shield/blocked', (req, res) => {
    const ip = ipOf(req);
    res.json({ blocked: isBlocked(ip), secondsLeft: blockSecondsLeft(ip) });
  });

  function recentAttempts(ip) {
    return db
      .prepare('SELECT COUNT(*) n FROM shield_attempts WHERE ip = ? AND at > ?')
      .get(ip, Date.now() - 60 * 60 * 1000).n;
  }

  function difficultyFor(ip) {
    const n = recentAttempts(ip);
    let work = DIFFICULTY_STEPS[0].work;
    for (const step of DIFFICULTY_STEPS) if (n >= step.after) work = step.work;
    // Turnstile is the stronger signal; keep the puzzle nominal so the two
    // layers do not tax a real person twice for the same assurance.
    return turnstileOn() ? Math.min(work, 2000) : work;
  }

  /** What the sign-in page needs to know before it can submit. */
  app.get('/api/shield/config', (req, res) => {
    res.json({ turnstileSiteKey: turnstile().siteKey });
  });

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
  async function guard(req, res, next) {
    const ip = ipOf(req);

    // Already over the line: show the block, and record no new strike so the
    // window can empty and the block lift by itself.
    if (isBlocked(ip)) {
      return res.status(429).json({ error: 'Access paused after too many failed security checks.', blocked: true });
    }

    // A hidden field no person can see, let alone fill in. A bot that trips
    // it is answered as though it won — and quietly collects a strike.
    if (String(req.body?.website || '').trim()) {
      console.warn('[shield] honeypot filled from', ip);
      strike(ip);
      return res.json({ ok: true, email: String(req.body?.email || ''), existing: false, delivered: true });
    }

    const problem = verify(req);
    if (problem) {
      strike(ip);
      return res.status(isBlocked(ip) ? 429 : 400).json(
        isBlocked(ip) ? { error: 'Access paused after too many failed security checks.', blocked: true } : { error: problem }
      );
    }

    if (turnstileOn()) {
      const out = await checkTurnstile(req.body?.turnstileToken, ip);
      if (!out.ok) {
        console.warn('[shield] turnstile refused', out.why, 'from', ip);
        strike(ip);
        if (isBlocked(ip))
          return res.status(429).json({ error: 'Access paused after too many failed security checks.', blocked: true });
        // Say which of the two it was. A spent or stale token just needs a
        // reload; no token at all usually means the browser could not reach
        // Cloudflare, and that person needs to know it is not their fault.
        return fail(res, 400, out.why === 'missing-token'
          ? 'The security check could not run. Your browser may be blocking challenges.cloudflare.com — try another network or browser.'
          : 'The security check expired. Reload the page and try again.');
      }
    }

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
    db.prepare('DELETE FROM shield_strikes WHERE at < ?').run(now - 24 * 60 * 60 * 1000);
  }, 10 * 60 * 1000).unref();

  return { guard, verify, emailAllowed, difficultyFor, ipOf, turnstileOn, isBlocked };
};
