'use strict';
// Stripe Terminal, server-driven: the server sends a payment to a Stripe smart reader (BBPOS WisePOS E,
// Stripe Reader S700) on the counter, and the point of sale waits for the customer to tap or insert their
// card. No card data passes through this site. In test mode a simulated reader can "tap" a test card.
const settings = require('./settings');
const stripe = require('./stripe');

const secretKey = () => process.env.STRIPE_SECRET_KEY || settings.load('payments').stripe_secret_key || '';
const testMode = () => secretKey().startsWith('sk_test_');
const readerId = () => settings.load('pos').terminal_reader || '';
const ready = () => Boolean(stripe.stripeConfigured() && readerId());

async function listReaders() {
  const res = await stripe.call('GET', '/terminal/readers?limit=50');
  return (res.data || []).map((r) => ({ id: r.id, label: r.label || r.device_type, device_type: r.device_type, status: r.status, location: r.location }));
}

// Creates the payment and puts it on the reader's screen. Returns the PaymentIntent id.
async function startPayment({ amount, description, staff }) {
  const store = settings.load('store');
  const pi = await stripe.call('POST', '/payment_intents', {
    amount, currency: store.currency.toLowerCase(), payment_method_types: ['card_present'], capture_method: 'automatic',
    description: description.slice(0, 500), metadata: { source: 'pos', staff },
  });
  await stripe.call('POST', `/terminal/readers/${encodeURIComponent(readerId())}/process_payment_intent`, { payment_intent: pi.id });
  return pi.id;
}

// 'succeeded' | 'waiting' | 'declined' (with a message) | 'canceled'
async function status(piId) {
  const pi = await stripe.call('GET', `/payment_intents/${encodeURIComponent(piId)}`);
  if (pi.status === 'succeeded') return { state: 'succeeded', amount: pi.amount_received, ref: pi.latest_charge || pi.id };
  if (pi.status === 'canceled') return { state: 'canceled' };
  if (pi.last_payment_error) return { state: 'declined', message: pi.last_payment_error.message || 'The card was declined.' };
  return { state: 'waiting' };
}

async function cancel(piId) {
  try { await stripe.call('POST', `/terminal/readers/${encodeURIComponent(readerId())}/cancel_action`); } catch { /* reader may be idle already */ }
  try { await stripe.call('POST', `/payment_intents/${encodeURIComponent(piId)}/cancel`); } catch { /* may have completed */ }
}

// Re-sends a declined payment to the reader so the customer can try another card.
const retry = (piId) => stripe.call('POST', `/terminal/readers/${encodeURIComponent(readerId())}/process_payment_intent`, { payment_intent: piId });

// Test mode only: the simulated reader taps a test card.
const simulateTap = () => stripe.call('POST', `/test_helpers/terminal/readers/${encodeURIComponent(readerId())}/present_payment_method`, {});

module.exports = { ready, testMode, readerId, listReaders, startPayment, status, cancel, retry, simulateTap };
