'use strict';
// The signed-in staff member's own profile and password.
const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../../db');
const { flash } = require('../../middleware');

const router = express.Router();

router.get('/', (req, res) => res.render('admin/profile', { title: 'Your profile' }));

router.post('/', (req, res) => {
  const me = get('SELECT * FROM staff WHERE id = ?', res.locals.staff.id);
  const { name = '', current_password = '', new_password = '' } = req.body;
  if (name.trim()) run('UPDATE staff SET name = ? WHERE id = ?', name.trim(), me.id);
  if (new_password) {
    if (!bcrypt.compareSync(current_password, me.password_hash)) {
      flash(req, 'error', 'Your current password is incorrect.');
      return res.redirect('/admin/profile');
    }
    if (new_password.length < 8) {
      flash(req, 'error', 'New password must be at least 8 characters.');
      return res.redirect('/admin/profile');
    }
    run('UPDATE staff SET password_hash = ? WHERE id = ?', bcrypt.hashSync(new_password, 10), me.id);
  }
  flash(req, 'success', 'Profile saved.');
  res.redirect('/admin/profile');
});

module.exports = router;
