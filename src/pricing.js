'use strict';
// Cart math: line items, discounts, shipping rates and taxes. All amounts in cents.
const { get, all } = require('./db');
const settings = require('./settings');
const { isVariantAvailable, intArray } = require('./catalog');

async function buildCart(items = []) {
  const ids = items.map((i) => i.variant_id);
  const rows = ids.length ? await all(`SELECT v.*, p.title AS product_title, p.handle,
      (SELECT url FROM product_images WHERE product_id = p.id ORDER BY position, id LIMIT 1) AS image
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.id = ANY(?::int[]) AND p.status = 'active'`, intArray(ids)) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = [];
  for (const item of items) {
    const variant = byId.get(Number(item.variant_id));
    if (!variant) continue;
    const max = variant.track_inventory && !variant.continue_selling ? Math.max(0, variant.inventory_qty) : 999;
    const quantity = Math.min(Math.max(1, item.quantity | 0), max);
    if (quantity < 1 || !isVariantAvailable(variant)) continue;
    lines.push({
      variant_id: variant.id,
      product_id: variant.product_id,
      title: variant.product_title,
      handle: variant.handle,
      variant_title: variant.title === 'Default Title' ? '' : variant.title,
      sku: variant.sku,
      image: variant.image || '',
      price: variant.price,
      compare_at_price: variant.compare_at_price,
      quantity,
      max,
      taxable: !!variant.taxable,
      requires_shipping: !!variant.requires_shipping,
      line_price: variant.price * quantity,
    });
  }
  return {
    lines,
    item_count: lines.reduce((s, l) => s + l.quantity, 0),
    subtotal: lines.reduce((s, l) => s + l.line_price, 0),
    requires_shipping: lines.some((l) => l.requires_shipping),
  };
}

// Returns { discount } when usable, or { error } explaining why not.
async function validateDiscount(code, cart, email = '') {
  if (!code) return { error: 'Enter a discount code.' };
  const d = await get('SELECT * FROM discounts WHERE code = ?', String(code).trim());
  const now = new Date().toISOString().slice(0, 16);
  if (!d || !d.active) return { error: 'This discount code is not valid.' };
  if (d.starts_at && d.starts_at > now) return { error: 'This discount code is not active yet.' };
  if (d.ends_at && d.ends_at < now) return { error: 'This discount code has expired.' };
  if (d.usage_limit !== null && d.used_count >= d.usage_limit) return { error: 'This discount code has reached its usage limit.' };
  if (cart.subtotal < d.min_subtotal) {
    return { error: `Spend ${settings.load('store').currency_symbol}${(d.min_subtotal / 100).toFixed(2)} or more to use this code.` };
  }
  if (d.once_per_customer && email) {
    const used = await get("SELECT 1 FROM orders WHERE lower(discount_code) = lower(?) AND lower(email) = lower(?) AND status != 'cancelled'", d.code, email);
    if (used) return { error: 'You have already used this discount code.' };
  }
  return { discount: d };
}

function discountAmount(discount, subtotal) {
  if (!discount) return 0;
  if (discount.kind === 'percentage') return Math.round((subtotal * Math.min(discount.value, 100)) / 100);
  if (discount.kind === 'fixed_amount') return Math.min(discount.value, subtotal);
  return 0;
}

function matchesCountry(rate, country) {
  const list = String(rate.countries || '*').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  return list.includes('*') || list.includes(String(country || '').toUpperCase());
}

async function shippingOptions(cart, country, discount) {
  if (!cart.requires_shipping) return [{ id: 0, name: 'No shipping required', price: 0, delivery_estimate: '' }];
  const base = cart.subtotal - discountAmount(discount, cart.subtotal);
  const freeShipping = discount && discount.kind === 'free_shipping';
  return (await all('SELECT * FROM shipping_rates ORDER BY position, price, id'))
    .filter((r) => matchesCountry(r, country))
    .filter((r) => base >= r.min_subtotal && (r.max_subtotal === null || base <= r.max_subtotal))
    .map((r) => ({ ...r, price: freeShipping ? 0 : r.price }));
}

async function taxRateFor(address = {}) {
  const country = String(address.country || '').toUpperCase();
  const province = String(address.province || '').toUpperCase();
  const row = (province && await get('SELECT * FROM tax_rates WHERE upper(country) = ? AND upper(province) = ?', country, province))
    || await get("SELECT * FROM tax_rates WHERE upper(country) = ? AND province = ''", country);
  if (row) return { name: row.name, rate: row.rate };
  const fallback = Number(settings.load('taxes').default_rate) || 0;
  return { name: 'Tax', rate: fallback };
}

// Full order totals. `shipping` is a shipping option (or null before one is chosen).
async function computeTotals(cart, { discount = null, shipping = null, address = null } = {}) {
  const taxes = settings.load('taxes');
  const subtotal = cart.subtotal;
  const discount_total = discountAmount(discount, subtotal);
  const shipping_total = shipping ? shipping.price : 0;

  const taxableSubtotal = cart.lines.filter((l) => l.taxable).reduce((s, l) => s + l.line_price, 0);
  const discountShare = subtotal > 0 ? Math.round(discount_total * (taxableSubtotal / subtotal)) : 0;
  let taxBase = Math.max(0, taxableSubtotal - discountShare);
  if (taxes.charge_tax_on_shipping) taxBase += shipping_total;

  const { name: tax_name, rate } = address ? await taxRateFor(address) : { name: 'Tax', rate: 0 };
  const pct = rate / 100;
  const tax_total = taxes.prices_include_tax
    ? Math.round(taxBase - taxBase / (1 + pct))
    : Math.round(taxBase * pct);

  const total = Math.max(0, subtotal - discount_total + shipping_total + (taxes.prices_include_tax ? 0 : tax_total));
  return { subtotal, discount_total, shipping_total, tax_total, tax_name, tax_rate: rate, tax_included: !!taxes.prices_include_tax, total };
}

module.exports = { buildCart, validateDiscount, discountAmount, shippingOptions, taxRateFor, computeTotals };
