'use strict';
// Bundles, gift cards, digital downloads and product reviews.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');
const { get, all, run, insert } = require('../src/db');
const settings = require('../src/settings');

let ctx;
let owner;
const ids = {};

async function product(title, kind, price, qty, extra = {}) {
  const handle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const pid = await insert("INSERT INTO products (title, handle, status, kind) VALUES (?, ?, 'active', ?)", title, handle, kind);
  const vid = await insert(`INSERT INTO variants (product_id, price, inventory_qty, track_inventory, requires_shipping, taxable, cost) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    pid, price, qty, extra.track ?? 1, extra.ship ?? 1, extra.taxable ?? 1, extra.cost ?? null);
  return { pid, vid, handle };
}

// Runs a checkout to the payment step. Returns the payment POST response.
async function checkout(c, email, { pay = true, payment = 'bank' } = {}) {
  await c.post('/checkout/information', { email, first_name: 'Rae', last_name: 'Lee', address1: '1 Elm St', city: 'Portland', province: 'OR', zip: '97201', country: 'US', accepts_marketing: '1' }, '/checkout/information');
  const ship = await c.get('/checkout/shipping');
  const rate = ship.text.match(/name="shipping_rate_id" value="(\d+)"/);
  await c.post('/checkout/shipping', { shipping_rate_id: rate ? rate[1] : '0' }, '/checkout/shipping');
  if (!pay) return null;
  return c.post('/checkout/payment', { payment_method: payment, billing_same: 'yes' }, '/checkout/payment');
}

async function lastOrder(email) {
  return get('SELECT * FROM orders WHERE email = ? ORDER BY id DESC LIMIT 1', email);
}

before(async () => {
  ctx = await start();
  owner = new Client(ctx.base);
  await owner.post('/admin/login', { email: 'owner@example.com', password: 'password123', next: '/admin' }, '/admin/login');
});
after(() => ctx.close());

/* ---------- Bundles ---------- */

test('a bundle is available while its parts are, takes their stock when sold and returns it when cancelled', async () => {
  const tea = await product('Bundle Tea', 'standard', 1200, 5, { cost: 300 });
  const tincture = await product('Bundle Tincture', 'standard', 2000, 2, { cost: 700 });
  const kit = await product('Sleep Kit', 'bundle', 2800, 0, { track: 0 });
  Object.assign(ids, { tea, tincture, kit });
  // Nothing in it yet: can't be bought.
  let page = await owner.get(`/admin/products/${kit.pid}/bundle`);
  assert.match(page.text, /can’t be sold until you add something/);
  await owner.post(`/admin/products/${kit.pid}/bundle`, { variant_id: String(kit.vid), component_id: String(tea.vid), quantity: '2' }, `/admin/products/${kit.pid}/bundle`);
  await owner.post(`/admin/products/${kit.pid}/bundle`, { variant_id: String(kit.vid), component_id: String(tincture.vid), quantity: '1' }, `/admin/products/${kit.pid}/bundle`);
  // A bundle can't contain itself or another bundle.
  await owner.post(`/admin/products/${kit.pid}/bundle`, { variant_id: String(kit.vid), component_id: String(kit.vid), quantity: '1' }, `/admin/products/${kit.pid}/bundle`);
  assert.equal((await get('SELECT COUNT(*) AS n FROM bundle_components WHERE bundle_variant_id = ?', kit.vid)).n, 2);

  page = await new Client(ctx.base).get(`/products/${kit.handle}`);
  assert.match(page.text, /What’s included/);
  assert.match(page.text, /2 × Bundle Tea/);
  assert.match(page.text, /you save \$16\.00/, 'separate price 2×12 + 20 = 44 vs 28 → 16 saved');
  assert.match(page.text, /Add to cart/);

  // Stock allows 2 kits (tea 5/2 = 2, tincture 2/1 = 2). Asking for 3 is capped at 2.
  const c = new Client(ctx.base);
  await c.post('/cart/add', { variant_id: String(kit.vid), quantity: '3' }, `/products/${kit.handle}`);
  assert.match((await c.get('/cart')).text, /value="2"/);
  const res = await checkout(c, 'kit@example.com');
  assert.match(res.location, /thank-you/);
  const order = await lastOrder('kit@example.com');
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', tea.vid)).inventory_qty, 1);
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', tincture.vid)).inventory_qty, 0);
  const item = await get('SELECT * FROM order_items WHERE order_id = ?', order.id);
  assert.equal(item.unit_cost, 2 * 300 + 700, 'cost is the parts added up');
  assert.equal(JSON.parse(item.bundle_snapshot).length, 2);
  // Now sold out, because the tincture is.
  page = await new Client(ctx.base).get(`/products/${kit.handle}`);
  assert.match(page.text, /Sold out/);
  // Cancelling puts the parts back.
  await owner.post(`/admin/orders/${order.id}/cancel`, { restock: '1', reason: 'test' }, `/admin/orders/${order.id}`);
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', tea.vid)).inventory_qty, 5);
  assert.equal((await get('SELECT inventory_qty FROM variants WHERE id = ?', tincture.vid)).inventory_qty, 2);
});

/* ---------- Gift cards ---------- */

test('staff issue a gift card; the code is shown once and only its hash is stored', async () => {
  const res = await owner.post('/admin/gift-cards/new', { value: '30.00', recipient_email: 'friend@example.com', recipient_name: 'Fern', send: '1', note: 'Raffle prize' }, '/admin/gift-cards/new');
  const code = res.text.match(/([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/)[1];
  ids.code = code;
  const card = await get('SELECT * FROM gift_cards ORDER BY id DESC LIMIT 1');
  assert.equal(card.balance, 3000);
  assert.equal(card.last4, code.slice(-4));
  assert.ok(!JSON.stringify(card).includes(code.replace(/-/g, '')), 'plain code not stored');
  const mail = await get("SELECT * FROM email_outbox WHERE to_address = 'friend@example.com' ORDER BY id DESC LIMIT 1");
  assert.match(mail.html, new RegExp(code));
  const show = await owner.get(`/admin/gift-cards/${card.id}`);
  assert.doesNotMatch(show.text, new RegExp(code), 'not shown again');
  // Balance check page.
  const bal = await new Client(ctx.base).post('/gift-cards/balance', { code: code.toLowerCase() }, '/gift-cards/balance');
  assert.match(bal.text, /\$30\.00/);
  ids.card = card.id;
});

test('a gift card pays part of an order, the rest is paid normally, and cancelling gives the balance back', async () => {
  const c = new Client(ctx.base);
  const tea = await product('Card Tea', 'standard', 2500, 10);
  await c.post('/cart/add', { variant_id: String(tea.vid), quantity: '2' }, `/products/${tea.handle}`);
  await checkout(c, 'spender@example.com', { pay: false });
  let res = await c.post('/checkout/gift-card', { code: 'NOPE-NOPE-NOPE-NOPE' }, '/checkout/payment');
  assert.match((await c.get('/checkout/payment')).text, /isn’t valid/);
  res = await c.post('/checkout/gift-card', { code: ids.code }, '/checkout/payment');
  const pay = await c.get('/checkout/payment');
  assert.match(pay.text, /Gift card ••••/);
  assert.match(pay.text, /To pay/);
  res = await c.post('/checkout/payment', { payment_method: 'bank', billing_same: 'yes' }, '/checkout/payment');
  const order = await lastOrder('spender@example.com');
  assert.equal(order.gift_card_total, 3000);
  assert.equal(order.financial_status, 'pending', 'the rest is still to pay by bank transfer');
  assert.equal((await get('SELECT balance FROM gift_cards WHERE id = ?', ids.card)).balance, 0);
  // Paying the rest records two ledger lines.
  await owner.post(`/admin/orders/${order.id}/paid`, { ref: 'BANK1' }, `/admin/orders/${order.id}`);
  const ledger = await all('SELECT method, amount FROM payments WHERE order_id = ? ORDER BY id', order.id);
  assert.deepEqual(ledger.map((l) => [l.method, l.amount]), [['Bank transfer', order.total - 3000], ['Gift card', 3000]]);

  // A second order using a fresh card, then cancelled before payment: balance restored.
  const made = await require('../src/giftcards').create({ value: 1000, createdBy: 'test' });
  const c2 = new Client(ctx.base);
  await c2.post('/cart/add', { variant_id: String(tea.vid), quantity: '1' }, `/products/${tea.handle}`);
  await checkout(c2, 'canceller@example.com', { pay: false });
  await c2.post('/checkout/gift-card', { code: made.code }, '/checkout/payment');
  await c2.post('/checkout/payment', { payment_method: 'bank', billing_same: 'yes' }, '/checkout/payment');
  const o2 = await lastOrder('canceller@example.com');
  assert.equal((await get('SELECT balance FROM gift_cards WHERE id = ?', made.id)).balance, 0);
  await owner.post(`/admin/orders/${o2.id}/cancel`, { restock: '1', reason: 'test' }, `/admin/orders/${o2.id}`);
  assert.equal((await get('SELECT balance FROM gift_cards WHERE id = ?', made.id)).balance, 1000);
});

test('a gift card that covers the whole order needs no other payment', async () => {
  const made = await require('../src/giftcards').create({ value: 50000, createdBy: 'test' });
  const tea = await get("SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.handle = 'card-tea'");
  const c = new Client(ctx.base);
  await c.post('/cart/add', { variant_id: String(tea.id), quantity: '1' }, '/products/card-tea');
  await checkout(c, 'covered@example.com', { pay: false });
  await c.post('/checkout/gift-card', { code: made.code }, '/checkout/payment');
  assert.match((await c.get('/checkout/payment')).text, /covers this order/);
  const res = await c.post('/checkout/payment', { billing_same: 'yes' }, '/checkout/payment');
  assert.match(res.location, /thank-you/);
  const order = await lastOrder('covered@example.com');
  assert.equal(order.financial_status, 'paid');
  assert.equal((await get('SELECT balance FROM gift_cards WHERE id = ?', made.id)).balance, 50000 - order.total);
});

test('buying a gift card emails a code to the recipient once paid, and is not counted as a sale until spent', async () => {
  const gc = await product('Herbal Gift Card', 'gift_card', 5000, 0, { track: 0, ship: 0, taxable: 0 });
  const c = new Client(ctx.base);
  const page = await c.get(`/products/${gc.handle}`);
  assert.match(page.text, /Who is it for\?/);
  await c.post('/cart/add', { variant_id: String(gc.vid), quantity: '1', recipient_email: 'lucky@example.com', recipient_name: 'Lucky', sender_name: 'Rae', gift_message: 'Happy birthday!' }, `/products/${gc.handle}`);
  const res = await checkout(c, 'giver@example.com');
  assert.match(res.location, /thank-you/);
  const order = await lastOrder('giver@example.com');
  assert.equal(order.shipping_total, 0, 'no shipping');
  assert.equal(order.tax_total, 0, 'no tax');
  assert.equal(await get("SELECT 1 FROM email_outbox WHERE to_address = 'lucky@example.com'"), undefined, 'nothing until paid');
  await owner.post(`/admin/orders/${order.id}/paid`, {}, `/admin/orders/${order.id}`);
  const mail = await get("SELECT * FROM email_outbox WHERE to_address = 'lucky@example.com' AND template = 'gift_card_received'");
  assert.ok(mail);
  assert.match(mail.html, /Happy birthday!/);
  assert.match(mail.html, /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  assert.equal((await get('SELECT balance FROM gift_cards WHERE order_id = ?', order.id)).balance, 5000);
  // Marking paid again (or the release button) never issues a second card.
  await owner.post(`/admin/orders/${order.id}/release`, {}, `/admin/orders/${order.id}`);
  assert.equal((await get('SELECT COUNT(*) AS n FROM gift_cards WHERE order_id = ?', order.id)).n, 1);
  // Finance: this month's product sales leave the gift card out.
  const { summary } = require('../src/billing');
  const y = new Date().getUTCFullYear();
  const before = (await summary(`${y}-01-01`, `${y + 1}-01-01`)).months.reduce((s, m) => s + m.product_sales, 0);
  const paidOrders = await all("SELECT total, refunded_total, tax_total FROM orders WHERE status != 'cancelled' AND financial_status IN ('paid', 'partially_refunded')");
  const gross = paidOrders.reduce((s, o) => s + o.total - o.refunded_total - o.tax_total, 0);
  assert.equal(before, gross - 5000);
});

/* ---------- Digital downloads ---------- */

test('digital files are given out through limited links after payment', async () => {
  const ebook = await product('Herbal Remedies eBook', 'digital', 900, 0, { track: 0, ship: 0 });
  // Upload a file through the admin.
  const page = await owner.get(`/admin/products/${ebook.pid}/files`);
  const form = new FormData();
  form.append('_csrf', page.text.match(/name="_csrf" value="([^"]+)"/)[1]);
  form.append('file', new Blob(['%PDF-1.4 the ebook']), 'Remedies Guide.pdf');
  const up = await fetch(`${ctx.base}/admin/products/${ebook.pid}/files`, { method: 'POST', body: form, redirect: 'manual', headers: { cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(up.status, 302);
  assert.equal((await get('SELECT filename FROM digital_files WHERE product_id = ?', ebook.pid)).filename, 'Remedies Guide.pdf');

  await settings.save('downloads', { max_downloads: 2, expiry_days: 30 });
  const c = new Client(ctx.base);
  await c.post('/cart/add', { variant_id: String(ebook.vid), quantity: '1' }, `/products/${ebook.handle}`);
  const res = await checkout(c, 'reader@example.com');
  let thanks = await c.get(res.location);
  assert.match(thanks.text, /once payment is received/);
  const order = await lastOrder('reader@example.com');
  assert.equal(await get('SELECT 1 FROM download_links WHERE order_id = ?', order.id), undefined);
  await owner.post(`/admin/orders/${order.id}/paid`, {}, `/admin/orders/${order.id}`);
  const link = await get('SELECT * FROM download_links WHERE order_id = ?', order.id);
  assert.ok(link);
  const mail = await get("SELECT * FROM email_outbox WHERE to_address = 'reader@example.com' AND template = 'downloads_ready'");
  assert.match(mail.html, new RegExp(`/downloads/${link.token}`));
  thanks = await c.get(res.location);
  assert.match(thanks.text, /Remedies Guide\.pdf/);
  // Two downloads allowed.
  const anyone = new Client(ctx.base);
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${ctx.base}/downloads/${link.token}`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '%PDF-1.4 the ebook');
    assert.match(r.headers.get('content-disposition'), /Remedies Guide\.pdf/);
  }
  assert.equal((await anyone.get(`/downloads/${link.token}`)).status, 410);
  assert.equal((await anyone.get('/downloads/not-a-token')).status, 404);
  // Staff can reset the limit.
  await owner.post(`/admin/orders/${order.id}/downloads/reset`, {}, `/admin/orders/${order.id}`);
  assert.equal((await anyone.get(`/downloads/${link.token}`)).status, 200);
  // Expired links stop working.
  await run("UPDATE download_links SET expires_at = now() - interval '1 day' WHERE id = ?", link.id);
  assert.equal((await anyone.get(`/downloads/${link.token}`)).status, 410);
  // Refunded/cancelled orders lose access.
  await run("UPDATE download_links SET expires_at = NULL, downloads = 0 WHERE id = ?", link.id);
  await run("UPDATE orders SET financial_status = 'refunded' WHERE id = ?", order.id);
  assert.equal((await anyone.get(`/downloads/${link.token}`)).status, 410);
});

/* ---------- Reviews ---------- */

test('only buyers can review; reviews wait for approval, then show with the average rating', async () => {
  const tea = await get("SELECT p.id, p.handle FROM products p WHERE p.handle = 'card-tea'");
  // spender@example.com bought Card Tea (paid). Give them a password to log in.
  const bcrypt = require('bcryptjs');
  await run("UPDATE customers SET password_hash = ? WHERE email IN ('spender@example.com', 'giver@example.com')", bcrypt.hashSync('password123', 4));
  const stranger = new Client(ctx.base);
  await stranger.post('/account/login', { email: 'giver@example.com', password: 'password123' }, '/account/login');
  let page = await stranger.get(`/products/${tea.handle}`);
  assert.match(page.text, /Only customers who bought this product can review it/);
  await stranger.post(`/products/${tea.handle}/reviews`, { rating: '5', title: 'Fake' }, `/products/${tea.handle}`);
  assert.equal((await get('SELECT COUNT(*) AS n FROM product_reviews')).n, 0);

  const buyer = new Client(ctx.base);
  await buyer.post('/account/login', { email: 'spender@example.com', password: 'password123' }, '/account/login');
  page = await buyer.get(`/products/${tea.handle}`);
  assert.match(page.text, /Write a review/);
  await buyer.post(`/products/${tea.handle}/reviews`, { rating: '4', title: 'Lovely blend', body: 'Calming and tasty.' }, `/products/${tea.handle}`);
  const review = await get('SELECT * FROM product_reviews');
  assert.equal(review.status, 'pending');
  assert.equal(review.verified, 1);
  assert.equal(review.author_name, 'Rae L.');
  assert.doesNotMatch((await new Client(ctx.base).get(`/products/${tea.handle}`)).text, /Lovely blend/, 'not shown before approval');
  assert.ok(await get("SELECT 1 FROM notifications WHERE kind = 'review'"));
  // Staff approve and reply.
  await owner.post(`/admin/reviews/${review.id}`, { status: 'published', reply: 'Thank you!' }, '/admin/reviews');
  page = await new Client(ctx.base).get(`/products/${tea.handle}`);
  assert.match(page.text, /Lovely blend/);
  assert.match(page.text, /Verified buyer/);
  assert.match(page.text, /Thank you!/);
  assert.match(page.text, /<strong>4<\/strong> out of 5/);
  assert.match(page.text, /"aggregateRating"/);
  // Editing replaces (one review per customer per product) and goes back to waiting.
  await buyer.post(`/products/${tea.handle}/reviews`, { rating: '5', title: 'Even better' }, `/products/${tea.handle}`);
  assert.equal((await get('SELECT COUNT(*) AS n FROM product_reviews')).n, 1);
  assert.equal((await get('SELECT status FROM product_reviews')).status, 'pending');
  // Bad ratings are refused.
  await buyer.post(`/products/${tea.handle}/reviews`, { rating: '9' }, `/products/${tea.handle}`);
  assert.equal((await get('SELECT rating FROM product_reviews')).rating, 5);
});
