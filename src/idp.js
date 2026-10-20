'use strict';

/**
 * LSP OAuth — LSP-Pay acting as an identity provider.
 *
 * The mirror image of src/oauth.js. There, we are the client asking GitHub
 * who someone is. Here, somebody else's app asks *us*, and an LSP-Pay user
 * approves it on a consent screen.
 *
 * A developer registers an app in the LSP-Pay app and gets:
 *   client_id     lspc_…  public, goes in their page's sign-in link
 *   client_secret lspk_…  private, shown once, used only server-to-server
 *
 * The flow their users see:
 *   1. Their site  → GET  /oauth/authorize?client_id=…&redirect_uri=…&state=…
 *   2. We show a consent screen naming the app and what it is asking for.
 *   3. Approve      → redirect back with a one-time `code`.
 *   4. Their server → POST /oauth/token to swap code + secret for a token.
 *   5. Their server → GET  /oauth/userinfo with that token.
 *
 * The rules that keep this honest, each enforced below:
 *   - redirect_uri must EXACTLY match one the developer registered. This is
 *     the single most important check: without it an attacker crafts a link
 *     that sends the code to their own server.
 *   - Codes are single-use and live 60 seconds, bound to the client that
 *     asked and the redirect that will receive them.
 *   - Secrets and tokens are stored only as hashes.
 *   - Consent is per app and revocable by the user at any time.
 *   - Scopes gate the data: an app that asked for `profile` never sees the
 *     email, and no scope exposes the balance unless asked for and granted.
 */

const crypto = require('crypto');
const path = require('path');

const CODE_TTL_MS = 60 * 1000;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const SCOPES = {
  profile: 'Your name and LSP-Pay handle',
  email: 'Your email address',
  'wallet:read': 'Your balance and points, read only'
};

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

module.exports = function mountIdp(app, deps) {
  const { db, auth, fail, inr, findUserById, notify } = deps;

  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_apps (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id      INTEGER NOT NULL REFERENCES users(id),
      name          TEXT NOT NULL,
      description   TEXT,
      logo_url      TEXT,
      homepage      TEXT,
      client_id     TEXT NOT NULL UNIQUE,
      secret_hash   TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code          TEXT PRIMARY KEY,
      app_id        INTEGER NOT NULL REFERENCES oauth_apps(id),
      user_id       INTEGER NOT NULL REFERENCES users(id),
      redirect_uri  TEXT NOT NULL,
      scope         TEXT NOT NULL,
      challenge     TEXT,
      used          INTEGER NOT NULL DEFAULT 0,
      expires_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash    TEXT NOT NULL UNIQUE,
      app_id        INTEGER NOT NULL REFERENCES oauth_apps(id),
      user_id       INTEGER NOT NULL REFERENCES users(id),
      scope         TEXT NOT NULL,
      revoked       INTEGER NOT NULL DEFAULT 0,
      expires_at    INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS oauth_grants (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id        INTEGER NOT NULL REFERENCES oauth_apps(id),
      user_id       INTEGER NOT NULL REFERENCES users(id),
      scope         TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grant_unique ON oauth_grants(app_id, user_id);
  `);

  const appByClientId = db.prepare('SELECT * FROM oauth_apps WHERE client_id = ?');
  const myApp = db.prepare('SELECT * FROM oauth_apps WHERE id = ? AND owner_id = ?');

  const publicApp = (a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    logoUrl: a.logo_url,
    homepage: a.homepage,
    clientId: a.client_id,
    redirectUris: JSON.parse(a.redirect_uris),
    active: !!a.active,
    users: db.prepare('SELECT COUNT(*) n FROM oauth_grants WHERE app_id = ?').get(a.id).n,
    createdAt: a.created_at
  });

  /**
   * A redirect URI has to be a URI we are willing to send a code to.
   * https everywhere, except localhost, which developers need for testing.
   */
  function checkRedirects(list) {
    const uris = (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/))
      .map((u) => String(u).trim()).filter(Boolean);

    if (!uris.length) return { error: 'Give at least one redirect URL.' };
    if (uris.length > 5) return { error: 'Register at most five redirect URLs.' };

    for (const u of uris) {
      let parsed;
      try { parsed = new URL(u); } catch { return { error: `${u} is not a valid URL.` }; }

      const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' && !local)
        return { error: `${u} must use https (http is allowed only on localhost).` };
      if (parsed.hash) return { error: 'A redirect URL cannot contain a #fragment.' };
    }
    return { uris };
  }

  const cleanScope = (raw) => {
    const asked = String(raw || 'profile').split(/[\s,+]+/).filter(Boolean);
    const kept = asked.filter((s) => SCOPES[s]);
    return kept.length ? [...new Set(kept)] : ['profile'];
  };

  /* ------------------------------------------- developer app management */

  app.get('/api/dev/apps', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM oauth_apps WHERE owner_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ apps: rows.map(publicApp), scopes: SCOPES });
  });

  app.post('/api/dev/apps', auth, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (name.length < 2) return fail(res, 400, 'Give your app a name. Your users will see it.');

    const mine = db.prepare('SELECT COUNT(*) n FROM oauth_apps WHERE owner_id = ?').get(req.user.id).n;
    if (mine >= 5) return fail(res, 400, 'You can register up to five apps.');

    const redirects = checkRedirects(req.body.redirectUris);
    if (redirects.error) return fail(res, 400, redirects.error);

    const clientId = 'lspc_' + crypto.randomBytes(10).toString('hex');
    const secret = 'lspk_' + crypto.randomBytes(24).toString('hex');

    const info = db.prepare(
      `INSERT INTO oauth_apps (owner_id, name, description, logo_url, homepage, client_id, secret_hash, redirect_uris)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user.id, name,
      String(req.body.description || '').slice(0, 140) || null,
      String(req.body.logoUrl || '').slice(0, 400) || null,
      String(req.body.homepage || '').slice(0, 400) || null,
      clientId, sha256(secret), JSON.stringify(redirects.uris)
    );

    // The only time the secret is ever readable.
    res.json({
      ok: true,
      app: publicApp(db.prepare('SELECT * FROM oauth_apps WHERE id = ?').get(info.lastInsertRowid)),
      secret,
      warning: 'Copy this secret now. It is stored only as a hash and cannot be shown again.'
    });
  });

  app.post('/api/dev/apps/update', auth, (req, res) => {
    const a = myApp.get(Number(req.body.appId), req.user.id);
    if (!a) return fail(res, 404, 'No such app on your account.');

    const redirects = checkRedirects(req.body.redirectUris);
    if (redirects.error) return fail(res, 400, redirects.error);

    db.prepare(
      'UPDATE oauth_apps SET name = ?, description = ?, logo_url = ?, homepage = ?, redirect_uris = ?, active = ? WHERE id = ?'
    ).run(
      String(req.body.name || a.name).trim().slice(0, 60),
      String(req.body.description || '').slice(0, 140) || null,
      String(req.body.logoUrl || '').slice(0, 400) || null,
      String(req.body.homepage || '').slice(0, 400) || null,
      JSON.stringify(redirects.uris),
      req.body.active === false ? 0 : 1,
      a.id
    );

    res.json({ ok: true, app: publicApp(db.prepare('SELECT * FROM oauth_apps WHERE id = ?').get(a.id)) });
  });

  app.post('/api/dev/apps/roll-secret', auth, (req, res) => {
    const a = myApp.get(Number(req.body.appId), req.user.id);
    if (!a) return fail(res, 404, 'No such app on your account.');

    const pin = deps.checkPin(req.user, req.body.pin);
    if (!pin.ok) return fail(res, 403, pin.message);

    const secret = 'lspk_' + crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE oauth_apps SET secret_hash = ? WHERE id = ?').run(sha256(secret), a.id);
    res.json({ ok: true, secret, warning: 'The old secret stopped working. Update your server now.' });
  });

  app.post('/api/dev/apps/delete', auth, (req, res) => {
    const a = myApp.get(Number(req.body.appId), req.user.id);
    if (!a) return fail(res, 404, 'No such app on your account.');

    db.transaction(() => {
      db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE app_id = ?').run(a.id);
      db.prepare('DELETE FROM oauth_grants WHERE app_id = ?').run(a.id);
      db.prepare('DELETE FROM oauth_codes WHERE app_id = ?').run(a.id);
      db.prepare('DELETE FROM oauth_apps WHERE id = ?').run(a.id);
    })();

    res.json({ ok: true });
  });

  /* ------------------------------------------------ the authorize screen */

  /** What the consent page needs to render. */
  app.get('/api/oauth/request', (req, res) => {
    const a = appByClientId.get(String(req.query.client_id || ''));
    if (!a || !a.active) return fail(res, 400, 'That app is not recognised.');

    const redirectUri = String(req.query.redirect_uri || '');
    if (!JSON.parse(a.redirect_uris).includes(redirectUri))
      return fail(res, 400, 'That redirect URL is not registered for this app.');

    const scope = cleanScope(req.query.scope);
    const owner = findUserById.get(a.owner_id);

    res.json({
      app: { name: a.name, description: a.description, logoUrl: a.logo_url, homepage: a.homepage },
      developer: owner ? (owner.display_name || owner.handle) : 'Unknown',
      scope: scope.map((s) => ({ key: s, label: SCOPES[s] })),
      signedIn: Boolean(req.lspUser),
      you: req.lspUser ? (req.lspUser.display_name || req.lspUser.email) : null,
      alreadyGranted: req.lspUser
        ? Boolean(db.prepare('SELECT 1 FROM oauth_grants WHERE app_id = ? AND user_id = ?').get(a.id, req.lspUser.id))
        : false
    });
  });

  app.get('/oauth/authorize', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'authorize.html')));

  /** A client app you can point at your own gateway, to see the flow work. */
  app.get('/oauth/playground', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'playground.html')));

  /** The user pressed Allow. Mint a one-time code and bounce them back. */
  app.post('/api/oauth/approve', auth, (req, res) => {
    const a = appByClientId.get(String(req.body.client_id || ''));
    if (!a || !a.active) return fail(res, 400, 'That app is not recognised.');

    const redirectUri = String(req.body.redirect_uri || '');
    if (!JSON.parse(a.redirect_uris).includes(redirectUri))
      return fail(res, 400, 'That redirect URL is not registered for this app.');

    if (a.owner_id === req.user.id) {
      // Allowed, and useful for testing your own app.
    }

    const scope = cleanScope(req.body.scope);
    const code = 'lspa_' + crypto.randomBytes(24).toString('hex');

    db.prepare(
      'INSERT INTO oauth_codes (code, app_id, user_id, redirect_uri, scope, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      sha256(code), a.id, req.user.id, redirectUri, scope.join(' '),
      String(req.body.code_challenge || '') || null,
      Date.now() + CODE_TTL_MS
    );

    db.prepare('INSERT OR REPLACE INTO oauth_grants (app_id, user_id, scope) VALUES (?, ?, ?)')
      .run(a.id, req.user.id, scope.join(' '));

    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (req.body.state) url.searchParams.set('state', String(req.body.state));

    res.json({ ok: true, redirect: url.toString() });
  });

  /* ------------------------------------------------------ token endpoint */

  app.post('/oauth/token', async (req, res) => {
    // Credentials may come as Basic auth or in the body, as in the spec.
    let clientId = req.body.client_id;
    let secret = req.body.client_secret;

    const header = req.get('Authorization') || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const cut = decoded.indexOf(':');
      if (cut > -1) { clientId = decoded.slice(0, cut); secret = decoded.slice(cut + 1); }
    }

    if (String(req.body.grant_type || '') !== 'authorization_code')
      return res.status(400).json({ error: 'unsupported_grant_type' });

    const a = appByClientId.get(String(clientId || ''));
    if (!a || !a.active) return res.status(401).json({ error: 'invalid_client' });

    const row = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(sha256(String(req.body.code || '')));
    if (!row) return res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown code.' });

    // Every one of these is a real attack if left out.
    if (row.used) {
      // A replayed code means it may have leaked; kill what it produced.
      db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE app_id = ? AND user_id = ?').run(row.app_id, row.user_id);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'That code was already used.' });
    }
    if (Date.now() > row.expires_at)
      return res.status(400).json({ error: 'invalid_grant', error_description: 'That code expired.' });
    if (row.app_id !== a.id)
      return res.status(400).json({ error: 'invalid_grant', error_description: 'That code belongs to another app.' });
    if (String(req.body.redirect_uri || '') !== row.redirect_uri)
      return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match the one used to get this code.' });

    // PKCE, when the app opted in. Lets a public client skip the secret.
    if (row.challenge) {
      const verifier = String(req.body.code_verifier || '');
      const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || digest !== row.challenge)
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
    } else if (sha256(String(secret || '')) !== a.secret_hash) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(row.code);

    const token = 'lspt_' + crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO oauth_tokens (token_hash, app_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), a.id, row.user_id, row.scope, Date.now() + TOKEN_TTL_MS);

    res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      scope: row.scope
    });
  });

  /* --------------------------------------------------- userinfo endpoint */

  function bearer(req, res) {
    const header = req.get('Authorization') || '';
    if (!header.startsWith('Bearer ')) { res.status(401).json({ error: 'invalid_token' }); return null; }

    const row = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(sha256(header.slice(7)));
    if (!row || row.revoked || Date.now() > row.expires_at) {
      res.status(401).json({ error: 'invalid_token' });
      return null;
    }
    return row;
  }

  app.get('/oauth/userinfo', (req, res) => {
    const t = bearer(req, res);
    if (!t) return;

    const u = findUserById.get(t.user_id);
    if (!u) return res.status(404).json({ error: 'user_not_found' });

    const scope = t.scope.split(' ');
    // `sub` is stable and opaque: an app never learns the internal row id.
    const out = { sub: crypto.createHash('sha256').update(`${t.app_id}:${u.id}`).digest('hex').slice(0, 32) };

    if (scope.includes('profile')) {
      out.name = u.display_name || u.handle;
      out.handle = u.handle;
    }
    if (scope.includes('email')) {
      out.email = u.email;
      out.email_verified = true;
    }
    if (scope.includes('wallet:read')) {
      out.balance = u.balance_p / 100;
      out.balance_label = inr(u.balance_p);
      out.points = u.points;
    }

    res.json(out);
  });

  app.post('/oauth/revoke', (req, res) => {
    // RFC 7009 style: the token in the request body. Revoking only needs the
    // token itself (holding it already lets you use it), and the answer is
    // 200 whether or not it existed, so it reveals nothing.
    if (!(req.get('Authorization') || '').startsWith('Bearer ') && req.body && req.body.token) {
      db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?').run(sha256(String(req.body.token)));
      return res.json({ ok: true });
    }
    const t = bearer(req, res);
    if (!t) return;
    db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE id = ?').run(t.id);
    res.json({ ok: true });
  });

  /* ------------------------------------------- what the user has allowed */

  app.get('/api/oauth/grants', auth, (req, res) => {
    const rows = db.prepare(
      `SELECT g.*, a.name, a.logo_url, a.homepage FROM oauth_grants g
       JOIN oauth_apps a ON a.id = g.app_id WHERE g.user_id = ? ORDER BY g.id DESC`
    ).all(req.user.id);

    res.json({
      grants: rows.map((g) => ({
        appId: g.app_id,
        name: g.name,
        logoUrl: g.logo_url,
        homepage: g.homepage,
        scope: g.scope.split(' ').map((s) => SCOPES[s] || s),
        since: g.created_at
      }))
    });
  });

  /** Taking access away must actually kill live tokens, not just the record. */
  app.post('/api/oauth/grants/revoke', auth, (req, res) => {
    const appId = Number(req.body.appId);
    db.transaction(() => {
      db.prepare('DELETE FROM oauth_grants WHERE app_id = ? AND user_id = ?').run(appId, req.user.id);
      db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE app_id = ? AND user_id = ?').run(appId, req.user.id);
    })();
    res.json({ ok: true });
  });

  // Housekeeping: expired codes are useless and shouldn't accumulate.
  setInterval(() => {
    db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(Date.now() - 86400000);
    db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(Date.now() - 86400000);
  }, 3600000).unref();
};
