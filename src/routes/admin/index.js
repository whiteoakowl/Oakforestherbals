'use strict';
const express = require('express');
const { requireStaff, requirePermission: allow } = require('../../middleware');
const { navFor, showSettings } = require('../../admin-nav');

const router = express.Router();

router.use(async (req, res, next) => {
  res.locals.adminPath = req.originalUrl.split('?')[0];
  next();
});

router.use(require('./auth'));
router.use(requireStaff);
router.use((req, res, next) => {
  res.locals.adminNav = navFor(res.locals.can);
  res.locals.showSettings = showSettings(res.locals.can);
  next();
});

// Every staff member gets a home page; the sales dashboard needs analytics access.
router.get('/', (req, res, next) => (res.locals.can('analytics.view') ? next() : res.render('admin/home-basic', { title: 'Home' })));
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
