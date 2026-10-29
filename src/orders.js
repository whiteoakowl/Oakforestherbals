'use strict';
// Order lifecycle: placement, payment, fulfillment, refunds and cancellation.
const { get, all, run, tx } = require('./db');
const settings = require('./settings');
const { token } = require('./utils');
const mailer = require('./mailer');

function addEvent(orderId, message, author = '') {
  run('INSERT INTO order_events (order_id, message, author) VALUES (?, ?, ?)', orderId, message, author);
}

function orderName(order) {
  return `${settings.load('store').order_prefix}${order.number}`;
}

function loadOrder(where, value) {
  const order = get(`SELECT * FROM orders WHERE ${where} = ?`, value);
  if (!order) return null;
  order.name = orderName(order);
  order.shipping_address = JSON.parse(order.shipping_address || '{}');
  order.billing_address = JSON.parse(order.billing_address || '{}');
  order.items = all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id);
  order.events = all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id DESC', order.id);
  order.fulfillments = all('SELECT * FROM fulfillments WHERE order_id = ? ORDER BY id', order.id);
  order.customer = order.customer_id ? get('SELECT * FROM customers WHERE id = ?', order.customer_id) : null;
  return order;
}

const orderById = (id) => loadOrder('id', id);
const orderByToken = (t) => loadOrder('token', t);

// Find or create the customer record for a checkout email.
function upsertCustomer({ email, first_name, last_name, phone, accepts_marketing }) {
  const existing = get('SELECT * FROM customers WHERE email = ?', email);
  if (existing) {
    if (accepts_marketing && !existing.accepts_marketing) run('UPDATE customers SET accepts_marketing = 1 WHERE id = ?', existing.id);
    return existing.id;
  }
  return Number(run('INSERT INTO customers (email, first_name, last_name, phone, accepts_marketing) VALUES (?, ?, ?, ?, ?)',
    email, first_name || '', last_name || '', phone || '', accepts_marketing ? 1 : 0).lastInsertRowid);
}

/**
 * Places an order from a priced cart. Decrements inventory, increments discount usage
 * and records the customer. Throws if stock ran out since the cart was built.
 */
function createOrder({ cart, totals, contact, shippingAddress, billingAddress, shipping, discount, payment, note, customerId }) {
  const orderId = tx(() => {
    for (const line of cart.lines) {
      const v = get('SELECT * FROM variants WHERE id = ?', line.variant_id);
      if (v.track_inventory && !v.continue_selling && v.inventory_qty < line.quantity) {
        throw Object.assign(new Error(`Only ${Math.max(0, v.inventory_qty)} of ${line.title} left in stock.`), { status: 409 });
      }
    }
    const cid = customerId || upsertCustomer({
      email: contact.email,
      first_name: shippingAddress.first_name,
      last_name: shippingAddress.last_name,
      phone: contact.phone || shippingAddress.phone,
      accepts_marketing: contact.accepts_marketing,
    });
    const last = get('SELECT MAX(number) AS n FROM orders');
    const number = Math.max(1000, last.n || 1000) + 1;
    const res = run(`INSERT INTO orders (number, token, customer_id, email, phone, financial_status, currency, subtotal,
        discount_total, shipping_total, tax_total, total, discount_code, shipping_method, shipping_address,
        billing_address, payment_method, note) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    number, token(16), cid, contact.email, contact.phone || '', settings.load('store').currency,
    totals.subtotal, totals.discount_total, totals.shipping_total, totals.tax_total, totals.total,
    discount ? discount.code : '', shipping ? shipping.name : '', JSON.stringify(shippingAddress || {}),
    JSON.stringify(billingAddress || shippingAddress || {}), payment.name, note || '');
    const id = Number(res.lastInsertRowid);
    for (const line of cart.lines) {
      run(`INSERT INTO order_items (order_id, product_id, variant_id, title, variant_title, sku, image, price, quantity, requires_shipping)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, line.product_id, line.variant_id, line.title, line.variant_title,
      line.sku, line.image, line.price, line.quantity, line.requires_shipping ? 1 : 0);
      run('UPDATE variants SET inventory_qty = inventory_qty - ? WHERE id = ? AND track_inventory = 1', line.quantity, line.variant_id);
    }
    if (discount) run('UPDATE discounts SET used_count = used_count + 1 WHERE id = ?', discount.id);
    if (!cart.requires_shipping) run("UPDATE orders SET fulfillment_status = 'fulfilled' WHERE id = ?", id);
    addEvent(id, `Order placed by ${contact.email} using ${payment.name}.`);
    return id;
  });

  const order = orderById(orderId);
  mailer.notify('order_confirmation', order.email, `Order ${order.name} confirmed`, 'order-confirmation', { order });
  const staffEmail = settings.load('notifications').staff_order_email;
  if (staffEmail) mailer.notify(null, staffEmail, `[${settings.load('store').name}] New order ${order.name}`, 'staff-order', { order });
  return order;
}

function markPaid(orderId, { ref = '', author = '' } = {}) {
  const order = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order || order.financial_status === 'paid') return;
  run("UPDATE orders SET financial_status = 'paid', payment_ref = COALESCE(NULLIF(?, ''), payment_ref) WHERE id = ?", ref, orderId);
  addEvent(orderId, `Payment of ${(order.total / 100).toFixed(2)} ${order.currency} was marked as received${ref ? ` (ref ${ref})` : ''}.`, author);
}

// items: [{ id, quantity }] of order_items to fulfill; empty = everything remaining.
function fulfill(orderId, { items = [], tracking_company = '', tracking_number = '', tracking_url = '', notify = true, author = '' }) {
  const order = orderById(orderId);
  if (!order) return null;
  const wanted = new Map(items.map((i) => [Number(i.id), Number(i.quantity)]));
  const fulfilled = [];
  tx(() => {
    for (const item of order.items) {
      const remaining = item.quantity - item.fulfilled_qty;
      const qty = wanted.size ? Math.min(remaining, wanted.get(item.id) || 0) : remaining;
      if (qty > 0) {
        run('UPDATE order_items SET fulfilled_qty = fulfilled_qty + ? WHERE id = ?', qty, item.id);
        fulfilled.push({ id: item.id, title: item.title, variant_title: item.variant_title, quantity: qty });
      }
    }
    if (!fulfilled.length) return;
    run('INSERT INTO fulfillments (order_id, tracking_company, tracking_number, tracking_url, items) VALUES (?, ?, ?, ?, ?)',
      orderId, tracking_company, tracking_number, tracking_url, JSON.stringify(fulfilled));
    const left = get('SELECT SUM(quantity - fulfilled_qty) AS n FROM order_items WHERE order_id = ?', orderId).n;
    run('UPDATE orders SET fulfillment_status = ? WHERE id = ?', left > 0 ? 'partial' : 'fulfilled', orderId);
    addEvent(orderId, `${fulfilled.reduce((s, i) => s + i.quantity, 0)} item(s) fulfilled${tracking_number ? ` — tracking ${tracking_company} ${tracking_number}` : ''}.`, author);
  });
  if (fulfilled.length && notify) {
    const fresh = orderById(orderId);
    mailer.notify('shipping_confirmation', fresh.email, `Your order ${fresh.name} is on the way`, 'shipping-confirmation', {
      order: fresh, fulfillment: { tracking_company, tracking_number, tracking_url, items: fulfilled },
    });
  }
  return fulfilled;
}

function refund(orderId, { amount, restock = false, reason = '', author = '' }) {
  const order = orderById(orderId);
  if (!order) return;
  const refundable = order.total - order.refunded_total;
  const value = Math.min(Math.max(0, amount | 0), refundable);
  if (value <= 0 && !restock) return;
  tx(() => {
    if (restock) restockItems(order);
    const refunded = order.refunded_total + value;
    const status = refunded >= order.total ? 'refunded' : refunded > 0 ? 'partially_refunded' : order.financial_status;
    run('UPDATE orders SET refunded_total = ?, financial_status = ? WHERE id = ?', refunded, status, orderId);
    addEvent(orderId, `Refunded ${(value / 100).toFixed(2)} ${order.currency}${restock ? ' and restocked items' : ''}${reason ? ` — ${reason}` : ''}.`, author);
  });
}

function restockItems(order) {
  for (const item of order.items) {
    if (item.variant_id) run('UPDATE variants SET inventory_qty = inventory_qty + ? WHERE id = ? AND track_inventory = 1', item.quantity, item.variant_id);
  }
}

function cancel(orderId, { restock = true, reason = '', author = '', notify = true } = {}) {
  const order = orderById(orderId);
  if (!order || order.status === 'cancelled') return;
  tx(() => {
    if (restock) restockItems(order);
    const financial = order.financial_status === 'paid' ? order.financial_status : 'voided';
    run("UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now'), financial_status = ? WHERE id = ?", financial, orderId);
    addEvent(orderId, `Order cancelled${reason ? ` — ${reason}` : ''}${restock ? '; items restocked' : ''}.`, author);
  });
  if (notify) mailer.notify('order_cancelled', order.email, `Order ${order.name} has been cancelled`, 'order-cancelled', { order, reason });
}

module.exports = { orderById, orderByToken, orderName, createOrder, markPaid, fulfill, refund, cancel, addEvent, upsertCustomer };
