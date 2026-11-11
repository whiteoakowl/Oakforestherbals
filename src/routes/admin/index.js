'use strict';
const express = require('express');
const { requireStaff, requirePermission: allow, flash } = require('../../middleware');
const { navFor, showSettings } = require('../../admin-nav');

const router = express.Router();

router.use(async (req, res, next) => {
  res.locals.adminPath = req.originalUrl.split('?')[0];
  next();
});

router.use(require('./auth'));
router.use(requireStaff);
// Staff who can see patient records are signed out after a period without activity.
router.use((req, res, next) => {
  const staff = res.locals.staff;
  const minutes = Number(require('../../settings').load('security').clinical_idle_minutes) || 0;
  const clinical = [...staff.permissions].some((p) => p.startsWith('clinic.'));
  const now = Date.now();
  if (clinical && minutes > 0 && req.session.lastActive && now - req.session.lastActive > minutes * 60000) {
    return req.session.regenerate(() => {
      flash(req, 'info', `You were signed out after ${minutes} minutes without activity.`);
      res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    });
  }
  req.session.lastActive = now;
  next();
});
// When the owner requires two-step sign-in, staff without it can only reach the page that sets it up.
router.use((req, res, next) => {
  const staff = res.locals.staff;
  if (staff.two_factor || !require('../../twofactor').required(staff)) return next();
  if (req.path.startsWith('/profile') || req.path === '/logout') return next();
  flash(req, 'info', 'Your store requires two-step sign-in. Set it up to continue.');
  res.redirect('/admin/profile/two-factor');
});
router.use(async (req, res, next) => {
  res.locals.adminNav = navFor(res.locals.can);
  res.locals.showSettings = showSettings(res.locals.can);
  if (req.method === 'GET') res.locals.unreadCount = (await require('../../comms').forStaff(res.locals.staff, { unreadOnly: true, limit: 99 })).length;
  next();
});

// Every staff member gets a home page; the sales dashboard needs analytics access.
router.get('/', async (req, res, next) => {
  res.locals.widgets = await require('../../dashboard-widgets').build(res.locals.staff, res.locals.can);
  return res.locals.can('analytics.view') ? next() : res.render('admin/home-basic', { title: 'Home' });
});
router.post('/dashboard/widgets', async (req, res) => {
  const w = require('../../dashboard-widgets');
  const show = new Set([].concat(req.body.show || []));
  await w.setHidden(res.locals.staff.id, w.WIDGETS.map(([k]) => k).filter((k) => !show.has(k)));
  res.redirect('/admin');
});
router.use('/analytics/profitability', allow('costing.manage'), require('./profitability'));
router.use('/analytics', allow('analytics.view'));
router.use(require('./dashboard'));

router.use('/products', allow('products.manage'), require('./products'));
router.use('/collections', allow('products.manage'), require('./collections'));
router.use('/orders', allow('orders.view', 'orders.manage'), require('./orders'));
router.use('/customers', allow('customers.view', 'customers.manage'), require('./customers'));
router.use('/discounts', allow('discounts.manage'), require('./discounts'));
router.use('/costing', allow('costing.manage'), require('./costing'));
router.use('/pos', allow('pos.use'), require('./pos'));
router.use('/clinic/forms', allow('clinic.records.manage'), require('./clinic-forms'));
router.use('/clinic', require('./clinic'));
router.use('/education', allow('education.manage'), require('./education'));
router.use('/schedule', require('./schedule'));
router.use('/communications', require('./communications'));
router.use('/assistant', allow('assistant.use'), require('./assistant'));
router.use('/invoices', allow('invoices.manage'), require('./finance').invoices);
router.use('/finance', require('./finance').finance);
router.use('/herbs', require('./herbs'));
router.use('/inventory', allow('inventory.manage'), require('./inventory'));
router.use('/formulas', require('./formulas'));
router.use('/production', allow('production.manage', 'production.manage'), require('./production'));
router.use('/content', allow('content.manage'), require('./content'));
router.use('/themes', allow('themes.manage'), require('./theme'));
router.use('/settings', require('./access'));
router.use('/settings', require('./settings'));
router.use('/profile', require('./profile'));

router.use(async (req, res) => res.status(404).render('admin/error', { title: 'Not found', message: 'This admin page does not exist.' }));

module.exports = router;
