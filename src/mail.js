'use strict';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function config() {
  return {
    key: process.env.RESEND_API_KEY,
    from: process.env.MAIL_FROM || 'LSP-Pay <onboarding@resend.dev>',
    brand: 'LSP-Pay'
  };
}

async function send({ to, subject, html }) {
  const { key, from } = config();

  // No key configured: log instead of sending so the app still runs locally.
  if (!key) {
    console.log(`\n[mail:dev] to=${to}\n[mail:dev] subject=${subject}\n`);
    return { delivered: false, reason: 'RESEND_API_KEY is not set' };
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from, to: [to], subject, html })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[mail] Resend rejected the request:', res.status, body);
    return { delivered: false, reason: `Resend returned ${res.status}` };
  }
  return { delivered: true };
}

const shell = (heading, body) => `
<div style="margin:0;padding:32px 16px;background:#100E1D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#1A182C;border:1px solid #2E2A45;border-radius:18px;overflow:hidden;">
    <div style="padding:22px 28px;border-bottom:1px solid #2E2A45;">
      <span style="color:#D9A441;font-size:18px;letter-spacing:.02em;">LSP&#8209;Pay</span>
      <span style="color:#8E89A6;font-size:12px;margin-left:10px;">Light real server pay</span>
    </div>
    <div style="padding:28px;">
      <h1 style="margin:0 0 14px;color:#F2EEE6;font-size:21px;font-weight:600;">${heading}</h1>
      ${body}
    </div>
    <div style="padding:16px 28px;border-top:1px solid #2E2A45;color:#6E6987;font-size:12px;line-height:1.6;">
      LSP-Pay never asks for your PIN or codes over email, chat or phone.
    </div>
  </div>
</div>`;

const codeBlock = (code) => `
<div style="margin:20px 0;padding:18px;background:#100E1D;border:1px solid #3A3357;border-radius:12px;text-align:center;">
  <span style="color:#D9A441;font-size:34px;letter-spacing:.22em;font-weight:600;">${code}</span>
</div>`;

const p = (text) => `<p style="margin:0 0 12px;color:#B8B2CC;font-size:15px;line-height:1.65;">${text}</p>`;

async function sendLoginCode(to, code) {
  return send({
    to,
    subject: `${code} is your LSP-Pay sign-in code`,
    html: shell(
      'Sign in to LSP-Pay',
      p('Enter this code to sign in. It expires in 10 minutes.') +
        codeBlock(code) +
        p('If you did not try to sign in, you can ignore this email.')
    )
  });
}

async function sendPinChangeCode(to, code) {
  return send({
    to,
    subject: `${code} is your LSP-Pay PIN change code`,
    html: shell(
      'Confirm your new PIN',
      p('Enter this code in the app to set a new payment PIN. It expires in 10 minutes.') +
        codeBlock(code) +
        p('If you did not request a PIN change, sign in and change your PIN immediately.')
    )
  });
}

async function sendGiftCard(to, { code, faceLabel, buyer, message }) {
  return send({
    to,
    subject: `You received a ${faceLabel} LSP-Pay gift card`,
    html: shell(
      `${buyer} sent you a gift card`,
      p(`Worth <strong style="color:#F2EEE6;">${faceLabel}</strong>. Sign in to LSP-Pay with this email address and redeem the code below.`) +
        codeBlock(code) +
        (message ? p(`&ldquo;${message}&rdquo;`) : '')
    )
  });
}

async function sendReceipt(to, { title, amountLabel, reference, detail, balanceLabel, points }) {
  const row = (k, v) =>
    `<tr><td style="padding:9px 0;color:#8E89A6;font-size:14px;">${k}</td><td style="padding:9px 0;color:#F2EEE6;font-size:14px;text-align:right;">${v}</td></tr>`;
  return send({
    to,
    subject: `Paid ${amountLabel} — ${title}`,
    html: shell(
      'Payment successful',
      `<div style="margin:0 0 18px;color:#F2EEE6;font-size:32px;font-weight:600;">${amountLabel}</div>` +
        `<table style="width:100%;border-collapse:collapse;border-top:1px solid #2E2A45;">
          ${row('Paid to', title)}
          ${detail ? row('Details', detail) : ''}
          ${row('Reference', reference)}
          ${row('Points earned', `+${points}`)}
          ${row('Balance left', balanceLabel)}
        </table>`
    )
  });
}

/** Sends a customer the checkout link for an unpaid order. */
async function sendPaymentLink(to, { merchant, amountLabel, description, checkoutUrl, logoUrl, note }) {
  const button = `
    <a href="${checkoutUrl}" style="display:inline-block;margin:8px 0 18px;padding:14px 26px;background:#D9A441;color:#241A05;font-size:16px;font-weight:600;text-decoration:none;border-radius:12px;">
      Pay ${amountLabel}
    </a>`;

  return send({
    to,
    subject: `${merchant} is requesting ${amountLabel}`,
    html: shell(
      `${merchant} would like ${amountLabel}`,
      (logoUrl ? `<img src="${logoUrl}" alt="" style="max-height:44px;margin:0 0 16px;border-radius:8px;" />` : '') +
        (description ? p(description) : '') +
        (note ? p(note) : '') +
        button +
        p('This link works for 30 minutes and can only be used once.') +
        `<p style="margin:0;color:#6E6987;font-size:12px;word-break:break-all;">${checkoutUrl}</p>`
    )
  });
}

/** Tells a business their money arrived. */
async function sendMerchantAlert(to, { merchant, amountLabel, method, orderId, description }) {
  const row = (k, v) =>
    `<tr><td style="padding:9px 0;color:#8E89A6;font-size:14px;">${k}</td><td style="padding:9px 0;color:#F2EEE6;font-size:14px;text-align:right;">${v}</td></tr>`;

  return send({
    to,
    subject: `${amountLabel} received — ${merchant}`,
    html: shell(
      'Payment received',
      `<div style="margin:0 0 18px;color:#F2EEE6;font-size:32px;font-weight:600;">${amountLabel}</div>` +
        `<table style="width:100%;border-collapse:collapse;border-top:1px solid #2E2A45;">
          ${row('Gateway', merchant)}
          ${description ? row('For', description) : ''}
          ${row('Method', method || '—')}
          ${row('Order', orderId)}
        </table>` +
        p('It has been added to your LSP-Pay balance.')
    )
  });
}


/** Tells a customer their money is coming back. */
async function sendRefundNotice(to, { merchant, amountLabel, orderId, reason }) {
  return send({
    to,
    subject: `${amountLabel} refunded — ${merchant}`,
    html: shell(
      'Refund issued',
      `<div style="margin:0 0 18px;color:#F2EEE6;font-size:32px;font-weight:600;">${amountLabel}</div>` +
        p(`${merchant} has refunded this payment.`) +
        (reason ? p(`Reason: ${reason}`) : '') +
        p(`Order ${orderId}`)
    )
  });
}

module.exports = { send, sendLoginCode, sendPinChangeCode, sendGiftCard, sendReceipt, sendPaymentLink, sendMerchantAlert, sendRefundNotice };
