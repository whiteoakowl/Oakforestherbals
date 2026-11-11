'use strict';
// Review moderation: approve, hide, reply to and delete customer reviews.
const express = require('express');
const { get, all, run } = require('../../db');
const audit = require('../../audit');
const { toInt, paginate } = require('../../utils');

const router = express.Router();
const STATUSES = ['pending', 'published', 'hidden'];

router.get('/', async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const total = (await get(`SELECT COUNT(*) AS n FROM product_reviews ${status ? 'WHERE status = ?' : ''}`, ...(status ? [status] : []))).n;
  const pager = paginate(total, req.query.page, 30);
  const reviews = await all(`SELECT r.*, p.title AS product_title, p.handle, c.email FROM product_reviews r JOIN products p ON p.id = r.product_id
    LEFT JOIN customers c ON c.id = r.customer_id ${status ? 'WHERE r.status = ?' : ''} ORDER BY r.status = 'pending' DESC, r.created_at DESC LIMIT ? OFFSET ?`, ...(status ? [status] : []), pager.perPage, pager.offset);
  const counts = Object.fromEntries((await all('SELECT status, COUNT(*) AS n FROM product_reviews GROUP BY status')).map((r) => [r.status, Number(r.n)]));
  res.render('admin/reviews', { title: 'Reviews', reviews, status, pager, counts });
});

router.post('/:id', async (req, res) => {
  const r = await get('SELECT * FROM product_reviews WHERE id = ?', toInt(req.params.id));
  if (r) {
    if (req.body.delete) {
      await run('DELETE FROM product_reviews WHERE id = ?', r.id);
      await audit.record(req, 'review.deleted', { entityType: 'review', entityId: r.id });
    } else {
      const status = STATUSES.includes(req.body.status) ? req.body.status : r.status;
      const reply = req.body.reply !== undefined ? String(req.body.reply).trim().slice(0, 2000) : r.reply;
      await run('UPDATE product_reviews SET status = ?, reply = ?, updated_at = now() WHERE id = ?', status, reply, r.id);
      if (status !== r.status) await audit.record(req, `review.${status}`, { entityType: 'review', entityId: r.id });
    }
  }
  const back = String(req.body.back || '');
  res.redirect(back.startsWith('/admin/reviews') ? back : '/admin/reviews');
});

module.exports = router;
