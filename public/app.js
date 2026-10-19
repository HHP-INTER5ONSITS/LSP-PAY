'use strict';

/* ───────────────────────────────── plumbing ───────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);

let user = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

let toastTimer;
function toast(text, bad = false) {
  const t = el('toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ─────────────────────────────── sheet stack ──────────────────────────── */

function openSheet(title, html, onMount) {
  el('sheet-title').textContent = title;
  el('sheet-body').innerHTML = html;
  el('scrim').hidden = false;
  el('sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  if (onMount) onMount(el('sheet-body'));
  const first = $('input, select, button', el('sheet-body'));
  if (first && first.tagName !== 'BUTTON') first.focus();
}

function closeSheet() {
  el('sheet').hidden = true;
  el('scrim').hidden = true;
  el('sheet-body').innerHTML = '';
  document.body.style.overflow = '';
}

el('sheet-close').addEventListener('click', closeSheet);
el('scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('sheet').hidden) closeSheet();
});

/* ───────────────────── Cloudflare Turnstile, if configured ───────────── */

let shieldConfig = null;
let turnstileWidget = null;
let turnstilePending = null;   // resolves with a token when Cloudflare finishes

/**
 * Turnstile solves asynchronously after the widget renders. Reading
 * getResponse() at the moment someone presses the button returns nothing if
 * they were quick, which is most people — so the token is captured from the
 * callback and awaited instead.
 */
function freshTurnstilePromise() {
  turnstilePending = {};
  turnstilePending.promise = new Promise((resolve) => { turnstilePending.resolve = resolve; });
  return turnstilePending.promise;
}

async function setUpTurnstile() {
  try { shieldConfig = await api('/api/shield/config'); } catch { return; }
  if (!shieldConfig.turnstileSiteKey) return;   // not configured: nothing to do

  const host = el('turnstile-slot');
  if (!host) {
    // The slot ships in index.html alongside this file. Missing it almost
    // always means a stale cached page, which is worth saying out loud.
    console.warn('[turnstile] no #turnstile-slot in the page — the HTML may be a cached older version');
    authMessage('The page is out of date. Reload with Cmd+Shift+R (or Ctrl+F5) to pick up the latest version.');
    return;
  }

  // The script's own load event fires before window.turnstile exists, so
  // waiting on it and then checking for the object silently does nothing.
  // Cloudflare's documented signal is an onload callback named in the URL.
  const ready = new Promise((resolve) => {
    window.__lspTurnstileReady = () => resolve(true);

    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__lspTurnstileReady';
    s.async = true; s.defer = true;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);

    // Belt and braces: some blockers load the file but never fire the
    // callback, so poll for the object too.
    let waited = 0;
    const poll = setInterval(() => {
      if (window.turnstile) { clearInterval(poll); resolve(true); }
      else if ((waited += 200) > 8000) { clearInterval(poll); resolve(false); }
    }, 200);
  });

  const ok = await ready;
  if (!ok || !window.turnstile) {
    // Say so rather than failing mutely: the server will refuse the sign-in
    // and the person deserves to know it is the check, not their email.
    console.warn('[turnstile] could not load — challenges.cloudflare.com may be blocked');
    authMessage('The security check could not load. Something may be blocking challenges.cloudflare.com — try another browser or network.');
    return;
  }

  freshTurnstilePromise();
  try {
    turnstileWidget = window.turnstile.render(host, {
      sitekey: shieldConfig.turnstileSiteKey,
      theme: 'auto',
      // 'always' so the widget is visible and people can see the check
      // happening. Cloudflare still decides how hard it is: most visitors
      // get a tick that completes itself, only doubtful ones are asked to
      // do anything. 'interaction-only' hides it entirely, which is tidier
      // but leaves no way to tell working from broken.
      appearance: 'always',
      callback: (token) => turnstilePending?.resolve(token),
      'error-callback': () => turnstilePending?.resolve(''),
      'expired-callback': () => { freshTurnstilePromise(); resetTurnstile(); }
    });
  } catch (err) {
    console.warn('[turnstile] render failed:', err?.message || err);
    authMessage('The security check could not start. Reload the page, or tell the site owner the Turnstile hostname may not match.');
  }
}

/**
 * The token, waiting for it if Cloudflare is still working. Returns '' when
 * Turnstile is switched off, failed to load, or took too long — the server
 * decides what to do about that, since only it knows whether Turnstile is
 * required at all.
 */
async function turnstileToken(waitMs = 12000) {
  if (!turnstileWidget || !window.turnstile) return '';

  // Already solved?
  try {
    const have = window.turnstile.getResponse(turnstileWidget);
    if (have) return have;
  } catch { /* widget not ready */ }

  const timeout = new Promise((r) => setTimeout(() => r(''), waitMs));
  const token = await Promise.race([turnstilePending?.promise ?? Promise.resolve(''), timeout]);

  // Nothing came back in time, so stop hiding the widget and let the person
  // finish it themselves rather than leaving them stuck on a silent failure.
  if (!token && window.turnstile) {
    try {
      window.turnstile.remove(turnstileWidget);
      freshTurnstilePromise();
      turnstileWidget = window.turnstile.render(el('turnstile-slot'), {
        sitekey: shieldConfig.turnstileSiteKey,
        theme: 'auto',
        appearance: 'always',
        callback: (t) => turnstilePending?.resolve(t)
      });
    } catch { /* leave it as it was */ }
  }
  return token;
}

function resetTurnstile() {
  if (turnstileWidget && window.turnstile) {
    try { window.turnstile.reset(turnstileWidget); freshTurnstilePromise(); }
    catch { /* ignore */ }
  }
}

/* ───────────────────────── the security check ────────────────────────── */

/**
 * Finds a nonce whose SHA-256 starts with the required zeros. A person waits
 * a fraction of a second; a bot pays that for every attempt it makes, which
 * is the whole point.
 */
async function solveChallenge() {
  const c = await api('/api/shield/challenge');
  const enc = new TextEncoder();

  // Hashing in batches rather than one await at a time: the per-call promise
  // overhead dominates otherwise, and made the harder levels take seconds
  // instead of milliseconds.
  const BATCH = 1024;
  for (let n = 0; n < 20_000_000; n += BATCH) {
    const digests = await Promise.all(
      Array.from({ length: BATCH }, (_, i) =>
        crypto.subtle.digest('SHA-256', enc.encode(`${c.challenge}:${n + i}`)))
    );
    for (let i = 0; i < digests.length; i++) {
      if ((new DataView(digests[i]).getUint32(0) >>> 8) <= c.ceiling)
        return { shieldToken: c.token, shieldSolution: String(n + i) };
    }
  }
  throw new Error('Could not complete the security check.');
}

/* ──────────────────────────────── sign in ─────────────────────────────── */

function authMessage(text, good = false) {
  const box = el('auth-msg');
  if (!text) { box.hidden = true; return; }
  box.textContent = text;
  box.classList.toggle('good', good);
  box.hidden = false;
}

async function requestLoginCode() {
  const email = el('auth-email').value.trim();
  const btn = el('auth-send');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = 'Checking…';
    const proof = await solveChallenge();

    btn.textContent = 'Checking…';
    const tsToken = await turnstileToken();

    btn.textContent = 'Sending…';
    const out = await api('/api/auth/request-code', {
      email,
      website: el('hp')?.value || '',   // honeypot: must stay empty
      turnstileToken: tsToken,
      ...proof
    });
    el('auth-target').textContent = out.email;
    el('auth-step-email').hidden = true;
    el('auth-step-code').hidden = false;
    el('auth-code').value = '';
    el('auth-code').focus();
    authMessage(out.devCode ? `Development mode: your code is ${out.devCode}` : out.note, !out.note);
  } catch (err) {
    authMessage(err.message);
    resetTurnstile();   // a token is single use; a retry needs a fresh one
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

el('auth-send').addEventListener('click', requestLoginCode);
el('auth-resend').addEventListener('click', requestLoginCode);
el('auth-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') requestLoginCode(); });

el('auth-back').addEventListener('click', () => {
  el('auth-step-code').hidden = true;
  el('auth-step-email').hidden = false;
  authMessage('');
});

async function verifyLoginCode() {
  const btn = el('auth-verify');
  btn.disabled = true;
  try {
    const out = await api('/api/auth/verify', {
      email: el('auth-target').textContent,
      code: el('auth-code').value.trim()
    });
    user = out.user;
    showWallet();
  } catch (err) {
    authMessage(err.message);
  } finally {
    btn.disabled = false;
  }
}

el('auth-verify').addEventListener('click', verifyLoginCode);
el('auth-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyLoginCode(); });

/* ──────────────────────────── oauth sign-in ───────────────────────────── */

const OAUTH_MARKS = {
  github: '<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  google: '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>'
};

async function setUpOAuth() {
  // The server only offers a provider it has credentials for, so a
  // half-configured deploy shows a working button rather than a dead one.
  let providers = [];
  try { providers = (await api('/api/auth/providers')).providers; } catch { return; }
  if (!providers.length) return;

  el('oauth-buttons').innerHTML = providers.map((p) => `
    <button class="oauth-btn" data-go="${escapeHtml(p.name)}">
      ${OAUTH_MARKS[p.name] || ''}Continue with ${escapeHtml(p.label)}
    </button>`).join('');

  document.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => { location.href = `/auth/${b.dataset.go}`; }));

  el('oauth-block').hidden = false;
  el('email-title').textContent = 'Or use an email code';
}

// A failed round trip comes back as ?oauth_error=… — show it and tidy the URL.
(function showOAuthError() {
  const err = new URLSearchParams(location.search).get('oauth_error');
  if (!err) return;
  history.replaceState({}, '', location.pathname);
  setTimeout(() => authMessage(err), 60);
})();

/* ──────────────────────────────── wallet ──────────────────────────────── */

function paintUser() {
  el('balance-amount').textContent = Number(user.balance).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  el('user-handle').textContent = user.name || user.email;
  el('points-chip').textContent = `${user.points.toLocaleString('en-IN')} points`;
}

let allTx = [];

function paintHistory() {
  const list = el('tx-list');
  const q = (el('tx-search')?.value || '').toLowerCase();
  const kind = el('tx-filter')?.value || '';

  const rows = allTx.filter((t) => {
    if (kind === 'in' && t.direction !== 'credit') return false;
    if (kind === 'out' && t.direction !== 'debit') return false;
    if (kind && kind !== 'in' && kind !== 'out' && t.kind !== kind) return false;
    if (!q) return true;
    return [t.title, t.detail, t.reference, t.amountLabel].join(' ').toLowerCase().includes(q);
  });

  if (!rows.length) {
    list.innerHTML = `<p class="empty">${allTx.length ? 'Nothing matches that.' : 'Nothing yet. Your payments, recharges and gift cards will show up here.'}</p>`;
    return;
  }

  list.innerHTML = rows.map((t) => {
    const when = new Date(t.createdAt.replace(' ', 'T') + 'Z').toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
    });
    const bits = [when, t.detail, t.points ? `+${t.points} points` : null].filter(Boolean);
    return `<div class="tx">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(t.title)}</div>
        <div class="tx-sub">${escapeHtml(bits.join(' · '))}</div>
      </div>
      <div class="tx-amt ${t.direction === 'credit' ? 'credit' : ''}">${escapeHtml(t.amountLabel)}</div>
    </div>`;
  }).join('');
}

async function loadHistory() {
  const list = el('tx-list');
  try {
    const { transactions } = await api('/api/transactions');
    allTx = transactions;
    paintHistory();
    return;
  } catch (err) {
    list.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function showWallet() {
  // Someone sent here mid-authorisation goes straight back to it.
  try {
    const back = sessionStorage.getItem('lsp-after-auth');
    if (back) { sessionStorage.removeItem('lsp-after-auth'); location.href = back; return; }
  } catch { /* private mode */ }

  el('screen-auth').hidden = true;
  el('screen-app').hidden = false;
  paintUser();
  loadHistory();
  refreshBell();
  if (user.pinIsDefault) {
    setTimeout(() => toast('Your PIN is still 00000. Change it under Your account.'), 900);
  }
}

/* ────────────────────────────── the PIN pad ───────────────────────────── */

/**
 * Shows the confirm screen with a keypad, then calls submit(pin).
 * `submit` should return the server response; this handles errors and success.
 */
async function confirmWithPin({ amountLabel, to, actionLabel = 'Pay', submit, onDone }) {
  let pin = '';

  let saved = [];
  try { saved = (await api('/api/cards')).cards; } catch { /* wallet only */ }

  const sourcePicker = saved.length
    ? `<label class="field"><span>Pay using</span>
        <select id="source">
          <option value="">Wallet · ${escapeHtml(user.balanceLabel)}</option>
          ${saved.map((c) => `<option value="${c.id}"${c.isDefault ? '' : ''}>${escapeHtml(c.display)}</option>`).join('')}
        </select></label>`
    : '';

  const html = `
    <div class="summary">
      <div class="summary-amt">${escapeHtml(amountLabel)}</div>
      <div class="summary-to">${escapeHtml(to)}</div>
    </div>
    ${sourcePicker}
    <p class="sheet-note">Enter your 5-digit payment PIN.</p>
    <div class="pin-dots">${'<span class="pin-dot"></span>'.repeat(5)}</div>
    <div class="keypad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button class="key" data-k="${n}">${n}</button>`).join('')}
      <button class="key wide" data-k="clear">Clear</button>
      <button class="key" data-k="0">0</button>
      <button class="key wide" data-k="del">Delete</button>
    </div>
    <button id="pin-go" class="btn-primary" disabled>${escapeHtml(actionLabel)}</button>
    <p id="pin-msg" class="msg" hidden></p>`;

  openSheet('Confirm payment', html, (root) => {
    const dots = root.querySelectorAll('.pin-dot');
    const go = $('#pin-go', root);
    const msg = $('#pin-msg', root);

    const paint = () => {
      dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
      go.disabled = pin.length !== 5;
    };

    root.querySelectorAll('.key').forEach((key) =>
      key.addEventListener('click', () => {
        const k = key.dataset.k;
        if (k === 'clear') pin = '';
        else if (k === 'del') pin = pin.slice(0, -1);
        else if (pin.length < 5) pin += k;
        paint();
      })
    );

    document.addEventListener('keydown', function onKey(e) {
      if (el('sheet').hidden) { document.removeEventListener('keydown', onKey); return; }
      if (/^\d$/.test(e.key) && pin.length < 5) pin += e.key;
      else if (e.key === 'Backspace') pin = pin.slice(0, -1);
      else if (e.key === 'Enter' && pin.length === 5) go.click();
      else return;
      paint();
    });

    go.addEventListener('click', async () => {
      go.disabled = true;
      msg.hidden = true;
      try {
        const source = $('#source', root);
        const out = await submit(pin, source && source.value ? Number(source.value) : undefined);
        user = out.user || user;
        paintUser();
        loadHistory();
        onDone(out);
      } catch (err) {
        msg.textContent = err.message;
        msg.hidden = false;
        pin = '';
        paint();
      }
    });
  });
}

function showSuccess({ amountLabel, headline, rows, extraHtml = '' }) {
  const html = `
    <div class="done">
      <div class="done-mark">✓</div>
      <div class="done-amt">${escapeHtml(amountLabel)}</div>
      <p class="done-to">${escapeHtml(headline)}</p>
      ${extraHtml}
      ${rows.map(([k, v]) => `<div class="kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`).join('')}
      <button class="btn-primary" style="margin-top:20px" onclick="document.getElementById('sheet-close').click()">Done</button>
    </div>`;
  openSheet('Payment successful', html);
}

/* ───────────────────────────── amount helper ──────────────────────────── */

const amountField = (label = 'Amount in rupees', min = 1) => `
  <label class="field">
    <span>${label}</span>
    <input name="amount" type="number" inputmode="decimal" min="${min}" step="0.01" placeholder="0.00" />
  </label>`;

const readForm = (root) => {
  const out = {};
  root.querySelectorAll('input, select, textarea').forEach((i) => { if (i.name) out[i.name] = i.value.trim(); });
  return out;
};

/* ─────────────────────────── 1. pay a person ──────────────────────────── */

async function sheetPay() {
  let saved = [];
  try { saved = (await api('/api/payees')).payees; } catch {}

  openSheet('Pay a person', `
    ${saved.length ? `<div class="toolbar" style="margin-bottom:14px">${saved.slice(0, 6).map((p) =>
      `<button class="tab-payee btn-quiet" style="width:auto;margin:0;padding:8px 13px;font-size:13px" data-email="${escapeHtml(p.email)}">${escapeHtml(p.label)}</button>`).join('')}</div>` : ''}
    <p class="sheet-note">Money reaches them the moment you confirm. They need an LSP-Pay account on the same email.</p>
    <label class="field"><span>Their email address</span>
      <input name="to" type="email" inputmode="email" placeholder="friend@example.com" /></label>
    ${amountField()}
    <label class="field"><span>Note (optional)</span>
      <input name="note" maxlength="80" placeholder="Dinner, rent, cab…" /></label>
    <button id="go" class="btn-primary">Continue</button>
  `, (root) => {
    root.querySelectorAll('.tab-payee').forEach((b) =>
      b.addEventListener('click', () => { root.querySelector('[name=to]').value = b.dataset.email; }));

    $('#go', root).addEventListener('click', async () => {
      const f = readForm(root);
      if (!f.to) return toast('Enter their email address.', true);
      if (!(Number(f.amount) > 0)) return toast('Enter an amount.', true);

      await confirmWithPin({
        amountLabel: money(f.amount),
        to: `To ${f.to}`,
        submit: (pin, cardId) => api('/api/pay/user', { ...f, pin, cardId }),
        onDone: (out) =>
          showSuccess({
            amountLabel: out.amountLabel,
            headline: `Paid to ${f.to}`,
            rows: [['Reference', out.reference], ['Points earned', `+${out.points}`], ['Balance left', user.balanceLabel]]
          })
      });
    });
  });
}

/* ────────────────────────── 3. mobile recharge ────────────────────────── */

function sheetMobile() {
  openSheet('Recharge a mobile number', `
    <p class="sheet-note">Prepaid top-up for any Indian number.</p>
    <label class="field"><span>Mobile number</span>
      <input name="phone" inputmode="numeric" maxlength="10" placeholder="98765 43210" /></label>
    <label class="field"><span>Operator</span>
      <select name="operator">
        <option>Airtel</option><option>Jio</option><option>Vi</option><option>BSNL</option>
      </select></label>
    ${amountField('Recharge amount', 10)}
    <button id="go" class="btn-primary">Continue</button>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      const f = readForm(root);
      if (!/^[6-9]\d{9}$/.test(f.phone)) return toast('Enter a 10-digit mobile number.', true);
      if (!(Number(f.amount) >= 10)) return toast('Minimum recharge is ₹10.', true);

      await confirmWithPin({
        amountLabel: money(f.amount),
        to: `${f.operator} · ${f.phone}`,
        actionLabel: 'Recharge',
        submit: (pin, cardId) => api('/api/recharge/mobile', { ...f, pin, cardId }),
        onDone: (out) =>
          showSuccess({
            amountLabel: out.amountLabel,
            headline: `${f.operator} recharge done for ${f.phone}`,
            rows: [['Reference', out.reference], ['Points earned', `+${out.points}`], ['Balance left', user.balanceLabel]]
          })
      });
    });
  });
}

/* ────────────────────────── 4. FASTag top-up ──────────────────────────── */

function sheetFastag() {
  openSheet('Top up FASTag', `
    <p class="sheet-note">Add toll balance to a tag. Credit shows at plazas within a few minutes.</p>
    <label class="field"><span>FASTag number</span>
      <input name="tagId" maxlength="20" placeholder="34161FA820328D2C" /></label>
    <label class="field"><span>Vehicle number (optional)</span>
      <input name="vehicle" maxlength="12" placeholder="UP16AB1234" /></label>
    ${amountField('Top-up amount', 100)}
    <button id="go" class="btn-primary">Continue</button>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      const f = readForm(root);
      if (!/^[A-Za-z0-9]{8,20}$/.test(f.tagId || '')) return toast('Enter a FASTag number of 8 to 20 characters.', true);
      if (!(Number(f.amount) >= 100)) return toast('Minimum top-up is ₹100.', true);

      await confirmWithPin({
        amountLabel: money(f.amount),
        to: `FASTag ${f.tagId.toUpperCase()}`,
        actionLabel: 'Top up',
        submit: (pin, cardId) => api('/api/recharge/fastag', { ...f, pin, cardId }),
        onDone: (out) =>
          showSuccess({
            amountLabel: out.amountLabel,
            headline: 'FASTag topped up',
            rows: [['Tag', f.tagId.toUpperCase()], ['Reference', out.reference], ['Points earned', `+${out.points}`]]
          })
      });
    });
  });
}

/* ────────────────────────── 5. gift cards ─────────────────────────────── */

async function sheetGift() {
  const { faces, discount } = await api('/api/giftcards');
  let face = null;

  openSheet('Buy a gift card', `
    <p class="sheet-note">Pay ${Math.round(discount * 100)}% less than the card is worth. The code lands in your recipient's inbox and they redeem it into their own LSP-Pay balance.</p>
    <div class="picker">
      ${faces.map((f) => `
        <button class="pick" data-face="${f.face}" aria-pressed="false">
          <span><strong>${escapeHtml(f.faceLabel)} card</strong><small>You save ${escapeHtml(f.saveLabel)}</small></span>
          <span class="pick-tag">${escapeHtml(f.priceLabel)}</span>
        </button>`).join('')}
    </div>
    <label class="field"><span>Recipient's email address</span>
      <input name="recipient" type="email" inputmode="email" placeholder="them@example.com" /></label>
    <label class="field"><span>Message (optional)</span>
      <input name="message" maxlength="140" placeholder="Happy birthday!" /></label>
    <button id="go" class="btn-primary">Continue</button>
    <button id="redeem" class="btn-quiet">I have a gift card code</button>
  `, (root) => {
    root.querySelectorAll('.pick').forEach((b) =>
      b.addEventListener('click', () => {
        face = Number(b.dataset.face);
        root.querySelectorAll('.pick').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      })
    );

    $('#redeem', root).addEventListener('click', sheetRedeem);

    $('#go', root).addEventListener('click', async () => {
      const f = readForm(root);
      const picked = faces.find((x) => x.face === face);
      if (!picked) return toast('Pick a card value.', true);
      if (!f.recipient) return toast("Enter the recipient's email address.", true);

      await confirmWithPin({
        amountLabel: money(picked.price),
        to: `${picked.faceLabel} card for ${f.recipient}`,
        actionLabel: 'Buy card',
        submit: (pin, cardId) => api('/api/giftcards/buy', { face, ...f, pin, cardId }),
        onDone: (out) =>
          showSuccess({
            amountLabel: out.amountLabel,
            headline: out.delivered
              ? `${out.faceLabel} card emailed to ${out.recipient}`
              : `${out.faceLabel} card created. ${out.note}`,
            extraHtml: `<div class="gift-code">${escapeHtml(out.code)}</div>`,
            rows: [['You saved', out.savedLabel], ['Reference', out.reference], ['Points earned', `+${out.points}`]]
          })
      });
    });
  });
}

function sheetRedeem() {
  openSheet('Redeem a gift card', `
    <p class="sheet-note">Enter the code from your email. The full face value goes into your balance.</p>
    <label class="field"><span>Gift card code</span>
      <input name="code" placeholder="LSPG-XXXX-XXXX" /></label>
    <button id="go" class="btn-primary">Add to balance</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      const msg = $('#msg', root);
      try {
        const out = await api('/api/giftcards/redeem', { code: readForm(root).code });
        user = out.user;
        paintUser();
        loadHistory();
        closeSheet();
        toast(`${out.creditedLabel} added to your balance.`);
      } catch (err) {
        msg.textContent = err.message;
        msg.hidden = false;
      }
    });
  });
}

/* ────────────────────── 6. points and gift cards ──────────────────────── */

async function sheetRewards() {
  const { cards } = await api('/api/giftcards');

  openSheet('Points and gift cards', `
    <div class="reward-figure">${user.points.toLocaleString('en-IN')}</div>
    <p class="reward-note">You earn 5 points for every ₹100 you spend — on people, providers, recharges, FASTag and gift cards alike.</p>
    <h3 class="section-title">Cards you bought</h3>
    ${cards.length
      ? cards.map((c) => `<div class="kv">
          <span>${escapeHtml(c.faceLabel)} → ${escapeHtml(c.recipient)}</span>
          <span>${c.redeemed ? 'Redeemed' : escapeHtml(c.code)}</span>
        </div>`).join('')
      : '<p class="empty">No gift cards yet.</p>'}
    <button id="redeem" class="btn-quiet">Redeem a code</button>
  `, (root) => {
    $('#redeem', root).addEventListener('click', sheetRedeem);
  });
}

/* ──────────────────────────── 7. debit cards ──────────────────────────── */

async function sheetCards() {
  const { cards: saved } = await api('/api/cards');

  openSheet('Cards and money', `
    <p class="sheet-note">Add money to your wallet from a card, or pick a card at the moment you pay.</p>
    ${saved.length
      ? `<div class="picker">${saved.map((c) => `
          <div class="pick" style="cursor:default">
            <span><strong>${escapeHtml(c.display)}</strong><small>Expires ${escapeHtml(c.expiry)}${c.isDefault ? ' · Default' : ''}${c.label ? ' · ' + escapeHtml(c.label) : ''}</small></span>
            <span style="display:flex;gap:10px">
              <button class="btn-link" data-topup="${c.id}">Add money</button>
              <button class="btn-link" data-remove="${c.id}">Remove</button>
            </span>
          </div>`).join('')}</div>`
      : '<p class="empty">No cards saved yet.</p>'}
    <button id="add" class="btn-primary">Add a debit card</button>
    <p class="sheet-note" style="margin-top:16px">Demo mode. Cards are not charged and no card number is stored — only the brand, last four digits and expiry.</p>
  `, (root) => {
    $('#add', root).addEventListener('click', sheetAddCard);

    root.querySelectorAll('[data-topup]').forEach((b) =>
      b.addEventListener('click', () => sheetTopUp(saved.find((c) => c.id === Number(b.dataset.topup))))
    );

    root.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await api('/api/cards/remove', { cardId: Number(b.dataset.remove) });
          toast('Card removed.');
          sheetCards();
        } catch (err) { toast(err.message, true); }
      })
    );
  });
}

function sheetAddCard() {
  openSheet('Add a debit card', `
    <label class="field"><span>Card number</span>
      <input name="number" inputmode="numeric" maxlength="23" placeholder="4111 1111 1111 1111" /></label>
    <div class="field-row">
      <label class="field"><span>Expiry</span>
        <input name="expiry" inputmode="numeric" maxlength="5" placeholder="09/29" /></label>
      <label class="field"><span>Security code</span>
        <input name="cvv" inputmode="numeric" maxlength="4" type="password" placeholder="•••" /></label>
    </div>
    <label class="field"><span>Nickname (optional)</span>
      <input name="label" maxlength="24" placeholder="Salary account" /></label>
    <button id="go" class="btn-primary">Save card</button>
    <p id="msg" class="msg" hidden></p>
    <p class="sheet-note" style="margin-top:16px">Demo mode — use a test number like 4111 1111 1111 1111. Never enter a real card. 4000 0000 0000 9995, 4000 0000 0000 0002 and 4000 0000 0000 0069 are set up to decline so you can try the failure paths.</p>
  `, (root) => {
    const msg = $('#msg', root);

    // format as the person types
    const num = root.querySelector('[name=number]');
    num.addEventListener('input', () => {
      const d = num.value.replace(/\D/g, '').slice(0, 19);
      num.value = d.replace(/(.{4})/g, '$1 ').trim();
    });
    const exp = root.querySelector('[name=expiry]');
    exp.addEventListener('input', () => {
      const d = exp.value.replace(/\D/g, '').slice(0, 4);
      exp.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    });

    $('#go', root).addEventListener('click', async () => {
      try {
        await api('/api/cards', readForm(root));
        closeSheet();
        toast('Card saved.');
        sheetCards();
      } catch (err) {
        msg.textContent = err.message;
        msg.hidden = false;
      }
    });
  });
}

function sheetTopUp(card) {
  openSheet('Add money', `
    <p class="sheet-note">From ${escapeHtml(card.display)} into your LSP-Pay balance.</p>
    ${amountField('Amount in rupees', 100)}
    <button id="go" class="btn-primary">Continue</button>
  `, (root) => {
    $('#go', root).addEventListener('click', () => {
      const f = readForm(root);
      if (!(Number(f.amount) >= 100)) return toast('Minimum top-up is ₹100.', true);

      confirmWithPin({
        amountLabel: money(f.amount),
        to: `From ${card.display}`,
        actionLabel: 'Add money',
        submit: (pin) => api('/api/cards/topup', { cardId: card.id, amount: f.amount, pin }),
        onDone: (out) =>
          showSuccess({
            amountLabel: out.amountLabel,
            headline: `Added from ${out.card}`,
            rows: [['Reference', out.reference], ['New balance', user.balanceLabel]]
          })
      });
    });
  });
}

/* ───────────────────────────── settings + PIN ─────────────────────────── */

function sheetSettings() {
  openSheet('Your account', `
    <div class="kv"><span>Signed in as</span><span>${escapeHtml(user.email)}</span></div>
    <div class="kv"><span>Balance</span><span>${escapeHtml(user.balanceLabel)}</span></div>
    <div class="kv"><span>Points</span><span>${user.points.toLocaleString('en-IN')}</span></div>
    <div class="kv"><span>Payment PIN</span><span>${user.pinIsDefault ? 'Still 00000' : 'Set by you'}</span></div>
    <label class="field" style="margin-top:20px"><span>Display name</span>
      <input name="displayName" maxlength="40" value="${escapeHtml(user.displayName || '')}" placeholder="How others see you" /></label>
    <label class="field"><span>Daily spending limit in rupees (optional)</span>
      <input name="dailyLimit" type="number" min="1" step="1" value="${user.dailyLimit || ''}" placeholder="No limit" /></label>
    <button id="save" class="btn-primary">Save profile</button>
    <button id="pin" class="btn-quiet">Change payment PIN</button>
    <button id="linked" class="btn-quiet">Linked accounts</button>
    <button id="connected" class="btn-quiet">Apps you have allowed</button>
    <button id="dev" class="btn-quiet">Developer — LSP OAuth</button>
    <button id="logins" class="btn-quiet">Recent sign-ins</button>
    <button id="out" class="btn-quiet">Sign out</button>
  `, (root) => {
    $('#save', root).addEventListener('click', async () => {
      try {
        const out = await api('/api/profile', readForm(root));
        user = out.user; paintUser(); closeSheet(); toast('Profile saved.');
      } catch (err) { toast(err.message, true); }
    });
    $('#pin', root).addEventListener('click', sheetChangePin);
    $('#connected', root).addEventListener('click', sheetConnectedApps);
    $('#dev', root).addEventListener('click', sheetDeveloper);

    $('#linked', root).addEventListener('click', async () => {
      const d = await api('/api/auth/linked');
      openSheet('Linked accounts', `
        <p class="sheet-note">Sign in faster next time. An email code always works too, so unlinking never locks you out.</p>
        ${d.available.length ? d.available.map((p) => {
          const on = d.linked.find((l) => l.provider === p.name);
          return `<div class="kv"><span>${escapeHtml(p.label)}${on ? `<br><small style="color:var(--mist)">${escapeHtml(on.email || '')}</small>` : ''}</span>
            ${on ? `<button class="btn-link" data-unlink="${escapeHtml(p.name)}">Unlink</button>`
                 : `<button class="btn-link" data-link="${escapeHtml(p.name)}">Link</button>`}</div>`;
        }).join('') : '<p class="empty">No sign-in providers are set up on this server.</p>'}
      `, (r2) => {
        r2.querySelectorAll('[data-link]').forEach((b) =>
          b.addEventListener('click', () => { location.href = `/auth/${b.dataset.link}`; }));
        r2.querySelectorAll('[data-unlink]').forEach((b) =>
          b.addEventListener('click', async () => {
            await api('/api/auth/unlink', { provider: b.dataset.unlink });
            toast('Unlinked.');
            closeSheet();
          }));
      });
    });

    $('#logins', root).addEventListener('click', async () => {
      const { logins } = await api('/api/logins');
      openSheet('Recent sign-ins', logins.length
        ? logins.map((l) => `<div class="kv"><span>${escapeHtml(l.ip || 'unknown address')}<br>
            <small style="color:var(--mist)">${escapeHtml((l.agent || '').slice(0, 46))}</small></span>
            <span>${new Date(l.createdAt.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span></div>`).join('')
          + '<p class="sheet-note" style="margin-top:16px">See something you do not recognise? Change your PIN and sign out.</p>'
        : '<p class="empty">No sign-ins recorded yet.</p>');
    });

    $('#out', root).addEventListener('click', async () => {
      await api('/api/auth/logout', {});
      location.reload();
    });
  });
}

function sheetChangePin() {
  openSheet('Change payment PIN', `
    <p class="sheet-note">We email a six-digit code to ${escapeHtml(user.email)} before the new PIN takes effect.</p>
    <button id="send" class="btn-quiet" style="margin:0 0 18px">Email me a code</button>
    <label class="field"><span>Code from your email</span>
      <input name="code" inputmode="numeric" maxlength="6" placeholder="••••••" /></label>
    <label class="field"><span>New 5-digit PIN</span>
      <input name="newPin" inputmode="numeric" maxlength="5" type="password" placeholder="•••••" /></label>
    <button id="go" class="btn-primary">Save new PIN</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    const msg = $('#msg', root);
    const say = (text, good) => { msg.textContent = text; msg.classList.toggle('good', !!good); msg.hidden = false; };

    $('#send', root).addEventListener('click', async () => {
      try {
        const out = await api('/api/pin/request-code', {});
        say(out.devCode ? `Development mode: your code is ${out.devCode}` : out.note || 'Code sent. Check your inbox.', !out.note);
      } catch (err) { say(err.message); }
    });

    $('#go', root).addEventListener('click', async () => {
      const f = readForm(root);
      if (!/^\d{5}$/.test(f.newPin || '')) return say('Your PIN must be exactly 5 digits.');
      try {
        const out = await api('/api/pin/change', f);
        user = out.user;
        paintUser();
        closeSheet();
        toast('New PIN saved.');
      } catch (err) { say(err.message); }
    });
  });
}

/* ───────────────────────── requests & insights ────────────────────────── */

async function sheetRequest() {
  const { incoming, outgoing } = await api('/api/requests');

  openSheet('Request money', `
    ${incoming.length ? `<h3 class="section-title" style="margin-top:0">Waiting on you</h3>
      <div class="picker">${incoming.map((r) => `
        <div class="pick" style="cursor:default">
          <span><strong>${escapeHtml(r.amountLabel)} to ${escapeHtml(r.who)}</strong>
            <small>${escapeHtml(r.note || 'No note')}</small></span>
          <span style="display:flex;gap:10px">
            <button class="btn-link" data-pay="${r.id}" data-email="${escapeHtml(r.email)}" data-amt="${r.amount}">Pay</button>
            <button class="btn-link" data-decline="${r.id}">No</button>
          </span>
        </div>`).join('')}</div>` : ''}

    <h3 class="section-title"${incoming.length ? '' : ' style="margin-top:0"'}>Ask someone</h3>
    <label class="field"><span>Their email address</span>
      <input name="to" type="email" placeholder="friend@example.com" /></label>
    <label class="field"><span>Amount in rupees</span>
      <input name="amount" type="number" inputmode="decimal" min="1" step="0.01" placeholder="0.00" /></label>
    <label class="field"><span>What for (optional)</span>
      <input name="note" maxlength="80" placeholder="Dinner on Friday" /></label>
    <button id="go" class="btn-primary">Send the request</button>
    <button id="split" class="btn-quiet">Split a bill between several people</button>
    <p id="msg" class="msg" hidden></p>

    ${outgoing.length ? `<h3 class="section-title">You asked for</h3>
      ${outgoing.map((r) => `<div class="kv"><span>${escapeHtml(r.amountLabel)} from ${escapeHtml(r.who)}</span><span>${escapeHtml(r.status)}</span></div>`).join('')}` : ''}
  `, (root) => {
    root.querySelectorAll('[data-pay]').forEach((b) =>
      b.addEventListener('click', () => {
        closeSheet();
        confirmWithPin({
          amountLabel: money(b.dataset.amt),
          to: `To ${b.dataset.email}`,
          submit: (pin, cardId) => api('/api/pay/user', { to: b.dataset.email, amount: b.dataset.amt, pin, cardId }),
          onDone: (out) => showSuccess({
            amountLabel: out.amountLabel,
            headline: `Paid ${b.dataset.email}`,
            rows: [['Reference', out.reference], ['Points earned', `+${out.points}`]]
          })
        });
      })
    );

    root.querySelectorAll('[data-decline]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api('/api/requests/decline', { id: Number(b.dataset.decline) });
        toast('Request turned down.');
        sheetRequest();
      })
    );

    $('#split', root).addEventListener('click', sheetSplit);

    $('#go', root).addEventListener('click', async () => {
      try {
        await api('/api/requests', readForm(root));
        closeSheet();
        toast('Request sent.');
      } catch (err) {
        const msg = $('#msg', root); msg.textContent = err.message; msg.hidden = false;
      }
    });
  });
}

function sheetSplit() {
  openSheet('Split a bill', `
    <p class="sheet-note">Everyone gets a request for their share. You are counted in the split, so a ₹900 bill between you and two friends means ₹300 each.</p>
    <label class="field"><span>Their email addresses, one per line</span>
      <textarea name="emails" rows="4" placeholder="friend@example.com&#10;other@example.com" style="resize:vertical"></textarea></label>
    <label class="field"><span>The total bill in rupees</span>
      <input name="total" type="number" min="1" step="0.01" placeholder="900" /></label>
    <label class="field"><span>What for (optional)</span>
      <input name="note" maxlength="80" placeholder="Dinner at Kaapi Co." /></label>
    <button id="go" class="btn-primary">Send everyone their share</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      const f = readForm(root);
      const emails = (root.querySelector('[name=emails]').value || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
      try {
        const out = await api('/api/split', { emails, total: f.total, note: f.note });
        closeSheet();
        toast(`${out.eachLabel} requested from ${out.sent} ${out.sent === 1 ? 'person' : 'people'}.${out.note ? ' ' + out.note : ''}`);
      } catch (err) {
        const m = $('#msg', root); m.textContent = err.message; m.hidden = false;
      }
    });
  });
}

async function sheetInsights() {
  const a = await api('/api/analytics');
  const top = a.byKind[0]?.amount || 1;

  openSheet('Spending this month', `
    <div class="stat-grid">
      <div class="stat"><div class="n">${escapeHtml(a.spentLabel)}</div><div class="l">Out this month</div></div>
      <div class="stat"><div class="n">${escapeHtml(a.receivedLabel)}</div><div class="l">In this month</div></div>
      <div class="stat"><div class="n">${escapeHtml(a.todayLabel)}</div><div class="l">Spent today</div></div>
      <div class="stat"><div class="n">${escapeHtml(a.limitLabel || 'None')}</div><div class="l">Daily limit</div></div>
    </div>

    ${a.byKind.length ? a.byKind.map((k) => `
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px">
          <span>${escapeHtml(k.kind)}</span><span>${escapeHtml(k.label)}</span>
        </div>
        <div style="height:6px;background:var(--line);border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${Math.max(3, Math.round((k.amount / top) * 100))}%;background:var(--brass)"></div>
        </div>
      </div>`).join('')
      : '<p class="empty">Nothing spent yet this month.</p>'}

    <button id="export" class="btn-quiet">Download full statement</button>
  `, (root) => {
    $('#export', root).addEventListener('click', () => window.open('/api/statement.csv', '_blank'));
  });
}

/* ──────────────── scheduled, recurring, bank, notifications ───────────── */

async function sheetScheduled() {
  const d = await api('/api/scheduled');

  openSheet('Scheduled and recurring', `
    ${d.scheduled.length ? `<h3 class="section-title" style="margin-top:0">Coming up once</h3>
      ${d.scheduled.map((s) => `<div class="kv">
        <span>${escapeHtml(s.amountLabel)} to ${escapeHtml(s.to)}<br>
          <small style="color:var(--mist)">${new Date(s.runAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${s.note ? ' · ' + escapeHtml(s.note) : ''}</small></span>
        <button class="btn-link" data-cancel="${s.id}">Cancel</button></div>`).join('')}` : ''}

    ${d.subscriptions.length ? `<h3 class="section-title">Repeating</h3>
      ${d.subscriptions.map((s) => `<div class="kv">
        <span>${escapeHtml(s.amountLabel)} to ${escapeHtml(s.to)}<br>
          <small style="color:var(--mist)">every ${s.everyDays} day${s.everyDays === 1 ? '' : 's'} · ${s.runs} sent${s.maxRuns ? ' of ' + s.maxRuns : ''}${s.lastError ? ' · last failed: ' + escapeHtml(s.lastError) : ''}</small></span>
        ${s.active ? `<button class="btn-link" data-stop="${s.id}">Stop</button>` : '<span style="color:var(--mist);font-size:13px">Stopped</span>'}</div>`).join('')}` : ''}

    ${!d.scheduled.length && !d.subscriptions.length ? '<p class="empty">Nothing set up yet.</p>' : ''}

    <button id="one" class="btn-primary" style="margin-top:20px">Schedule a one-off payment</button>
    <button id="rec" class="btn-quiet">Set up a repeating payment</button>
  `, (root) => {
    $('#one', root).addEventListener('click', () => sheetScheduleOne());
    $('#rec', root).addEventListener('click', () => sheetRecurring());
    root.querySelectorAll('[data-cancel]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api('/api/scheduled/cancel', { id: Number(b.dataset.cancel) });
        toast('Cancelled.'); sheetScheduled();
      }));
    root.querySelectorAll('[data-stop]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api('/api/subscriptions/stop', { id: Number(b.dataset.stop) });
        toast('Stopped.'); sheetScheduled();
      }));
  });
}

function sheetScheduleOne() {
  openSheet('Schedule a payment', `
    <p class="sheet-note">It goes out automatically on the day. If your balance is short then, it is skipped and you are told — never overdrawn.</p>
    <label class="field"><span>Their email address</span><input name="to" type="email" placeholder="friend@example.com" /></label>
    <label class="field"><span>Amount in rupees</span><input name="amount" type="number" min="1" step="0.01" placeholder="0.00" /></label>
    <label class="field"><span>In how many days</span><input name="inDays" type="number" min="1" max="365" placeholder="7" /></label>
    <label class="field"><span>Note (optional)</span><input name="note" maxlength="80" placeholder="Rent" /></label>
    <label class="field"><span>Your payment PIN</span><input name="pin" type="password" inputmode="numeric" maxlength="5" placeholder="•••••" /></label>
    <button id="go" class="btn-primary">Schedule it</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try { await api('/api/scheduled', readForm(root)); closeSheet(); toast('Payment scheduled.'); }
      catch (err) { const m = $('#msg', root); m.textContent = err.message; m.hidden = false; }
    });
  });
}

function sheetRecurring() {
  openSheet('Repeating payment', `
    <p class="sheet-note">A standing instruction. It keeps going until you stop it, or until it has run the number of times you set.</p>
    <label class="field"><span>Their email address</span><input name="to" type="email" placeholder="landlord@example.com" /></label>
    <label class="field"><span>Amount in rupees</span><input name="amount" type="number" min="1" step="0.01" placeholder="0.00" /></label>
    <div class="field-row">
      <label class="field"><span>Every how many days</span><input name="everyDays" type="number" min="1" max="365" placeholder="30" /></label>
      <label class="field"><span>Stop after (optional)</span><input name="maxRuns" type="number" min="1" placeholder="never" /></label>
    </div>
    <label class="field"><span>Note (optional)</span><input name="note" maxlength="80" placeholder="Monthly rent" /></label>
    <label class="field"><span>Your payment PIN</span><input name="pin" type="password" inputmode="numeric" maxlength="5" placeholder="•••••" /></label>
    <button id="go" class="btn-primary">Start it</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try { await api('/api/subscriptions', { ...readForm(root), startNow: false }); closeSheet(); toast('Repeating payment set up.'); }
      catch (err) { const m = $('#msg', root); m.textContent = err.message; m.hidden = false; }
    });
  });
}

async function sheetBank() {
  const d = await api('/api/banks');

  openSheet('Bank and withdrawals', `
    ${d.banks.length
      ? `<div class="picker">${d.banks.map((b) => `
          <div class="pick" style="cursor:default">
            <span><strong>${escapeHtml(b.display)}</strong><small>${escapeHtml(b.holder)} · ${escapeHtml(b.ifsc)}</small></span>
            <span style="display:flex;gap:10px">
              <button class="btn-link" data-out="${b.id}" data-name="${escapeHtml(b.display)}">Withdraw</button>
              <button class="btn-link" data-del="${b.id}">Remove</button>
            </span></div>`).join('')}</div>`
      : '<p class="empty">No bank account saved yet.</p>'}
    <button id="add" class="btn-primary">Add a bank account</button>

    ${d.payouts.length ? `<h3 class="section-title" style="margin-top:26px">Recent withdrawals</h3>
      ${d.payouts.map((p) => `<div class="kv"><span>${escapeHtml(p.amountLabel)}</span><span>${escapeHtml(p.status)}</span></div>`).join('')}` : ''}
    <p class="sheet-note" style="margin-top:16px">Demo mode — the money leaves your wallet but no bank is credited. Only the last four digits of an account are stored.</p>
  `, (root) => {
    $('#add', root).addEventListener('click', sheetAddBank);
    root.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api('/api/banks/remove', { id: Number(b.dataset.del) });
        toast('Account removed.'); sheetBank();
      }));
    root.querySelectorAll('[data-out]').forEach((b) =>
      b.addEventListener('click', () => sheetWithdraw(Number(b.dataset.out), b.dataset.name)));
  });
}

function sheetAddBank() {
  openSheet('Add a bank account', `
    <label class="field"><span>Name on the account</span><input name="holder" maxlength="60" placeholder="Saurabh Bhardwaj" /></label>
    <label class="field"><span>Account number</span><input name="number" inputmode="numeric" maxlength="18" placeholder="123456789012" /></label>
    <label class="field"><span>IFSC</span><input name="ifsc" maxlength="11" placeholder="HDFC0001234" style="text-transform:uppercase" /></label>
    <button id="go" class="btn-primary">Save account</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try { await api('/api/banks', readForm(root)); closeSheet(); toast('Bank account saved.'); sheetBank(); }
      catch (err) { const m = $('#msg', root); m.textContent = err.message; m.hidden = false; }
    });
  });
}

function sheetWithdraw(bankId, name) {
  openSheet('Withdraw to bank', `
    <p class="sheet-note">To ${escapeHtml(name)}. Real transfers take a working day; this one is instant and imaginary.</p>
    ${amountField('Amount in rupees', 100)}
    <button id="go" class="btn-primary">Continue</button>
  `, (root) => {
    $('#go', root).addEventListener('click', () => {
      const f = readForm(root);
      if (!(Number(f.amount) >= 100)) return toast('Minimum withdrawal is ₹100.', true);
      confirmWithPin({
        amountLabel: money(f.amount),
        to: `To ${name}`,
        actionLabel: 'Withdraw',
        submit: (pin) => api('/api/payouts', { bankId, amount: f.amount, pin }),
        onDone: (out) => showSuccess({
          amountLabel: out.amountLabel,
          headline: `On its way to ${out.bank}`,
          rows: [['Reference', out.id], ['Balance left', user.balanceLabel]]
        })
      });
    });
  });
}

async function sheetNotifications() {
  const d = await api('/api/notifications');
  await api('/api/notifications/seen', {});
  el('bell-dot').hidden = true;

  openSheet('Notifications', d.notifications.length
    ? d.notifications.map((n) => `<div class="tx"><div class="tx-main">
        <div class="tx-title">${escapeHtml(n.title)}</div>
        <div class="tx-sub">${escapeHtml([n.body, new Date(n.createdAt.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · '))}</div>
      </div></div>`).join('')
    : '<p class="empty">Nothing yet.</p>');
}

async function refreshBell() {
  try {
    const { unread } = await api('/api/notifications');
    el('bell-dot').hidden = unread === 0;
  } catch { /* not signed in */ }
}

/* ───────────────────────────── ask lsp-pay ───────────────────────────── */

const STARTERS = [
  'What did I spend on this month?',
  'How do I take payments on my website?',
  'What is a FASTag?',
  'Explain UPI in simple words'
];

async function sheetAsk() {
  const [status, past] = await Promise.all([
    api('/api/ai/status').catch(() => ({ ready: false, note: 'Could not reach the assistant.' })),
    api('/api/ai/history').catch(() => ({ messages: [] }))
  ]);

  openSheet('Ask LSP-Pay', `
    ${status.ready
      ? `<p class="sheet-note">Ask anything — about your money, about the app, or about nothing to do with either. Answers come from ${escapeHtml(status.provider)}.</p>`
      : `<p class="msg">${escapeHtml(status.note || 'The assistant is not set up on this server.')}</p>`}

    <div class="chat" id="chat"></div>

    ${past.messages.length ? '' : `<div class="starters">${STARTERS.map((q) =>
      `<button class="starter" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}</div>`}

    <div class="ask-row">
      <textarea id="ask" rows="1" placeholder="Ask anything…" ${status.ready ? '' : 'disabled'}></textarea>
      <button id="send" aria-label="Send" ${status.ready ? '' : 'disabled'}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M12 5l7 7-7 7"/></svg>
      </button>
    </div>

    <p class="sheet-note" style="margin-top:14px">It can read your balance and recent activity to answer, but it cannot move money or change anything. Never give it your PIN or a code.</p>
    ${past.messages.length ? '<button id="clear" class="btn-quiet">Clear this conversation</button>' : ''}
  `, (root) => {
    const chat = $('#chat', root);
    const box = $('#ask', root);

    const bubble = (role, text, cls = '') => {
      const d = document.createElement('div');
      d.className = `bub ${role === 'user' ? 'me' : 'ai'} ${cls}`.trim();
      d.textContent = text;
      chat.appendChild(d);
      chat.scrollTop = chat.scrollHeight;
      return d;
    };

    if (past.messages.length) past.messages.forEach((m) => bubble(m.role, m.text));
    else if (status.ready) bubble('assistant', 'Ask me anything. I can see your balance and recent activity, so "where did my money go?" works too.');

    // grow the box with the question, up to a point
    box.addEventListener('input', () => {
      box.style.height = 'auto';
      box.style.height = Math.min(box.scrollHeight, 120) + 'px';
    });

    async function send(text) {
      const q = (text || box.value).trim();
      if (!q) return;

      box.value = ''; box.style.height = 'auto';
      $('.starters', root)?.remove();
      bubble('user', q);

      const pending = bubble('assistant', 'Thinking…', 'thinking');
      $('#send', root).disabled = true;

      try {
        const out = await api('/api/ai/chat', { message: q });
        pending.classList.remove('thinking');
        pending.textContent = out.reply;
      } catch (err) {
        pending.classList.remove('thinking');
        pending.classList.add('oops');
        pending.textContent = err.message;
      } finally {
        $('#send', root).disabled = false;
        chat.scrollTop = chat.scrollHeight;
        box.focus();
      }
    }

    $('#send', root).addEventListener('click', () => send());
    box.addEventListener('keydown', (e) => {
      // Enter sends, Shift+Enter makes a new line.
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    root.querySelectorAll('.starter').forEach((b) =>
      b.addEventListener('click', () => send(b.dataset.q)));

    $('#clear', root)?.addEventListener('click', async () => {
      await api('/api/ai/clear', {});
      closeSheet(); toast('Conversation cleared.');
    });

    if (status.ready) setTimeout(() => box.focus(), 120);
  });
}

/* ─────────────────────────── 8. business gateway ─────────────────────── */

async function sheetBusiness() {
  const { merchants } = await api('/api/merchants');

  if (!merchants.length) {
    return openSheet('Business gateway', `
      <p class="sheet-note">Take payments on your own website. Your server creates an order, your customer pays on a page carrying your name and logo, and the money lands in this wallet.</p>
      <label class="field"><span>Business name</span>
        <input name="name" maxlength="60" placeholder="Sharma Electronics" /></label>
      <button id="go" class="btn-primary">Create my gateway</button>
      <p class="sheet-note" style="margin-top:16px">Demo mode — no real money moves. <a href="/developers" target="_blank" style="color:var(--brass)">Read the API docs</a></p>
    `, (root) => {
      $('#go', root).addEventListener('click', async () => {
        try {
          const out = await api('/api/merchants', readForm(root));
          showSecret(out.secret, out.warning, () => sheetBusiness());
        } catch (err) { toast(err.message, true); }
      });
    });
  }

  const m = merchants.find((x) => x.id === window.__lspGateway) || merchants[0];
  window.__lspGateway = m.id;
  const { orders } = await api(`/api/merchants/orders?merchantId=${m.id}`);
  const sum = await api(`/api/merchants/summary?merchantId=${m.id}`);

  openSheet(m.name, `
    ${merchants.length > 1 ? `<label class="field"><span>Gateway</span>
      <select id="switch">${merchants.map((x) => `<option value="${x.id}"${x.id === m.id ? ' selected' : ''}>${escapeHtml(x.name)}</option>`).join('')}</select></label>` : ''}
    <div class="kv"><span>Collected</span><span>${escapeHtml(sum.collectedLabel)} · ${sum.paidCount} paid</span></div>
    <div class="kv"><span>Refunded</span><span>${escapeHtml(sum.refundedLabel)} · ${sum.refundCount}</span></div>
    <div class="kv"><span>Net</span><span>${escapeHtml(sum.netLabel)}</span></div>
    <div class="kv"><span>Awaiting payment</span><span>${escapeHtml(sum.pendingLabel)} · ${sum.pendingCount}</span></div>
    <div class="kv"><span>Key ID</span><span style="word-break:break-all">${escapeHtml(m.keyId)}</span></div>
    <div class="kv"><span>Secret</span><span>Hidden — reset to get a new one</span></div>
    <div class="kv"><span>Checkout theme</span><span>${m.theme === 'light' ? 'Light' : 'Dark'}</span></div>
    <div class="kv"><span>Methods</span><span>${escapeHtml(m.methods.join(', '))}</span></div>

    <button id="test" class="btn-primary" style="margin-top:20px">Create a test order</button>
    <button id="links" class="btn-quiet">Shareable payment links</button>
    <button id="customers" class="btn-quiet">Customers</button>
    <button id="coupons" class="btn-quiet">Discount codes</button>
    <button id="newgw" class="btn-quiet">Add another gateway</button>
    <button id="settings" class="btn-quiet">Logo, theme and methods</button>
    <button id="roll" class="btn-quiet">Reset API secret</button>
    <button id="docs" class="btn-quiet">API documentation</button>

    <h3 class="section-title" style="margin-top:26px">Recent orders</h3>
    ${orders.length
      ? orders.slice(0, 12).map((o) => `<div class="tx">
          <div class="tx-main">
            <div class="tx-title">${escapeHtml(o.amountLabel)} · ${escapeHtml(o.status)}</div>
            <div class="tx-sub">${escapeHtml([o.description, o.method, o.refunded > 0 ? 'refunded ' + o.refundedLabel : null, o.id].filter(Boolean).join(' · '))}</div>
          </div>
          ${o.status === 'paid' ? `<button class="btn-link" data-refund="${o.id}">Refund</button>` : ''}
        </div>`).join('')
      : '<p class="empty">No orders yet. Create one from your server with the API.</p>'}
  `, (root) => {
    $('#test', root).addEventListener('click', () => sheetTestOrder(m));
    $('#links', root).addEventListener('click', () => sheetLinks(m));
    $('#customers', root).addEventListener('click', () => sheetCustomers(m));
    $('#coupons', root).addEventListener('click', () => sheetCoupons(m));
    $('#newgw', root).addEventListener('click', () => sheetNewGateway());
    $('#switch', root)?.addEventListener('change', (e) => {
      window.__lspGateway = Number(e.target.value);
      sheetBusiness();
    });
    root.querySelectorAll('[data-refund]').forEach((b) =>
      b.addEventListener('click', () => sheetRefund(m, orders.find((o) => o.id === b.dataset.refund)))
    );
    $('#settings', root).addEventListener('click', () => sheetBusinessSettings(m));
    $('#docs', root).addEventListener('click', () => window.open('/developers', '_blank'));
    $('#roll', root).addEventListener('click', () => sheetRollSecret(m));
  });
}

function sheetTestOrder(m) {
  openSheet('Create a test order', `
    <p class="sheet-note">This is what your website's server would do. It makes a real payment link you can open and pay, without needing your API key.</p>
    <label class="field"><span>Amount in rupees</span>
      <input name="amount" type="number" inputmode="decimal" min="1" step="0.01" value="499" /></label>
    <label class="field"><span>What is it for</span>
      <input name="description" maxlength="140" value="Test order" /></label>
    <button id="go" class="btn-primary">Create the link</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try {
        const o = await api('/api/merchants/test-order', { merchantId: m.id, ...readForm(root) });
        showCheckoutLink(o);
      } catch (err) {
        const msg = $('#msg', root);
        msg.textContent = err.message; msg.hidden = false;
      }
    });
  });
}

function showCheckoutLink(o) {
  openSheet('Your payment link', `
    <div class="summary">
      <div class="summary-amt">${escapeHtml(o.amountLabel)}</div>
      <div class="summary-to">${escapeHtml(o.description || '')}</div>
    </div>
    <p class="sheet-note">Open this to pay as your customer would. It works for 30 minutes and can only be paid once.</p>
    <div class="gift-code" style="font-size:13px;word-break:break-all;letter-spacing:0">${escapeHtml(o.checkoutUrl)}</div>
    <button id="open" class="btn-primary">Open the checkout page</button>
    <button id="copy" class="btn-quiet">Copy the link</button>
    <p class="sheet-note" style="margin-top:16px">Pay with UPI using any ID like <strong>buyer@okbank</strong>, or card <strong>4111 1111 1111 1111</strong>. Use <strong>fail@bank</strong> or card <strong>4000 0000 0000 0002</strong> to watch it decline.</p>
  `, (root) => {
    $('#open', root).addEventListener('click', () => window.open(o.checkoutUrl, '_blank'));
    $('#copy', root).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(o.checkoutUrl); toast('Link copied.'); }
      catch { toast('Select the link above and copy it.', true); }
    });
  });
}

async function sheetLinks(m) {
  const { links } = await api(`/api/merchants/links?merchantId=${m.id}`);

  openSheet('Payment links', `
    <p class="sheet-note">A link you can share as many times as you like — put it in a bio, a WhatsApp message or a printed QR. Each visit makes a fresh order, so two people can pay the same link without clashing.</p>
    ${links.length
      ? `<div class="picker">${links.map((l) => `
          <div class="pick" style="cursor:default">
            <span><strong>${escapeHtml(l.title)}</strong>
              <small>${escapeHtml(l.amountLabel)} · used ${l.usedCount}${l.usageLimit ? ' of ' + l.usageLimit : ''}${l.active ? '' : ' · off'}</small></span>
            <span style="display:flex;gap:10px">
              <button class="btn-link" data-qr="${escapeHtml(l.id)}" data-title="${escapeHtml(l.title)}">QR</button>
              <button class="btn-link" data-copy="${escapeHtml(l.url)}">Copy</button>
            </span>
          </div>`).join('')}</div>`
      : '<p class="empty">No links yet.</p>'}
    <button id="add" class="btn-primary">Create a link</button>
  `, (root) => {
    root.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied.'); }
        catch { toast(b.dataset.copy, false); }
      })
    );
    root.querySelectorAll('[data-qr]').forEach((b) =>
      b.addEventListener('click', () => {
        const link = links.find((l) => l.id === b.dataset.qr);
        openSheet(link.title, `
          <img class="qr" src="/l/${escapeHtml(link.id)}/qr.svg" alt="QR code" />
          <p class="sheet-note" style="text-align:center">Print it, or show it at a counter. Anyone who scans it pays ${escapeHtml(link.amountLabel)}.</p>
          <div class="gift-code" style="font-size:12.5px;word-break:break-all;letter-spacing:0">${escapeHtml(link.url)}</div>
          <button id="dl" class="btn-quiet">Open the QR on its own</button>
        `, (r2) => $('#dl', r2).addEventListener('click', () => window.open(`/l/${link.id}/qr.svg`, '_blank')));
      })
    );
    $('#add', root).addEventListener('click', () => sheetNewLink(m));
  });
}

function sheetNewLink(m) {
  openSheet('Create a payment link', `
    <label class="field"><span>What is it for</span>
      <input name="title" maxlength="80" placeholder="Coffee subscription" /></label>
    <label class="field"><span>Amount in rupees — leave empty to let the payer choose</span>
      <input name="amount" type="number" inputmode="decimal" min="1" step="0.01" placeholder="250" /></label>
    <div class="field-row">
      <label class="field"><span>Usage limit (optional)</span>
        <input name="usageLimit" type="number" min="1" placeholder="unlimited" /></label>
      <label class="field"><span>Expires in days (optional)</span>
        <input name="expiresInDays" type="number" min="1" max="3650" placeholder="never" /></label>
    </div>
    <button id="go" class="btn-primary">Create it</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try {
        const l = await api('/api/merchants/links', { merchantId: m.id, ...readForm(root) });
        openSheet('Your payment link', `
          <div class="summary"><div class="summary-amt">${escapeHtml(l.amountLabel)}</div>
            <div class="summary-to">${escapeHtml(l.title)}</div></div>
          <img class="qr" src="/l/${escapeHtml(l.id)}/qr.svg" alt="QR code for this payment link" />
          <div class="gift-code" style="font-size:13px;word-break:break-all;letter-spacing:0">${escapeHtml(l.url)}</div>
          <button id="open" class="btn-primary">Open it</button>
          <button id="copy" class="btn-quiet">Copy the link</button>
        `, (r2) => {
          $('#open', r2).addEventListener('click', () => window.open(l.url, '_blank'));
          $('#copy', r2).addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(l.url); toast('Link copied.'); }
            catch { toast('Select the link above and copy it.', true); }
          });
        });
      } catch (err) {
        const msg = $('#msg', root); msg.textContent = err.message; msg.hidden = false;
      }
    });
  });
}

function sheetRefund(m, order) {
  openSheet('Refund', `
    <div class="summary"><div class="summary-amt">${escapeHtml(order.amountLabel)}</div>
      <div class="summary-to">${escapeHtml(order.description || order.id)}</div></div>
    <p class="sheet-note">The money comes out of your wallet. Leave the amount empty to refund it all.</p>
    <label class="field"><span>Amount to refund (optional)</span>
      <input name="amount" type="number" inputmode="decimal" min="1" step="0.01" placeholder="everything" /></label>
    <label class="field"><span>Reason (optional)</span>
      <input name="reason" maxlength="140" placeholder="Item out of stock" /></label>
    <button id="go" class="btn-primary">Refund</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      const f = readForm(root);
      const body = { merchantId: m.id, orderId: order.id, reason: f.reason };
      if (f.amount) body.amount = f.amount;
      try {
        const out = await api('/api/merchants/refund', body);
        closeSheet();
        toast(`${out.amountLabel} refunded.`);
        const me = await api('/api/me'); user = me.user; paintUser(); loadHistory();
        sheetBusiness();
      } catch (err) {
        const msg = $('#msg', root); msg.textContent = err.message; msg.hidden = false;
      }
    });
  });
}

async function sheetCoupons(m) {
  const { coupons } = await api(`/api/merchants/coupons?merchantId=${m.id}`);

  openSheet('Discount codes', `
    <p class="sheet-note">Customers type these at checkout. The discount comes off what they pay you.</p>
    ${coupons.length
      ? coupons.map((c) => `<div class="kv">
          <span>${escapeHtml(c.code)}<br><small style="color:var(--mist)">${escapeHtml(c.off)}${c.minSpendLabel ? ' · min ' + escapeHtml(c.minSpendLabel) : ''} · used ${c.usedCount}${c.maxUses ? ' of ' + c.maxUses : ''}</small></span>
          <span>${c.active ? 'Live' : 'Off'}</span></div>`).join('')
      : '<p class="empty">No codes yet.</p>'}
    <button id="add" class="btn-primary">Create a code</button>
  `, (root) => $('#add', root).addEventListener('click', () => sheetNewCoupon(m)));
}

function sheetNewCoupon(m) {
  openSheet('New discount code', `
    <label class="field"><span>The code customers type</span>
      <input name="code" maxlength="24" placeholder="WELCOME20" style="text-transform:uppercase" /></label>
    <div class="field-row">
      <label class="field"><span>Percent off</span><input name="percentOff" type="number" min="1" max="90" placeholder="20" /></label>
      <label class="field"><span>Or flat ₹ off</span><input name="amountOff" type="number" min="1" placeholder="100" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Minimum spend (optional)</span><input name="minSpend" type="number" min="1" placeholder="none" /></label>
      <label class="field"><span>Use limit (optional)</span><input name="maxUses" type="number" min="1" placeholder="unlimited" /></label>
    </div>
    <label class="field"><span>Expires in days (optional)</span><input name="expiresInDays" type="number" min="1" max="3650" placeholder="never" /></label>
    <button id="go" class="btn-primary">Create it</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try { await api('/api/merchants/coupons', { merchantId: m.id, ...readForm(root) }); closeSheet(); toast('Code created.'); sheetCoupons(m); }
      catch (err) { const msg = $('#msg', root); msg.textContent = err.message; msg.hidden = false; }
    });
  });
}

async function sheetCustomers(m) {
  const { customers } = await api(`/api/merchants/customers?merchantId=${m.id}`);

  openSheet('Customers', `
    <p class="sheet-note">Everyone who has paid this gateway, biggest spender first.</p>
    ${customers.length
      ? customers.map((c) => `<div class="kv">
          <span>${escapeHtml(c.who)}<br><small style="color:var(--mist)">${c.orders} order${c.orders === 1 ? '' : 's'}</small></span>
          <span>${escapeHtml(c.totalLabel)}</span></div>`).join('')
      : '<p class="empty">Nobody yet. Customers appear once an order carries an email or is paid from a wallet.</p>'}
  `);
}

function sheetNewGateway() {
  openSheet('Add a gateway', `
    <p class="sheet-note">A second business, with its own name, logo, keys and orders. You can run up to three.</p>
    <label class="field"><span>Business name</span>
      <input name="name" maxlength="60" placeholder="Second shop" /></label>
    <button id="go" class="btn-primary">Create it</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try {
        const out = await api('/api/merchants', readForm(root));
        window.__lspGateway = out.merchant.id;
        showSecret(out.secret, out.warning, () => sheetBusiness());
      } catch (err) {
        const msg = $('#msg', root); msg.textContent = err.message; msg.hidden = false;
      }
    });
  });
}

function showSecret(secret, warning, after) {
  openSheet('Your API secret', `
    <p class="sheet-note">${escapeHtml(warning)}</p>
    <div class="gift-code" style="font-size:15px;word-break:break-all;letter-spacing:0">${escapeHtml(secret)}</div>
    <button id="copy" class="btn-primary">Copy secret</button>
    <p class="sheet-note" style="margin-top:16px">Put this in your server's environment variables. Never in a web page, never in JavaScript a customer can download, never in a GitHub repo.</p>
    <button id="done" class="btn-quiet">I've saved it</button>
  `, (root) => {
    $('#copy', root).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(secret); toast('Secret copied.'); }
      catch { toast('Select the text above and copy it.', true); }
    });
    $('#done', root).addEventListener('click', () => { closeSheet(); if (after) after(); });
  });
}

function sheetRollSecret(m) {
  openSheet('Reset API secret', `
    <p class="sheet-note">The current secret stops working the moment you do this. Any website using it will start failing until you paste the new one in.</p>
    <label class="field"><span>Your payment PIN</span>
      <input name="pin" type="password" inputmode="numeric" maxlength="5" placeholder="•••••" /></label>
    <button id="go" class="btn-primary">Reset it</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try {
        const out = await api('/api/merchants/roll-secret', { merchantId: m.id, pin: readForm(root).pin });
        showSecret(out.secret, out.warning, () => sheetBusiness());
      } catch (err) {
        const msg = $('#msg', root);
        msg.textContent = err.message; msg.hidden = false;
      }
    });
  });
}

function sheetBusinessSettings(m) {
  const ALL = ['upi', 'card', 'netbanking', 'wallet', 'cash'];
  const LABEL = { upi: 'UPI', card: 'Card', netbanking: 'Netbanking', wallet: 'LSP-Pay wallet', cash: 'Cash' };

  openSheet('Gateway settings', `
    <label class="field"><span>Business name</span>
      <input name="name" maxlength="60" value="${escapeHtml(m.name)}" /></label>
    <label class="field"><span>Logo image link (https)</span>
      <input name="logoUrl" placeholder="https://yoursite.com/logo.png" value="${escapeHtml(m.logoUrl || '')}" /></label>
    <label class="field"><span>Checkout theme</span>
      <select name="theme">
        <option value="dark"${m.theme === 'dark' ? ' selected' : ''}>Dark</option>
        <option value="light"${m.theme === 'light' ? ' selected' : ''}>Light</option>
      </select></label>
    <label class="field"><span>Email me when money arrives</span>
      <select name="notifyEmail">
        <option value="yes"${m.notifyEmail !== false ? ' selected' : ''}>Yes</option>
        <option value="no"${m.notifyEmail === false ? ' selected' : ''}>No</option>
      </select></label>
    <label class="field"><span>Webhook URL (https, optional)</span>
      <input name="webhookUrl" placeholder="https://yoursite.com/lsp-webhook" value="${escapeHtml(m.webhookUrl || '')}" /></label>
    <span class="field"><span>Payment methods</span></span>
    <div class="picker">
      ${ALL.map((x) => `<button class="pick" data-method="${x}" aria-pressed="${m.methods.includes(x)}">
        <span><strong>${LABEL[x]}</strong></span>
        <span class="pick-tag">${m.methods.includes(x) ? 'On' : 'Off'}</span></button>`).join('')}
    </div>
    <button id="go" class="btn-primary">Save</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    root.querySelectorAll('[data-method]').forEach((b) =>
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        $('.pick-tag', b).textContent = on ? 'On' : 'Off';
      })
    );

    $('#go', root).addEventListener('click', async () => {
      const methods = [...root.querySelectorAll('[data-method][aria-pressed="true"]')].map((b) => b.dataset.method);
      const f = readForm(root);
      try {
        await api('/api/merchants/update', {
          merchantId: m.id, ...f, methods, notifyEmail: f.notifyEmail !== 'no'
        });
        closeSheet();
        toast('Gateway updated.');
        sheetBusiness();
      } catch (err) {
        const msg = $('#msg', root);
        msg.textContent = err.message; msg.hidden = false;
      }
    });
  });
}

/* ──────────────────────── LSP OAuth — developer ───────────────────────── */

async function sheetDeveloper() {
  const { apps, scopes } = await api('/api/dev/apps');

  openSheet('Developer', `
    <p class="sheet-note">Let other sites offer "Sign in with LSP-Pay". Register an app, get a client ID and secret, and their users approve it on a consent screen.</p>
    ${apps.length
      ? `<div class="picker">${apps.map((a) => `
          <div class="pick" style="cursor:default">
            <span><strong>${escapeHtml(a.name)}</strong>
              <small>${a.users} user${a.users === 1 ? '' : 's'}${a.active ? '' : ' · disabled'}<br>${escapeHtml(a.clientId)}</small></span>
            <span style="display:flex;gap:10px">
              <button class="btn-link" data-edit="${a.id}">Edit</button>
              <button class="btn-link" data-roll="${a.id}">New secret</button>
            </span>
          </div>`).join('')}</div>`
      : '<p class="empty">No apps registered yet.</p>'}
    <button id="add" class="btn-primary">Register an app</button>
    <button id="try" class="btn-quiet">Try the sign-in flow</button>
    <button id="docs" class="btn-quiet">How to use it</button>
  `, (root) => {
    $('#add', root).addEventListener('click', () => sheetNewDevApp(scopes));
    $('#try', root).addEventListener('click', () => window.open('/oauth/playground', '_blank'));
    $('#docs', root).addEventListener('click', () => window.open('/developers#lsp-oauth', '_blank'));
    root.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => sheetEditDevApp(apps.find((a) => a.id === Number(b.dataset.edit)))));
    root.querySelectorAll('[data-roll]').forEach((b) =>
      b.addEventListener('click', () => sheetRollAppSecret(Number(b.dataset.roll))));
  });
}

const devAppFields = (a = {}) => `
  <label class="field"><span>App name — your users will see this</span>
    <input name="name" maxlength="60" value="${escapeHtml(a.name || '')}" placeholder="Kaapi Rewards" /></label>
  <label class="field"><span>One-line description (optional)</span>
    <input name="description" maxlength="140" value="${escapeHtml(a.description || '')}" placeholder="Points for your coffee" /></label>
  <label class="field"><span>Redirect URLs — one per line, https (localhost may use http)</span>
    <textarea name="redirectUris" rows="3" style="resize:vertical" placeholder="https://yoursite.com/auth/lsp/callback">${escapeHtml((a.redirectUris || []).join('\n'))}</textarea></label>
  <label class="field"><span>Logo URL (optional)</span>
    <input name="logoUrl" value="${escapeHtml(a.logoUrl || '')}" placeholder="https://yoursite.com/logo.png" /></label>
  <label class="field"><span>Homepage (optional)</span>
    <input name="homepage" value="${escapeHtml(a.homepage || '')}" placeholder="https://yoursite.com" /></label>`;

function readDevForm(root) {
  const f = readForm(root);
  f.redirectUris = (root.querySelector('[name=redirectUris]').value || '')
    .split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  return f;
}

function sheetNewDevApp(scopes) {
  openSheet('Register an app', `
    ${devAppFields()}
    <button id="go" class="btn-primary">Register it</button>
    <p id="msg" class="msg" hidden></p>
    <p class="sheet-note" style="margin-top:16px">The redirect URL must match character for character when your app signs someone in. That exact-match check is what stops anyone else collecting your users' sign-in codes.</p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try {
        const out = await api('/api/dev/apps', readDevForm(root));
        showAppCredentials(out.app, out.secret, out.warning);
      } catch (err) { const m = $('#msg', root); m.textContent = err.message; m.hidden = false; }
    });
  });
}

function sheetEditDevApp(a) {
  openSheet('Edit app', `
    <div class="kv"><span>Client ID</span><span style="word-break:break-all">${escapeHtml(a.clientId)}</span></div>
    ${devAppFields(a)}
    <button id="go" class="btn-primary">Save</button>
    <button id="del" class="btn-quiet">Delete this app</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try {
        await api('/api/dev/apps/update', { appId: a.id, ...readDevForm(root) });
        closeSheet(); toast('App updated.'); sheetDeveloper();
      } catch (err) { const m = $('#msg', root); m.textContent = err.message; m.hidden = false; }
    });
    $('#del', root).addEventListener('click', async () => {
      await api('/api/dev/apps/delete', { appId: a.id });
      closeSheet(); toast('App deleted. Everyone signed in through it was signed out.'); sheetDeveloper();
    });
  });
}

function sheetRollAppSecret(appId) {
  openSheet('New client secret', `
    <p class="sheet-note">The current secret stops working immediately, and any site using it will fail until you paste in the new one.</p>
    <label class="field"><span>Your payment PIN</span>
      <input name="pin" type="password" inputmode="numeric" maxlength="5" placeholder="•••••" /></label>
    <button id="go" class="btn-primary">Generate it</button>
    <p id="msg" class="msg" hidden></p>
  `, (root) => {
    $('#go', root).addEventListener('click', async () => {
      try {
        const out = await api('/api/dev/apps/roll-secret', { appId, pin: readForm(root).pin });
        showAppCredentials(null, out.secret, out.warning);
      } catch (err) { const m = $('#msg', root); m.textContent = err.message; m.hidden = false; }
    });
  });
}

function showAppCredentials(a, secret, warning) {
  openSheet('Your app credentials', `
    ${a ? `<div class="kv"><span>Client ID</span><span style="word-break:break-all">${escapeHtml(a.clientId)}</span></div>` : ''}
    <p class="sheet-note" style="margin-top:16px">${escapeHtml(warning)}</p>
    <div class="gift-code" style="font-size:13px;word-break:break-all;letter-spacing:0">${escapeHtml(secret)}</div>
    <button id="copy" class="btn-primary">Copy the secret</button>
    <button id="done" class="btn-quiet">I've saved it</button>
    <p class="sheet-note" style="margin-top:16px">The client ID is public and belongs in your sign-in link. The secret is a password — keep it in a server environment variable, never in a web page.</p>
  `, (root) => {
    $('#copy', root).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(secret); toast('Secret copied.'); }
      catch { toast('Select the text above and copy it.', true); }
    });
    $('#done', root).addEventListener('click', () => { closeSheet(); sheetDeveloper(); });
  });
}

async function sheetConnectedApps() {
  const { grants } = await api('/api/oauth/grants');

  openSheet('Apps you have allowed', `
    <p class="sheet-note">Other sites you signed into using LSP-Pay. None of them can move money or see your PIN.</p>
    ${grants.length
      ? grants.map((g) => `<div class="kv">
          <span>${escapeHtml(g.name)}<br><small style="color:var(--mist)">${escapeHtml(g.scope.join(' · '))}</small></span>
          <button class="btn-link" data-revoke="${g.appId}">Remove</button></div>`).join('')
      : '<p class="empty">You have not signed into anything with LSP-Pay yet.</p>'}
  `, (root) => {
    root.querySelectorAll('[data-revoke]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api('/api/oauth/grants/revoke', { appId: Number(b.dataset.revoke) });
        toast('Access removed and signed out everywhere.');
        sheetConnectedApps();
      }));
  });
}

/* ─────────────────────────────── theming ─────────────────────────────── */

function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('lsp-theme', next); } catch { /* private mode */ }

  const bar = document.querySelector('meta[name=theme-color]');
  if (bar) bar.setAttribute('content', next === 'light' ? '#FBF8F1' : '#0E0C1A');
}

['btn-theme', 'btn-theme-auth'].forEach((id) => {
  const b = el(id);
  if (b) b.addEventListener('click', toggleTheme);
});

/* ──────────────────────────────── wiring ──────────────────────────────── */

const SHEETS = {
  pay: sheetPay,
  mobile: sheetMobile,
  fastag: sheetFastag,
  gift: sheetGift,
  rewards: sheetRewards,
  cards: sheetCards,
  business: sheetBusiness,
  request: sheetRequest,
  insights: sheetInsights,
  scheduled: sheetScheduled,
  bank: sheetBank,
  account: sheetSettings,
  ask: sheetAsk
};

document.querySelectorAll('[data-open]').forEach((b) =>
  b.addEventListener('click', async () => {
    try { await SHEETS[b.dataset.open](); }
    catch (err) { toast(err.message, true); }
  })
);

el('btn-bell').addEventListener('click', sheetNotifications);
['tx-search', 'tx-filter'].forEach((id) => el(id)?.addEventListener('input', paintHistory));
el('tx-export')?.addEventListener('click', () => window.open('/api/statement.csv', '_blank'));

(async function boot() {
  try {
    const out = await api('/api/me');
    user = out.user;
    showWallet();
  } catch {
    el('screen-auth').hidden = false;
    setUpOAuth();
    setUpTurnstile();
  }
})();
