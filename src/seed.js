'use strict';
// Seeds a demo Oak Forest Herbals catalog. Run with `npm run seed` (add --orders for sample sales).
// Set ADMIN_EMAIL and ADMIN_PASSWORD to also create the owner account.
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { get, all, run, tx } = require('./db');
const { slugify, token } = require('./utils');

const DEMO_DIR = path.join(__dirname, '..', 'public', 'images', 'demo');

// Menus the theme relies on; created at boot so a fresh store has navigation.
function ensureBase() {
  if (!get("SELECT 1 FROM menus WHERE handle = 'main-menu'")) {
    run("INSERT INTO menus (handle, title, items) VALUES ('main-menu', 'Main menu', ?)", JSON.stringify([
      { title: 'Shop all', url: '/collections/all', children: [] },
      { title: 'Collections', url: '/collections', children: [] },
      { title: 'Journal', url: '/blogs/news', children: [] },
      { title: 'About', url: '/pages/about', children: [] },
      { title: 'Contact', url: '/pages/contact', children: [] },
    ]));
  }
  if (!get("SELECT 1 FROM menus WHERE handle = 'footer'")) {
    run("INSERT INTO menus (handle, title, items) VALUES ('footer', 'Footer menu', ?)", JSON.stringify([
      { title: 'Search', url: '/search', children: [] },
      { title: 'Shipping policy', url: '/policies/shipping', children: [] },
      { title: 'Refund policy', url: '/policies/refund', children: [] },
      { title: 'Privacy policy', url: '/policies/privacy', children: [] },
      { title: 'Terms of service', url: '/policies/terms', children: [] },
    ]));
  }
}

// Simple botanical illustration so the demo store looks finished without stock photos.
function illustration(file, { bg, fg, accent, kind }) {
  const shapes = {
    tea: `<rect x="230" y="250" width="340" height="380" rx="30" fill="${fg}"/><rect x="230" y="250" width="340" height="70" rx="20" fill="${accent}"/>
      <path d="M400 380c60 40 80 110 40 170-20 30-60 40-80 20-40-40-30-130 40-190z" fill="${bg}" opacity=".85"/><path d="M400 400v170" stroke="${fg}" stroke-width="6"/>`,
    tincture: `<rect x="320" y="190" width="160" height="60" rx="10" fill="${accent}"/><rect x="345" y="140" width="110" height="60" rx="30" fill="#2b2b2b"/>
      <path d="M290 260h220c20 0 30 15 30 35v300c0 25-15 40-40 40H300c-25 0-40-15-40-40V295c0-20 10-35 30-35z" fill="${fg}"/>
      <rect x="290" y="380" width="220" height="140" rx="8" fill="${bg}" opacity=".85"/><circle cx="400" cy="450" r="34" fill="${accent}"/>`,
    salve: `<ellipse cx="400" cy="470" rx="200" ry="70" fill="${fg}"/><rect x="200" y="380" width="400" height="90" fill="${fg}"/>
      <ellipse cx="400" cy="380" rx="200" ry="70" fill="${accent}"/><ellipse cx="400" cy="380" rx="120" ry="38" fill="${bg}" opacity=".7"/>`,
    herb: `<path d="M400 640V260" stroke="${fg}" stroke-width="10"/>
      ${[0, 1, 2, 3].map((i) => `<path d="M400 ${560 - i * 90}c-90-10-140-70-130-120 70 0 120 50 130 120z" fill="${fg}"/><path d="M400 ${520 - i * 90}c90-10 140-70 130-120-70 0-120 50-130 120z" fill="${accent}"/>`).join('')}`,
    hero: `<rect width="1600" height="800" fill="${bg}"/>
      ${Array.from({ length: 14 }, (_, i) => `<path d="M${80 + i * 115} 800c-10-200 30-380 ${60 + (i % 3) * 20}-${520 + (i % 4) * 40}" stroke="${fg}" stroke-width="${6 + (i % 3) * 3}" fill="none" opacity="${0.35 + (i % 4) * 0.12}"/>
        <ellipse cx="${140 + i * 115}" cy="${300 + (i % 5) * 50}" rx="38" ry="16" transform="rotate(${-30 + (i % 4) * 20} ${140 + i * 115} ${300 + (i % 5) * 50})" fill="${accent}" opacity=".7"/>`).join('')}`,
  };
  const size = kind === 'hero' ? '1600 800' : '800 800';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size}">${kind === 'hero' ? '' : `<rect width="800" height="800" fill="${bg}"/>`}${shapes[kind]}</svg>`;
  fs.writeFileSync(path.join(DEMO_DIR, file), svg);
  return `/images/demo/${file}`;
}

const PALETTES = [
  { bg: '#e9efe1', fg: '#4f7a4a', accent: '#c8873a' }, { bg: '#f3e6d6', fg: '#8a5a2b', accent: '#e0b15c' },
  { bg: '#e6e9f2', fg: '#5b5f97', accent: '#b8a1d9' }, { bg: '#f6e3e3', fg: '#a3485a', accent: '#f0b7a4' },
  { bg: '#e3f0ee', fg: '#2f6f68', accent: '#9fd3c7' }, { bg: '#f2efd9', fg: '#7d7a2e', accent: '#d9c45f' },
];

const PRODUCTS = [
  { title: 'Chamomile Meadow Tea', type: 'Tea', kind: 'tea', price: 1400, compare: null, tags: 'calming, caffeine-free, best-seller', options: { Size: ['2 oz', '4 oz', '8 oz'] }, step: 600,
    body: '<p>Whole German chamomile flowers harvested at peak bloom. Honeyed, apple-sweet and deeply relaxing — our most loved evening cup.</p><ul><li>Organic, hand-sifted flowers</li><li>Steep 1 tbsp in hot water for 5–7 minutes</li></ul>' },
  { title: 'Peppermint Leaf Tea', type: 'Tea', kind: 'tea', price: 1200, compare: null, tags: 'digestion, caffeine-free', options: { Size: ['2 oz', '4 oz'] }, step: 500,
    body: '<p>Cool, bright peppermint grown in our creek-side beds. Perfect after meals, hot or iced.</p>' },
  { title: 'Forest Breath Elderberry Syrup', type: 'Syrup', kind: 'tincture', price: 2600, compare: 3000, tags: 'immune, best-seller, wellness', options: { Size: ['4 fl oz', '8 fl oz'] }, step: 1400,
    body: '<p>Slow-simmered elderberries with ginger, cinnamon, clove and raw local honey. A seasonal staple for the whole family.</p><p><em>Refrigerate after opening.</em></p>' },
  { title: 'Lemon Balm Tincture', type: 'Tincture', kind: 'tincture', price: 2200, compare: null, tags: 'calming, mood',
    body: '<p>Fresh lemon balm extracted in organic cane alcohol. A bright, uplifting herb for tense days.</p>' },
  { title: 'Ashwagandha Root Tincture', type: 'Tincture', kind: 'tincture', price: 2800, compare: null, tags: 'adaptogen, stress, best-seller',
    body: '<p>Dual-extracted ashwagandha root to support steady energy and restful sleep.</p>' },
  { title: 'Calendula Healing Salve', type: 'Salve', kind: 'salve', price: 1800, compare: null, tags: 'skin, best-seller', options: { Size: ['1 oz tin', '2 oz jar'] }, step: 800,
    body: '<p>Sun-infused calendula and plantain in olive oil and local beeswax. For dry hands, scrapes and everyday skin care.</p>' },
  { title: 'Lavender Sleep Balm', type: 'Salve', kind: 'salve', price: 1600, compare: 2000, tags: 'calming, sleep, skin',
    body: '<p>A soft balm of lavender, chamomile and shea butter. Rub on wrists and temples at bedtime.</p>' },
  { title: 'Nettle & Oatstraw Infusion', type: 'Tea', kind: 'tea', price: 1500, compare: null, tags: 'nourishing, caffeine-free',
    body: '<p>Mineral-rich nettle and milky oat tops for a long overnight infusion.</p>' },
  { title: 'Holy Basil Tulsi Blend', type: 'Tea', kind: 'tea', price: 1600, compare: null, tags: 'adaptogen, mood',
    body: '<p>Three varieties of tulsi with a hint of rose. Spicy, floral and grounding.</p>' },
  { title: 'Dried Rosemary Bundle', type: 'Bulk herb', kind: 'herb', price: 900, compare: null, tags: 'culinary, bulk', options: { Size: ['Small', 'Large'] }, step: 500,
    body: '<p>Hand-tied bundles of rosemary for the kitchen, bath or smoke-cleansing.</p>' },
  { title: 'Echinacea Root', type: 'Bulk herb', kind: 'herb', price: 1300, compare: null, tags: 'immune, bulk',
    body: '<p>Cut and sifted Echinacea purpurea root, grown on our farm and dried low and slow.</p>' },
  { title: 'Wild Rose Facial Oil', type: 'Skin care', kind: 'tincture', price: 3400, compare: null, tags: 'skin, new',
    body: '<p>Rosehip seed and jojoba oils infused with wild rose petals. Lightweight and glow-giving.</p>', inventory: 0 },
];

const COLLECTIONS = [
  { title: 'Best sellers', handle: 'best-sellers', kind: 'smart', rules: [{ field: 'tag', relation: 'equals', value: 'best-seller' }], kindImg: 'herb' },
  { title: 'Herbal teas', handle: 'herbal-teas', kind: 'smart', rules: [{ field: 'type', relation: 'equals', value: 'Tea' }], kindImg: 'tea' },
  { title: 'Tinctures & syrups', handle: 'tinctures', kind: 'smart', rules: [{ field: 'type', relation: 'equals', value: 'Tincture' }, { field: 'type', relation: 'equals', value: 'Syrup' }], match_any: 1, kindImg: 'tincture' },
  { title: 'Salves & skin care', handle: 'skin-care', kind: 'smart', rules: [{ field: 'tag', relation: 'equals', value: 'skin' }], kindImg: 'salve' },
  { title: 'Calm & sleep', handle: 'calm-sleep', kind: 'manual', products: ['Chamomile Meadow Tea', 'Lemon Balm Tincture', 'Lavender Sleep Balm', 'Holy Basil Tulsi Blend'], kindImg: 'herb' },
];

function seedCatalog() {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  illustration('hero.svg', { bg: '#2f4f3a', fg: '#77b48a', accent: '#809ec4', kind: 'hero' });
  const ids = new Map();
  PRODUCTS.forEach((p, i) => {
    const palette = PALETTES[i % PALETTES.length];
    const handle = slugify(p.title);
    const img = illustration(`${handle}.svg`, { ...palette, kind: p.kind });
    const alt = illustration(`${handle}-2.svg`, { ...PALETTES[(i + 2) % PALETTES.length], kind: p.kind === 'herb' ? 'tea' : 'herb' });
    const optionNames = Object.keys(p.options || {});
    const pid = Number(run(`INSERT INTO products (title, handle, description_html, vendor, product_type, tags, status, options, created_at)
      VALUES (?, ?, ?, 'Oak Forest Herbals', ?, ?, 'active', ?, datetime('now', ?))`,
    p.title, handle, p.body, p.type, p.tags, JSON.stringify(optionNames), `-${PRODUCTS.length - i} days`).lastInsertRowid);
    ids.set(p.title, pid);
    run('INSERT INTO product_images (product_id, url, alt, position) VALUES (?, ?, ?, 0)', pid, img, p.title);
    run('INSERT INTO product_images (product_id, url, alt, position) VALUES (?, ?, ?, 1)', pid, alt, `${p.title} detail`);
    const values = optionNames.length ? p.options[optionNames[0]] : [null];
    values.forEach((value, vi) => {
      const price = p.price + vi * (p.step || 0);
      const compare = p.compare ? p.compare + vi * (p.step || 0) : null;
      run(`INSERT INTO variants (product_id, title, option1, sku, price, compare_at_price, cost, inventory_qty, weight_grams, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pid, value || 'Default Title', value, `OFH-${String(i + 1).padStart(3, '0')}${value ? `-${vi + 1}` : ''}`,
      price, compare, Math.round(price * 0.35), p.inventory ?? 12 + ((i * 7 + vi * 5) % 40), 120 + vi * 110, vi);
    });
  });

  COLLECTIONS.forEach((c, i) => {
    const img = illustration(`collection-${c.handle}.svg`, { ...PALETTES[(i + 1) % PALETTES.length], kind: c.kindImg });
    const cid = Number(run(`INSERT INTO collections (title, handle, description_html, image, kind, rules, match_any, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, c.title, c.handle, `<p>${c.title} from our apothecary.</p>`, img, c.kind,
    JSON.stringify(c.rules || []), c.match_any || 0, c.kind === 'manual' ? 'manual' : 'best-selling').lastInsertRowid);
    (c.products || []).forEach((title, pos) => run('INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, ?)', cid, ids.get(title), pos));
  });
}

function seedContent() {
  run(`INSERT INTO pages (title, handle, body_html) VALUES ('About', 'about', ?)`,
    '<p>Oak Forest Herbals began in a small kitchen at the edge of an old oak woodland. Today we grow, wildcraft and blend more than forty herbs by hand.</p><h2>Our promise</h2><ul><li>Organic and ethically wildcrafted herbs</li><li>Small batches, dated and traceable</li><li>Plastic-free packaging</li></ul>');
  run(`INSERT INTO pages (title, handle, body_html) VALUES ('Contact', 'contact', ?)`, '<p>Questions about an order or an herb? Send us a note and we will reply within one business day.</p>');
  run(`INSERT INTO pages (title, handle, body_html) VALUES ('FAQ', 'faq', ?)`, '<h3>Are your herbs organic?</h3><p>Yes — everything we grow is organic, and wildcrafted herbs are harvested sustainably.</p><h3>How long does shipping take?</h3><p>Orders ship within 2 business days.</p>');
  const posts = [
    ['A beginner’s guide to herbal infusions', 'How to brew long, mineral-rich infusions with nettle, oatstraw and more.', 'tea'],
    ['Making elderberry syrup at home', 'Our family recipe, plus tips on sourcing berries and storing your syrup.', 'tincture'],
    ['Five herbs for a calmer evening', 'Gentle allies for winding down: chamomile, lemon balm, lavender, tulsi and passionflower.', 'herb'],
  ];
  posts.forEach(([title, excerpt, kind], i) => {
    const handle = slugify(title);
    const img = illustration(`post-${handle}.svg`, { ...PALETTES[(i + 3) % PALETTES.length], kind });
    run(`INSERT INTO articles (title, handle, author, excerpt, body_html, image, tags, published_at) VALUES (?, ?, 'Oak Forest Herbals', ?, ?, ?, 'herbalism', datetime('now', ?))`,
      title, handle, excerpt, `<p>${excerpt}</p><p>Start with good-quality dried herbs, filtered water and a little patience. Steep, strain and enjoy.</p>`, img, `-${(i + 1) * 9} days`);
  });
}

function seedSettingsData() {
  run("INSERT INTO shipping_rates (name, price, min_subtotal, max_subtotal, countries, delivery_estimate, position) VALUES ('Standard', 600, 0, 9999, 'US', '3 to 5 business days', 0)");
  run("INSERT INTO shipping_rates (name, price, min_subtotal, max_subtotal, countries, delivery_estimate, position) VALUES ('Free standard shipping', 0, 10000, NULL, 'US', '3 to 5 business days', 1)");
  run("INSERT INTO shipping_rates (name, price, min_subtotal, max_subtotal, countries, delivery_estimate, position) VALUES ('Express', 1800, 0, NULL, 'US', '1 to 2 business days', 2)");
  run("INSERT INTO shipping_rates (name, price, min_subtotal, max_subtotal, countries, delivery_estimate, position) VALUES ('International', 2400, 0, NULL, 'CA,GB,AU,IE,DE,FR,NZ', '7 to 14 business days', 3)");
  run("INSERT INTO tax_rates (country, province, name, rate) VALUES ('US', '', 'Sales tax', 0)");
  run("INSERT INTO tax_rates (country, province, name, rate) VALUES ('US', 'CA', 'CA sales tax', 7.25)");
  run("INSERT INTO tax_rates (country, province, name, rate) VALUES ('US', 'NY', 'NY sales tax', 4)");
  run("INSERT INTO tax_rates (country, province, name, rate) VALUES ('CA', '', 'GST', 5)");
  run("INSERT INTO discounts (code, kind, value, min_subtotal) VALUES ('WELCOME10', 'percentage', 10, 0)");
  run("INSERT INTO discounts (code, kind, value, min_subtotal) VALUES ('FREESHIP', 'free_shipping', 0, 2500)");
  run("INSERT INTO discounts (code, kind, value, min_subtotal, usage_limit) VALUES ('SPRING5', 'fixed_amount', 500, 3000, 100)");
}

// Sample customers and orders spread over the last 45 days, so the dashboard has data.
function seedOrders() {
  const names = [['Maya', 'Rivera'], ['Jonah', 'Park'], ['Priya', 'Shah'], ['Elena', 'Novak'], ['Sam', 'Okafor'], ['Lena', 'Fischer'], ['Theo', 'Martin'], ['Ava', 'Lindqvist']];
  const cities = [['Asheville', 'NC', '28801'], ['Portland', 'OR', '97205'], ['Los Angeles', 'CA', '90012'], ['Brooklyn', 'NY', '11201'], ['Austin', 'TX', '78701']];
  const variants = all("SELECT v.*, p.title AS ptitle FROM variants v JOIN products p ON p.id = v.product_id WHERE v.inventory_qty > 0");
  let number = (get('SELECT MAX(number) AS n FROM orders').n || 1000);
  for (let i = 0; i < 36; i++) {
    const [first, last] = names[i % names.length];
    const email = `${first.toLowerCase()}.${last.toLowerCase()}@example.com`;
    let cust = get('SELECT id FROM customers WHERE email = ?', email);
    if (!cust) cust = { id: Number(run('INSERT INTO customers (email, first_name, last_name, accepts_marketing) VALUES (?, ?, ?, ?)', email, first, last, i % 2).lastInsertRowid) };
    const [city, province, zip] = cities[i % cities.length];
    const address = { first_name: first, last_name: last, address1: `${100 + i} Oak Lane`, city, province, zip, country: 'US' };
    const picks = [variants[(i * 3) % variants.length], variants[(i * 5 + 2) % variants.length]].slice(0, 1 + (i % 2));
    const items = picks.map((v) => ({ v, qty: 1 + (i % 3 === 0 ? 1 : 0) }));
    const subtotal = items.reduce((s, x) => s + x.v.price * x.qty, 0);
    const shipping = subtotal >= 10000 ? 0 : 600;
    const tax = province === 'CA' ? Math.round(subtotal * 0.0725) : province === 'NY' ? Math.round(subtotal * 0.04) : 0;
    const daysAgo = Math.floor(((35 - i) * 45) / 36); // later order numbers are more recent
    const paid = i % 7 !== 0;
    const fulfilled = paid && daysAgo > 3;
    const oid = Number(run(`INSERT INTO orders (number, token, customer_id, email, financial_status, fulfillment_status, subtotal, shipping_total, tax_total, total,
        shipping_method, shipping_address, billing_address, payment_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?, ?))`,
    ++number, token(16), cust.id, email, paid ? 'paid' : 'pending', fulfilled ? 'fulfilled' : 'unfulfilled', subtotal, shipping, tax,
    subtotal + shipping + tax, shipping ? 'Standard' : 'Free standard shipping', JSON.stringify(address), JSON.stringify(address),
    paid ? 'Credit / debit card' : 'Bank transfer', `-${daysAgo} days`, `-${(i * 37) % 600} minutes`).lastInsertRowid);
    for (const { v, qty } of items) {
      run(`INSERT INTO order_items (order_id, product_id, variant_id, title, variant_title, sku, image, price, quantity, fulfilled_qty)
        VALUES (?, ?, ?, ?, ?, ?, (SELECT url FROM product_images WHERE product_id = ? ORDER BY position LIMIT 1), ?, ?, ?)`,
      oid, v.product_id, v.id, v.ptitle, v.title === 'Default Title' ? '' : v.title, v.sku, v.product_id, v.price, qty, fulfilled ? qty : 0);
    }
    run("INSERT INTO order_events (order_id, message, created_at) VALUES (?, 'Order placed (sample data).', datetime('now', ?))", oid, `-${daysAgo} days`);
    for (let d = 0; d < 3; d++) run("INSERT OR IGNORE INTO page_views (day, visitor, views) VALUES (date('now', ?), ?, 3)", `-${daysAgo} days`, `seed-${i}-${d}`);
  }
}

function seedAdmin() {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!email || !password) return false;
  if (get('SELECT 1 FROM staff WHERE email = ?', email)) return false;
  run("INSERT INTO staff (email, name, password_hash, role) VALUES (?, ?, ?, 'owner')", email, process.env.ADMIN_NAME || 'Store owner', bcrypt.hashSync(password, 10));
  return true;
}

function main({ orders = process.argv.includes('--orders') } = {}) {
  ensureBase();
  if (get('SELECT 1 FROM products LIMIT 1')) {
    console.log('Catalog already has products; skipping demo catalog.');
  } else {
    tx(() => { seedCatalog(); seedContent(); seedSettingsData(); });
    console.log(`Seeded ${PRODUCTS.length} products, ${COLLECTIONS.length} collections, pages, blog posts, shipping, taxes and discounts.`);
  }
  if (orders) {
    tx(seedOrders);
    console.log('Seeded sample customers and orders.');
  }
  if (seedAdmin()) console.log(`Created owner account ${process.env.ADMIN_EMAIL}.`);
}

if (require.main === module) main();

module.exports = { ensureBase, main };
