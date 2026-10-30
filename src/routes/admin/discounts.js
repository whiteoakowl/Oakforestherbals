'use strict';
const express = require('express');
const { get, all, run, insert } = require('../../db');
const { flash } = require('../../middleware');
const { toInt, parseMoney, token } = require('../../utils');

const router = express.Router();

const KINDS = [['percentage', 'Percentage off order'], ['fixed_amount', 'Fixed amount off order'], ['free_shipping', 'Free shipping']];

function statusOf(d) {
  const now = new Date().toISOString().slice(0, 16);
  if (!d.active) return 'disabled';
  if (d.starts_at && d.starts_at > now) return 'scheduled';
  if ((d.ends_at && d.ends_at < now) || (d.usage_limit !== null && d.used_count >= d.usage_limit)) return 'expired';
  return 'active';
}

router.get('/', async (req, res) => {
  const discounts = (await all('SELECT * FROM discounts ORDER BY id DESC')).map((d) => ({ ...d, state: statusOf(d) }));
  res.render('admin/discounts/index', { title: 'Discounts', discounts, KINDS });
});

router.get('/new', async (req, res) => {
  res.render('admin/discounts/edit', { title: 'Create discount', discount: null, KINDS, suggested: token(4).toUpperCase() });
});

router.get('/:id', async (req, res, next) => {
  const discount = await get('SELECT * FROM discounts WHERE id = ?', toInt(req.params.id));
  if (!discount) return next();
  const revenue = await get("SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS sales FROM orders WHERE lower(discount_code) = lower(?) AND status != 'cancelled'", discount.code);
  res.render('admin/discounts/edit', { title: discount.code, discount, KINDS, revenue });
});

function values(body) {
  const kind = KINDS.some(([k]) => k === body.kind) ? body.kind : 'percentage';
  const value = kind === 'percentage' ? Math.min(100, Math.max(0, toInt(body.value))) : kind === 'fixed_amount' ? parseMoney(body.value) || 0 : 0;
  return {
    code: String(body.code || '').trim().toUpperCase().replace(/\s+/g, ''),
    kind,
    value,
    min_subtotal: parseMoney(body.min_subtotal) || 0,
    usage_limit: body.usage_limit === '' || body.usage_limit === undefined ? null : Math.max(0, toInt(body.usage_limit)),
    once_per_customer: body.once_per_customer ? 1 : 0,
    starts_at: body.starts_at || null,
    ends_at: body.ends_at || null,
    active: body.active ? 1 : 0,
  };
}

async function save(req, res, id) {
  const v = values(req.body);
  if (!v.code) {
    flash(req, 'error', 'Enter a discount code.');
    return res.redirect(id ? `/admin/discounts/${id}` : '/admin/discounts/new');
  }
  const clash = await get('SELECT id FROM discounts WHERE code = ? AND id != ?', v.code, id || 0);
  if (clash) {
    flash(req, 'error', 'That code is already in use.');
    return res.redirect(id ? `/admin/discounts/${id}` : '/admin/discounts/new');
  }
  const cols = [v.code, v.kind, v.value, v.min_subtotal, v.usage_limit, v.once_per_customer, v.starts_at, v.ends_at, v.active];
  if (id) {
    await run(`UPDATE discounts SET code = ?, kind = ?, value = ?, min_subtotal = ?, usage_limit = ?, once_per_customer = ?, starts_at = ?,
      ends_at = ?, active = ? WHERE id = ?`, ...cols, id);
  } else {
    id = await insert(`INSERT INTO discounts (code, kind, value, min_subtotal, usage_limit, once_per_customer, starts_at, ends_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...cols);
  }
  flash(req, 'success', 'Discount saved.');
  res.redirect(`/admin/discounts/${id}`);
}

router.post('/new', async (req, res) => save(req, res, null));
router.post('/:id', async (req, res) => save(req, res, toInt(req.params.id)));

router.post('/:id/delete', async (req, res) => {
  await run('DELETE FROM discounts WHERE id = ?', toInt(req.params.id));
  flash(req, 'success', 'Discount deleted.');
  res.redirect('/admin/discounts');
});

module.exports = router;
