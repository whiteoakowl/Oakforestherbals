'use strict';
// Abandoned checkouts: when a shopper gives their email at checkout but doesn't finish, one reminder
// email can go out later with a link that restores their cart. Off by default; by default only for
// shoppers who agreed to marketing emails, and anyone can stop them with one click.
const { get, all, run } = require('./db');
const settings = require('./settings');
const { token, formatMoney } = require('./utils');

// Records (or updates) the checkout for this session. Returns its token.
async function track(session, { email, customerId, cart, consent }) {
  const co = session.checkout || {};
  const items = cart.lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, title: l.title, variant_title: l.variant_title, ...(l.properties ? { properties: l.properties } : {}) }));
  if (co.recovery_token) {
    const res = await run(`UPDATE abandoned_checkouts SET email = ?, customer_id = ?, cart = ?, subtotal = ?, consent = ?, updated_at = now()
      WHERE token = ? AND completed_at IS NULL`, email, customerId, JSON.stringify(items), cart.subtotal, consent ? 1 : 0, co.recovery_token);
    if (res.changes) return co.recovery_token;
  }
  const t = token(18);
  await run('INSERT INTO abandoned_checkouts (token, email, customer_id, cart, subtotal, consent) VALUES (?, ?, ?, ?, ?, ?)', t, email, customerId, JSON.stringify(items), cart.subtotal, consent ? 1 : 0);
  co.recovery_token = t;
  session.checkout = co;
  return t;
}

async function complete(tok, orderId) {
  if (tok) await run('UPDATE abandoned_checkouts SET completed_at = now(), order_id = ? WHERE token = ? AND completed_at IS NULL', orderId, tok);
}

// The hourly job: send one reminder for each checkout that has sat untouched long enough.
async function remind(now = new Date()) {
  const cfg = settings.load('abandoned_cart');
  if (!cfg.enabled) return 0;
  const hours = Math.max(1, Number(cfg.delay_hours) || 4);
  const due = await all(`SELECT a.* FROM abandoned_checkouts a WHERE a.completed_at IS NULL AND a.reminded_at IS NULL
      AND a.updated_at <= ? AND a.updated_at > ? ${cfg.require_consent ? 'AND a.consent = 1' : ''}
      AND NOT EXISTS (SELECT 1 FROM marketing_suppressions s WHERE s.email = a.email)
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.email = a.email AND o.created_at >= a.created_at)
    ORDER BY a.id LIMIT 200`, new Date(now.getTime() - hours * 3600000).toISOString(), new Date(now.getTime() - 7 * 86400000).toISOString());
  const comms = require('./comms');
  const store = settings.load('store');
  let sent = 0;
  for (const a of due) {
    const claimed = await run('UPDATE abandoned_checkouts SET reminded_at = now() WHERE id = ? AND reminded_at IS NULL', a.id);
    if (!claimed.changes) continue;
    const items = JSON.parse(a.cart || '[]');
    if (!items.length) continue;
    const customer = a.customer_id ? await get('SELECT first_name FROM customers WHERE id = ?', a.customer_id) : await get('SELECT first_name FROM customers WHERE email = ?', a.email);
    await comms.send('abandoned_cart', { email: a.email, first_name: customer ? customer.first_name : '' }, {
      items: items.map((i) => `${i.quantity} × ${i.title}${i.variant_title ? ` (${i.variant_title})` : ''}`).join('\n') + `\nSubtotal: ${formatMoney(a.subtotal, store.currency_symbol)}`,
      link: `${comms.base()}/cart/recover/${a.token}`, unsubscribe: `${comms.base()}/cart/recover/${a.token}/stop`,
    });
    sent++;
  }
  return sent;
}

module.exports = { track, complete, remind };
