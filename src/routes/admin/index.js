'use strict';
const express = require('express');
const { requireStaff } = require('../../middleware');

const router = express.Router();

router.use((req, res, next) => {
  res.locals.adminPath = req.originalUrl.split('?')[0];
  next();
});

router.use(require('./auth'));
router.use(requireStaff);
router.use(require('./dashboard'));
router.use('/products', require('./products'));
router.use('/collections', require('./collections'));
router.use('/orders', require('./orders'));
router.use('/customers', require('./customers'));
router.use('/discounts', require('./discounts'));
router.use('/content', require('./content'));
router.use('/themes', require('./theme'));
router.use('/settings', require('./settings'));
router.use('/profile', require('./profile'));

router.use((req, res) => res.status(404).render('admin/error', { title: 'Not found', message: 'This admin page does not exist.' }));

module.exports = router;
