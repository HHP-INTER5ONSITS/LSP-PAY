'use strict';

/**
 * LSP-Pay Business Gateway.
 *
 * A merchant creates a gateway in the app and gets a key ID and a secret.
 * Their server calls POST /api/v1/orders to create a payment, redirects the
 * customer to the returned checkout_url, and gets told the result by webhook
 * or by polling. The customer pays by UPI, card, netbanking, their LSP-Pay
 * wallet, or chooses cash on delivery.
 *
 * Credential rules, which the rest of this file enforces:
 *   key_id  — public. Safe in a URL or a page. Prefixed lsp_test_ / lsp_live_.
 *   secret  — private. Shown once at creation, then only a scrypt hash is
 *             kept. Never logged, never returned by any endpoint.
 */

const crypto = require('crypto');

const ORDER_TTL_MS = 30 * 60 * 1000; // a checkout link is good for 30 minutes
const ALL_METHODS = ['upi', 'card', 'netbanking', 'wallet', 'cash'];

const BANKS = ['HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank', 'Kotak Mahindra', 'Punjab National Bank'];

module.exports = function mountGateway(app, deps) {
  const { db, auth, fail, inr, paise, reference, publicUser, findUserById, addTx, checkPin, cards, mail, rateLimit } = deps;

  /* ------------------------------------------------------------ helpers */

  const hash = (value) => {
    const salt = crypto.randomBytes(16).toString('hex');
    return { digest: crypto.scryptSync(String(value), salt, 32).toString('hex'), salt };
  };
  const verify = (value, digest, salt) => {
    const a = crypto.scryptSync(String(value), salt, 32);
    const b = Buffer.from(digest, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const orderId = () => 'ord_' + crypto.randomBytes(10).toString('hex');
  const makeKeyId = (live) => (live ? 'lsp_live_' : 'lsp_test_') + crypto.randomBytes(9).toString('hex');
  const makeSecret = () => 'lsps_' + crypto.randomBytes(24).toString('hex');

  const findMerchant = db.prepare('SELECT * FROM merchants WHERE id = ? AND owner_id = ?');
  const merchantByKey = db.prepare('SELECT * FROM merchants WHERE key_id = ?');
  const orderById = db.prepare('SELECT * FROM orders WHERE id = ?');

  const publicMerchant = (m, baseUrl) => ({
    id: m.id,
    name: m.name,
    logoUrl: m.logo_url,
    theme: m.theme,
    methods: m.methods.split(','),
    webhookUrl: m.webhook_url,
    keyId: m.key_id,
    live: !!m.live,
    createdAt: m.created_at,
    docsUrl: `${baseUrl}/developers`
  });

  const baseUrlOf = (req) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    return `${proto}://${req.get('host')}`;
  };

  const publicOrder = (o, m, baseUrl) => ({
    id: o.id,
    amount: o.amount_p / 100,
    amountLabel: inr(o.amount_p),
    description: o.description,
    reference: o.reference,
    customerEmail: o.customer_email,
    status: o.status,
    method: o.method,
    authCode: o.auth_code,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    expiresAt: new Date(o.expires_at).toISOString(),
    checkoutUrl: `${baseUrl}/pay/${o.id}`,
    merchant: m ? { name: m.name, logoUrl: m.logo_url, theme: m.theme, methods: m.methods.split(',') } : undefined
  });

  /* ------------------------------------------------- merchant API auth */

  /**
   * Reads Basic auth (key_id:secret) or the X-LSP-Key / X-LSP-Secret pair.
   * Rejects with 401 rather than saying which half was wrong.
   */
  function apiAuth(req, res, next) {
    let keyId = req.get('X-LSP-Key');
    let secret = req.get('X-LSP-Secret');

    const header = req.get('Authorization') || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const cut = decoded.indexOf(':');
      if (cut > -1) {
        keyId = decoded.slice(0, cut);
        secret = decoded.slice(cut + 1);
      }
    }

    if (!keyId || !secret)
      return fail(res, 401, 'Send your key ID and secret with HTTP Basic auth.');

    const merchant = merchantByKey.get(keyId);
    if (!merchant || !verify(secret, merchant.secret_hash, merchant.secret_salt))
      return fail(res, 401, 'Those API credentials are not valid.');

    req.merchant = merchant;
    next();
  }

  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const payLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

  /* ------------------------------------------------ webhooks (outgoing) */

  /**
   * Notifies the merchant's server. Signed with HMAC-SHA256 so they can
   * prove the call came from us — the signature covers the exact body.
   */
  async function fireWebhook(merchant, event, order, baseUrl) {
    if (!merchant.webhook_url) return;

    const body = JSON.stringify({
      event,
      sentAt: new Date().toISOString(),
      order: publicOrder(order, merchant, baseUrl)
    });
    const signature = crypto.createHmac('sha256', merchant.webhook_secret).update(body).digest('hex');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      await fetch(merchant.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LSP-Event': event,
          'X-LSP-Signature': signature
        },
        body,
        signal: controller.signal
      });
      clearTimeout(timer);
    } catch (err) {
      // A merchant's server being down must never fail the customer's payment.
      console.error('[webhook] delivery failed:', merchant.key_id, err.message);
    }
  }

  /* ------------------------------------- merchant management (in-app) */

  app.get('/api/merchants', auth, (req, res) => {
    const rows = db.prepare('SELECT * FROM merchants WHERE owner_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ merchants: rows.map((m) => publicMerchant(m, baseUrlOf(req))) });
  });

  app.post('/api/merchants', auth, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (name.length < 2) return fail(res, 400, 'Give your business a name.');

    const mine = db.prepare('SELECT COUNT(*) n FROM merchants WHERE owner_id = ?').get(req.user.id).n;
    if (mine >= 3) return fail(res, 400, 'You can run up to three gateways per account.');

    const secret = makeSecret();
    const { digest, salt } = hash(secret);
    const keyId = makeKeyId(false);

    const info = db
      .prepare(
        `INSERT INTO merchants (owner_id, name, logo_url, theme, methods, key_id, secret_hash, secret_salt, webhook_secret)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id,
        name,
        String(req.body.logoUrl || '').slice(0, 400) || null,
        req.body.theme === 'light' ? 'light' : 'dark',
        'upi,card,netbanking,wallet',
        keyId,
        digest,
        salt,
        crypto.randomBytes(24).toString('hex')
      );

    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(info.lastInsertRowid);

    // The only time the plaintext secret ever leaves this server.
    res.json({
      ok: true,
      merchant: publicMerchant(merchant, baseUrlOf(req)),
      secret,
      warning: 'Copy this secret now. It is stored only as a hash and cannot be shown again.'
    });
  });

  app.post('/api/merchants/update', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.body.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');

    const logoUrl = String(req.body.logoUrl || '').trim();
    if (logoUrl && !/^https:\/\/\S+$/i.test(logoUrl))
      return fail(res, 400, 'The logo must be an https link to an image.');

    const chosen = Array.isArray(req.body.methods)
      ? req.body.methods.filter((m) => ALL_METHODS.includes(m))
      : merchant.methods.split(',');
    if (!chosen.length) return fail(res, 400, 'Keep at least one payment method switched on.');

    const webhookUrl = String(req.body.webhookUrl || '').trim();
    if (webhookUrl && !/^https:\/\/\S+$/i.test(webhookUrl))
      return fail(res, 400, 'The webhook URL must start with https://');

    db.prepare(
      `UPDATE merchants SET name = ?, logo_url = ?, theme = ?, methods = ?, webhook_url = ? WHERE id = ?`
    ).run(
      String(req.body.name || merchant.name).trim().slice(0, 60),
      logoUrl || null,
      req.body.theme === 'light' ? 'light' : 'dark',
      chosen.join(','),
      webhookUrl || null,
      merchant.id
    );

    res.json({ ok: true, merchant: publicMerchant(db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchant.id), baseUrlOf(req)) });
  });

  /** Rotates the secret. The old one stops working immediately. */
  app.post('/api/merchants/roll-secret', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.body.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');

    const pinResult = checkPin(req.user, req.body.pin);
    if (!pinResult.ok) return fail(res, 403, pinResult.message);

    const secret = makeSecret();
    const { digest, salt } = hash(secret);
    db.prepare('UPDATE merchants SET secret_hash = ?, secret_salt = ? WHERE id = ?').run(digest, salt, merchant.id);

    res.json({ ok: true, secret, warning: 'The old secret stopped working. Update your server now.' });
  });

  /**
   * Creates an order from inside the app, using the owner's session rather
   * than API credentials. Exists so a merchant can see their own checkout
   * page without a terminal, a key or a secret.
   */
  app.post('/api/merchants/test-order', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.body.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');

    const rupees = Number(req.body.amount);
    if (!Number.isFinite(rupees) || rupees <= 0 || rupees > 200000)
      return fail(res, 400, 'Enter an amount between 1 and 200000.');

    const id = orderId();
    db.prepare(
      `INSERT INTO orders (id, merchant_id, amount_p, description, reference, expires_at)
       VALUES (?, ?, ?, ?, 'in-app-test', ?)`
    ).run(
      id,
      merchant.id,
      paise(rupees),
      String(req.body.description || 'Test order').slice(0, 140),
      Date.now() + ORDER_TTL_MS
    );

    res.json(publicOrder(orderById.get(id), merchant, baseUrlOf(req)));
  });

  app.get('/api/merchants/orders', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.query.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');

    const rows = db
      .prepare('SELECT * FROM orders WHERE merchant_id = ? ORDER BY rowid DESC LIMIT 50')
      .all(merchant.id);

    const paid = db
      .prepare("SELECT COALESCE(SUM(amount_p),0) t, COUNT(*) n FROM orders WHERE merchant_id = ? AND status = 'paid'")
      .get(merchant.id);

    res.json({
      orders: rows.map((o) => publicOrder(o, merchant, baseUrlOf(req))),
      collectedLabel: inr(paid.t),
      paidCount: paid.n
    });
  });

  /* ----------------------------------------------- the public REST API */

  /** POST /api/v1/orders — create a payment and get a checkout link. */
  app.post('/api/v1/orders', apiLimiter, apiAuth, (req, res) => {
    const rupees = Number(req.body.amount);
    if (!Number.isFinite(rupees) || rupees <= 0) return fail(res, 400, 'amount must be a positive number of rupees.');
    if (rupees > 200000) return fail(res, 400, 'amount may not exceed 200000.');

    const id = orderId();
    db.prepare(
      `INSERT INTO orders (id, merchant_id, amount_p, description, reference, customer_email, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.merchant.id,
      paise(rupees),
      String(req.body.description || '').slice(0, 140) || null,
      String(req.body.reference || '').slice(0, 60) || null,
      String(req.body.customer_email || '').trim().toLowerCase().slice(0, 120) || null,
      Date.now() + ORDER_TTL_MS
    );

    res.status(201).json(publicOrder(orderById.get(id), req.merchant, baseUrlOf(req)));
  });

  /** GET /api/v1/orders/:id — check whether it was paid. */
  app.get('/api/v1/orders/:id', apiLimiter, apiAuth, (req, res) => {
    const order = orderById.get(req.params.id);
    if (!order || order.merchant_id !== req.merchant.id) return fail(res, 404, 'No such order.');
    res.json(publicOrder(order, req.merchant, baseUrlOf(req)));
  });

  /** GET /api/v1/orders — recent orders. */
  app.get('/api/v1/orders', apiLimiter, apiAuth, (req, res) => {
    const rows = db
      .prepare('SELECT * FROM orders WHERE merchant_id = ? ORDER BY rowid DESC LIMIT 50')
      .all(req.merchant.id);
    res.json({ orders: rows.map((o) => publicOrder(o, req.merchant, baseUrlOf(req))) });
  });

  /** Merchant confirms a cash order was collected. */
  app.post('/api/v1/orders/:id/collect', apiLimiter, apiAuth, async (req, res) => {
    const order = orderById.get(req.params.id);
    if (!order || order.merchant_id !== req.merchant.id) return fail(res, 404, 'No such order.');
    if (order.status !== 'awaiting_cash') return fail(res, 400, 'That order is not awaiting cash.');

    db.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?").run(order.id);
    const updated = orderById.get(order.id);

    creditMerchant(req.merchant, updated, 'Cash collected');
    fireWebhook(req.merchant, 'order.paid', updated, baseUrlOf(req));

    res.json(publicOrder(updated, req.merchant, baseUrlOf(req)));
  });

  /* ------------------------------------------------- checkout (public) */

  /** Public view of an order. No credentials — the order id is the capability. */
  app.get('/api/checkout/:id', (req, res) => {
    const order = orderById.get(req.params.id);
    if (!order) return fail(res, 404, 'This payment link is not valid.');

    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(order.merchant_id);

    if (order.status === 'created' && Date.now() > order.expires_at) {
      db.prepare("UPDATE orders SET status = 'expired' WHERE id = ?").run(order.id);
      order.status = 'expired';
    }

    // Deliberately excludes the merchant's keys and webhook. Also drops the
    // customer's email and the merchant's own reference: whoever holds this
    // link can see the page, and neither field is needed to pay.
    const view = publicOrder(order, merchant, baseUrlOf(req));
    delete view.customerEmail;
    delete view.reference;
    res.json(view);
  });

  /** Credits the business owner's wallet when an order is paid. */
  function creditMerchant(merchant, order, note) {
    db.transaction(() => {
      db.prepare('UPDATE users SET balance_p = balance_p + ? WHERE id = ?').run(order.amount_p, merchant.owner_id);
      addTx.run({
        user_id: merchant.owner_id,
        kind: 'receive',
        direction: 'credit',
        amount_p: order.amount_p,
        points: 0,
        title: `${merchant.name} · payment received`,
        detail: [order.description, note, order.id].filter(Boolean).join(' · '),
        reference: reference()
      });
    })();
  }

  /**
   * Customer pays. Every branch re-reads the order inside a transaction and
   * refuses anything not in 'created', so a double submit or two tabs open
   * at once cannot pay twice.
   */
  app.post('/api/checkout/:id/pay', payLimiter, async (req, res) => {
    const order = orderById.get(req.params.id);
    if (!order) return fail(res, 404, 'This payment link is not valid.');
    if (order.status !== 'created')
      return fail(res, 409, order.status === 'paid' ? 'This order was already paid.' : 'This payment link is no longer active.');
    if (Date.now() > order.expires_at) {
      db.prepare("UPDATE orders SET status = 'expired' WHERE id = ?").run(order.id);
      return fail(res, 410, 'This payment link expired. Ask the business for a new one.');
    }

    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(order.merchant_id);
    const method = String(req.body.method || '');
    if (!merchant.methods.split(',').includes(method))
      return fail(res, 400, 'That payment method is not accepted here.');

    let authCode = 'AUTH' + crypto.randomBytes(3).toString('hex').toUpperCase();
    let note = null;
    let paid = true;

    if (method === 'upi') {
      const vpa = String(req.body.vpa || '').trim();
      if (!/^[\w.\-]{2,50}@[a-zA-Z]{2,20}$/.test(vpa)) return fail(res, 400, 'Enter a UPI ID like name@bank.');
      if (vpa.startsWith('fail@')) return fail(res, 402, 'The UPI request was declined.');
      note = vpa;
    } else if (method === 'netbanking') {
      const bank = String(req.body.bank || '');
      if (!BANKS.includes(bank)) return fail(res, 400, 'Pick your bank.');
      note = bank;
    } else if (method === 'card') {
      const check = cards.inspect(req.body);
      if (!check.ok) return fail(res, 400, check.message);
      const authed = cards.authorise({ last4: check.last4 }, order.amount_p);
      if (!authed.ok) return fail(res, 402, authed.message);
      authCode = authed.authCode;
      note = `${check.brand} ••••${check.last4}`;
    } else if (method === 'wallet') {
      // Real money movement: the payer must be signed in to LSP-Pay.
      const payer = req.lspUser;
      if (!payer) return fail(res, 401, 'Sign in to LSP-Pay first to pay from your wallet.');

      const pinResult = checkPin(payer, req.body.pin);
      if (!pinResult.ok) return fail(res, 403, pinResult.message);
      if (payer.id === merchant.owner_id) return fail(res, 400, 'You cannot pay your own gateway.');

      const fresh = findUserById.get(payer.id);
      if (fresh.balance_p < order.amount_p) return fail(res, 400, 'Not enough balance in your wallet.');

      db.transaction(() => {
        db.prepare('UPDATE users SET balance_p = balance_p - ? WHERE id = ?').run(order.amount_p, payer.id);
        addTx.run({
          user_id: payer.id,
          kind: 'send',
          direction: 'debit',
          amount_p: order.amount_p,
          points: 0,
          title: `Paid ${merchant.name}`,
          detail: order.description || order.id,
          reference: reference()
        });
      })();
      note = payer.email;
    } else if (method === 'cash') {
      paid = false; // collected in person later
      note = String(req.body.note || '').slice(0, 80) || null;
    }

    const status = paid ? 'paid' : 'awaiting_cash';
    const changed = db
      .prepare(
        `UPDATE orders SET status = ?, method = ?, payer_note = ?, auth_code = ?,
         paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE NULL END
         WHERE id = ? AND status = 'created'`
      )
      .run(status, method, note, paid ? authCode : null, status, order.id);

    if (changed.changes === 0) return fail(res, 409, 'This order was already handled.');

    const updated = orderById.get(order.id);
    if (paid) creditMerchant(merchant, updated, note);

    fireWebhook(merchant, paid ? 'order.paid' : 'order.awaiting_cash', updated, baseUrlOf(req));

    if (updated.customer_email && paid) {
      mail
        .sendReceipt(updated.customer_email, {
          title: merchant.name,
          amountLabel: inr(updated.amount_p),
          reference: updated.id,
          detail: updated.description,
          balanceLabel: '—',
          points: 0
        })
        .catch((e) => console.error('[mail] checkout receipt failed:', e.message));
    }

    res.json({
      ok: true,
      status,
      authCode: paid ? authCode : null,
      amountLabel: inr(updated.amount_p),
      merchant: merchant.name,
      orderId: updated.id
    });
  });

  app.get('/api/checkout/banks', (req, res) => res.json({ banks: BANKS }));
};
