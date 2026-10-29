'use strict';
const express = require('express');
const { get, all, run } = require('../db');
const catalog = require('../catalog');
const { buildCart } = require('../pricing');
const settings = require('../settings');
const mailer = require('../mailer');
const { flash } = require('../middleware');
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

router.get('/', (req, res) => {
  const theme = res.locals.theme;
  const featured = catalog.collectionByHandle(theme.featured_collection);
  const featuredProducts = (featured ? catalog.collectionProducts(featured) : catalog.activeProducts())
    .slice(0, Number(theme.featured_count) || 8);
  const collections = all('SELECT * FROM collections WHERE published = 1 ORDER BY id LIMIT 6');
  const articles = all('SELECT * FROM articles WHERE published = 1 ORDER BY published_at DESC LIMIT 3');
  const seo = settings.load('seo');
  res.render('store/home', {
    title: seo.home_title || res.locals.store.name,
    description: seo.home_description,
    featured, featuredProducts, collections, articles,
  });
});

router.get('/collections', (req, res) => {
  const collections = all('SELECT * FROM collections WHERE published = 1 ORDER BY title');
  res.render('store/collections', { title: 'Collections', collections });
});

router.get('/collections/:handle', (req, res, next) => {
  let collection;
  if (req.params.handle === 'all') {
    collection = { id: 0, title: 'All products', handle: 'all', description_html: '', image: '', kind: 'smart', rules: '[]', sort_order: 'created-desc' };
  } else {
    collection = catalog.collectionByHandle(req.params.handle);
  }
  if (!collection) return next();

  let products = catalog.collectionProducts(collection);
  const types = [...new Set(products.map((p) => p.product_type).filter(Boolean))].sort();
  const { availability, type } = req.query;
  if (availability === 'in') products = products.filter((p) => p.available);
  if (availability === 'out') products = products.filter((p) => !p.available);
  if (type) products = products.filter((p) => p.product_type === type);
  const sort = SORT_OPTIONS.some(([k]) => k === req.query.sort) ? req.query.sort : 'manual';
  if (sort !== 'manual') catalog.sortProducts(products, sort);

  const pager = paginate(products.length, req.query.page, Number(res.locals.theme.products_per_page) || 12);
  res.render('store/collection', {
    title: collection.seo_title || collection.title,
    description: collection.seo_description,
    collection, types, sort, SORT_OPTIONS, pager,
    products: products.slice(pager.offset, pager.offset + pager.perPage),
  });
});

function renderProduct(req, res, next) {
  const product = catalog.productByHandle(req.params.handle);
  if (!product) return next();
  const related = all(`SELECT p.* FROM products p WHERE p.status = 'active' AND p.id != ? AND p.product_type = ?
    ORDER BY RANDOM() LIMIT 4`, product.id, product.product_type).map(catalog.hydrate);
  const selected = product.variants.find((v) => String(v.id) === String(req.query.variant))
    || product.variants.find(catalog.isVariantAvailable) || product.variants[0];
  res.render('store/product', {
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
router.get('/collections/:collection/products/:handle', renderProduct);

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  let products = [];
  let pages = [];
  let articles = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    products = all(`SELECT * FROM products WHERE status = 'active' AND (title LIKE ? OR tags LIKE ? OR product_type LIKE ?
      OR vendor LIKE ? OR description_html LIKE ?) ORDER BY title LIMIT 48`, like, like, like, like, like).map(catalog.hydrate);
    pages = all('SELECT * FROM pages WHERE published = 1 AND (title LIKE ? OR body_html LIKE ?) LIMIT 10', like, like);
    articles = all('SELECT * FROM articles WHERE published = 1 AND (title LIKE ? OR body_html LIKE ?) LIMIT 10', like, like);
  }
  res.render('store/search', { title: q ? `Search: ${q}` : 'Search', q, products, pages, articles });
});

// Predictive search for the header search box.
router.get('/search/suggest.json', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ products: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const products = all("SELECT * FROM products WHERE status = 'active' AND (title LIKE ? OR tags LIKE ?) ORDER BY title LIMIT 6", like, like)
    .map(catalog.hydrate)
    .map((p) => ({ title: p.title, url: `/products/${p.handle}`, image: p.image, price: res.locals.money(p.price_min) }));
  res.json({ products });
});

/* ---------- Cart ---------- */

function cartPayload(req, res) {
  const cart = buildCart(req.session.cart);
  return {
    item_count: cart.item_count,
    subtotal: cart.subtotal,
    subtotal_formatted: res.locals.money(cart.subtotal),
    lines: cart.lines.map((l) => ({ ...l, line_price_formatted: res.locals.money(l.line_price) })),
  };
}

router.get('/cart', (req, res) => {
  const cart = buildCart(req.session.cart);
  // Drop lines that are no longer purchasable so the session matches what we show.
  req.session.cart = cart.lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }));
  res.render('store/cart', { title: 'Your cart', cart, note: req.session.cartNote || '', settingsOrderNotes: settings.load('checkout').order_notes });
});

router.get('/cart.json', (req, res) => res.json(cartPayload(req, res)));

router.post('/cart/add', (req, res) => {
  const variantId = toInt(req.body.variant_id);
  const quantity = Math.max(1, toInt(req.body.quantity, 1));
  const variant = get(`SELECT v.* FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.id = ? AND p.status = 'active'`, variantId);
  const wantsJson = req.xhr || req.accepts(['html', 'json']) === 'json';
  if (!variant || !catalog.isVariantAvailable(variant)) {
    if (wantsJson) return res.status(422).json({ error: 'This item is sold out.' });
    flash(req, 'error', 'Sorry, that item is sold out.');
    return res.redirect(safeBack(req, '/cart'));
  }
  const cart = req.session.cart || [];
  const line = cart.find((l) => l.variant_id === variantId);
  if (line) line.quantity += quantity; else cart.push({ variant_id: variantId, quantity });
  req.session.cart = buildCart(cart).lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }));
  if (wantsJson) return res.json(cartPayload(req, res));
  flash(req, 'success', 'Added to your cart.');
  res.redirect('/cart');
});

router.post('/cart/update', (req, res) => {
  const quantities = req.body.quantities || {};
  const next = [];
  for (const line of req.session.cart || []) {
    const q = quantities[line.variant_id] !== undefined ? toInt(quantities[line.variant_id], line.quantity) : line.quantity;
    if (q > 0) next.push({ variant_id: line.variant_id, quantity: q });
  }
  if (req.body.remove) {
    const removeId = toInt(req.body.remove);
    req.session.cart = next.filter((l) => l.variant_id !== removeId);
  } else {
    req.session.cart = next;
  }
  if (req.body.note !== undefined) req.session.cartNote = String(req.body.note).slice(0, 1000);
  if (req.xhr || req.accepts(['html', 'json']) === 'json') return res.json(cartPayload(req, res));
  if (req.body.checkout) return res.redirect('/checkout');
  res.redirect('/cart');
});

router.post('/cart/clear', (req, res) => {
  req.session.cart = [];
  res.redirect('/cart');
});

/* ---------- Content ---------- */

router.get('/pages/contact', (req, res) => {
  const page = get("SELECT * FROM pages WHERE handle = 'contact' AND published = 1");
  res.render('store/contact', { title: 'Contact us', page });
});

router.post('/contact', (req, res) => {
  const { name = '', email = '', message = '', website = '' } = req.body;
  if (website) return res.redirect('/pages/contact'); // honeypot
  if (!email.includes('@') || !message.trim()) {
    flash(req, 'error', 'Please include your email and a message.');
    return res.redirect('/pages/contact');
  }
  const store = res.locals.store;
  mailer.notify(null, store.email, `Contact form: ${name || email}`, 'contact', {
    name: escapeHtml(name), email: escapeHtml(email), message: escapeHtml(message),
  });
  flash(req, 'success', 'Thanks for reaching out — we will get back to you soon.');
  res.redirect('/pages/contact');
});

router.get('/pages/:handle', (req, res, next) => {
  const page = get('SELECT * FROM pages WHERE handle = ? AND published = 1', req.params.handle);
  if (!page) return next();
  res.render('store/page', { title: page.seo_title || page.title, description: page.seo_description, page });
});

router.get('/blogs/news', (req, res) => {
  const total = get('SELECT COUNT(*) AS n FROM articles WHERE published = 1').n;
  const pager = paginate(total, req.query.page, 9);
  const articles = all('SELECT * FROM articles WHERE published = 1 ORDER BY published_at DESC LIMIT ? OFFSET ?', pager.perPage, pager.offset);
  res.render('store/blog', { title: 'Journal', articles, pager });
});

router.get('/blogs/news/:handle', (req, res, next) => {
  const article = get('SELECT * FROM articles WHERE handle = ? AND published = 1', req.params.handle);
  if (!article) return next();
  res.render('store/article', {
    title: article.seo_title || article.title, description: article.seo_description || article.excerpt, ogImage: article.image, article,
  });
});

const POLICY_TITLES = { refund: 'Refund policy', privacy: 'Privacy policy', terms: 'Terms of service', shipping: 'Shipping policy', contact: 'Contact information' };
router.get('/policies/:type', (req, res, next) => {
  const key = req.params.type.replace(/-policy$/, '').replace('terms-of-service', 'terms').replace('contact-information', 'contact');
  const body = settings.load('policies')[key];
  if (!POLICY_TITLES[key] || !body) return next();
  res.render('store/page', { title: POLICY_TITLES[key], page: { title: POLICY_TITLES[key], body_html: body } });
});

router.post('/newsletter', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    flash(req, 'error', 'Please enter a valid email address.');
  } else {
    const existing = get('SELECT id FROM customers WHERE email = ?', email);
    if (existing) run('UPDATE customers SET accepts_marketing = 1 WHERE id = ?', existing.id);
    else run("INSERT INTO customers (email, accepts_marketing, tags) VALUES (?, 1, 'newsletter')", email);
    flash(req, 'success', 'Thanks for subscribing!');
  }
  res.redirect(safeBack(req, '/'));
});

/* ---------- Store password ---------- */

router.get('/password', (req, res) => {
  if (!res.locals.store.password_enabled) return res.redirect('/');
  res.render('store/password', { title: res.locals.store.name, layoutless: true });
});

router.post('/password', (req, res) => {
  if (String(req.body.password || '') === res.locals.store.password) {
    req.session.storefrontUnlocked = true;
    return res.redirect('/');
  }
  flash(req, 'error', 'Incorrect password.');
  res.redirect('/password');
});

/* ---------- SEO ---------- */

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nSitemap: ${req.protocol}://${req.get('host')}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const urls = ['/', '/collections/all', '/blogs/news'];
  for (const p of all("SELECT handle FROM products WHERE status = 'active'")) urls.push(`/products/${p.handle}`);
  for (const c of all('SELECT handle FROM collections WHERE published = 1')) urls.push(`/collections/${c.handle}`);
  for (const p of all('SELECT handle FROM pages WHERE published = 1')) urls.push(`/pages/${p.handle}`);
  for (const a of all('SELECT handle FROM articles WHERE published = 1')) urls.push(`/blogs/news/${a.handle}`);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${escapeHtml(base + u)}</loc></url>`).join('\n')}\n</urlset>\n`);
});

module.exports = router;
