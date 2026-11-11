'use strict';
// Gift cards: list, issue by hand (the code is shown once), adjust balances, disable.
const express = require('express');
const { get, all, run } = require('../../db');
const giftcards = require('../../giftcards');
const audit = require('../../audit');
const comms = require('../../comms');
const { flash } = require('../../middleware');
const { toInt, parseMoney, paginate } = require('../../utils');

const router = express.Router();

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = q ? 'WHERE g.last4 ILIKE ? OR g.recipient_email ILIKE ? OR c.email ILIKE ?' : '';
  const params = q ? [`%${q.slice(-4)}%`, `%${q}%`, `%${q}%`] : [];
  const total = (await get(`SELECT COUNT(*) AS n FROM gift_cards g LEFT JOIN customers c ON c.id = g.customer_id ${where}`, ...params)).n;
  const pager = paginate(total, req.query.page, 50);
  const cards = await all(`SELECT g.*, c.email AS customer_email, o.number AS order_number FROM gift_cards g LEFT JOIN customers c ON c.id = g.customer_id
    LEFT JOIN orders o ON o.id = g.order_id ${where} ORDER BY g.id DESC LIMIT ? OFFSET ?`, ...params, pager.perPage, pager.offset);
  const totals = await get("SELECT COALESCE(SUM(balance), 0) AS outstanding, COUNT(*) FILTER (WHERE status = 'active' AND balance > 0) AS active FROM gift_cards");
  res.render('admin/giftcards/index', { title: 'Gift cards', cards, pager, q, totals, ymd: giftcards.ymd });
});

router.get('/new', (req, res) => res.render('admin/giftcards/new', { title: 'Issue a gift card', issued: null }));

router.post('/new', async (req, res) => {
  const value = parseMoney(req.body.value);
  if (!value || value <= 0) { flash(req, 'error', 'Enter the card’s value.'); return res.redirect('/admin/gift-cards/new'); }
  const email = String(req.body.recipient_email || '').trim().toLowerCase().slice(0, 200);
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on || '') ? req.body.expires_on : null;
  const customer = email ? await get('SELECT id, first_name FROM customers WHERE email = ?', email) : null;
  const made = await giftcards.create({ value, expiresOn: expires, customerId: customer ? customer.id : null, recipientEmail: email, recipientName: String(req.body.recipient_name || '').slice(0, 100), note: String(req.body.note || '').slice(0, 300), createdBy: res.locals.staff.name });
  await audit.record(req, 'gift_card.issued', { entityType: 'gift_card', entityId: made.id, details: { value } });
  if (email && req.body.send === '1') {
    await comms.send('gift_card_received', { email, first_name: String(req.body.recipient_name || (customer && customer.first_name) || '') }, {
      code: made.code, amount: res.locals.money(value), sender: res.locals.store.name, message: String(req.body.message || ''), expires: expires ? ` It expires on ${expires}.` : '', link: `${comms.base()}/gift-cards/balance`,
    });
  }
  // The code is shown this once; only its hash is kept.
  res.render('admin/giftcards/new', { title: 'Gift card issued', issued: { ...made, value, email, sent: Boolean(email && req.body.send === '1') } });
});

router.get('/:id', async (req, res, next) => {
  const card = await get('SELECT g.*, c.email AS customer_email, o.number AS order_number FROM gift_cards g LEFT JOIN customers c ON c.id = g.customer_id LEFT JOIN orders o ON o.id = g.order_id WHERE g.id = ?', toInt(req.params.id));
  if (!card) return next();
  const history = await all('SELECT t.*, o.number AS order_number FROM gift_card_transactions t LEFT JOIN orders o ON o.id = t.order_id WHERE t.gift_card_id = ? ORDER BY t.id DESC', card.id);
  res.render('admin/giftcards/show', { title: `Gift card ••••${card.last4}`, card, history, ymd: giftcards.ymd });
});

router.post('/:id', async (req, res, next) => {
  const card = await get('SELECT * FROM gift_cards WHERE id = ?', toInt(req.params.id));
  if (!card) return next();
  if (req.body.action === 'adjust') {
    const amount = parseMoney(req.body.amount);
    if (!amount) flash(req, 'error', 'Enter an amount (negative to take value off).');
    else {
      const change = await giftcards.adjust(card.id, amount, String(req.body.note || '').slice(0, 300), res.locals.staff.name);
      await audit.record(req, 'gift_card.adjusted', { entityType: 'gift_card', entityId: card.id, details: { change } });
      flash(req, 'success', 'Balance updated.');
    }
  } else if (req.body.action === 'disable' || req.body.action === 'enable') {
    await run('UPDATE gift_cards SET status = ? WHERE id = ?', req.body.action === 'disable' ? 'disabled' : 'active', card.id);
    await audit.record(req, `gift_card.${req.body.action}d`, { entityType: 'gift_card', entityId: card.id });
  } else if (req.body.action === 'expiry') {
    await run('UPDATE gift_cards SET expires_on = ? WHERE id = ?', /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_on || '') ? req.body.expires_on : null, card.id);
  }
  res.redirect(`/admin/gift-cards/${card.id}`);
});

module.exports = router;
