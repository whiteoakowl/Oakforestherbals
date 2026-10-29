# Oak Forest Herbals — self-hosted store

A complete online store you own and run yourself: a customer-facing storefront plus a Shopify-style admin to manage products, orders, customers, discounts, content, theme and settings.

Built with Node.js, Express, EJS templates and SQLite (Node's built-in `node:sqlite`, so there is no database server to install).

## Quick start

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm run seed -- --orders   # optional: demo catalog, pages, shipping, taxes, discounts and sample orders
npm start
```

- Storefront: http://localhost:3000
- Admin: http://localhost:3000/admin — the first visit opens a setup screen to create the owner account.

To create the owner account from the command line instead:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm run seed
```

Run the tests with `npm test`.

## What's included

### Storefront
- Home page with announcement bar, hero banner, featured collection, collection list, testimonial and blog posts — all editable in the theme editor
- Collection pages with sorting (featured, best selling, price, A–Z, date), availability/type filters and pagination
- Product pages with variant picker (up to 3 options), image gallery, sale and sold-out badges, low-stock notice, related products and structured data for search engines
- Predictive search in the header and a full search results page
- Cart with quantity updates, order notes and line removal
- Three-step checkout (Information → Shipping → Payment) with discount codes, shipping rates by country and order value, region-based taxes, billing address and an order status page
- Customer accounts: register, log in, password reset, order history and saved addresses
- Blog, content pages, contact form, policy pages, newsletter signup
- Store password page (for pre-launch), `sitemap.xml` and `robots.txt`
- Mobile-responsive layout

### Admin
- **Home** — sales, orders, average order value, visitors and conversion for a chosen date range, a sales chart, recent orders, things to do and low-stock alerts
- **Orders** — status tabs, search, CSV export; order detail with fulfillment and tracking, mark as paid, refunds with optional restock, cancellation, timeline comments, notes and tags, address editing, packing slips; create orders manually
- **Products** — list with status tabs, filters and bulk actions; editor with rich-text description, media, pricing with profit margin, inventory, shipping weight, options/variants, SEO; duplicate; CSV import and export; inventory screen for bulk stock updates
- **Collections** — manual (pick and order products) or automated (rules on tag, type, vendor, title, price or stock)
- **Customers** — segments (subscribers, repeat customers, prospects, account holders), detail with order history and lifetime spend, notes and tags, CSV export
- **Discounts** — percentage, fixed amount or free shipping; minimum subtotal, usage limits, one per customer, start/end dates
- **Content** — pages, blog posts, file uploads, header/footer navigation menus with dropdowns
- **Analytics** — sales breakdown, top products, top customers, discount usage
- **Online Store → Themes** — live theme editor: colors, fonts, logo, favicon, button radius, announcement bar, home page sections, product card options, footer, social links, with desktop/mobile preview
- **Settings** — store details and currency, payments, checkout options, shipping rates, taxes, email notifications (with outbox), policies, preferences (SEO, tracking code, store password) and staff accounts (owner vs staff permissions)

## Taking payments

Under **Settings → Payments**:

- **Manual methods** (bank transfer, cash on delivery, check) work immediately. Orders arrive as "Payment pending"; mark them paid from the order page.
- **Card payments via Stripe**: paste your Stripe secret key and enable card payments. Shoppers are sent to Stripe Checkout and the order is marked paid when they return. For reliability, also add a webhook in Stripe pointing to `https://your-domain/webhooks/stripe` for the `checkout.session.completed` event and paste its signing secret.

## Sending email

Order confirmations, shipping updates, cancellations, welcome and password-reset emails are always recorded in the outbox under **Settings → Notifications**. Enter SMTP details there (any provider: Gmail, SendGrid, Mailgun, Postmark, SES…) to actually deliver them, and use **Send test email** to check.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | — | Public URL (e.g. `https://shop.example.com`), used for links in emails |
| `NODE_ENV` | — | Set to `production` behind HTTPS so session cookies are marked secure |
| `SESSION_SECRET` | generated | Cookie signing secret; if unset, one is generated and stored in `data/.session-secret` |
| `DB_PATH` | `data/store.db` | SQLite database file |
| `UPLOAD_DIR` | `uploads/` | Where uploaded images are saved |

## Deploying

Any host that runs Node.js 22 works (a VPS, Render, Railway, Fly.io…). The two things to keep on persistent storage are `data/` (database and session secret) and `uploads/` (images). Put the app behind HTTPS and set `NODE_ENV=production` and `BASE_URL`.

With Docker:

```bash
docker build -t oakforest-store .
docker run -d -p 3000:3000 -e BASE_URL=https://shop.example.com \
  -v store-data:/app/data -v store-uploads:/app/uploads oakforest-store
```

Back up by copying `data/store.db` (and `uploads/`).

## Project layout

```
server.js              entry point
src/app.js             Express app, sessions, middleware, routes
src/db.js              SQLite schema and helpers
src/catalog.js         products, collections, menus (read side)
src/pricing.js         cart totals, discounts, shipping and tax
src/orders.js          placing, paying, fulfilling, refunding and cancelling orders
src/routes/            storefront, checkout, account, webhooks, admin/*
views/store, views/admin, views/emails   EJS templates
public/                CSS, JS and images
test/                  end-to-end tests (node:test)
```

## Not yet included

Compared with Shopify, these are not built: gift cards, product reviews, abandoned-checkout recovery emails, multiple currencies/languages, multi-location inventory, shipping label purchase, automatic (code-less) discounts and an app marketplace. Refunds are recorded in the store; money goes back through your payment provider's dashboard.
