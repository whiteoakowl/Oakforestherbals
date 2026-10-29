'use strict';
const express = require('express');
const { get, all, run } = require('../../db');
const orders = require('../../orders');
const pricing = require('../../pricing');
const { COUNTRIES } = require('../../countries');
const { flash } = require('../../middleware');
const { toInt, parseMoney, paginate, csvRow, parseTags, centsToInput, asBool, asList, idFromKey } = require('../../utils');

const router = express.Router();

const TABS = {
  all: "status != 'archived'",
  unfulfilled: "status = 'open' AND fulfillment_status != 'fulfilled'",
  unpaid: "status = 'open' AND financial_status = 'pending'",
  open: "status = 'open'",
  archived: "status = 'archived'",
  cancelled: "status = 'cancelled'",
};

function filters(req) {
  const tab = TABS[req.query.tab] ? req.query.tab : 'all';
  const where = [TABS[tab]];
  const params = [];
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push("(email LIKE ? OR CAST(number AS TEXT) LIKE ? OR shipping_address LIKE ? OR tags LIKE ?)");
    const like = `%${q.replace(/^#/, '')}%`;
    params.push(like, like, like, like);
  }
  if (req.query.financial) { where.push('financial_status = ?'); params.push(req.query.financial); }
  if (req.query.fulfillment) { where.push('fulfillment_status = ?'); params.push(req.query.fulfillment); }
  return { tab, q, where: where.join(' AND '), params };
}

router.get('/', (req, res) => {
  const f = filters(req);
  const total = get(`SELECT COUNT(*) AS n FROM orders WHERE ${f.where}`, ...f.params).n;
  const pager = paginate(total, req.query.page, 25);
  const list = all(`SELECT o.*, (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS item_count
    FROM orders o WHERE ${f.where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...f.params, pager.perPage, pager.offset)
    .map((o) => ({ ...o, name: orders.orderName(o), shipping_address: JSON.parse(o.shipping_address || '{}') }));
  res.render('admin/orders/index', { title: 'Orders', orders: list, pager, tab: f.tab, q: f.q, TABS: Object.keys(TABS) });
});

router.get('/export.csv', (req, res) => {
  const f = filters(req);
  const lines = [csvRow(['Name', 'Email', 'Created at', 'Financial status', 'Fulfillment status', 'Status', 'Subtotal', 'Discount code',
    'Discount amount', 'Shipping', 'Taxes', 'Total', 'Refunded', 'Shipping method', 'Payment method', 'Lineitem quantity',
    'Lineitem name', 'Lineitem price', 'Lineitem sku', 'Shipping name', 'Shipping address1', 'Shipping city', 'Shipping province',
    'Shipping zip', 'Shipping country', 'Note'])];
  for (const o of all(`SELECT * FROM orders WHERE ${f.where} ORDER BY id`, ...f.params)) {
    const a = JSON.parse(o.shipping_address || '{}');
    const items = all('SELECT * FROM order_items WHERE order_id = ?', o.id);
    items.forEach((i, idx) => {
      const head = idx === 0;
      lines.push(csvRow([orders.orderName(o), o.email, o.created_at, head ? o.financial_status : '', head ? o.fulfillment_status : '',
        head ? o.status : '', head ? centsToInput(o.subtotal) : '', head ? o.discount_code : '', head ? centsToInput(o.discount_total) : '',
        head ? centsToInput(o.shipping_total) : '', head ? centsToInput(o.tax_total) : '', head ? centsToInput(o.total) : '',
        head ? centsToInput(o.refunded_total) : '', head ? o.shipping_method : '', head ? o.payment_method : '', i.quantity,
        `${i.title}${i.variant_title ? ` - ${i.variant_title}` : ''}`, centsToInput(i.price), i.sku,
        head ? `${a.first_name || ''} ${a.last_name || ''}`.trim() : '', head ? a.address1 : '', head ? a.city : '',
        head ? a.province : '', head ? a.zip : '', head ? a.country : '', head ? o.note : '']));
    });
  }
  res.attachment('orders.csv').type('text/csv').send(lines.join('\n'));
});

/* ---------- Manual (draft) orders created by staff ---------- */

router.get('/new', (req, res) => {
  const variants = all(`SELECT v.id, v.title, v.price, v.inventory_qty, v.track_inventory, p.title AS product_title
    FROM variants v JOIN products p ON p.id = v.product_id WHERE p.status = 'active' ORDER BY p.title COLLATE NOCASE, v.position`);
  res.render('admin/orders/new', { title: 'Create order', variants, COUNTRIES });
});

router.post('/new', (req, res) => {
  const lines = asList(req.body.lines).filter((l) => l && toInt(l.variant_id) && toInt(l.quantity) > 0);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!lines.length || !email.includes('@')) {
    flash(req, 'error', 'Add at least one product and a customer email.');
    return res.redirect('/admin/orders/new');
  }
  const cart = pricing.buildCart(lines.map((l) => ({ variant_id: toInt(l.variant_id), quantity: toInt(l.quantity) })));
  const fields = ['first_name', 'last_name', 'company', 'address1', 'address2', 'city', 'province', 'zip', 'country', 'phone'];
  const address = Object.fromEntries(fields.map((f) => [f, String(req.body[f] || '').trim()]));
  const shipping = { name: String(req.body.shipping_name || 'Custom shipping'), price: parseMoney(req.body.shipping_price) || 0 };
  const discount = req.body.discount_code ? pricing.validateDiscount(req.body.discount_code, cart, email).discount || null : null;
  const totals = pricing.computeTotals(cart, { discount, shipping, address });
  let order;
  try {
    order = orders.createOrder({
      cart, totals, discount, shipping,
      contact: { email, phone: address.phone, accepts_marketing: false },
      shippingAddress: address, billingAddress: address,
      payment: { name: req.body.mark_paid ? 'Manual (paid)' : 'Manual (invoice)' },
      note: String(req.body.note || ''),
    });
  } catch (err) {
    if (err.status !== 409) throw err;
    flash(req, 'error', err.message);
    return res.redirect('/admin/orders/new');
  }
  orders.addEvent(order.id, `Order created by staff.`, author(res));
  if (req.body.mark_paid) orders.markPaid(order.id, { author: author(res) });
  flash(req, 'success', `Order ${order.name} created.`);
  res.redirect(back(order.id));
});

router.get('/:id', (req, res, next) => {
  const order = orders.orderById(toInt(req.params.id));
  if (!order) return next();
  const customerStats = order.customer_id
    ? get("SELECT COUNT(*) AS orders, COALESCE(SUM(total - refunded_total), 0) AS spent FROM orders WHERE customer_id = ? AND status != 'cancelled'", order.customer_id)
    : null;
  const prevOrder = get('SELECT id FROM orders WHERE id < ? ORDER BY id DESC LIMIT 1', order.id);
  const nextOrder = get('SELECT id FROM orders WHERE id > ? ORDER BY id LIMIT 1', order.id);
  res.render('admin/orders/show', { title: `Order ${order.name}`, order, customerStats, prevOrder, nextOrder });
});

router.get('/:id/packing-slip', (req, res, next) => {
  const order = orders.orderById(toInt(req.params.id));
  if (!order) return next();
  res.render('admin/orders/packing-slip', { title: `Packing slip ${order.name}`, order, bare: true });
});

const author = (res) => res.locals.staff.name;
const back = (id) => `/admin/orders/${id}`;

router.post('/:id/paid', (req, res) => {
  orders.markPaid(toInt(req.params.id), { ref: String(req.body.ref || ''), author: author(res) });
  flash(req, 'success', 'Order marked as paid.');
  res.redirect(back(req.params.id));
});

router.post('/:id/fulfill', (req, res) => {
  const qty = req.body.qty || {};
  const items = Object.entries(qty).map(([key, quantity]) => ({ id: idFromKey(key), quantity: toInt(quantity) })).filter((i) => i.quantity > 0);
  if (!items.length) {
    flash(req, 'error', 'Choose at least one item to fulfill.');
    return res.redirect(back(req.params.id));
  }
  const done = orders.fulfill(toInt(req.params.id), {
    items,
    tracking_company: String(req.body.tracking_company || ''),
    tracking_number: String(req.body.tracking_number || ''),
    tracking_url: /^https?:\/\//.test(req.body.tracking_url || '') ? req.body.tracking_url : '',
    notify: asBool(req.body.notify),
    author: author(res),
  });
  flash(req, done && done.length ? 'success' : 'error', done && done.length ? 'Items fulfilled.' : 'Nothing left to fulfill.');
  res.redirect(back(req.params.id));
});

router.post('/:id/refund', (req, res) => {
  orders.refund(toInt(req.params.id), {
    amount: parseMoney(req.body.amount) || 0,
    restock: asBool(req.body.restock),
    reason: String(req.body.reason || ''),
    author: author(res),
  });
  flash(req, 'success', 'Refund recorded. Remember to return the funds through your payment provider if it was not automatic.');
  res.redirect(back(req.params.id));
});

router.post('/:id/cancel', (req, res) => {
  orders.cancel(toInt(req.params.id), { restock: asBool(req.body.restock), reason: String(req.body.reason || ''), author: author(res) });
  flash(req, 'success', 'Order cancelled.');
  res.redirect(back(req.params.id));
});

router.post('/:id/archive', (req, res) => {
  const id = toInt(req.params.id);
  const order = get('SELECT status FROM orders WHERE id = ?', id);
  if (order && order.status !== 'cancelled') {
    const next = order.status === 'archived' ? 'open' : 'archived';
    run('UPDATE orders SET status = ? WHERE id = ?', next, id);
    orders.addEvent(id, next === 'archived' ? 'Order archived.' : 'Order unarchived.', author(res));
  }
  res.redirect(back(id));
});

router.post('/:id/comment', (req, res) => {
  const message = String(req.body.message || '').trim();
  if (message) orders.addEvent(toInt(req.params.id), message, author(res));
  res.redirect(back(req.params.id));
});

router.post('/:id/details', (req, res) => {
  run('UPDATE orders SET note = ?, tags = ? WHERE id = ?', String(req.body.note || ''), parseTags(req.body.tags).join(', '), toInt(req.params.id));
  flash(req, 'success', 'Order updated.');
  res.redirect(back(req.params.id));
});

router.post('/:id/address', (req, res) => {
  const fields = ['first_name', 'last_name', 'company', 'address1', 'address2', 'city', 'province', 'zip', 'country', 'phone'];
  const address = Object.fromEntries(fields.map((f) => [f, String(req.body[f] || '')]));
  run('UPDATE orders SET shipping_address = ? WHERE id = ?', JSON.stringify(address), toInt(req.params.id));
  orders.addEvent(toInt(req.params.id), 'Shipping address updated.', author(res));
  res.redirect(back(req.params.id));
});

module.exports = router;
