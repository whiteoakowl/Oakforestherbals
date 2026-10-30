'use strict';
// Three-step checkout: information -> shipping -> payment, then order status page.
const express = require('express');
const { get } = require('../db');
const settings = require('../settings');
const pricing = require('../pricing');
const orders = require('../orders');
const stripe = require('../stripe');
const { flash } = require('../middleware');
const { toInt, asBool } = require('../utils');
const { COUNTRIES } = require('../countries');

const router = express.Router();

const ADDRESS_FIELDS = ['first_name', 'last_name', 'company', 'address1', 'address2', 'city', 'province', 'zip', 'country', 'phone'];
const pickAddress = (src = {}) => Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, String(src[f] || '').trim().slice(0, 200)]));

function state(req) {
  if (!req.session.checkout) req.session.checkout = {};
  return req.session.checkout;
}

// Everything a checkout step needs to render its order summary.
async function context(req) {
  const co = state(req);
  const cart = await pricing.buildCart(req.session.cart);
  let discount = null;
  let discountError = '';
  if (co.discount_code) {
    const result = await pricing.validateDiscount(co.discount_code, cart, co.email);
    if (result.discount) discount = result.discount;
    else { discountError = result.error; }
  }
  const address = co.address || null;
  const options = address ? await pricing.shippingOptions(cart, address.country, discount) : [];
  const shipping = options.find((o) => o.id === co.shipping_rate_id) || null;
  const totals = await pricing.computeTotals(cart, { discount, shipping, address });
  return { co, cart, discount, discountError, options, shipping, totals, address };
}

function render(res, view, ctx, extra = {}) {
  res.render(`store/checkout/${view}`, {
    title: 'Checkout', layoutless: true, COUNTRIES, checkoutSettings: settings.load('checkout'), ...ctx, ...extra,
  });
}

router.use(async (req, res, next) => {
  if (req.path.startsWith('/thank-you') || req.path.startsWith('/stripe')) return next();
  if (!(req.session.cart || []).length) return res.redirect('/cart');
  const mode = settings.load('checkout').customer_accounts;
  if (mode === 'required' && !res.locals.customer) {
    flash(req, 'info', 'Please log in or create an account to check out.');
    return res.redirect('/account/login?next=/checkout');
  }
  next();
});

router.get('/', async (req, res) => res.redirect('/checkout/information'));

router.get('/information', async (req, res) => {
  const ctx = await context(req);
  if (!ctx.cart.lines.length) return res.redirect('/cart');
  const customer = res.locals.customer;
  if (customer && !ctx.co.email) ctx.co.email = customer.email;
  if (customer && !ctx.co.address) {
    const addr = await get('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, id LIMIT 1', customer.id);
    if (addr) ctx.co.address = pickAddress(addr);
  }
  const prefill = ctx.co.address || { country: 'US', first_name: customer?.first_name, last_name: customer?.last_name };
  render(res, 'information', ctx, { step: 'information', prefill, note: ctx.co.note ?? req.session.cartNote ?? '' });
});

router.post('/information', async (req, res) => {
  const co = state(req);
  const cs = settings.load('checkout');
  const address = pickAddress(req.body);
  const email = String(req.body.email || '').trim().toLowerCase();
  const errors = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address.');
  for (const f of ['last_name', 'address1', 'city', 'zip', 'country']) if (!address[f]) errors.push(`${f.replace('_', ' ').replace('address1', 'address')} is required.`);
  if (cs.require_phone && !address.phone) errors.push('Phone number is required.');
  if (cs.require_company && !address.company) errors.push('Company is required.');
  co.email = email;
  co.address = address;
  co.accepts_marketing = asBool(req.body.accepts_marketing);
  if (cs.order_notes) co.note = String(req.body.note || '').slice(0, 1000);
  if (errors.length) {
    errors.forEach((e) => flash(req, 'error', e.charAt(0).toUpperCase() + e.slice(1)));
    return res.redirect('/checkout/information');
  }
  res.redirect('/checkout/shipping');
});

router.get('/shipping', async (req, res) => {
  const ctx = await context(req);
  if (!ctx.address || !ctx.co.email) return res.redirect('/checkout/information');
  render(res, 'shipping', ctx, { step: 'shipping' });
});

router.post('/shipping', async (req, res) => {
  const ctx = await context(req);
  const chosen = ctx.options.find((o) => o.id === toInt(req.body.shipping_rate_id, -1));
  if (!chosen) {
    flash(req, 'error', 'Choose a shipping method.');
    return res.redirect('/checkout/shipping');
  }
  ctx.co.shipping_rate_id = chosen.id;
  res.redirect('/checkout/payment');
});

function paymentMethods() {
  const p = settings.load('payments');
  const methods = p.manual.filter((m) => m.enabled).map((m) => ({ ...m, kind: 'manual' }));
  if (p.stripe_enabled && p.stripe_secret_key) {
    methods.unshift({ id: 'stripe', name: 'Credit / debit card', instructions: 'You will be redirected to our secure payment page.', kind: 'stripe' });
  }
  return methods;
}

router.get('/payment', async (req, res) => {
  const ctx = await context(req);
  if (!ctx.address) return res.redirect('/checkout/information');
  if (!ctx.shipping) return res.redirect('/checkout/shipping');
  render(res, 'payment', ctx, { step: 'payment', methods: paymentMethods() });
});

router.post('/payment', async (req, res, next) => {
  try {
    const ctx = await context(req);
    if (!ctx.address || !ctx.shipping) return res.redirect('/checkout/information');
    if (ctx.discountError) {
      flash(req, 'error', ctx.discountError);
      return res.redirect('/checkout/payment');
    }
    const method = paymentMethods().find((m) => m.id === req.body.payment_method);
    if (!method) {
      flash(req, 'error', 'Choose a payment method.');
      return res.redirect('/checkout/payment');
    }
    const billing = req.body.billing_same === 'no' ? pickAddress(req.body.billing || {}) : ctx.address;
    if (req.body.billing_same === 'no' && (!billing.address1 || !billing.city || !billing.zip)) {
      flash(req, 'error', 'Complete your billing address.');
      return res.redirect('/checkout/payment');
    }

    let order;
    try {
      order = await orders.createOrder({
        cart: ctx.cart,
        totals: ctx.totals,
        contact: { email: ctx.co.email, phone: ctx.address.phone, accepts_marketing: ctx.co.accepts_marketing },
        shippingAddress: ctx.address,
        billingAddress: billing,
        shipping: ctx.shipping,
        discount: ctx.discount,
        payment: method,
        note: ctx.co.note || '',
        customerId: res.locals.customer ? res.locals.customer.id : null,
      });
    } catch (err) {
      if (err.status !== 409) throw err;
      flash(req, 'error', err.message);
      return res.redirect('/cart');
    }

    req.session.cart = [];
    req.session.cartNote = '';
    req.session.checkout = {};
    req.session.lastOrder = order.token;

    if (method.kind === 'stripe') {
      const base = `${req.protocol}://${req.get('host')}`;
      try {
        return res.redirect(303, await stripe.createCheckoutSession(order, base));
      } catch (err) {
        console.error('[stripe]', err.message);
        req.session.cart = order.items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity }));
        await orders.cancel(order.id, { restock: true, reason: `Card payment could not start: ${err.message}`, notify: false });
        flash(req, 'error', 'We could not start the card payment. Please try again or choose another payment method.');
        return res.redirect('/cart');
      }
    }
    if (order.total === 0) await orders.markPaid(order.id, { ref: 'zero-total' });
    res.redirect(`/checkout/thank-you/${order.token}`);
  } catch (err) { next(err); }
});

router.post('/discount', async (req, res) => {
  const co = state(req);
  if (req.body.remove) {
    co.discount_code = '';
  } else {
    const cart = await pricing.buildCart(req.session.cart);
    const result = await pricing.validateDiscount(req.body.code, cart, co.email);
    if (result.discount) {
      co.discount_code = result.discount.code;
      flash(req, 'success', `Discount ${result.discount.code} applied.`);
    } else {
      flash(req, 'error', result.error);
    }
  }
  const step = ['information', 'shipping', 'payment'].includes(req.body.step) ? req.body.step : 'information';
  res.redirect(`/checkout/${step}`);
});

router.get('/stripe/return', async (req, res, next) => {
  try {
    const order = await orders.orderByToken(String(req.query.order || ''));
    if (!order) return res.redirect('/');
    const session = await stripe.retrieveSession(String(req.query.session_id || ''));
    if (session && session.payment_status === 'paid' && session.client_reference_id === order.token) {
      await orders.markPaid(order.id, { ref: session.payment_intent || session.id });
    }
    res.redirect(`/checkout/thank-you/${order.token}`);
  } catch (err) { next(err); }
});

router.get('/stripe/cancel', async (req, res) => {
  const order = await orders.orderByToken(String(req.query.order || ''));
  if (order && order.financial_status === 'pending' && req.session.lastOrder === order.token) {
    // Put the items back in the cart and release the reserved stock.
    req.session.cart = order.items.filter((i) => i.variant_id).map((i) => ({ variant_id: i.variant_id, quantity: i.quantity }));
    await orders.cancel(order.id, { restock: true, reason: 'Customer abandoned card payment', notify: false });
    flash(req, 'info', 'Payment was cancelled. Your cart has been restored.');
  }
  res.redirect('/cart');
});

router.get('/thank-you/:token', async (req, res, next) => {
  const order = await orders.orderByToken(req.params.token);
  if (!order) return next();
  const method = settings.load('payments').manual.find((m) => m.name === order.payment_method);
  res.render('store/checkout/thank-you', {
    title: `Order ${order.name}`, layoutless: true, order, method,
    checkoutSettings: settings.load('checkout'),
  });
});

module.exports = router;
