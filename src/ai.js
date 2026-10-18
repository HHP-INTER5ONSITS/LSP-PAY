'use strict';

/**
 * Ask LSP-Pay — an assistant inside the wallet.
 *
 * Gemini by default; Anthropic or OpenAI are used instead if their key is
 * the one present. Whichever it is, the key lives in a server environment
 * variable and the call is made from here. The browser never sees it: a key
 * shipped to a page is a key anyone can lift and spend.
 *
 * The assistant is deliberately read-only. It is given a summary of the
 * signed-in person's own wallet so it can answer "what did I spend on?",
 * but there is no path from a reply to a payment: no tool calling, no
 * function results, nothing that writes. A chatbot that can move money is a
 * chatbot that can be talked into moving money.
 */

const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    env: 'GEMINI_API_KEY',
    defaultModel: 'gemini-flash-latest',
    modelEnv: 'GEMINI_MODEL',

    async ask({ key, model, system, history, message }) {
      // The key goes in a header, not the query string. Google's newer
      // AQ. authentication keys reject ?key=, and a key in a URL ends up
      // in logs and referrers. The header works for both key types.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [
            ...history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })),
            { role: 'user', parts: [{ text: message }] }
          ],
          generationConfig: { temperature: 0.6, maxOutputTokens: 700 }
        })
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = body?.error?.message || `HTTP ${res.status}`;

        // Tag the two conditions worth recovering from rather than reporting.
        const err = new Error('');
        if (res.status === 404) err.kind = 'model';
        else if (res.status === 503 || res.status === 429 || /overload|high demand|try again/i.test(detail)) err.kind = 'busy';

        err.message = 
          res.status === 404
            ? `Gemini does not know the model "${model}". Set GEMINI_MODEL to one your key can use.`
            : res.status === 400 && /API key/i.test(detail) ? 'That Gemini API key was rejected.'
            : res.status === 401 ? `Gemini rejected the key: ${detail}. If it begins "AQ.", check it was copied whole.`
            : res.status === 403 ? `Gemini refused the key: ${detail}. A new key can take a minute, and some need the Generative Language API enabled on its Cloud project.`
            : res.status === 429 ? 'Gemini is rate limiting this key. Try again shortly.'
            : `Gemini said: ${detail}`;
        throw err;
      }

      const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('');
      if (!text) {
        const why = body?.promptFeedback?.blockReason || body?.candidates?.[0]?.finishReason;
        throw new Error(why ? `Gemini returned nothing (${why}).` : 'Gemini returned an empty reply.');
      }
      return text.trim();
    }
  },

  anthropic: {
    label: 'Claude',
    env: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
    modelEnv: 'ANTHROPIC_MODEL',

    async ask({ key, model, system, history, message }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          system,
          messages: [...history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: message }]
        })
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Claude said: ${body?.error?.message || 'HTTP ' + res.status}`);

      const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (!text) throw new Error('Claude returned an empty reply.');
      return text.trim();
    }
  },

  openai: {
    label: 'ChatGPT',
    env: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    modelEnv: 'OPENAI_MODEL',

    async ask({ key, model, system, history, message }) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          messages: [
            { role: 'system', content: system },
            ...history.map((h) => ({ role: h.role, content: h.text })),
            { role: 'user', content: message }
          ]
        })
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`ChatGPT said: ${body?.error?.message || 'HTTP ' + res.status}`);

      const text = body?.choices?.[0]?.message?.content;
      if (!text) throw new Error('ChatGPT returned an empty reply.');
      return text.trim();
    }
  }
};

/** Gemini first, as the one this app is set up for. */
function active() {
  for (const name of ['gemini', 'anthropic', 'openai']) {
    const p = PROVIDERS[name];
    if (process.env[p.env]) {
      return { name, ...p, key: process.env[p.env], model: process.env[p.modelEnv] || p.defaultModel };
    }
  }
  return null;
}


/**
 * Asks a Gemini model, recovering from the two things that go wrong on
 * their own: the configured model no longer existing, and the model being
 * temporarily full. Both used to surface as a dead end the operator had to
 * fix by hand.
 *
 * Model names change often enough that a hardcoded default is a losing bet,
 * so on a 404 we ask the key what it can actually use and prefer a Flash
 * model — fast and cheap, which is what short wallet questions want.
 */
const FALLBACK_ORDER = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
let discovered = null;   // cached per process, so we ask Google once

async function listGeminiModels(key) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': key }
  });
  if (!r.ok) return [];
  const b = await r.json().catch(() => ({}));
  return (b.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
}

/** Flash first, previews and specialised variants last. */
function rankModels(names) {
  const bad = /tts|image|audio|video|embed|robotics|computer-use|deep-research|lyria|banana|transcribe|omni/i;
  return names
    .filter((n) => !bad.test(n))
    .sort((a, b) => {
      const score = (n) =>
        (/flash/i.test(n) ? 0 : 10) +
        (/lite/i.test(n) ? 1 : 0) +
        (/preview|exp/i.test(n) ? 5 : 0) +
        (/latest/i.test(n) ? -1 : 0);
      return score(a) - score(b);
    });
}

async function askWithRecovery(provider, args) {
  if (provider.name !== 'gemini') return provider.ask({ ...args, key: provider.key, model: provider.model });

  const tried = new Set();
  const queue = [provider.model, ...FALLBACK_ORDER.filter((m) => m !== provider.model)];

  for (let i = 0; i < queue.length + 4; i++) {
    const model = queue.find((m) => m && !tried.has(m));
    if (!model) break;
    tried.add(model);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const text = await provider.ask({ ...args, key: provider.key, model });
        if (model !== provider.model) console.log(`[ai] fell back to ${model}`);
        return text;
      } catch (err) {
        if (err.kind === 'busy' && attempt < 2) {
          // Short, increasing pause. A spike is usually over in a moment.
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }
        if (err.kind === 'busy') break;          // that model is full; try the next
        if (err.kind === 'model') {
          // Ask the key what it really has, once, then queue the best of them.
          if (!discovered) discovered = rankModels(await listGeminiModels(provider.key));
          discovered.forEach((m) => { if (!queue.includes(m)) queue.push(m); });
          break;
        }
        throw err;                                // a key or safety problem: say so
      }
    }
  }

  const err = new Error('Gemini is busy on every model this key can use. Try again in a minute.');
  err.kind = 'busy';
  throw err;
}

module.exports = function mountAI(app, deps) {
  const { db, auth, fail, inr, findUserById, rateLimit } = deps;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      role       TEXT NOT NULL,              -- user | assistant
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_user ON ai_messages(user_id, id);
  `);

  /**
   * A read-only picture of this person's own wallet, so the assistant can
   * answer real questions instead of guessing. Only ever their own rows.
   */
  function context(user) {
    const month = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_p END),0) out_p,
              COALESCE(SUM(CASE WHEN direction='credit' THEN amount_p END),0) in_p
       FROM transactions WHERE user_id = ? AND created_at >= date('now','start of month')`
    ).get(user.id);

    const byKind = db.prepare(
      `SELECT kind, COUNT(*) n, SUM(amount_p) t FROM transactions
       WHERE user_id = ? AND direction='debit' AND created_at >= date('now','start of month')
       GROUP BY kind ORDER BY t DESC LIMIT 8`
    ).all(user.id);

    const recent = db.prepare(
      'SELECT title, direction, amount_p, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 10'
    ).all(user.id);

    return [
      `Their name: ${user.display_name || user.handle}`,
      `Balance: ${inr(user.balance_p)}`,
      `Points: ${user.points}`,
      `Daily limit: ${user.daily_limit_p ? inr(user.daily_limit_p) : 'none set'}`,
      `This month — out ${inr(month.out_p)}, in ${inr(month.in_p)}`,
      byKind.length ? `Spending by category this month: ${byKind.map((k) => `${k.kind} ${inr(k.t)} (${k.n})`).join(', ')}` : 'No spending yet this month.',
      recent.length
        ? `Last ${recent.length} entries:\n${recent.map((t) => `  ${t.created_at} ${t.direction === 'debit' ? '-' : '+'}${inr(t.amount_p)} ${t.title}`).join('\n')}`
        : 'No transactions yet.'
    ].join('\n');
  }

  const SYSTEM = (user) => `You are the assistant inside LSP-Pay, a rupee wallet and payments app.

Be brief and plain. Two or three sentences usually does it; use a short list only when the answer really is a list. Write amounts in rupees like ₹1,250.00. Never open with "Certainly" or "Great question".

You can answer anything the person asks — general knowledge, a calculation, a recipe — not only app questions. When it is about LSP-Pay, here is what the app does:
- Pay anyone with an LSP-Pay account by email; mobile and FASTag recharges; discounted gift cards; request money; split a bill; scheduled and recurring payments; bank withdrawals; saved debit cards; 5 points per ₹100 spent.
- A business gateway for taking payments on your own website, with refunds, payment links, QR codes, coupons and webhooks.
- LSP OAuth, so other sites can offer "Sign in with LSP-Pay".
- The payment PIN starts at 00000 and is changed under Your account.

Important and non-negotiable:
- You cannot move money, change settings, or act on the account. You can only talk. If asked to send a payment, say plainly that you cannot and tell them which screen does it.
- Never claim a payment or change has happened.
- Never ask for their PIN, a one-time code, a card number or an API secret, and tell them not to paste those anywhere, including to you.
- This is a demo app: no real money moves and no bank is involved. Say so if the difference matters to the answer.

Here is their current wallet, as of now. Use it when relevant and do not invent figures beyond it:
${context(user)}`;

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'You have asked a lot this hour. Try again later.' }
  });

  app.get('/api/ai/status', auth, (req, res) => {
    const p = active();
    res.json({
      ready: Boolean(p),
      provider: p ? p.label : null,
      model: p ? p.model : null,
      note: p ? null : 'No AI key is set on this server. Add GEMINI_API_KEY in Render and redeploy.'
    });
  });

  app.get('/api/ai/history', auth, (req, res) => {
    const rows = db.prepare(
      'SELECT role, text, created_at FROM ai_messages WHERE user_id = ? ORDER BY id DESC LIMIT 40'
    ).all(req.user.id).reverse();
    res.json({ messages: rows.map((r) => ({ role: r.role, text: r.text, at: r.created_at })) });
  });

  app.post('/api/ai/clear', auth, (req, res) => {
    db.prepare('DELETE FROM ai_messages WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  });

  /** Lists the models this key can use. Gemini only; the others are fixed. */
  app.get('/api/ai/models', auth, async (req, res) => {
    const p = active();
    if (!p) return fail(res, 503, 'No AI key is set on this server.');
    if (p.name !== 'gemini') return res.json({ provider: p.label, models: [p.model] });

    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': p.key }
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) return fail(res, 502, b?.error?.message || `HTTP ${r.status}`);

      const models = (b.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
      res.json({ provider: p.label, current: p.model, models });
    } catch (err) {
      fail(res, 502, err.message);
    }
  });

  app.post('/api/ai/chat', auth, limiter, async (req, res) => {
    const provider = active();
    if (!provider)
      return fail(res, 503, 'No AI key is set on this server. Add GEMINI_API_KEY in Render and redeploy.');

    const message = String(req.body.message || '').trim();
    if (!message) return fail(res, 400, 'Type a question first.');
    if (message.length > 2000) return fail(res, 400, 'Keep it under 2000 characters.');

    // Last few turns only: enough to follow a thread, not enough to grow
    // the request without bound.
    const history = db.prepare(
      'SELECT role, text FROM ai_messages WHERE user_id = ? ORDER BY id DESC LIMIT 10'
    ).all(req.user.id).reverse();

    const user = findUserById.get(req.user.id);

    let reply;
    try {
      reply = await askWithRecovery(provider, { system: SYSTEM(user), history, message });
    } catch (err) {
      console.error('[ai]', provider.name, err.message);
      return fail(res, 502, err.message);
    }

    db.transaction(() => {
      const ins = db.prepare('INSERT INTO ai_messages (user_id, role, text) VALUES (?, ?, ?)');
      ins.run(req.user.id, 'user', message);
      ins.run(req.user.id, 'assistant', reply);
    })();

    res.json({ reply, provider: provider.label });
  });
};
