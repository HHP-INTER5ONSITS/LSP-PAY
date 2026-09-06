'use strict';

/**
 * Card handling for LSP-Pay.
 *
 * DEMO MODE. No money moves and no bank is contacted. A card number is
 * validated, reduced to a brand and its last four digits, and then thrown
 * away — it is never written to the database, never logged, and never
 * returned in a response.
 *
 * To go live you replace two functions, `tokenise` and `authorise`, with
 * calls to a real processor. Everything else in the app stays as it is,
 * because the rest of the code only ever sees a token and a last-four.
 */

const crypto = require('crypto');

const BRANDS = [
  { name: 'Visa', test: /^4/, length: [13, 16, 19], cvv: 3 },
  { name: 'Mastercard', test: /^(5[1-5]|2[2-7])/, length: [16], cvv: 3 },
  { name: 'American Express', test: /^3[47]/, length: [15], cvv: 4 },
  { name: 'RuPay', test: /^(60|65|81|82|508)/, length: [16], cvv: 3 },
  { name: 'Discover', test: /^(6011|64[4-9]|65)/, length: [16], cvv: 3 }
];

function brandOf(digits) {
  return BRANDS.find((b) => b.test.test(digits)) || { name: 'Card', length: [16, 19], cvv: 3 };
}

/** Luhn checksum — catches typos, not fraud. */
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Checks a card and reduces it to storable fields.
 * Returns { ok, brand, last4, expMonth, expYear } or { ok:false, message }.
 */
function inspect({ number, expiry, cvv }) {
  const digits = String(number || '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return { ok: false, message: 'Card number should be digits only.' };

  const brand = brandOf(digits);
  if (!brand.length.includes(digits.length))
    return { ok: false, message: `That is not the right length for a ${brand.name} card.` };
  if (!luhnValid(digits)) return { ok: false, message: 'Check the card number — a digit looks wrong.' };

  const m = String(expiry || '').match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!m) return { ok: false, message: 'Enter the expiry as MM/YY.' };

  const expMonth = Number(m[1]);
  const expYear = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (expMonth < 1 || expMonth > 12) return { ok: false, message: 'That month does not exist.' };

  const now = new Date();
  const lastDay = new Date(expYear, expMonth, 0, 23, 59, 59);
  if (lastDay < now) return { ok: false, message: 'That card has expired.' };
  if (expYear > now.getFullYear() + 20) return { ok: false, message: 'Check the expiry year.' };

  const code = String(cvv || '');
  if (!new RegExp(`^\\d{${brand.cvv}}$`).test(code))
    return { ok: false, message: `The security code on a ${brand.name} card is ${brand.cvv} digits.` };

  return { ok: true, brand: brand.name, last4: digits.slice(-4), expMonth, expYear, digits };
}

/**
 * DEMO. A real build sends the card to the processor from the browser and
 * receives a token back; the number never touches this server at all.
 * Here we mint a random token and let `digits` fall out of scope.
 */
function tokenise() {
  return 'demo_card_' + crypto.randomBytes(12).toString('hex');
}

/**
 * DEMO authorisation. Swap this for the processor's charge call.
 * Test behaviour, using the numbers processors conventionally reserve:
 *   4000 0000 0000 9995 → declined, not enough funds
 *   4000 0000 0000 0002 → declined, bank refused
 *   4000 0000 0000 0069 → declined, expired
 *   anything else valid → approved
 */
function authorise(card, amountP) {
  if (amountP > 50000 * 100) return { ok: false, message: 'Card limit is ₹50,000 per transaction.' };

  const declines = {
    '9995': 'Declined — not enough funds on the card.',
    '0002': 'Declined — your bank refused the payment.',
    '0069': 'Declined — the card has expired.'
  };
  if (declines[card.last4]) return { ok: false, message: declines[card.last4] };

  return { ok: true, authCode: 'AUTH' + crypto.randomBytes(3).toString('hex').toUpperCase() };
}

const describe = (card) => `${card.brand} ••••${card.last4}`;

module.exports = { inspect, tokenise, authorise, describe };
