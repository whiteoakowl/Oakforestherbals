'use strict';
// Digital products: after payment, each file gets a private download link per order line, limited
// by count and time (Settings → Digital downloads). Links are emailed and shown on the order page.
const { get, all, run } = require('./db');
const settings = require('./settings');
const storage = require('./storage');
const { token } = require('./utils');

async function filesFor(productId, variantId) {
  return all('SELECT * FROM digital_files WHERE product_id = ? AND (variant_id IS NULL OR variant_id = ?) ORDER BY id', productId, variantId);
}

// Creates the links for a paid order (safe to repeat) and emails them when new ones were made.
async function grantForOrder(orderId) {
  const order = await get('SELECT * FROM orders WHERE id = ?', orderId);
  const items = await all("SELECT * FROM order_items WHERE order_id = ? AND product_kind = 'digital'", orderId);
  const cfg = settings.load('downloads');
  const max = Number(cfg.max_downloads) || null;
  const days = Number(cfg.expiry_days) || 0;
  const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  let made = 0;
  for (const item of items) {
    for (const f of await filesFor(item.product_id, item.variant_id)) {
      const res = await run(`INSERT INTO download_links (order_id, order_item_id, digital_file_id, token, max_downloads, expires_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (order_item_id, digital_file_id) DO NOTHING`, orderId, item.id, f.id, token(24), max, expires);
      made += res.changes || 0;
    }
  }
  if (made && order.email) {
    const comms = require('./comms');
    const links = await linksForOrder(orderId);
    await comms.send('downloads_ready', { email: order.email, first_name: (await get('SELECT first_name FROM customers WHERE id = ?', order.customer_id) || {}).first_name }, {
      number: String(order.number), links: links.map((l) => `${l.filename}: ${comms.base()}/downloads/${l.token}`).join('\n'),
      link: `${comms.base()}/checkout/thank-you/${order.token}`,
    });
  }
  return made;
}

async function linksForOrder(orderId) {
  return all(`SELECT l.*, f.filename, f.size_bytes FROM download_links l JOIN digital_files f ON f.id = l.digital_file_id
    WHERE l.order_id = ? ORDER BY l.order_item_id, f.id`, orderId);
}

// Counts a download and returns the file, or an error message.
async function open(tok) {
  const link = await get(`SELECT l.*, f.filename, f.storage_key, f.mime, o.financial_status, o.status AS order_status FROM download_links l
    JOIN digital_files f ON f.id = l.digital_file_id JOIN orders o ON o.id = l.order_id WHERE l.token = ?`, String(tok || ''));
  if (!link) return { error: 'This download link isn’t valid.', status: 404 };
  if (link.order_status === 'cancelled' || !['paid', 'partially_refunded'].includes(link.financial_status)) return { error: 'This order is no longer active.', status: 410 };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { error: 'This download link has expired. Contact us for a new one.', status: 410 };
  const claimed = await run('UPDATE download_links SET downloads = downloads + 1 WHERE id = ? AND (max_downloads IS NULL OR downloads < max_downloads)', link.id);
  if (!claimed.changes) return { error: 'This file has been downloaded the maximum number of times. Contact us if you need it again.', status: 410 };
  return { link };
}

// Gives a customer more downloads/time (staff action).
async function reset(orderId) {
  const cfg = settings.load('downloads');
  const days = Number(cfg.expiry_days) || 0;
  await run('UPDATE download_links SET downloads = 0, expires_at = ? WHERE order_id = ?', days ? new Date(Date.now() + days * 86400000).toISOString() : null, orderId);
}

module.exports = { filesFor, grantForOrder, linksForOrder, open, reset, storage };
