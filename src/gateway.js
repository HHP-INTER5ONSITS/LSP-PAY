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
const path = require('path');
const QRCode = require('qrcode');

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
    notifyEmail: !!m.notify_email,
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
    refunded: o.refunded_p / 100,
    refundedLabel: inr(o.refunded_p),
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
   * Queues a webhook and tries to deliver it. Real gateways retry, because
   * a merchant's server being down for a minute must not lose the event.
   * Backoff: 10s, 1m, 5m, 30m, 2h, then give up.
   */
  const BACKOFF_MS = [10e3, 60e3, 300e3, 1800e3, 7200e3];

  function queueWebhook(merchant, event, order, baseUrl) {
    if (!merchant.webhook_url) return;

    const payload = JSON.stringify({
      event,
      sentAt: new Date().toISOString(),
      order: publicOrder(order, merchant, baseUrl)
    });

    const info = db
      .prepare('INSERT INTO webhook_jobs (merchant_id, url, event, payload, next_at) VALUES (?, ?, ?, ?, ?)')
      .run(merchant.id, merchant.webhook_url, event, payload, Date.now());

    deliverWebhook(info.lastInsertRowid);
  }

  async function deliverWebhook(jobId) {
    const job = db.prepare('SELECT * FROM webhook_jobs WHERE id = ?').get(jobId);
    if (!job || job.delivered) return;

    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(job.merchant_id);
    if (!merchant) return;

    const signature = crypto.createHmac('sha256', merchant.webhook_secret).update(job.payload).digest('hex');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(job.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LSP-Event': job.event,
          'X-LSP-Signature': signature,
          'X-LSP-Delivery': String(job.id),
          'X-LSP-Attempt': String(job.attempts + 1)
        },
        body: job.payload,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        db.prepare('UPDATE webhook_jobs SET delivered = 1, attempts = attempts + 1 WHERE id = ?').run(job.id);
        return;
      }
      throw new Error(`responded ${res.status}`);
    } catch (err) {
      const attempts = job.attempts + 1;
      const wait = BACKOFF_MS[attempts - 1];

      db.prepare('UPDATE webhook_jobs SET attempts = ?, last_error = ?, next_at = ? WHERE id = ?').run(
        attempts,
        err.message.slice(0, 200),
        wait ? Date.now() + wait : Date.now(),
        job.id
      );

      if (!wait) console.error('[webhook] gave up after 5 attempts:', merchant.key_id, job.event);
    }
  }

  // Sweeps for anything due. A payment must never fail because a merchant's
  // server is down, so delivery is always out of band from the payment.
  setInterval(() => {
    const due = db
      .prepare('SELECT id FROM webhook_jobs WHERE delivered = 0 AND attempts < 5 AND next_at <= ? LIMIT 20')
      .all(Date.now());
    due.forEach((j) => deliverWebhook(j.id));
  }, 30000).unref();

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
      `UPDATE merchants SET name = ?, logo_url = ?, theme = ?, methods = ?, webhook_url = ?, notify_email = ? WHERE id = ?`
    ).run(
      String(req.body.name || merchant.name).trim().slice(0, 60),
      logoUrl || null,
      req.body.theme === 'light' ? 'light' : 'dark',
      chosen.join(','),
      webhookUrl || null,
      req.body.notifyEmail === false ? 0 : 1,
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
  app.post('/api/v1/orders', apiLimiter, apiAuth, async (req, res) => {
    const rupees = Number(req.body.amount);
    if (!Number.isFinite(rupees) || rupees <= 0) return fail(res, 400, 'amount must be a positive number of rupees.');
    if (rupees > 200000) return fail(res, 400, 'amount may not exceed 200000.');

    // Idempotency-Key: a retried request returns the original order rather
    // than charging the customer twice. Every real gateway supports this.
    const idem = String(req.get('Idempotency-Key') || '').slice(0, 80) || null;
    if (idem) {
      const seen = db
        .prepare('SELECT * FROM orders WHERE merchant_id = ? AND idem_key = ?')
        .get(req.merchant.id, idem);
      if (seen) return res.status(200).json(publicOrder(seen, req.merchant, baseUrlOf(req)));
    }

    const id = orderId();
    db.prepare(
      `INSERT INTO orders (id, merchant_id, amount_p, description, reference, customer_email, expires_at, idem_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.merchant.id,
      paise(rupees),
      String(req.body.description || '').slice(0, 140) || null,
      String(req.body.reference || '').slice(0, 60) || null,
      String(req.body.customer_email || '').trim().toLowerCase().slice(0, 120) || null,
      Date.now() + ORDER_TTL_MS,
      idem
    );

    const created = orderById.get(id);
    const view = publicOrder(created, req.merchant, baseUrlOf(req));

    // notify: true emails the customer the link, the way Razorpay's
    // Payment Links do. Needs customer_email to be set.
    if (req.body.notify) {
      if (!created.customer_email) {
        view.emailed = false;
        view.emailNote = 'notify was set but customer_email was missing.';
      } else {
        const out = await mail.sendPaymentLink(created.customer_email, {
          merchant: req.merchant.name,
          amountLabel: inr(created.amount_p),
          description: created.description,
          checkoutUrl: view.checkoutUrl,
          logoUrl: req.merchant.logo_url,
          note: String(req.body.note || '').slice(0, 200) || null
        });
        view.emailed = out.delivered;
        if (!out.delivered) view.emailNote = out.reason;
      }
    }

    res.status(201).json(view);
  });

  /** POST /api/v1/orders/:id/notify — email the link again. */
  app.post('/api/v1/orders/:id/notify', apiLimiter, apiAuth, async (req, res) => {
    const order = orderById.get(req.params.id);
    if (!order || order.merchant_id !== req.merchant.id) return fail(res, 404, 'No such order.');
    if (order.status !== 'created') return fail(res, 400, 'That order is no longer payable.');

    const to = String(req.body.customer_email || order.customer_email || '').trim().toLowerCase();
    if (!to) return fail(res, 400, 'No customer_email on this order. Send one in the body.');

    const out = await mail.sendPaymentLink(to, {
      merchant: req.merchant.name,
      amountLabel: inr(order.amount_p),
      description: order.description,
      checkoutUrl: `${baseUrlOf(req)}/pay/${order.id}`,
      logoUrl: req.merchant.logo_url,
      note: String(req.body.note || '').slice(0, 200) || null
    });

    if (!out.delivered) return fail(res, 502, `Could not send the email: ${out.reason}`);
    res.json({ ok: true, emailed: to });
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
    queueWebhook(req.merchant, 'order.paid', updated, baseUrlOf(req));

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
    if (merchant.notify_email) {
      const owner = findUserById.get(merchant.owner_id);
      if (owner) {
        mail
          .sendMerchantAlert(owner.email, {
            merchant: merchant.name,
            amountLabel: inr(order.amount_p),
            method: order.method,
            orderId: order.id,
            description: order.description
          })
          .catch((e) => console.error('[mail] merchant alert failed:', e.message));
      }
    }

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

    queueWebhook(merchant, paid ? 'order.paid' : 'order.awaiting_cash', updated, baseUrlOf(req));

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

  /* ------------------------------------------------------------ refunds */

  /**
   * Refunds a paid order, fully or partially. The money comes back out of
   * the business's wallet, so it can fail for want of balance — which is
   * exactly how a real gateway behaves when you've already withdrawn.
   */
  /** Shared by the REST API and the in-app button. */
  function doRefund(merchant, order, body, baseUrl) {
    if (order.status !== 'paid' && order.status !== 'refunded')
      return { error: 'Only a paid order can be refunded.' };

    const remaining = order.amount_p - order.refunded_p;
    if (remaining <= 0) return { error: 'This order is already fully refunded.' };

    // No amount means refund whatever is left.
    let amountP = remaining;
    if (body.amount !== undefined) {
      const rupees = Number(body.amount);
      if (!Number.isFinite(rupees) || rupees <= 0) return { error: 'amount must be a positive number.' };
      amountP = paise(rupees);
      if (amountP > remaining) return { error: `Only ${inr(remaining)} is left to refund.` };
    }

    const owner = findUserById.get(merchant.owner_id);
    if (!owner || owner.balance_p < amountP)
      return { error: 'Not enough balance in the business wallet to refund this.' };

    const refundId = 'rfnd_' + crypto.randomBytes(8).toString('hex');
    const reason = String(body.reason || '').slice(0, 140) || null;

    db.transaction(() => {
      db.prepare('UPDATE users SET balance_p = balance_p - ? WHERE id = ?').run(amountP, owner.id);
      addTx.run({
        user_id: owner.id,
        kind: 'send',
        direction: 'debit',
        amount_p: amountP,
        points: 0,
        title: `Refund · ${merchant.name}`,
        detail: [order.description, reason, order.id].filter(Boolean).join(' · '),
        reference: reference()
      });

      // If they paid from an LSP-Pay wallet, put it back where it came from.
      if (order.method === 'wallet' && order.payer_note) {
        const payer = db.prepare('SELECT * FROM users WHERE email = ?').get(order.payer_note);
        if (payer) {
          db.prepare('UPDATE users SET balance_p = balance_p + ? WHERE id = ?').run(amountP, payer.id);
          addTx.run({
            user_id: payer.id,
            kind: 'receive',
            direction: 'credit',
            amount_p: amountP,
            points: 0,
            title: `Refund from ${merchant.name}`,
            detail: reason || order.description,
            reference: reference()
          });
        }
      }

      db.prepare('INSERT INTO refunds (id, order_id, merchant_id, amount_p, reason) VALUES (?, ?, ?, ?, ?)')
        .run(refundId, order.id, merchant.id, amountP, reason);

      const total = order.refunded_p + amountP;
      db.prepare('UPDATE orders SET refunded_p = ?, status = ? WHERE id = ?')
        .run(total, total >= order.amount_p ? 'refunded' : 'paid', order.id);
    })();

    const updated = orderById.get(order.id);
    queueWebhook(merchant, 'order.refunded', updated, baseUrl);

    if (order.customer_email) {
      mail
        .sendRefundNotice(order.customer_email, {
          merchant: merchant.name,
          amountLabel: inr(amountP),
          orderId: order.id,
          reason
        })
        .catch((e) => console.error('[mail] refund notice failed:', e.message));
    }

    return {
      id: refundId,
      orderId: order.id,
      amountLabel: inr(amountP),
      refundedTotalLabel: inr(updated.refunded_p),
      status: updated.status,
      reason
    };
  }

  app.post('/api/v1/orders/:id/refund', apiLimiter, apiAuth, (req, res) => {
    const order = orderById.get(req.params.id);
    if (!order || order.merchant_id !== req.merchant.id) return fail(res, 404, 'No such order.');
    const out = doRefund(req.merchant, order, req.body, baseUrlOf(req));
    if (out.error) return fail(res, 400, out.error);
    res.json(out);
  });

  app.post('/api/merchants/refund', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.body.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');
    const order = orderById.get(String(req.body.orderId));
    if (!order || order.merchant_id !== merchant.id) return fail(res, 404, 'No such order.');
    const out = doRefund(merchant, order, req.body, baseUrlOf(req));
    if (out.error) return fail(res, 400, out.error);
    res.json(out);
  });

  /** Session-authenticated summary, so the app needs no API key. */
  app.get('/api/merchants/summary', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.query.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');
    const q = (sql) => db.prepare(sql).get(merchant.id);
    const paid = q("SELECT COALESCE(SUM(amount_p),0) t, COUNT(*) n FROM orders WHERE merchant_id = ? AND status IN ('paid','refunded')");
    const ref = q('SELECT COALESCE(SUM(amount_p),0) t, COUNT(*) n FROM refunds WHERE merchant_id = ?');
    const pend = q("SELECT COALESCE(SUM(amount_p),0) t, COUNT(*) n FROM orders WHERE merchant_id = ? AND status = 'created'");
    res.json({
      collectedLabel: inr(paid.t), paidCount: paid.n,
      refundedLabel: inr(ref.t), refundCount: ref.n,
      netLabel: inr(paid.t - ref.t),
      pendingLabel: inr(pend.t), pendingCount: pend.n
    });
  });

  app.get('/api/v1/orders/:id/refunds', apiLimiter, apiAuth, (req, res) => {
    const order = orderById.get(req.params.id);
    if (!order || order.merchant_id !== req.merchant.id) return fail(res, 404, 'No such order.');

    const rows = db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY rowid').all(order.id);
    res.json({
      refunds: rows.map((r) => ({ id: r.id, amountLabel: inr(r.amount_p), reason: r.reason, createdAt: r.created_at }))
    });
  });

  /* ----------------------------------------------- reusable payment links */

  const publicLink = (l, baseUrl) => ({
    id: l.id,
    title: l.title,
    description: l.description,
    amount: l.amount_p === null ? null : l.amount_p / 100,
    amountLabel: l.amount_p === null ? 'Payer chooses' : inr(l.amount_p),
    usageLimit: l.usage_limit,
    usedCount: l.used_count,
    active: !!l.active,
    url: `${baseUrl}/l/${l.id}`,
    expiresAt: l.expires_at ? new Date(l.expires_at).toISOString() : null,
    createdAt: l.created_at
  });

  /** A link you can share over and over — no API call per customer. */
  function createLink(merchantId, body) {
    const title = String(body.title || '').trim().slice(0, 80);
    if (title.length < 2) return { error: 'Give the link a title.' };

    let amountP = null;
    if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
      const rupees = Number(body.amount);
      if (!Number.isFinite(rupees) || rupees <= 0 || rupees > 200000)
        return { error: 'amount must be between 1 and 200000, or left out to let the payer choose.' };
      amountP = paise(rupees);
    }

    const id = 'plink_' + crypto.randomBytes(7).toString('hex');
    db.prepare(
      `INSERT INTO payment_links (id, merchant_id, title, description, amount_p, usage_limit, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      merchantId,
      title,
      String(body.description || '').slice(0, 200) || null,
      amountP,
      Number(body.usageLimit) > 0 ? Math.floor(Number(body.usageLimit)) : null,
      Number(body.expiresInDays) > 0 ? Date.now() + Math.floor(Number(body.expiresInDays)) * 86400000 : null
    );

    return { link: db.prepare('SELECT * FROM payment_links WHERE id = ?').get(id) };
  }

  app.post('/api/v1/links', apiLimiter, apiAuth, (req, res) => {
    const out = createLink(req.merchant.id, req.body);
    if (out.error) return fail(res, 400, out.error);
    res.status(201).json(publicLink(out.link, baseUrlOf(req)));
  });

  app.get('/api/v1/links', apiLimiter, apiAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM payment_links WHERE merchant_id = ? ORDER BY rowid DESC LIMIT 50').all(req.merchant.id);
    res.json({ links: rows.map((l) => publicLink(l, baseUrlOf(req))) });
  });

  app.post('/api/v1/links/:id/deactivate', apiLimiter, apiAuth, (req, res) => {
    const link = db.prepare('SELECT * FROM payment_links WHERE id = ? AND merchant_id = ?').get(req.params.id, req.merchant.id);
    if (!link) return fail(res, 404, 'No such link.');
    db.prepare('UPDATE payment_links SET active = 0 WHERE id = ?').run(link.id);
    res.json({ ok: true, id: link.id, active: false });
  });

  // In-app versions, session-authenticated, so no key is needed.
  app.post('/api/merchants/links', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.body.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');
    const out = createLink(merchant.id, req.body);
    if (out.error) return fail(res, 400, out.error);
    res.json(publicLink(out.link, baseUrlOf(req)));
  });

  app.get('/api/merchants/links', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.query.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');
    const rows = db.prepare('SELECT * FROM payment_links WHERE merchant_id = ? ORDER BY rowid DESC LIMIT 50').all(merchant.id);
    res.json({ links: rows.map((l) => publicLink(l, baseUrlOf(req))) });
  });

  /** Turns a shared link into a fresh one-shot order, then redirects. */
  app.get('/l/:id', (req, res) => {
    const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(req.params.id);
    if (!link) return res.status(404).sendFile(path.join(__dirname, '..', 'public', 'link-closed.html'));

    const dead =
      !link.active ||
      (link.expires_at && Date.now() > link.expires_at) ||
      (link.usage_limit !== null && link.used_count >= link.usage_limit);
    if (dead) return res.status(410).sendFile(path.join(__dirname, '..', 'public', 'link-closed.html'));

    // An open-amount link needs the payer to name a figure first.
    const asked = Number(req.query.amount);
    let amountP = link.amount_p;
    if (amountP === null) {
      if (!Number.isFinite(asked) || asked <= 0)
        return res.sendFile(path.join(__dirname, '..', 'public', 'link-amount.html'));
      amountP = paise(asked);
      if (amountP < link.min_p || amountP > link.max_p)
        return res.sendFile(path.join(__dirname, '..', 'public', 'link-amount.html'));
    }

    const id = orderId();
    db.prepare(
      `INSERT INTO orders (id, merchant_id, amount_p, description, reference, expires_at, link_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, link.merchant_id, amountP, link.title, link.id, Date.now() + ORDER_TTL_MS, link.id);

    db.prepare('UPDATE payment_links SET used_count = used_count + 1 WHERE id = ?').run(link.id);
    res.redirect(`/pay/${id}`);
  });

  app.get('/api/links/:id', (req, res) => {
    const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(req.params.id);
    if (!link) return fail(res, 404, 'No such link.');
    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(link.merchant_id);
    res.json({
      title: link.title,
      description: link.description,
      open: link.amount_p === null,
      min: link.min_p / 100,
      max: link.max_p / 100,
      merchant: { name: merchant.name, logoUrl: merchant.logo_url, theme: merchant.theme }
    });
  });

  /* --------------------------------------------------- settlement report */

  app.get('/api/v1/summary', apiLimiter, apiAuth, (req, res) => {
    const q = (sql, ...args) => db.prepare(sql).get(req.merchant.id, ...args);

    const paid = q("SELECT COALESCE(SUM(amount_p),0) t, COUNT(*) n FROM orders WHERE merchant_id = ? AND status IN ('paid','refunded')");
    const refunded = q('SELECT COALESCE(SUM(amount_p),0) t, COUNT(*) n FROM refunds WHERE merchant_id = ?');
    const pending = q("SELECT COALESCE(SUM(amount_p),0) t, COUNT(*) n FROM orders WHERE merchant_id = ? AND status = 'created'");
    const cash = q("SELECT COALESCE(SUM(amount_p),0) t, COUNT(*) n FROM orders WHERE merchant_id = ? AND status = 'awaiting_cash'");

    const byMethod = db
      .prepare("SELECT method, COUNT(*) n, SUM(amount_p) t FROM orders WHERE merchant_id = ? AND status IN ('paid','refunded') GROUP BY method")
      .all(req.merchant.id);

    res.json({
      collected: { label: inr(paid.t), count: paid.n },
      refunded: { label: inr(refunded.t), count: refunded.n },
      net: { label: inr(paid.t - refunded.t) },
      pending: { label: inr(pending.t), count: pending.n },
      awaitingCash: { label: inr(cash.t), count: cash.n },
      byMethod: byMethod.map((r) => ({ method: r.method || 'unknown', count: r.n, label: inr(r.t) }))
    });
  });

  /** CSV of every order, for your accountant. */
  app.get('/api/v1/orders.csv', apiLimiter, apiAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM orders WHERE merchant_id = ? ORDER BY rowid DESC LIMIT 5000').all(req.merchant.id);
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csv = [
      'order_id,created_at,paid_at,status,amount_inr,refunded_inr,method,description,reference,customer_email,auth_code',
      ...rows.map((o) =>
        [
          o.id, o.created_at, o.paid_at, o.status,
          (o.amount_p / 100).toFixed(2), (o.refunded_p / 100).toFixed(2),
          o.method, o.description, o.reference, o.customer_email, o.auth_code
        ].map(cell).join(',')
      )
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="lsp-orders-${Date.now()}.csv"`);
    res.send(csv);
  });

  /** A QR of a payment link, for a counter, a poster or an invoice. */
  app.get('/l/:id/qr.svg', async (req, res) => {
    const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(req.params.id);
    if (!link) return fail(res, 404, 'No such link.');

    try {
      const svg = await QRCode.toString(`${baseUrlOf(req)}/l/${link.id}`, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#FFFFFF' }
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(svg);
    } catch (err) {
      fail(res, 500, 'Could not draw the QR code.');
    }
  });

  /** Who has paid this business, and how much, most valuable first. */
  app.get('/api/merchants/customers', auth, (req, res) => {
    const merchant = findMerchant.get(Number(req.query.merchantId), req.user.id);
    if (!merchant) return fail(res, 404, 'No such gateway on your account.');

    const rows = db
      .prepare(
        `SELECT COALESCE(customer_email, payer_note) who,
                COUNT(*) n, SUM(amount_p) t, MAX(paid_at) last_at
         FROM orders
         WHERE merchant_id = ? AND status IN ('paid','refunded')
           AND COALESCE(customer_email, payer_note) IS NOT NULL
         GROUP BY who ORDER BY t DESC LIMIT 50`
      )
      .all(merchant.id);

    res.json({
      customers: rows.map((r) => ({
        who: r.who,
        orders: r.n,
        totalLabel: inr(r.t),
        lastAt: r.last_at
      }))
    });
  });

  app.get('/api/checkout/banks', (req, res) => res.json({ banks: BANKS }));
};
