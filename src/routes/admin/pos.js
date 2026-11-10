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

const METHODS = { cash: 'Cash', card: 'Card (terminal)', other: 'Other' };

function sale(req) {
  req.session.pos = req.session.pos || { lines: [], customer_id: null, discount_code: '' };
  return req.session.pos;
}

async function priced(req) {
  const s = sale(req);
  const customer = s.customer_id ? await get('SELECT * FROM customers WHERE id = ?', s.customer_id) : null;
  const cart = await pricing.buildCart(s.lines, { priceList: pricing.priceListFor(customer) });
  s.lines = cart.lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }));
  let discount = null;
  let discountError = '';
  if (s.discount_code) {
    const v = await pricing.validateDiscount(s.discount_code, cart, customer ? customer.email : '');
    discount = v.discount || null;
    discountError = v.error || '';
  }
  const pos = settings.load('pos');
  const totals = await pricing.computeTotals(cart, { discount, shipping: null, address: { country: pos.tax_country, province: pos.tax_province } });
  return { s, customer, cart, discount, discountError, totals };
}

function addLine(s, variantId, quantity) {
  const line = s.lines.find((l) => l.variant_id === variantId);
  if (line) line.quantity += quantity; else s.lines.push({ variant_id: variantId, quantity });
}

router.get('/', async (req, res) => {
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
    title: 'Point of sale', q, results, cq, customerResults, ...data, METHODS, posSettings: settings.load('pos'), COUNTRIES,
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

router.post('/complete', async (req, res) => {
  const { s, customer, cart, discount, discountError, totals } = await priced(req);
  const method = Object.hasOwn(METHODS, req.body.method) ? req.body.method : null;
  const tendered = parseMoney(req.body.tendered);
  const email = customer ? customer.email : String(req.body.email || '').trim().toLowerCase();
  const fail = (msg) => { flash(req, 'error', msg); return res.redirect('/admin/pos'); };
  if (!cart.lines.length) return fail('Add at least one product to the sale.');
  if (!method) return fail('Choose how the customer paid.');
  if (s.discount_code && !discount) return fail(`Discount not applied: ${discountError} Remove it or fix it before completing the sale.`);
  if (email && !email.includes('@')) return fail('That receipt email address looks wrong.');
  if (method === 'cash' && (tendered === null || tendered < totals.total)) return fail(`Cash received must be at least ${res.locals.money(totals.total)}.`);

  let order;
  try {
    order = await orders.createOrder({
      cart, totals, discount, shipping: null,
      contact: { email, phone: customer ? customer.phone : '', accepts_marketing: false },
      shippingAddress: {}, billingAddress: {},
      payment: { name: `${METHODS[method]} (in person)` },
      note: String(req.body.note || ''),
      customerId: customer ? customer.id : null,
      source: 'pos',
    });
  } catch (err) {
    if (err.status !== 409) throw err;
    return fail(err.message);
  }
  // Goods are handed over at the counter.
  await run('UPDATE order_items SET fulfilled_qty = quantity WHERE order_id = ?', order.id);
  await run("UPDATE orders SET fulfillment_status = 'fulfilled' WHERE id = ?", order.id);
  await orders.markPaid(order.id, { author: res.locals.staff.name });
  const change = method === 'cash' ? tendered - totals.total : 0;
  await orders.addEvent(order.id, `Sold at the counter by ${res.locals.staff.name}${method === 'cash' ? ` — cash received ${res.locals.money(tendered)}, change ${res.locals.money(change)}` : ''}.`, res.locals.staff.name);
  delete req.session.pos;
  req.session.posReceipt = { order_id: order.id, tendered: method === 'cash' ? tendered : null, change };
  res.redirect(`/admin/pos/receipt/${order.id}`);
});

router.get('/receipt/:id', async (req, res, next) => {
  const order = await orders.orderById(toInt(req.params.id));
  if (!order || order.source !== 'pos') return next();
  const cash = req.session.posReceipt && req.session.posReceipt.order_id === order.id ? req.session.posReceipt : null;
  res.render('admin/pos/receipt', { title: `Receipt ${order.name}`, order, cash });
});

module.exports = router;
