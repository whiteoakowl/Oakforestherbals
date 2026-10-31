# Oak Forest Herbals — online store

A complete online store you own: a customer-facing storefront plus a Shopify-style admin to manage products, orders, customers, discounts, content, theme and settings.

It runs on **Netlify** (the website and checkout) with **Supabase** (the database and product images), deployed from **GitHub**. Built with Node.js, Express and EJS templates on Postgres.

## Try it in your browser (no install)

Open **https://codespaces.new/whiteoakowl/Oakforestherbals/tree/ccr-1b4f9340-qkold8** and click **Create codespace**.
After a couple of minutes the store opens in a new tab with demo products and orders loaded.

- Admin: add `/admin` to the end of that tab's address, then log in with `owner@example.com` / `password123`.
- The address is private to your GitHub account. Stop the codespace when you're done (github.com/codespaces) to save your free hours.

## Put it online with Netlify + Supabase

### 1. Get three values from Supabase

In your Supabase project (create a new one for the store, or use an existing one):

1. Click **Connect** at the top of the project. Under **Transaction pooler**, copy the connection string (it uses port **6543**) and replace `[YOUR-PASSWORD]` with your database password. This is your `DATABASE_URL`.
2. Go to **Project Settings → Data API** and copy the **Project URL**. This is your `SUPABASE_URL`.
3. Go to **Project Settings → API Keys** and copy a **secret key** (starts with `sb_secret_`; the older **service_role** key also works). Do not use the publishable key. This is your `SUPABASE_SERVICE_ROLE_KEY`. Keep it secret — the store only uses it on the server, never in the browser.

You don't need to create any tables or storage buckets: the store creates its tables on first visit and a public `store-media` bucket on the first image upload.

### 2. Add environment variables in Netlify

In Netlify, open the site → **Site configuration → Environment variables** and add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Transaction pooler connection string from step 1 |
| `SUPABASE_URL` | your Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | your secret key (`sb_secret_...`) or legacy service_role key |
| `SETUP_KEY` | any password you make up — you'll type it once to create your admin account |
| `BASE_URL` | your store's address, e.g. `https://oakforestherbals.netlify.app` (used in email links) |

### 3. Deploy

Netlify builds from the branch set under **Site configuration → Build & deploy → Branches** (usually `main`). Merge this work into `main`, or point that setting at this branch, then trigger a deploy. No build command is needed; `netlify.toml` already tells Netlify what to do.

### 4. Create your admin account

Visit `https://your-site/admin`. The first visit shows a setup screen: enter the `SETUP_KEY` from step 2, your name, email and a password. That account is the store owner.

### 5. Optional: load the demo catalog

To start with the demo products, pages, shipping rates and discounts, run this once from a computer or Codespace with the project checked out:

```bash
DATABASE_URL='your-connection-string' npm run seed
```

### Good to know

- **Supabase free plan:** projects pause after about a week without activity. A store with regular visitors stays awake; Supabase Pro never pauses and adds daily backups.
- **Image uploads** are limited to 4 MB each on Netlify (Netlify Functions accept requests up to about 6 MB).
- **Your domain** can stay on Netlify DNS exactly as with your other sites.

## Run it on your own computer

Requires Node.js 20 or newer.

```bash
npm install
npm run seed -- --orders   # optional demo data
npm start                  # http://localhost:3000, admin at /admin
```

Without `DATABASE_URL`, the store uses a built-in copy of Postgres saved in `data/pglite/`, so nothing else needs installing. Run the tests with `npm test` (set `TEST_DATABASE_URL` to also test against a real Postgres server).

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
| `DATABASE_URL` | — | Postgres connection string (Supabase transaction pooler). Without it, the embedded database in `data/pglite/` is used |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Store uploaded images in Supabase Storage. Without them, images go to `uploads/` |
| `SUPABASE_BUCKET` | `store-media` | Storage bucket name (created automatically, public) |
| `SETUP_KEY` | — | Required to create the first admin account, when set |
| `BASE_URL` | — | Public URL of the store, used for links in emails |
| `SESSION_SECRET` | derived | Cookie signing secret; defaults to one derived from `DATABASE_URL` |
| `PORT` | `3000` | HTTP port when running with `npm start` |

## Project layout

```
netlify.toml           Netlify config: static files from public/, everything else to the function
netlify/functions/     the Netlify Function that runs the store
server.js              entry point for running locally
src/app.js             Express app, sessions, middleware, routes
src/db.js              Postgres schema and helpers (Supabase in production, embedded for local/tests)
src/storage.js         image uploads (Supabase Storage or local folder)
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
