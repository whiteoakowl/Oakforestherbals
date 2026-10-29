'use strict';
// Stripe webhook: marks orders paid even if the shopper never returns to the store.
const crypto = require('node:crypto');
const express = require('express');
const settings = require('../settings');
const orders = require('../orders');

const router = express.Router();

function verify(raw, header, secret) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

router.post('/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = settings.load('payments').stripe_webhook_secret;
  const raw = req.body.toString('utf8');
  if (!secret || !verify(raw, req.get('stripe-signature'), secret)) return res.status(400).send('Invalid signature');
  const event = JSON.parse(raw);
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const order = orders.orderByToken(event.data.object.client_reference_id || '');
    if (order) orders.markPaid(order.id, { ref: event.data.object.payment_intent || event.data.object.id, author: 'Stripe' });
  }
  res.json({ received: true });
});

module.exports = router;
