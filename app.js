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
  btn.disabled = true;
  try {
    const out = await api('/api/auth/request-code', { email });
    el('auth-target').textContent = out.email;
    el('auth-step-email').hidden = true;
    el('auth-step-code').hidden = false;
    el('auth-code').value = '';
    el('auth-code').focus();
    authMessage(out.devCode ? `Development mode: your code is ${out.devCode}` : out.note, !out.note);
  } catch (err) {
    authMessage(err.message);
  } finally {
    btn.disabled = false;
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

/* ──────────────────────────────── wallet ──────────────────────────────── */

function paintUser() {
  el('balance-amount').textContent = Number(user.balance).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  el('user-handle').textContent = user.email;
  el('points-chip').textContent = `${user.points.toLocaleString('en-IN')} points`;
}

async function loadHistory() {
  const list = el('tx-list');
  try {
    const { transactions } = await api('/api/transactions');
    if (!transactions.length) {
      list.innerHTML = '<p class="empty">Nothing yet. Your payments, recharges and gift cards will show up here.</p>';
      return;
    }
    list.innerHTML = transactions
      .map((t) => {
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
      })
      .join('');
  } catch (err) {
    list.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function showWallet() {
  el('screen-auth').hidden = true;
  el('screen-app').hidden = false;
  paintUser();
  loadHistory();
  if (user.pinIsDefault) {
    setTimeout(() => toast('Your PIN is still 00000. Change it in Settings.'), 900);
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

function sheetPay() {
  openSheet('Pay a person', `
    <p class="sheet-note">Money reaches them the moment you confirm. They need an LSP-Pay account on the same email.</p>
    <label class="field"><span>Their email address</span>
      <input name="to" type="email" inputmode="email" placeholder="friend@example.com" /></label>
    ${amountField()}
    <label class="field"><span>Note (optional)</span>
      <input name="note" maxlength="80" placeholder="Dinner, rent, cab…" /></label>
    <button id="go" class="btn-primary">Continue</button>
  `, (root) => {
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

/* ────────────────────────── 2. payment providers ──────────────────────── */

async function sheetProvider() {
  const { providers } = await api('/api/providers');
  let chosen = null;

  openSheet('Pay a payment provider', `
    <p class="sheet-note">Settle to a gateway using its LSP-Pay routing code.</p>
    <div class="picker">
      ${providers.map((p) => `
        <button class="pick" data-code="${p.code}" aria-pressed="false">
          <span><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.blurb)}</small></span>
          <span class="pick-tag">${escapeHtml(p.code)}</span>
        </button>`).join('')}
    </div>
    <label class="field"><span>Or type the code</span>
      <input name="code" inputmode="numeric" maxlength="7" placeholder="0001119" /></label>
    ${amountField()}
    <label class="field"><span>Reference note (optional)</span>
      <input name="note" maxlength="80" placeholder="Invoice or order id" /></label>
    <button id="go" class="btn-primary">Continue</button>
  `, (root) => {
    root.querySelectorAll('.pick').forEach((b) =>
      b.addEventListener('click', () => {
        chosen = b.dataset.code;
        root.querySelectorAll('.pick').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        root.querySelector('[name=code]').value = chosen;
      })
    );

    $('#go', root).addEventListener('click', async () => {
      const f = readForm(root);
      const provider = providers.find((p) => p.code === f.code);
      if (!provider) return toast('That code does not match a provider.', true);
      if (!(Number(f.amount) > 0)) return toast('Enter an amount.', true);

      await confirmWithPin({
        amountLabel: money(f.amount),
        to: `To ${provider.name} · ${provider.code}`,
        submit: (pin, cardId) => api('/api/pay/provider', { ...f, pin, cardId }),
        onDone: (out) =>
          showSuccess({
            amountLabel: out.amountLabel,
            headline: `Settled to ${provider.name}`,
            rows: [['Provider code', provider.code], ['Reference', out.reference], ['Points earned', `+${out.points}`]]
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
  openSheet('Settings', `
    <div class="kv"><span>Signed in as</span><span>${escapeHtml(user.email)}</span></div>
    <div class="kv"><span>Balance</span><span>${escapeHtml(user.balanceLabel)}</span></div>
    <div class="kv"><span>Points</span><span>${user.points.toLocaleString('en-IN')}</span></div>
    <div class="kv"><span>Payment PIN</span><span>${user.pinIsDefault ? 'Still 00000' : 'Set by you'}</span></div>
    <button id="pin" class="btn-primary" style="margin-top:20px">Change payment PIN</button>
    <button id="out" class="btn-quiet">Sign out</button>
  `, (root) => {
    $('#pin', root).addEventListener('click', sheetChangePin);
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
  provider: sheetProvider,
  mobile: sheetMobile,
  fastag: sheetFastag,
  gift: sheetGift,
  rewards: sheetRewards,
  cards: sheetCards
};

document.querySelectorAll('[data-open]').forEach((b) =>
  b.addEventListener('click', async () => {
    try { await SHEETS[b.dataset.open](); }
    catch (err) { toast(err.message, true); }
  })
);

el('btn-settings').addEventListener('click', sheetSettings);

(async function boot() {
  try {
    const out = await api('/api/me');
    user = out.user;
    showWallet();
  } catch {
    el('screen-auth').hidden = false;
  }
})();
