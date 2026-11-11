'use strict';
const express = require('express');
const { get, all, run } = require('../db');
const catalog = require('../catalog');
const { buildCart, priceListFor, toSession } = require('../pricing');
const settings = require('../settings');
const mailer = require('../mailer');
const { flash, throttle } = require('../middleware');
const { paginate, toInt, escapeHtml } = require('../utils');

const router = express.Router();

const SORT_OPTIONS = [
  ['manual', 'Featured'],
  ['best-selling', 'Best selling'],
  ['title-asc', 'Alphabetically, A-Z'],
  ['title-desc', 'Alphabetically, Z-A'],
  ['price-asc', 'Price, low to high'],
  ['price-desc', 'Price, high to low'],
  ['created-desc', 'Date, new to old'],
  ['created-asc', 'Date, old to new'],
];

const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

// Redirect target from the Referer header, only if it points back at this site.
function safeBack(req, fallback) {
  const back = String(req.get('referer') || '');
  return back.startsWith(`${req.protocol}://${req.get('host')}/`) ? back : fallback;
}

router.get('/', async (req, res) => {
  const theme = res.locals.theme;
  const featured = await catalog.collectionByHandle(theme.featured_collection);
  const featuredProducts = (featured ? await catalog.collectionProducts(featured) : await catalog.activeProducts())
    .slice(0, Number(theme.featured_count) || 8);
  const collections = await all('SELECT * FROM collections WHERE published = 1 ORDER BY id LIMIT 6');
  const articles = await all('SELECT * FROM articles WHERE published = 1 ORDER BY published_at DESC LIMIT 3');
  const seo = settings.load('seo');
  res.render('store/home', {
    title: seo.home_title || res.locals.store.name,
    description: seo.home_description,
    featured, featuredProducts, collections, articles,
  });
});

router.get('/collections', async (req, res) => {
  const collections = await all('SELECT * FROM collections WHERE published = 1 ORDER BY title');
  res.render('store/collections', { title: 'Collections', collections });
});

router.get('/collections/:handle', async (req, res, next) => {
  let collection;
  if (req.params.handle === 'all') {
    collection = { id: 0, title: 'All products', handle: 'all', description_html: '', image: '', kind: 'smart', rules: '[]', sort_order: 'created-desc' };
  } else {
    collection = await catalog.collectionByHandle(req.params.handle);
  }
  if (!collection) return next();

  let products = await catalog.collectionProducts(collection);
  const types = [...new Set(products.map((p) => p.product_type).filter(Boolean))].sort();
  const { availability, type } = req.query;
  if (availability === 'in') products = products.filter((p) => p.available);
  if (availability === 'out') products = products.filter((p) => !p.available);
  if (type) products = products.filter((p) => p.product_type === type);
  const sort = SORT_OPTIONS.some(([k]) => k === req.query.sort) ? req.query.sort : 'manual';
  if (sort !== 'manual') await catalog.sortProducts(products, sort);

  const pager = paginate(products.length, req.query.page, Number(res.locals.theme.products_per_page) || 12);
  res.render('store/collection', {
    title: collection.seo_title || collection.title,
    description: collection.seo_description,
    collection, types, sort, SORT_OPTIONS, pager,
    products: products.slice(pager.offset, pager.offset + pager.perPage),
  });
});

async function renderProduct(req, res, next) {
  const product = await catalog.productByHandle(req.params.handle);
  if (!product) return next();
  const related = await catalog.hydrateMany(await all(`SELECT p.* FROM products p WHERE p.status = 'active' AND p.id != ? AND p.product_type = ?
    ORDER BY RANDOM() LIMIT 4`, product.id, product.product_type));
  const selected = product.variants.find((v) => String(v.id) === String(req.query.variant))
    || product.variants.find(catalog.isVariantAvailable) || product.variants[0];
  const reviewsModule = require('../reviews');
  const reviews = { enabled: settings.load('reviews').enabled, summary: await reviewsModule.summary(product.id), list: await reviewsModule.published(product.id), eligibility: await reviewsModule.eligibility(res.locals.customer, product.id) };
  const subs = require('../subscriptions');
  const subscription = product.subscription_interval && subs.available() ? { every: subs.every(product), price: subs.subscriptionPrice(product, selected), shipping: Number(settings.load('subscriptions').shipping_price) || 0 } : null;
  res.render('store/product', {
    reviews, subscription,
    title: product.seo_title || product.title,
    description: product.seo_description || res.locals.stripHtml(product.description_html).slice(0, 160),
    ogImage: product.image,
    product, related, selected,
    pricesIncludeTax: settings.load('taxes').prices_include_tax,
    variantsJson: safeJson(product.variants.map((v) => ({
      id: v.id, title: v.title, options: [v.option1, v.option2, v.option3].filter((o) => o !== null),
      price: v.price, compare_at_price: v.compare_at_price, available: catalog.isVariantAvailable(v),
      sku: v.sku, inventory: v.track_inventory ? v.inventory_qty : null,
    }))),
  });
}
router.get('/products/:handle', renderProduct);

router.post('/products/:handle/reviews', async (req, res, next) => {
  const product = await catalog.productByHandle(req.params.handle);
  if (!product) return next();
  const out = await require('../reviews').submit(res.locals.customer, product.id, req.body);
  if (out.error) flash(req, 'error', out.error);
  else {
    flash(req, 'success', out.status === 'published' ? 'Thank you — your review is up.' : 'Thank you — your review will appear once we’ve checked it.');
    if (out.status === 'pending') await require('../comms').notifyStaff({ kind: 'review', title: `New review of ${product.title} waiting for approval`, link: '/admin/reviews?status=pending', permission: 'products.manage' });
  }
  res.redirect(`/products/${product.handle}#reviews`);
});

/* ---------- Subscribe & save ---------- */

router.post('/subscriptions/start', async (req, res) => {
  const subs = require('../subscriptions');
  const stripe = require('../stripe');
  const variant = await get(`SELECT v.*, p.title AS product_title, p.handle FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.id = ? AND p.status = 'active' AND p.subscription_interval != ''`, toInt(req.body.variant_id));
  if (!variant || !subs.available()) { flash(req, 'error', 'That product can’t be subscribed to.'); return res.redirect(safeBack(req, '/')); }
  if (!res.locals.customer) {
    flash(req, 'info', 'Log in or create an account to subscribe, so you can manage your deliveries.');
    return res.redirect(`/account/login?next=${encodeURIComponent(`/products/${variant.handle}?variant=${variant.id}`)}`);
  }
  const product = await get('SELECT * FROM products WHERE id = ?', variant.product_id);
  const quantity = Math.max(1, Math.min(20, toInt(req.body.quantity, 1)));
  const previous = await get("SELECT stripe_customer_id FROM subscriptions WHERE customer_id = ? AND stripe_customer_id != '' ORDER BY id DESC LIMIT 1", res.locals.customer.id);
  try {
    const url = await stripe.createSubscriptionSession({
      customer: res.locals.customer, stripeCustomerId: previous ? previous.stripe_customer_id : null, product, variant, quantity,
      unitAmount: subs.subscriptionPrice(product, variant), shippingPrice: variant.requires_shipping ? Number(settings.load('subscriptions').shipping_price) || 0 : 0,
      countries: await subs.shippingCountries(), baseUrl: `${req.protocol}://${req.get('host')}`,
    });
    res.redirect(303, url);
  } catch (err) {
    console.error('[stripe subscription]', err.message);
    flash(req, 'error', 'We couldn’t start the subscription. Please try again later.');
    res.redirect(`/products/${variant.handle}`);
  }
});

/* ---------- Downloads and gift card balance ---------- */

router.get('/downloads/:token', async (req, res) => {
  const downloads = require('../downloads');
  const out = await downloads.open(req.params.token);
  if (out.error) return res.status(out.status).render('store/message', { title: 'Download unavailable', heading: 'Download unavailable', message: out.error });
  res.set('Cache-Control', 'no-store');
  const signed = await downloads.storage.signedPrivateUrl(out.link.storage_key, 60);
  if (signed) return res.redirect(302, signed);
  res.attachment(out.link.filename).type(out.link.mime).send(await downloads.storage.readPrivate(out.link.storage_key));
});

router.get('/gift-cards/balance', (req, res) => res.render('store/gift-card-balance', { title: 'Gift card balance', result: null }));
router.post('/gift-cards/balance', throttle('giftcard'), async (req, res) => {
  const found = await require('../giftcards').find(req.body.code);
  const card = found.card || (found.error && found.error !== 'That gift card code isn’t valid.' ? await get('SELECT * FROM gift_cards WHERE code_hash = ?', require('../giftcards').hash(req.body.code)) : null);
  res.render('store/gift-card-balance', { title: 'Gift card balance', result: card ? { balance: card.balance, last4: card.last4, expires: card.expires_on, note: found.error || '' } : { error: found.error } });
});
router.get('/collections/:collection/products/:handle', renderProduct);

router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  let products = [];
  let pages = [];
  let articles = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    products = await catalog.hydrateMany(await all(`SELECT * FROM products WHERE status = 'active' AND (title ILIKE ? OR tags ILIKE ? OR product_type ILIKE ?
      OR vendor ILIKE ? OR description_html ILIKE ?) ORDER BY title LIMIT 48`, like, like, like, like, like));
    pages = await all('SELECT * FROM pages WHERE published = 1 AND (title ILIKE ? OR body_html ILIKE ?) LIMIT 10', like, like);
    articles = await all('SELECT * FROM articles WHERE published = 1 AND (title ILIKE ? OR body_html ILIKE ?) LIMIT 10', like, like);
  }
  res.render('store/search', { title: q ? `Search: ${q}` : 'Search', q, products, pages, articles });
});

// Predictive search for the header search box.
router.get('/search/suggest.json', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ products: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const found = await catalog.hydrateMany(await all("SELECT * FROM products WHERE status = 'active' AND (title ILIKE ? OR tags ILIKE ?) ORDER BY title LIMIT 6", like, like));
  const products = found.map((p) => ({ title: p.title, url: `/products/${p.handle}`, image: p.image, price: res.locals.money(p.price_min) }));
  res.json({ products });
});

/* ---------- Cart ---------- */

async function cartPayload(req, res) {
  const cart = await buildCart(req.session.cart, { priceList: priceListFor(res.locals.customer) });
  return {
    item_count: cart.item_count,
    subtotal: cart.subtotal,
    subtotal_formatted: res.locals.money(cart.subtotal),
    lines: cart.lines.map((l) => ({ ...l, line_price_formatted: res.locals.money(l.line_price) })),
  };
}

router.get('/cart', async (req, res) => {
  const cart = await buildCart(req.session.cart, { priceList: priceListFor(res.locals.customer) });
  // Drop lines that are no longer purchasable so the session matches what we show.
  req.session.cart = toSession(cart.lines);
  res.render('store/cart', { title: 'Your cart', cart, note: req.session.cartNote || '', settingsOrderNotes: settings.load('checkout').order_notes });
});

router.get('/cart.json', async (req, res) => res.json(await cartPayload(req, res)));

router.post('/cart/add', async (req, res) => {
  const variantId = toInt(req.body.variant_id);
  const quantity = Math.max(1, toInt(req.body.quantity, 1));
  const variant = await get(`SELECT v.*, p.kind AS product_kind FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.id = ? AND p.status = 'active'`, variantId);
  if (variant) await require('../bundles').applyStock([variant]);
  const wantsJson = req.xhr || req.accepts(['html', 'json']) === 'json';
  if (!variant || !catalog.isVariantAvailable(variant)) {
    if (wantsJson) return res.status(422).json({ error: 'This item is sold out.' });
    flash(req, 'error', 'Sorry, that item is sold out.');
    return res.redirect(safeBack(req, '/cart'));
  }
  // A gift card carries who it's for; the code is emailed to them once the order is paid.
  let properties = null;
  if (variant.product_kind === 'gift_card') {
    const email = String(req.body.recipient_email || '').trim().toLowerCase().slice(0, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (wantsJson) return res.status(422).json({ error: 'Enter a valid email for the recipient.' });
      flash(req, 'error', 'Enter a valid email for the recipient.');
      return res.redirect(safeBack(req, '/cart'));
    }
    properties = { recipient_email: email, recipient_name: String(req.body.recipient_name || '').trim().slice(0, 100), sender_name: String(req.body.sender_name || '').trim().slice(0, 100), message: String(req.body.gift_message || '').trim().slice(0, 500) };
  }
  const cart = req.session.cart || [];
  const line = cart.find((l) => l.variant_id === variantId);
  if (line) { line.quantity += quantity; if (properties) line.properties = properties; } else cart.push({ variant_id: variantId, quantity, ...(properties ? { properties } : {}) });
  req.session.cart = toSession((await buildCart(cart, { priceList: priceListFor(res.locals.customer) })).lines);
  if (wantsJson) return res.json(await cartPayload(req, res));
  flash(req, 'success', 'Added to your cart.');
  res.redirect('/cart');
});

router.post('/cart/update', async (req, res) => {
  const quantities = req.body.quantities || {};
  const next = [];
  for (const line of req.session.cart || []) {
    const sent = quantities[`id${line.variant_id}`];
    const q = sent !== undefined ? toInt(sent, line.quantity) : line.quantity;
    if (q > 0) next.push({ ...line, quantity: q });
  }
  if (req.body.remove) {
    const removeId = toInt(req.body.remove);
    req.session.cart = next.filter((l) => l.variant_id !== removeId);
  } else {
    req.session.cart = next;
  }
  if (req.body.note !== undefined) req.session.cartNote = String(req.body.note).slice(0, 1000);
  if (req.xhr || req.accepts(['html', 'json']) === 'json') return res.json(await cartPayload(req, res));
  if (req.body.checkout) return res.redirect('/checkout');
  res.redirect('/cart');
});

// Link from a cart reminder email: puts the cart back and continues where they left off.
router.get('/cart/recover/:token', async (req, res) => {
  const a = await get('SELECT * FROM abandoned_checkouts WHERE token = ?', String(req.params.token));
  if (!a || a.completed_at) { flash(req, 'info', 'That cart has already been checked out or has expired.'); return res.redirect('/cart'); }
  const items = JSON.parse(a.cart || '[]').map((i) => ({ variant_id: i.variant_id, quantity: i.quantity, ...(i.properties ? { properties: i.properties } : {}) }));
  req.session.cart = toSession((await buildCart(items, { priceList: priceListFor(res.locals.customer) })).lines);
  req.session.checkout = { email: a.email, recovery_token: a.token };
  await run('UPDATE abandoned_checkouts SET recovered_at = COALESCE(recovered_at, now()) WHERE id = ?', a.id);
  flash(req, 'success', 'Your cart is back.');
  res.redirect('/cart');
});

router.get('/cart/recover/:token/stop', async (req, res) => {
  const a = await get('SELECT email FROM abandoned_checkouts WHERE token = ?', String(req.params.token));
  if (a) await run("INSERT INTO marketing_suppressions (email, reason) VALUES (?, 'cart reminder link') ON CONFLICT DO NOTHING", a.email);
  res.render('store/message', { title: 'Unsubscribed', heading: 'You won’t get cart reminders', message: 'We won’t email you about unfinished checkouts again.' });
});

router.post('/cart/clear', async (req, res) => {
  req.session.cart = [];
  res.redirect('/cart');
});

/* ---------- Content ---------- */

router.get('/pages/contact', async (req, res) => {
  const page = await get("SELECT * FROM pages WHERE handle = 'contact' AND published = 1");
  res.render('store/contact', { title: 'Contact us', page });
});

router.post('/contact', async (req, res) => {
  const { name = '', email = '', message = '', website = '' } = req.body;
  if (website) return res.redirect('/pages/contact'); // honeypot
  if (!email.includes('@') || !message.trim()) {
    flash(req, 'error', 'Please include your email and a message.');
    return res.redirect('/pages/contact');
  }
  const store = res.locals.store;
  await mailer.notify(null, store.email, `Contact form: ${name || email}`, 'contact', {
    name: escapeHtml(name), email: escapeHtml(email), message: escapeHtml(message),
  });
  flash(req, 'success', 'Thanks for reaching out — we will get back to you soon.');
  res.redirect('/pages/contact');
});

router.get('/pages/:handle', async (req, res, next) => {
  const page = await get('SELECT * FROM pages WHERE handle = ? AND published = 1', req.params.handle);
  if (!page) return next();
  res.render('store/page', { title: page.seo_title || page.title, description: page.seo_description, page });
});

router.get('/blogs/news', async (req, res) => {
  const total = (await get('SELECT COUNT(*) AS n FROM articles WHERE published = 1')).n;
  const pager = paginate(total, req.query.page, 9);
  const articles = await all('SELECT * FROM articles WHERE published = 1 ORDER BY published_at DESC LIMIT ? OFFSET ?', pager.perPage, pager.offset);
  res.render('store/blog', { title: 'Journal', articles, pager });
});

router.get('/blogs/news/:handle', async (req, res, next) => {
  const article = await get('SELECT * FROM articles WHERE handle = ? AND published = 1', req.params.handle);
  if (!article) return next();
  res.render('store/article', {
    title: article.seo_title || article.title, description: article.seo_description || article.excerpt, ogImage: article.image, article,
  });
});

const POLICY_TITLES = { refund: 'Refund policy', privacy: 'Privacy policy', terms: 'Terms of service', shipping: 'Shipping policy', contact: 'Contact information' };
router.get('/policies/:type', async (req, res, next) => {
  const key = req.params.type.replace(/-policy$/, '').replace('terms-of-service', 'terms').replace('contact-information', 'contact');
  const body = settings.load('policies')[key];
  if (!POLICY_TITLES[key] || !body) return next();
  res.render('store/page', { title: POLICY_TITLES[key], page: { title: POLICY_TITLES[key], body_html: body } });
});

router.post('/newsletter', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    flash(req, 'error', 'Please enter a valid email address.');
  } else {
    const existing = await get('SELECT id FROM customers WHERE email = ?', email);
    if (existing) await run('UPDATE customers SET accepts_marketing = 1 WHERE id = ?', existing.id);
    else await run("INSERT INTO customers (email, accepts_marketing, tags) VALUES (?, 1, 'newsletter')", email);
    flash(req, 'success', 'Thanks for subscribing!');
  }
  res.redirect(safeBack(req, '/'));
});

/* ---------- Store password ---------- */

router.get('/password', async (req, res) => {
  if (!res.locals.store.password_enabled) return res.redirect('/');
  res.render('store/password', { title: res.locals.store.name, layoutless: true });
});

router.post('/password', async (req, res) => {
  if (String(req.body.password || '') === res.locals.store.password) {
    req.session.storefrontUnlocked = true;
    return res.redirect('/');
  }
  flash(req, 'error', 'Incorrect password.');
  res.redirect('/password');
});

/* ---------- SEO ---------- */

router.get('/robots.txt', async (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nSitemap: ${req.protocol}://${req.get('host')}/sitemap.xml\n`);
});

router.get('/sitemap.xml', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const urls = ['/', '/collections/all', '/blogs/news'];
  for (const p of await all("SELECT handle FROM products WHERE status = 'active'")) urls.push(`/products/${p.handle}`);
  for (const c of await all('SELECT handle FROM collections WHERE published = 1')) urls.push(`/collections/${c.handle}`);
  for (const p of await all('SELECT handle FROM pages WHERE published = 1')) urls.push(`/pages/${p.handle}`);
  for (const a of await all('SELECT handle FROM articles WHERE published = 1')) urls.push(`/blogs/news/${a.handle}`);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${escapeHtml(base + u)}</loc></url>`).join('\n')}\n</urlset>\n`);
});

module.exports = router;
