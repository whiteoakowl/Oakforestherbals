'use strict';
// Store-wide settings persisted as JSON in the settings table, merged over defaults.
const { get, run } = require('./db');

const DEFAULTS = {
  store: {
    name: 'Oak Forest Herbals',
    tagline: 'Small-batch herbal teas, tinctures and botanicals',
    email: 'hello@oakforestherbals.com',
    phone: '',
    address: '',
    currency: 'USD',
    currency_symbol: '$',
    weight_unit: 'oz',
    order_prefix: '#',
    password_enabled: false,
    password: '',
    password_message: 'Our store is opening soon.',
  },
  checkout: {
    customer_accounts: 'optional', // disabled | optional | required
    require_phone: false,
    require_company: false,
    order_notes: true,
    marketing_checkbox_default: false,
    thank_you_message: 'Thank you for supporting a small herbal apothecary!',
  },
  payments: {
    manual: [
      { id: 'cod', name: 'Cash on delivery', enabled: false, instructions: 'Pay in cash when your order arrives.' },
      { id: 'bank', name: 'Bank transfer', enabled: true, instructions: 'Transfer the order total to our bank account. Your order ships once payment clears.' },
      { id: 'check', name: 'Check / money order', enabled: false, instructions: 'Mail a check to our store address.' },
    ],
    stripe_enabled: false,
    stripe_publishable_key: '',
    stripe_secret_key: '',
    stripe_webhook_secret: '',
    test_mode: true,
  },
  taxes: {
    prices_include_tax: false,
    charge_tax_on_shipping: false,
    default_rate: 0,
  },
  notifications: {
    sender_name: 'Oak Forest Herbals',
    sender_email: 'hello@oakforestherbals.com',
    staff_order_email: '',
    smtp_host: '',
    smtp_port: 587,
    smtp_user: '',
    smtp_pass: '',
    smtp_secure: false,
    order_confirmation: true,
    shipping_confirmation: true,
    order_cancelled: true,
    customer_welcome: true,
  },
  policies: {
    refund: '<p>We accept returns of unopened products within 30 days of delivery.</p>',
    privacy: '<p>We only use your information to process orders and, with your permission, to send updates.</p>',
    terms: '<p>By using this site you agree to these terms of service.</p>',
    shipping: '<p>Orders ship within 2 business days from our apothecary.</p>',
    contact: '',
  },
  theme: {
    color_primary: '#77b48a', // brand green
    color_accent: '#809ec4', // brand blue
    color_background: '#ffffff',
    color_surface: '#ffffff',
    color_text: '#1f2a22',
    font_heading: 'Cormorant Garamond',
    font_body: 'Inter',
    logo: '',
    logo_width: 160,
    favicon: '',
    button_radius: 6,
    announcement_enabled: true,
    announcement_text: 'FREE shipping on all orders over $100',
    announcement_link: '/collections/all',
    hero_enabled: true,
    hero_heading: 'Rooted in the forest. Crafted by hand.',
    hero_subheading: 'Organic teas, tinctures and salves made in small batches from herbs we grow and wildcraft.',
    hero_image: '/images/demo/hero.svg',
    hero_button_text: 'Shop all herbs',
    hero_button_link: '/collections/all',
    featured_collection: 'best-sellers',
    featured_count: 8,
    show_collection_list: true,
    show_blog: true,
    show_newsletter: true,
    newsletter_heading: 'Join the herbal circle',
    newsletter_text: 'Seasonal recipes, new harvests and 10% off your first order.',
    testimonial_enabled: true,
    testimonial_quote: 'The best chamomile I have ever tasted. You can smell the meadow when you open the bag.',
    testimonial_author: 'Maya R.',
    footer_text: 'Hand-blended in small batches.',
    social_instagram: '',
    social_facebook: '',
    social_pinterest: '',
    social_tiktok: '',
    products_per_page: 12,
    show_vendor: false,
    show_sale_badge: true,
    show_sold_out_badge: true,
  },
  seo: {
    home_title: '',
    home_description: 'Small-batch organic herbal teas, tinctures and botanicals.',
    analytics_head_html: '',
  },
};

const cache = new Map();

function load(group) {
  if (cache.has(group)) return cache.get(group);
  const row = get('SELECT value FROM settings WHERE key = ?', group);
  const stored = row ? JSON.parse(row.value) : {};
  const merged = { ...structuredClone(DEFAULTS[group] || {}), ...stored };
  cache.set(group, merged);
  return merged;
}

function save(group, patch) {
  const next = { ...load(group), ...patch };
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    group, JSON.stringify(next));
  cache.set(group, next);
  return next;
}

function allSettings() {
  const out = {};
  for (const group of Object.keys(DEFAULTS)) out[group] = load(group);
  return out;
}

function clearCache() {
  cache.clear();
}

module.exports = { DEFAULTS, load, save, allSettings, clearCache };
