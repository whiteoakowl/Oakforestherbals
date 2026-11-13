'use strict';
// Installable app support: web app manifests for the storefront and the admin, plus local
// serving of the service worker and offline page (on Netlify the CDN serves those from /public).
const path = require('node:path');
const express = require('express');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

const ICONS = [
  { src: '/images/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/images/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/images/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

function shortName(name) {
  return name.length > 12 ? name.split(/\s+/).slice(0, 2).join(' ') : name;
}

function sendManifest(res, manifest) {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/manifest+json').send(JSON.stringify(manifest));
}

// Static files that need to live at the site root. Mounted before sessions so they stay cheap.
const staticRouter = express.Router();
staticRouter.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC, 'sw.js'));
});
staticRouter.get('/offline.html', (req, res) => res.sendFile(path.join(PUBLIC, 'offline.html')));
staticRouter.get('/apple-touch-icon.png', (req, res) => res.sendFile(path.join(PUBLIC, 'apple-touch-icon.png')));

// Manifests use the store's name and theme colours, so they need settings loaded.
const manifestRouter = express.Router();
manifestRouter.get('/manifest.webmanifest', (req, res) => {
  const { store, theme } = res.locals;
  sendManifest(res, {
    id: '/',
    name: store.name,
    short_name: shortName(store.name),
    description: store.tagline || undefined,
    start_url: '/?source=app',
    scope: '/',
    display: 'standalone',
    background_color: theme.color_background || '#ffffff',
    theme_color: theme.color_primary || '#77b48a',
    icons: ICONS,
  });
});
manifestRouter.get('/admin/manifest.webmanifest', (req, res) => {
  const { store } = res.locals;
  sendManifest(res, {
    id: '/admin',
    name: `${store.name} Admin`,
    short_name: shortName(store.name),
    start_url: '/admin',
    scope: '/admin',
    display: 'standalone',
    background_color: '#f1f1f1',
    theme_color: '#1a1a1a',
    icons: ICONS,
  });
});

module.exports = { staticRouter, manifestRouter };
