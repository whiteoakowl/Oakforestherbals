'use strict';
// Point of sale: in-person sales from the admin. The sale in progress lives in the staff
// member's session; completing it creates a normal, paid, fulfilled order (source 'pos'), so
// stock, reports, customer history and profitability all see it like any other order.
const express = require('express');
const { get, all, run } = require('../../db');
const settings = require('../../settings');
const pricing = require('../../pricing');
const orders = require('../../orders');
const audit = require('../../audit');
const { flash } = require('../../middleware');
const { toInt, parseMoney, idFromKey } = require('../../utils');
const { COUNTRIES } = require('../../countries');

const router = express.Router();

const terminal = require('../../terminal');
const giftcards = require('../../giftcards');

const METHODS = { cash: 'Cash', card: 'Card (own terminal)', terminal: 'Card reader (Stripe)', other: 'Other' };
const methodsAvailable = () => Object.fromEntries(Object.entries(METHODS).filter(([k]) => k !== 'terminal' || terminal.ready()));

function sale(req) {
  req.session.pos = req.session.pos || { lines: [], customer_id: null, discount_code: '' };
  return req.session.pos;
}

async function priced(req) {
  const s = sale(req);
  const customer = s.customer_id ? await get('SELECT * FROM customers WHERE id = ?', s.customer_id) : null;
  const cart = await pricing.buildCart(s.lines, { priceList: pricing.priceListFor(customer) });
  s.lines = pricing.toSession(cart.lines);
  let discount = null;
  let discountError = '';
  if (s.discount_code) {
    const v = await pricing.validateDiscount(s.discount_code, cart, customer ? customer.email : '');
    discount = v.discount || null;
    discountError = v.error || '';
  }
  const pos = settings.load('pos');
  const totals = await pricing.computeTotals(cart, { discount, shipping: null, address: { country: pos.tax_country, province: pos.tax_province } });
  let giftCard = null;
  let giftCardError = '';
  if (s.gift_card_code) {
    const found = await giftcards.find(s.gift_card_code);
    if (found.error) giftCardError = found.error;
    else {
      const payable = Math.max(0, totals.total - cart.lines.filter((l) => l.product_kind === 'gift_card').reduce((sum, l) => sum + l.line_price, 0));
      giftCard = { id: found.card.id, last4: found.card.last4, balance: found.card.balance, amount: Math.min(found.card.balance, payable) };
    }
  }
  const amountDue = totals.total - (giftCard ? giftCard.amount : 0);
  return { s, customer, cart, discount, discountError, totals, giftCard, giftCardError, amountDue };
}

function addLine(s, variantId, quantity) {
  const line = s.lines.find((l) => l.variant_id === variantId);
  if (line) line.quantity += quantity; else s.lines.push({ variant_id: variantId, quantity });
}

// While a card reader payment is waiting, the sale can't change.
router.use((req, res, next) => {
  const s = req.session.pos;
  if (req.method === 'POST' && s && s.terminal && !req.path.startsWith('/terminal')) {
    flash(req, 'error', 'A card payment is waiting on the reader. Finish or cancel it first.');
    return res.redirect('/admin/pos/terminal');
  }
  next();
});

router.get('/', async (req, res) => {
  if (req.session.pos && req.session.pos.terminal) return res.redirect('/admin/pos/terminal');
  const q = String(req.query.q || '').trim();
  let results = [];
  if (q) {
    results = await all(`SELECT v.id, v.title, v.sku, v.barcode, v.price, v.wholesale_price, v.inventory_qty, v.track_inventory, v.continue_selling,
        p.title AS product_title, (SELECT url FROM product_images WHERE product_id = p.id ORDER BY position, id LIMIT 1) AS image
      FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status = 'active' AND (p.title ILIKE ? OR v.sku ILIKE ? OR v.barcode = ?)
      ORDER BY lower(p.title), v.position LIMIT 30`, `%${q}%`, `%${q}%`, q);
    // A barcode scanner types the code and presses Enter: one exact match goes straight into the sale.
    const exact = results.filter((r) => r.barcode && r.barcode === q);
    if (exact.length === 1) {
      addLine(sale(req), exact[0].id, 1);
      return res.redirect('/admin/pos');
    }
  }
  const cq = String(req.query.customer_q || '').trim();
  const customerResults = cq ? await all(`SELECT id, email, first_name, last_name, customer_group FROM customers
    WHERE email ILIKE ? OR (first_name || ' ' || last_name) ILIKE ? OR phone ILIKE ? ORDER BY lower(first_name), id LIMIT 10`, `%${cq}%`, `%${cq}%`, `%${cq}%`) : [];
  const data = await priced(req);
  res.render('admin/pos/index', {
    title: 'Point of sale', q, results, cq, customerResults, ...data, METHODS: methodsAvailable(), posSettings: settings.load('pos'), COUNTRIES, terminalReady: terminal.ready(),
  });
});

router.post('/add', async (req, res) => {
  const variantId = toInt(req.body.variant_id);
  if (await get("SELECT 1 FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ? AND p.status = 'active'", variantId)) {
    addLine(sale(req), variantId, Math.max(1, toInt(req.body.quantity, 1)));
  }
  res.redirect(`/admin/pos${req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''}`);
});

router.post('/update', async (req, res) => {
  const s = sale(req);
  const qty = req.body.qty || {};
  s.lines = s.lines.map((l) => {
    const key = `id${l.variant_id}`;
    return qty[key] === undefined ? l : { ...l, quantity: toInt(qty[key], l.quantity) };
  }).filter((l) => l.quantity > 0);
  const remove = idFromKey(req.body.remove || '');
  if (remove) s.lines = s.lines.filter((l) => l.variant_id !== remove);
  res.redirect('/admin/pos');
});

router.post('/customer', async (req, res) => {
  const s = sale(req);
  const id = toInt(req.body.customer_id);
  s.customer_id = id && await get('SELECT 1 FROM customers WHERE id = ?', id) ? id : null;
  res.redirect('/admin/pos');
});

router.post('/discount', async (req, res) => {
  sale(req).discount_code = String(req.body.discount_code || '').trim();
  res.redirect('/admin/pos');
});

router.post('/gift-card', async (req, res) => {
  const s = sale(req);
  if (req.body.remove) s.gift_card_code = '';
  else {
    const found = await giftcards.find(req.body.code);
    if (found.error) flash(req, 'error', found.error);
    else s.gift_card_code = giftcards.normalize(req.body.code);
  }
  res.redirect('/admin/pos');
});

router.post('/clear', async (req, res) => {
  delete req.session.pos;
  flash(req, 'success', 'Sale cleared.');
  res.redirect('/admin/pos');
});

router.post('/settings', async (req, res) => {
  if (!res.locals.can('settings.manage')) {
    flash(req, 'error', 'Changing the sales tax location needs the store settings permission.');
    return res.redirect('/admin/pos');
  }
  const country = String(req.body.tax_country || '').toUpperCase();
  await settings.save('pos', {
    tax_country: COUNTRIES.some(([c]) => c === country) ? country : 'US',
    tax_province: String(req.body.tax_province || '').trim().toUpperCase(),
  });
  await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: 'pos' });
  flash(req, 'success', 'Point of sale tax location saved.');
  res.redirect('/admin/pos');
});

// Creates the order for the sale in progress (payment already taken).
async function finishSale(req, res, data, { method, tendered = null, ref = '', note = '', email = '' }) {
  const { customer, cart, discount, totals, giftCard, amountDue } = data;
  const order = await orders.createOrder({
    cart, totals, discount, shipping: null,
    contact: { email, phone: customer ? customer.phone : '', accepts_marketing: false },
    shippingAddress: {}, billingAddress: {},
    payment: { name: amountDue === 0 ? 'Gift card' : `${METHODS[method]}${method === 'terminal' ? '' : ' (in person)'}` },
    note, customerId: customer ? customer.id : null, source: 'pos', giftCard,
  });
  // Goods are handed over at the counter.
  await run('UPDATE order_items SET fulfilled_qty = quantity WHERE order_id = ?', order.id);
  await run("UPDATE orders SET fulfillment_status = 'fulfilled' WHERE id = ?", order.id);
  await orders.markPaid(order.id, { ref, author: res.locals.staff.name });
  const change = method === 'cash' ? tendered - amountDue : 0;
  await orders.addEvent(order.id, `Sold at the counter by ${res.locals.staff.name}${method === 'cash' ? ` — cash received ${res.locals.money(tendered)}, change ${res.locals.money(change)}` : ''}.`, res.locals.staff.name);
  delete req.session.pos;
  req.session.posReceipt = { order_id: order.id, tendered: method === 'cash' ? tendered : null, change };
  return order;
}

router.post('/complete', async (req, res) => {
  const data = await priced(req);
  const { s, customer, cart, discount, discountError, giftCardError, amountDue } = data;
  const method = amountDue === 0 && cart.lines.length ? 'gift_card' : Object.hasOwn(methodsAvailable(), req.body.method) ? req.body.method : null;
  const tendered = parseMoney(req.body.tendered);
  const email = customer ? customer.email : String(req.body.email || '').trim().toLowerCase();
  const fail = (msg) => { flash(req, 'error', msg); return res.redirect('/admin/pos'); };
  if (!cart.lines.length) return fail('Add at least one product to the sale.');
  if (!method) return fail('Choose how the customer paid.');
  if (s.discount_code && !discount) return fail(`Discount not applied: ${discountError} Remove it or fix it before completing the sale.`);
  if (giftCardError) return fail(`Gift card: ${giftCardError}`);
  if (email && !email.includes('@')) return fail('That receipt email address looks wrong.');
  if (method === 'cash' && (tendered === null || tendered < amountDue)) return fail(`Cash received must be at least ${res.locals.money(amountDue)}.`);

  if (method === 'terminal') {
    // Card first; the order is only created once the reader says it's paid.
    try {
      const pi = await terminal.startPayment({ amount: amountDue, description: `${res.locals.store.name} counter sale: ${cart.lines.map((l) => `${l.quantity} × ${l.title}`).join(', ')}`, staff: res.locals.staff.name });
      s.terminal = { pi, amount: amountDue, email, note: String(req.body.note || '') };
      return res.redirect('/admin/pos/terminal');
    } catch (err) {
      return fail(`The card reader couldn’t start the payment: ${err.message}`);
    }
  }
  try {
    const order = await finishSale(req, res, data, { method, tendered, email, note: String(req.body.note || '') });
    res.redirect(`/admin/pos/receipt/${order.id}`);
  } catch (err) {
    if (err.status !== 409) throw err;
    return fail(err.message);
  }
});

/* ---------- Card reader (Stripe Terminal) ---------- */

router.get('/terminal', async (req, res) => {
  const s = req.session.pos;
  if (!s || !s.terminal) return res.redirect('/admin/pos');
  const st = await terminal.status(s.terminal.pi).catch((err) => ({ state: 'error', message: err.message }));
  if (st.state === 'succeeded') {
    const data = await priced(req);
    if (st.amount !== s.terminal.amount || data.amountDue !== s.terminal.amount) {
      // Shouldn't happen (the sale is locked while waiting), but never record a different amount.
      await require('../../comms').notifyStaff({ kind: 'order', title: `Card reader payment ${s.terminal.pi} didn’t match the sale — check it in Stripe`, link: '/admin/pos', permission: 'orders.manage' });
      delete s.terminal;
      flash(req, 'error', 'The amount paid on the reader didn’t match the sale. Nothing was recorded; check the payment in Stripe.');
      return res.redirect('/admin/pos');
    }
    const already = await get('SELECT id FROM orders WHERE payment_ref = ?', st.ref);
    if (already) { delete req.session.pos; return res.redirect(`/admin/pos/receipt/${already.id}`); }
    const { email, note } = s.terminal;
    try {
      const order = await finishSale(req, res, data, { method: 'terminal', ref: st.ref, email, note });
      return res.redirect(`/admin/pos/receipt/${order.id}`);
    } catch (err) {
      if (err.status !== 409) throw err;
      // Paid, but stock ran out meanwhile: record it anyway rather than lose a payment.
      const order = await orders.createOrder({ cart: data.cart, totals: data.totals, discount: data.discount, shipping: null, contact: { email, phone: '' }, shippingAddress: {}, billingAddress: {}, payment: { name: METHODS.terminal }, note, customerId: data.customer ? data.customer.id : null, source: 'pos', giftCard: data.giftCard, allowOversell: true });
      await orders.markPaid(order.id, { ref: st.ref, author: res.locals.staff.name });
      delete req.session.pos;
      return res.redirect(`/admin/pos/receipt/${order.id}`);
    }
  }
  res.render('admin/pos/terminal', { title: 'Waiting for card', st, amount: s.terminal.amount, testMode: terminal.testMode() });
});

router.post('/terminal/cancel', async (req, res) => {
  const s = req.session.pos;
  if (s && s.terminal) {
    const st = await terminal.status(s.terminal.pi).catch(() => ({ state: 'unknown' }));
    if (st.state === 'succeeded') return res.redirect('/admin/pos/terminal'); // paid after all: record it
    await terminal.cancel(s.terminal.pi);
    delete s.terminal;
    flash(req, 'info', 'Card payment cancelled. The sale is still open.');
  }
  res.redirect('/admin/pos');
});

router.post('/terminal/retry', async (req, res) => {
  const s = req.session.pos;
  if (s && s.terminal) await terminal.retry(s.terminal.pi).catch((err) => flash(req, 'error', err.message));
  res.redirect('/admin/pos/terminal');
});

router.post('/terminal/simulate', async (req, res) => {
  const s = req.session.pos;
  if (s && s.terminal && terminal.testMode()) await terminal.simulateTap().catch((err) => flash(req, 'error', err.message));
  res.redirect('/admin/pos/terminal');
});

router.get('/readers', async (req, res) => {
  let readers = [];
  let error = '';
  try { readers = await terminal.listReaders(); } catch (err) { error = err.message; }
  res.render('admin/pos/readers', { title: 'Card readers', readers, error, current: terminal.readerId() });
});

router.post('/readers', async (req, res) => {
  if (!res.locals.can('settings.manage')) { flash(req, 'error', 'Choosing the card reader needs the store settings permission.'); return res.redirect('/admin/pos/readers'); }
  const id = String(req.body.reader || '').trim();
  await settings.save('pos', { terminal_reader: /^tmr_[A-Za-z0-9]+$/.test(id) ? id : '' });
  await audit.record(req, 'settings.updated', { entityType: 'settings', entityId: 'pos.terminal_reader' });
  flash(req, 'success', id ? 'Card reader saved.' : 'Card reader removed.');
  res.redirect('/admin/pos');
});

router.get('/receipt/:id', async (req, res, next) => {
  const order = await orders.orderById(toInt(req.params.id));
  if (!order || order.source !== 'pos') return next();
  const cash = req.session.posReceipt && req.session.posReceipt.order_id === order.id ? req.session.posReceipt : null;
  res.render('admin/pos/receipt', { title: `Receipt ${order.name}`, order, cash });
});

module.exports = router;
