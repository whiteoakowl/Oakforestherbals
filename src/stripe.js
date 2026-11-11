'use strict';
// Stripe Checkout via the REST API (no SDK). Configure keys in Settings > Payments.
const settings = require('./settings');

const API = 'https://api.stripe.com/v1';

function encode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') encode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

async function call(method, path, body) {
  const key = process.env.STRIPE_SECRET_KEY || settings.load('payments').stripe_secret_key;
  if (!key) throw new Error('Stripe is not configured.');
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? encode(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error ? json.error.message : 'Stripe request failed'), { status: 502 });
  return json;
}

// One line for the whole order keeps Stripe's total identical to ours (discounts, tax, shipping).
async function createCheckoutSession(order, baseUrl) {
  const store = settings.load('store');
  const session = await call('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: order.token,
    customer_email: order.email,
    success_url: `${baseUrl}/checkout/stripe/return?order=${order.token}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/checkout/stripe/cancel?order=${order.token}`,
    metadata: { order_number: order.number },
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: order.currency.toLowerCase(),
          unit_amount: order.total - (order.gift_card_total || 0),
          product_data: { name: `${store.name} order ${order.name}`, description: order.items.map((i) => `${i.quantity} × ${i.title}`).join(', ').slice(0, 500) },
        },
      },
    },
  });
  return session.url;
}

async function retrieveSession(id) {
  if (!id) return null;
  return call('GET', `/checkout/sessions/${encodeURIComponent(id)}`);
}

// Pays all or part of an invoice (e.g. a booking deposit) through Stripe Checkout.
async function createInvoiceSession(invoice, amount, baseUrl) {
  const store = settings.load('store');
  const session = await call('POST', '/checkout/sessions', {
    mode: 'payment',
    client_reference_id: `invoice-${invoice.token}`,
    customer_email: invoice.email || undefined,
    success_url: `${baseUrl}/invoices/${invoice.token}/stripe/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/invoices/${invoice.token}`,
    metadata: { invoice_number: invoice.number },
    line_items: { 0: { quantity: 1, price_data: { currency: store.currency.toLowerCase(), unit_amount: amount, product_data: { name: `${store.name} invoice #${invoice.number}` } } } },
  });
  return session.url;
}

// Subscribe & save: Stripe Checkout in subscription mode. Stripe collects the card and the
// delivery address, then bills on schedule; each paid invoice becomes an order here (webhook).
async function createSubscriptionSession({ customer, stripeCustomerId, product, variant, quantity, unitAmount, shippingPrice, countries, baseUrl }) {
  const store = settings.load('store');
  const cfg = settings.load('subscriptions');
  const recurring = { interval: product.subscription_interval, interval_count: product.subscription_interval_count || 1 };
  const meta = { customer_id: customer.id, variant_id: variant.id, quantity, price: unitAmount, shipping_price: shippingPrice };
  const lineItems = {
    0: { quantity, price_data: { currency: store.currency.toLowerCase(), unit_amount: unitAmount, recurring, product_data: { name: `${product.title}${variant.title && variant.title !== 'Default Title' ? ` — ${variant.title}` : ''}` } } },
  };
  if (shippingPrice > 0) lineItems[1] = { quantity: 1, price_data: { currency: store.currency.toLowerCase(), unit_amount: shippingPrice, recurring, product_data: { name: 'Delivery' } } };
  const session = await call('POST', '/checkout/sessions', {
    mode: 'subscription',
    client_reference_id: `customer-${customer.id}`,
    ...(stripeCustomerId ? { customer: stripeCustomerId } : { customer_email: customer.email }),
    success_url: `${baseUrl}/account/subscriptions?started=1`,
    cancel_url: `${baseUrl}/products/${product.handle}`,
    ...(variant.requires_shipping ? { shipping_address_collection: { allowed_countries: countries } } : {}),
    line_items: lineItems,
    subscription_data: { metadata: meta },
    metadata: meta,
    ...(cfg.automatic_tax ? { automatic_tax: { enabled: true } } : {}),
  });
  return session.url;
}

const getSubscription = (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`);
const updateSubscription = (id, body) => call('POST', `/subscriptions/${encodeURIComponent(id)}`, body);
const cancelSubscriptionNow = (id) => call('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
const getCustomer = (id) => call('GET', `/customers/${encodeURIComponent(id)}`);
async function billingPortal(customerId, returnUrl) {
  return (await call('POST', '/billing_portal/sessions', { customer: customerId, return_url: returnUrl })).url;
}

const stripeConfigured = () => Boolean(settings.load('payments').stripe_enabled && (process.env.STRIPE_SECRET_KEY || settings.load('payments').stripe_secret_key));

module.exports = { call, createCheckoutSession, retrieveSession, createInvoiceSession, stripeConfigured, createSubscriptionSession, getSubscription, updateSubscription, cancelSubscriptionNow, getCustomer, billingPortal };
