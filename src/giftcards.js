'use strict';
// Gift cards: sold as products or issued by staff, redeemed at checkout and the point of sale.
// Only a SHA-256 hash of each code is stored, so a database leak doesn't expose usable codes; the
// code is shown once to staff (manual cards) or emailed to the recipient (purchased cards).
const crypto = require('node:crypto');
const { get, all, run, insert, tx } = require('./db');
const settings = require('./settings');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hash = (code) => crypto.createHash('sha256').update(normalize(code)).digest('hex');

function newCode() {
  const bytes = crypto.randomBytes(16);
  const raw = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return raw.match(/.{4}/g).join('-');
}

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

function defaultExpiry() {
  const months = Number(settings.load('gift_cards').expiry_months) || 0;
  if (!months) return null;
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// Creates a card and returns { id, code }. The plain code is never stored.
async function create({ value, expiresOn = defaultExpiry(), customerId = null, recipientEmail = '', recipientName = '', senderName = '', message = '', orderId = null, orderItemId = null, seq = 1, note = '', createdBy = '' }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const row = await get(`INSERT INTO gift_cards (code_hash, last4, initial_value, balance, expires_on, customer_id, recipient_email, recipient_name, sender_name, message, order_id, order_item_id, seq, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
    hash(code), code.slice(-4), value, value, expiresOn, customerId, recipientEmail, recipientName, senderName, message, orderId, orderItemId, seq, note, createdBy);
    const id = row && row.id;
    if (id) {
      await insert('INSERT INTO gift_card_transactions (gift_card_id, order_id, amount, note, created_by) VALUES (?, ?, ?, ?, ?)', id, orderId, value, orderId ? 'Purchased' : (note || 'Issued'), createdBy);
      return { id, code };
    }
    if (orderItemId && await get('SELECT 1 FROM gift_cards WHERE order_item_id = ? AND seq = ?', orderItemId, seq)) return null; // already issued
  }
  throw new Error('Could not create a unique gift card code.');
}

function usable(card) {
  if (!card) return 'That gift card code isn’t valid.';
  if (card.status !== 'active') return 'That gift card has been disabled.';
  if (card.expires_on && ymd(card.expires_on) < new Date().toISOString().slice(0, 10)) return 'That gift card has expired.';
  if (card.balance <= 0) return 'That gift card has no balance left.';
  return null;
}

async function find(code) {
  const n = normalize(code);
  if (n.length < 12) return { error: 'That gift card code isn’t valid.' };
  const card = await get('SELECT * FROM gift_cards WHERE code_hash = ?', hash(n));
  const error = usable(card);
  return error ? { error } : { card };
}

// Takes up to `amount` from the card inside the caller's transaction. Returns the amount taken.
async function redeem(cardId, orderId, amount, by = '') {
  const card = await get('SELECT * FROM gift_cards WHERE id = ? FOR UPDATE', cardId);
  const error = usable(card);
  if (error) throw Object.assign(new Error(error), { status: 409 });
  const take = Math.min(card.balance, Math.max(0, amount));
  if (take <= 0) return 0;
  await run('UPDATE gift_cards SET balance = balance - ? WHERE id = ?', take, cardId);
  await insert('INSERT INTO gift_card_transactions (gift_card_id, order_id, amount, note, created_by) VALUES (?, ?, ?, ?, ?)', cardId, orderId, -take, 'Used on order', by);
  return take;
}

// Puts back whatever an order took from gift cards (order cancelled).
async function restoreForOrder(orderId, by = '') {
  const used = await all("SELECT gift_card_id, SUM(amount) AS amount FROM gift_card_transactions WHERE order_id = ? AND note IN ('Used on order', 'Returned from cancelled order') GROUP BY gift_card_id", orderId);
  for (const u of used) {
    const back = -Number(u.amount);
    if (back <= 0) continue;
    await run('UPDATE gift_cards SET balance = balance + ? WHERE id = ?', back, u.gift_card_id);
    await insert("INSERT INTO gift_card_transactions (gift_card_id, order_id, amount, note, created_by) VALUES (?, ?, ?, 'Returned from cancelled order', ?)", u.gift_card_id, orderId, back, by);
  }
}

async function adjust(cardId, amount, note, by) {
  return tx(async () => {
    const card = await get('SELECT * FROM gift_cards WHERE id = ? FOR UPDATE', cardId);
    if (!card) return null;
    const change = Math.max(-card.balance, amount);
    await run('UPDATE gift_cards SET balance = balance + ? WHERE id = ?', change, cardId);
    await insert('INSERT INTO gift_card_transactions (gift_card_id, amount, note, created_by) VALUES (?, ?, ?, ?)', cardId, change, note || 'Adjusted', by);
    return change;
  });
}

// Issues the cards bought on a paid order and emails each code to its recipient. Safe to repeat.
async function issueForOrder(orderId) {
  const order = await get('SELECT * FROM orders WHERE id = ?', orderId);
  const items = await all("SELECT * FROM order_items WHERE order_id = ? AND product_kind = 'gift_card'", orderId);
  const comms = require('./comms');
  const store = settings.load('store');
  const { formatMoney } = require('./utils');
  for (const item of items) {
    let props = {};
    try { props = JSON.parse(item.properties || '{}'); } catch { props = {}; }
    for (let seq = 1; seq <= item.quantity; seq++) {
      const made = await create({ value: item.price, customerId: order.customer_id, recipientEmail: props.recipient_email || order.email, recipientName: props.recipient_name || '', senderName: props.sender_name || '', message: props.message || '', orderId, orderItemId: item.id, seq });
      if (!made) continue;
      const expires = (await get('SELECT expires_on FROM gift_cards WHERE id = ?', made.id)).expires_on;
      await comms.send('gift_card_received', { email: props.recipient_email || order.email, first_name: props.recipient_name || '' }, {
        code: made.code, amount: formatMoney(item.price, store.currency_symbol), sender: props.sender_name || order.email, message: props.message || '',
        expires: expires ? ` It expires on ${ymd(expires)}.` : '', link: `${comms.base()}/gift-cards/balance`,
      });
    }
  }
}

module.exports = { normalize, hash, newCode, create, find, usable, redeem, restoreForOrder, adjust, issueForOrder, ymd };
