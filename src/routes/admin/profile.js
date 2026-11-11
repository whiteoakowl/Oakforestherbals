'use strict';
// The signed-in staff member's own profile and password.
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../../db');
const { flash } = require('../../middleware');
const QRCode = require('qrcode');
const twofactor = require('../../twofactor');
const vault = require('../../vault');
const audit = require('../../audit');

const router = express.Router();

router.get('/', async (req, res) => res.render('admin/profile', { title: 'Your profile', twoFactorRequired: twofactor.required(res.locals.staff) }));

router.post('/', async (req, res) => {
  const me = await get('SELECT * FROM staff WHERE id = ?', res.locals.staff.id);
  const { name = '', current_password = '', new_password = '' } = req.body;
  if (name.trim()) await run('UPDATE staff SET name = ? WHERE id = ?', name.trim(), me.id);
  if (new_password) {
    if (!bcrypt.compareSync(current_password, me.password_hash)) {
      flash(req, 'error', 'Your current password is incorrect.');
      return res.redirect('/admin/profile');
    }
    if (new_password.length < 8) {
      flash(req, 'error', 'New password must be at least 8 characters.');
      return res.redirect('/admin/profile');
    }
    if (bcrypt.compareSync(new_password, me.password_hash)) {
      flash(req, 'error', 'Choose a different password from your current one.');
      return res.redirect('/admin/profile');
    }
    await run('UPDATE staff SET password_hash = ?, must_change_password = 0 WHERE id = ?', bcrypt.hashSync(new_password, 10), me.id);
  }
  flash(req, 'success', 'Profile saved.');
  res.redirect('/admin/profile');
});

/* ---------- Two-step sign-in ---------- */

router.get('/two-factor', async (req, res) => {
  const me = res.locals.staff;
  if (me.two_factor) {
    return res.render('admin/two-factor', { title: 'Two-step sign-in', enabled: true, remaining: await twofactor.remainingCodes(me.id), required: twofactor.required(me), codes: null });
  }
  if (!vault.configured()) return res.render('admin/two-factor', { title: 'Two-step sign-in', enabled: false, unavailable: true, codes: null });
  // A fresh secret per visit until it's confirmed; kept only in this person's session.
  req.session.pendingTotp = twofactor.newSecret();
  const url = twofactor.otpauthUrl(req.session.pendingTotp, me.email);
  const qr = await QRCode.toString(url, { type: 'svg', margin: 1, width: 200 });
  res.render('admin/two-factor', { title: 'Two-step sign-in', enabled: false, secret: req.session.pendingTotp.replace(/(.{4})/g, '$1 ').trim(), qr, codes: null });
});

router.post('/two-factor/enable', async (req, res) => {
  const me = res.locals.staff;
  if (me.two_factor || !req.session.pendingTotp) return res.redirect('/admin/profile/two-factor');
  const codes = await twofactor.enable(me.id, req.session.pendingTotp, req.body.code);
  if (!codes) { flash(req, 'error', 'That code didn’t match. Check the time on your phone is set automatically, then scan the new code below.'); return res.redirect('/admin/profile/two-factor'); }
  req.session.pendingTotp = null;
  await audit.record(req, 'staff.two_factor_enabled', { entityType: 'staff', entityId: me.id });
  res.render('admin/two-factor', { title: 'Two-step sign-in', enabled: true, codes, remaining: codes.length, required: twofactor.required(me) });
});

router.post('/two-factor/codes', async (req, res) => {
  const me = res.locals.staff;
  if (!(await twofactor.check(me.id, req.body.code)).ok) { flash(req, 'error', 'That code didn’t work.'); return res.redirect('/admin/profile/two-factor'); }
  const codes = await twofactor.newRecoveryCodes(me.id);
  await audit.record(req, 'staff.recovery_codes_regenerated', { entityType: 'staff', entityId: me.id });
  res.render('admin/two-factor', { title: 'Two-step sign-in', enabled: true, codes, remaining: codes.length, required: twofactor.required(me) });
});

router.post('/two-factor/disable', async (req, res) => {
  const me = res.locals.staff;
  if (twofactor.required(me)) { flash(req, 'error', 'Your store requires two-step sign-in for your role, so it can’t be turned off.'); return res.redirect('/admin/profile/two-factor'); }
  const row = await get('SELECT password_hash FROM staff WHERE id = ?', me.id);
  if (!bcrypt.compareSync(String(req.body.password || ''), row.password_hash) || !(await twofactor.check(me.id, req.body.code)).ok) {
    flash(req, 'error', 'Enter your password and a current code to turn two-step sign-in off.');
    return res.redirect('/admin/profile/two-factor');
  }
  await twofactor.disable(me.id);
  await audit.record(req, 'staff.two_factor_disabled', { entityType: 'staff', entityId: me.id });
  flash(req, 'success', 'Two-step sign-in is off.');
  res.redirect('/admin/profile');
});

module.exports = router;
