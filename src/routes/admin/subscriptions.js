'use strict';
// Subscriptions (Stripe-billed): see who subscribes to what, and cancel on a customer's behalf.
const express = require('express');
const { get, all } = require('../../db');
const subs = require('../../subscriptions');
const stripe = require('../../stripe');
const audit = require('../../audit');
const { flash, requirePermission } = require('../../middleware');
const { toInt } = require('../../utils');

const router = express.Router();

router.get('/', async (req, res) => {
  const list = await all(`SELECT s.*, c.email, c.first_name, c.last_name, (SELECT COUNT(*) FROM orders o WHERE o.subscription_id = s.id) AS deliveries
    FROM subscriptions s LEFT JOIN customers c ON c.id = s.customer_id ORDER BY s.status = 'active' DESC, s.id DESC LIMIT 300`);
  const stats = await get("SELECT COUNT(*) FILTER (WHERE status IN ('active', 'trialing') AND cancel_at_period_end = 0) AS active, COALESCE(SUM((price * quantity + shipping_price) * CASE WHEN interval = 'week' THEN 52.0 / 12 / interval_count ELSE 1.0 / interval_count END) FILTER (WHERE status IN ('active', 'trialing') AND cancel_at_period_end = 0), 0) AS monthly FROM subscriptions");
  res.render('admin/subscriptions', { title: 'Subscriptions', list, stats, every: subs.every, ready: subs.available() });
});

router.post('/:id/cancel', requirePermission('orders.manage'), async (req, res, next) => {
  const sub = await get('SELECT * FROM subscriptions WHERE id = ?', toInt(req.params.id));
  if (!sub || !sub.stripe_subscription_id) return next();
  try {
    const result = req.body.now === '1' ? await stripe.cancelSubscriptionNow(sub.stripe_subscription_id) : await stripe.updateSubscription(sub.stripe_subscription_id, { cancel_at_period_end: 'true' });
    await subs.upsert(result);
    await audit.record(req, 'subscription.cancelled', { entityType: 'subscription', entityId: sub.id, details: { immediately: req.body.now === '1' } });
    flash(req, 'success', req.body.now === '1' ? 'Subscription cancelled now.' : 'Subscription will end after the current period.');
  } catch (err) {
    flash(req, 'error', `Stripe said: ${err.message}`);
  }
  res.redirect('/admin/subscriptions');
});

module.exports = router;
