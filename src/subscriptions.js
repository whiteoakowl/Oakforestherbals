'use strict';
// Subscribe & save. Stripe owns the billing schedule and the card; this keeps a copy of each
// subscription's state (from webhooks) and turns every paid Stripe invoice into an ordinary order,
// so deliveries go through the usual fulfilment, stock and reports.
const { get, all, run } = require('./db');
const settings = require('./settings');
const stripe = require('./stripe');

const INTERVALS = [['', 'Not offered'], ['week', 'Week(s)'], ['month', 'Month(s)']];

function every(sub) {
  const n = Number(sub.interval_count || sub.subscription_interval_count) || 1;
  const unit = sub.interval || sub.subscription_interval;
  return n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
}

const available = () => settings.load('subscriptions').enabled && stripe.stripeConfigured();
const subscriptionPrice = (product, variant) => Math.round(variant.price * (100 - Math.max(0, Math.min(90, Number(product.subscription_discount) || 0))) / 100);

// Countries the store ships to (from its shipping rates), for Stripe's address form.
async function shippingCountries() {
  const list = new Set();
  for (const r of await all('SELECT countries FROM shipping_rates')) {
    for (const c of String(r.countries || '').split(',').map((x) => x.trim().toUpperCase())) if (/^[A-Z]{2}$/.test(c)) list.add(c);
  }
  return list.size ? [...list] : [settings.load('store').country || 'US'];
}

const stamp = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
const periodEnd = (sub) => stamp(sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end));

function addressFromStripe(shipping, fallbackEmail = '') {
  if (!shipping || !shipping.address) return null;
  const a = shipping.address;
  const [first, ...rest] = String(shipping.name || '').split(' ');
  return { first_name: first || '', last_name: rest.join(' '), company: '', address1: a.line1 || '', address2: a.line2 || '', city: a.city || '', province: a.state || '', zip: a.postal_code || '', country: a.country || '', phone: shipping.phone || '', email: fallbackEmail };
}

// Creates or updates our copy of a Stripe subscription. Returns our row.
async function upsert(sub) {
  const m = sub.metadata || {};
  const existing = await get('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', sub.id);
  const status = sub.status || 'incomplete';
  if (existing) {
    await run('UPDATE subscriptions SET status = ?, current_period_end = COALESCE(?, current_period_end), cancel_at_period_end = ?, updated_at = now() WHERE id = ?',
      status, periodEnd(sub), sub.cancel_at_period_end ? 1 : 0, existing.id);
    return get('SELECT * FROM subscriptions WHERE id = ?', existing.id);
  }
  const variant = m.variant_id ? await get('SELECT v.*, p.title AS product_title, p.subscription_interval, p.subscription_interval_count FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', Number(m.variant_id)) : null;
  const title = variant ? `${variant.product_title}${variant.title !== 'Default Title' ? ` — ${variant.title}` : ''}` : 'Subscription';
  const recurring = (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.recurring) || {};
  await run(`INSERT INTO subscriptions (customer_id, variant_id, title, quantity, price, shipping_price, interval, interval_count, status, stripe_subscription_id, stripe_customer_id, current_period_end, cancel_at_period_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stripe_subscription_id) DO NOTHING`,
  Number(m.customer_id) || null, variant ? variant.id : null, title, Number(m.quantity) || 1, Number(m.price) || 0, Number(m.shipping_price) || 0,
  recurring.interval || (variant && variant.subscription_interval) || 'month', recurring.interval_count || (variant && variant.subscription_interval_count) || 1,
  status, sub.id, String(sub.customer || ''), periodEnd(sub), sub.cancel_at_period_end ? 1 : 0);
  return get('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', sub.id);
}

// Checkout finished: remember the delivery address it collected.
async function fromCheckout(session) {
  if (session.mode !== 'subscription' || !session.subscription) return null;
  const sub = await upsert(await stripe.getSubscription(session.subscription));
  const addr = addressFromStripe(session.shipping_details || (session.collected_information && session.collected_information.shipping_details) || null);
  if (addr) await run('UPDATE subscriptions SET shipping_address = ? WHERE id = ?', JSON.stringify(addr), sub.id);
  return sub;
}

const invoiceSubscriptionId = (inv) => inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;

// A paid invoice (first charge or renewal) becomes an order, once.
async function invoicePaid(invoice) {
  const sid = invoiceSubscriptionId(invoice);
  if (!sid) return null;
  let sub = await get('SELECT * FROM subscriptions WHERE stripe_subscription_id = ?', sid);
  if (!sub) sub = await upsert(await stripe.getSubscription(sid));
  const claimed = await run('INSERT INTO subscription_invoices (stripe_invoice_id, subscription_id) VALUES (?, ?) ON CONFLICT DO NOTHING', invoice.id, sub.id);
  if (!claimed.changes) return null;

  const variant = sub.variant_id ? await get('SELECT v.*, p.title AS product_title, p.handle, p.kind AS product_kind FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', sub.variant_id) : null;
  const customer = sub.customer_id ? await get('SELECT * FROM customers WHERE id = ?', sub.customer_id) : null;
  let address = addressFromStripe(invoice.customer_shipping);
  if (!address) address = JSON.parse(sub.shipping_address || '{}');
  if (!address.address1 && sub.stripe_customer_id) {
    try { address = addressFromStripe((await stripe.getCustomer(sub.stripe_customer_id)).shipping) || address; } catch { /* keep what we have */ }
  }
  if (!address.address1 && customer) {
    const a = await get('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, id LIMIT 1', customer.id);
    if (a) address = a;
  }
  const quantity = sub.quantity;
  const line = {
    variant_id: variant ? variant.id : null, product_id: variant ? variant.product_id : null, title: variant ? variant.product_title : sub.title,
    variant_title: variant && variant.title !== 'Default Title' ? variant.title : '', sku: variant ? variant.sku : '', image: '',
    price: sub.price, quantity, line_price: sub.price * quantity, requires_shipping: variant ? Boolean(variant.requires_shipping) : true,
    taxable: true, product_kind: variant ? variant.product_kind : 'standard', properties: null,
  };
  const subtotal = line.line_price;
  const total = Number(invoice.amount_paid) || subtotal + sub.shipping_price;
  const totals = { subtotal, discount_total: 0, shipping_total: sub.shipping_price, tax_total: Math.max(0, total - subtotal - sub.shipping_price), total };
  const email = invoice.customer_email || (customer && customer.email) || '';
  const orders = require('./orders');
  const order = await orders.createOrder({
    cart: { lines: variant ? [line] : [], subtotal, requires_shipping: line.requires_shipping },
    totals, contact: { email, phone: address.phone || '' }, shippingAddress: address, billingAddress: address,
    shipping: { name: `Subscription delivery (${every(sub)})`, price: sub.shipping_price }, discount: null, payment: { name: 'Card (subscription)' },
    note: `Stripe invoice ${invoice.number || invoice.id}`, customerId: sub.customer_id, source: 'subscription', allowOversell: true,
  });
  await run('UPDATE orders SET subscription_id = ? WHERE id = ?', sub.id, order.id);
  await run('UPDATE subscription_invoices SET order_id = ? WHERE stripe_invoice_id = ?', order.id, invoice.id);
  await orders.markPaid(order.id, { ref: invoice.payment_intent || invoice.id, author: 'Stripe' });
  await run("UPDATE subscriptions SET status = CASE WHEN status IN ('incomplete', 'past_due') THEN 'active' ELSE status END, updated_at = now() WHERE id = ?", sub.id);
  const comms = require('./comms');
  await comms.notifyStaff({ kind: 'order', title: `Subscription delivery to pack: order #${order.number}`, link: `/admin/orders/${order.id}`, permission: 'orders.manage' });
  if (variant && variant.track_inventory && (await get('SELECT inventory_qty FROM variants WHERE id = ?', variant.id)).inventory_qty < 0) {
    await comms.notifyStaff({ kind: 'inventory', title: `Not enough ${variant.product_title} in stock for subscription order #${order.number}`, link: `/admin/orders/${order.id}`, permission: 'products.manage' });
  }
  if (!address.address1 && line.requires_shipping) await orders.addEvent(order.id, 'No delivery address was found for this subscription. Contact the customer.');
  return order;
}

async function forCustomer(customerId) {
  return all('SELECT * FROM subscriptions WHERE customer_id = ? ORDER BY id DESC', customerId);
}

module.exports = { INTERVALS, every, available, subscriptionPrice, shippingCountries, upsert, fromCheckout, invoicePaid, forCustomer, addressFromStripe };
