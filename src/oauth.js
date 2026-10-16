'use strict';

/**
 * Sign in with GitHub and Google.
 *
 * Standard OAuth 2.0 authorization-code flow, written out rather than pulled
 * from a library so every step is visible:
 *
 *   1. /auth/<provider>          → redirect to the provider, carrying a
 *                                  random `state` that we also put in a
 *                                  short-lived cookie.
 *   2. /auth/<provider>/callback → the provider sends back a `code`. We check
 *                                  the state matches the cookie (this is what
 *                                  stops a CSRF login), swap the code for an
 *                                  access token server-side, and ask the
 *                                  provider who the user is.
 *   3.                           → match on a VERIFIED email, create or link
 *                                  the account, set our own session cookie.
 *
 * The client secret is only ever used in step 2, server to server. It never
 * reaches the browser.
 *
 * On matching by email: we accept an email from a provider only when that
 * provider says it has verified it. Without that check, anyone could sign up
 * to a provider claiming someone else's address and walk into their wallet.
 */

const crypto = require('crypto');

const STATE_COOKIE = 'lsp_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

const PROVIDERS = {
  github: {
    label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    idEnv: 'GITHUB_CLIENT_ID',
    secretEnv: 'GITHUB_CLIENT_SECRET',

    /** GitHub keeps emails on a separate endpoint, and may have several. */
    async profile(token) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'LSP-Pay'
      };

      const who = await fetch('https://api.github.com/user', { headers });
      if (!who.ok) throw new Error(`GitHub rejected the profile request (${who.status}).`);
      const me = await who.json();

      const list = await fetch('https://api.github.com/user/emails', { headers });
      if (!list.ok) throw new Error('GitHub would not share your email addresses.');
      const emails = await list.json();

      // Prefer the primary address, but only ever a verified one.
      const chosen =
        emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
      if (!chosen)
        throw new Error('Your GitHub account has no verified email address. Verify one on GitHub, then try again.');

      return {
        providerId: String(me.id),
        email: chosen.email.toLowerCase(),
        name: me.name || me.login
      };
    }
  },

  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    idEnv: 'GOOGLE_CLIENT_ID',
    secretEnv: 'GOOGLE_CLIENT_SECRET',
    extraAuthParams: { access_type: 'online', prompt: 'select_account' },

    async profile(token) {
      const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`Google rejected the profile request (${res.status}).`);
      const me = await res.json();

      if (!me.email) throw new Error('Google did not share an email address.');
      if (me.email_verified === false)
        throw new Error('That Google address is not verified. Verify it with Google, then try again.');

      return {
        providerId: String(me.sub),
        email: String(me.email).toLowerCase(),
        name: me.name || me.given_name || null
      };
    }
  }
};

const configured = (p) => Boolean(process.env[p.idEnv] && process.env[p.secretEnv]);

module.exports = function mountOAuth(app, deps) {
  const { db, findUserByEmail, findUserById, createUser, setSession, publicUser, notify, fail, IS_PROD } = deps;

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      provider     TEXT NOT NULL,
      provider_id  TEXT NOT NULL,
      email        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_unique ON oauth_accounts(provider, provider_id);
  `);

  const findLink = db.prepare('SELECT * FROM oauth_accounts WHERE provider = ? AND provider_id = ?');

  /** Where the provider sends people back. Must match what you registered. */
  function callbackUrl(req, name) {
    const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '') ||
      `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
    return `${base}/auth/${name}/callback`;
  }

  /** Which buttons the sign-in screen should show. */
  app.get('/api/auth/providers', (req, res) => {
    res.json({
      providers: Object.entries(PROVIDERS)
        .filter(([, p]) => configured(p))
        .map(([name, p]) => ({ name, label: p.label }))
    });
  });

  app.get('/auth/:provider', (req, res) => {
    const name = String(req.params.provider);
    const provider = PROVIDERS[name];
    if (!provider) return fail(res, 404, 'Unknown sign-in provider.');
    if (!configured(provider))
      return res.redirect(`/?oauth_error=${encodeURIComponent(`${provider.label} sign-in is not set up on this server.`)}`);

    // The state links this redirect to the callback. Signed into a cookie so
    // a forged callback from somewhere else cannot complete a sign-in.
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, `${name}:${state}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: STATE_TTL_MS
    });

    const params = new URLSearchParams({
      client_id: process.env[provider.idEnv],
      redirect_uri: callbackUrl(req, name),
      scope: provider.scope,
      state,
      response_type: 'code',
      ...(provider.extraAuthParams || {})
    });

    res.redirect(`${provider.authUrl}?${params}`);
  });

  app.get('/auth/:provider/callback', async (req, res) => {
    const name = String(req.params.provider);
    const provider = PROVIDERS[name];
    if (!provider || !configured(provider)) return fail(res, 404, 'Unknown sign-in provider.');

    const bounce = (message) => res.redirect(`/?oauth_error=${encodeURIComponent(message)}`);

    // The user pressed cancel on the provider's screen.
    if (req.query.error) return bounce(`${provider.label} sign-in was cancelled.`);

    const cookie = req.cookies?.[STATE_COOKIE] || '';
    res.clearCookie(STATE_COOKIE);

    const [cookieProvider, cookieState] = cookie.split(':');
    if (!cookieState || cookieProvider !== name || cookieState !== req.query.state)
      return bounce('That sign-in attempt expired or did not match. Please try again.');

    const code = String(req.query.code || '');
    if (!code) return bounce(`${provider.label} did not send a sign-in code.`);

    try {
      // Swap the code for a token. This call carries the client secret and
      // happens entirely server-side.
      const tokenRes = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: process.env[provider.idEnv],
          client_secret: process.env[provider.secretEnv],
          code,
          redirect_uri: callbackUrl(req, name),
          grant_type: 'authorization_code'
        })
      });

      const tokenBody = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || tokenBody.error || !tokenBody.access_token) {
        console.error('[oauth] token exchange failed:', name, tokenRes.status, tokenBody.error || '');
        return bounce(`${provider.label} would not complete the sign-in. Check the app's client ID and secret.`);
      }

      const profile = await provider.profile(tokenBody.access_token);

      // Returning user, already linked.
      const link = findLink.get(name, profile.providerId);
      let user = link ? findUserById.get(link.user_id) : null;

      if (!user) {
        // Otherwise match on the verified email, or make a new wallet.
        user = findUserByEmail.get(profile.email);
        const isNew = !user;
        if (!user) user = createUser(profile.email);

        db.prepare('INSERT OR IGNORE INTO oauth_accounts (user_id, provider, provider_id, email) VALUES (?, ?, ?, ?)')
          .run(user.id, name, profile.providerId, profile.email);

        if (!isNew)
          notify(user.id, `${provider.label} linked to your account`,
            `You can now sign in with ${provider.label} as well as an email code.`);

        // Use their real name if we don't have one yet.
        if (profile.name && !user.display_name) {
          db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(profile.name.slice(0, 40), user.id);
          user = findUserById.get(user.id);
        }
      }

      setSession(res, user);

      const agent = String(req.get('user-agent') || '').slice(0, 160);
      const ip = (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
      db.prepare('INSERT INTO logins (user_id, ip, agent) VALUES (?, ?, ?)')
        .run(user.id, ip, `${provider.label} · ${agent}`);

      res.redirect('/');
    } catch (err) {
      console.error('[oauth]', name, err.message);
      bounce(err.message || `Could not finish signing in with ${provider.label}.`);
    }
  });

  /** Which providers the signed-in person has linked, for the settings screen. */
  app.get('/api/auth/linked', deps.auth, (req, res) => {
    const rows = db.prepare('SELECT provider, email, created_at FROM oauth_accounts WHERE user_id = ?').all(req.user.id);
    res.json({
      linked: rows.map((r) => ({ provider: r.provider, label: PROVIDERS[r.provider]?.label || r.provider, email: r.email })),
      available: Object.entries(PROVIDERS).filter(([, p]) => configured(p)).map(([n, p]) => ({ name: n, label: p.label }))
    });
  });

  /** Unlinking is always allowed: an email code is still a way back in. */
  app.post('/api/auth/unlink', deps.auth, (req, res) => {
    const name = String(req.body.provider || '');
    if (!PROVIDERS[name]) return fail(res, 400, 'Unknown provider.');
    db.prepare('DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?').run(req.user.id, name);
    res.json({ ok: true });
  });
};
