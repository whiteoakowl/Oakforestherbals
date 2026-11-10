# Technical assessment — existing Oak Forest Herbals application

Audit date: 2026-11-10. Audited from the repository (`whiteoakowl/oakforestherbals`, default branch
`ccr-1b4f9340-qkold8`, commit `e8b6e8b`). The live Netlify site and Supabase project were **not**
inspected directly (no credentials in this environment), so anything about production data,
Supabase dashboard settings or Netlify environment variables below is inferred from the code and
must be confirmed.

## 1. Summary

The application is a complete, well-built, server-rendered Shopify-style store: storefront,
three-step checkout, customer accounts and a full admin. It is small (≈5,400 lines), consistent
and tested end to end. It is a good foundation to grow into the herbal business system **if we keep
its architecture** rather than replace it.

It is **not** a React/SPA application, and it does **not** use Supabase Auth, the Supabase client
library, Edge Functions, RLS policies or a migrations folder. Supabase is used only as a hosted
Postgres database and for image storage. That shapes the whole plan (section 5).

## 2. What exists

| Area | What's there |
|---|---|
| Runtime | Node 20+, Express 5, EJS templates. The whole app runs as **one Netlify Function** (`netlify/functions/server.js` via `serverless-http`); `public/` is served from Netlify's CDN. |
| Database | Postgres through the `postgres` driver to Supabase's **transaction pooler** (port 6543, `prepare: false`). Locally and in tests: embedded Postgres (PGlite). 25 tables, created at boot with `CREATE TABLE IF NOT EXISTS` under an advisory lock (`src/db.js`). Money is integer cents throughout. |
| Migrations | None before this work — schema changes to existing tables had no mechanism. |
| Auth | Two account systems, both bcrypt + Postgres-backed sessions: **staff** (`staff` table, `/admin`) and **customers** (`customers` table, `/account`). First-run owner setup guarded by `SETUP_KEY`. CSRF token on every non-GET request. Login throttle is in memory. |
| Roles | Only `owner` (everything) and `staff` (everything except Settings). |
| Storefront | Home sections, collections with filters/sort, product pages with up to 3 variant options, predictive search, cart, checkout with discounts/shipping/tax, order status page, customer accounts (orders, addresses, password reset), blog, pages, policies, contact form, newsletter, password page, sitemap/robots, responsive layout. |
| Admin | Dashboard (sales, orders, AOV, visitors, chart, to-dos, low stock), orders (fulfil, track, refund, cancel, packing slip, manual orders, CSV), products (variants, media, SEO, cost & margin, CSV import/export, bulk inventory), collections (manual/automated), customers (segments, lifetime spend, CSV), discounts, content (pages, blog, files, menus), analytics, theme editor, settings (general, payments, checkout, shipping, taxes, notifications+outbox, policies, preferences, staff). |
| Payments | Stripe Checkout via direct REST calls (`src/stripe.js`) plus `checkout.session.completed` webhook; manual methods (bank transfer, COD, check). No card data touches the app. |
| Email | Nodemailer over any SMTP provider; every message is logged to `email_outbox` first. |
| Storage | Supabase Storage **public** bucket `store-media` (auto-created) for images; local `uploads/` otherwise. 4 MB limit on Netlify. |
| Design system | `public/css/admin.css` (Polaris-like admin: cards, tables, badges, toasts, forms) and `public/css/store.css` (theme-driven CSS variables). Small vanilla JS in `public/js/`. |
| Tests | `node:test` end-to-end suite booting the real app on in-memory Postgres (15 tests before this work). |
| Integrations configured in code | Stripe, SMTP. Nothing else (no SMS, calendar, shipping, accounting, AI). |

## 3. Findings and risks

Ranked by severity.

1. **High — database tables were likely reachable through Supabase's Data API.** Supabase
   publishes the `public` schema over its REST API to anyone with the project's publishable/anon
   key, which is public by design. Every table here was created in `public` with Row Level Security
   **off**, including `sessions` (live login sessions), `staff` (password hashes), `customers`,
   `orders` and `settings` (which stores the **Stripe secret key and SMTP password**). Whether this
   was actually exploitable depends on the project's Data API settings and default grants, which I
   can't see. **Fixed in Phase 2** (RLS enabled on every table; the app is unaffected because it
   connects as the table owner). Once deployed, please check *Supabase → Database → Tables* shows
   RLS on everywhere. If the Data API was enabled, rotate the Stripe secret key and SMTP password
   as a precaution.
2. **Medium — secrets live in the database.** The Stripe secret key, webhook secret and SMTP
   password are stored in plain text in `settings`. They should move to Netlify environment
   variables (with the database value kept as a fallback for compatibility). Planned for Phase 8.
3. **Medium — schema could not evolve safely.** `CREATE TABLE IF NOT EXISTS` can't add columns to
   existing tables. **Fixed in Phase 2** with versioned, recorded migrations (`src/migrations.js`).
4. **Medium — the login throttle doesn't work on Netlify.** It's an in-memory map, and each
   function instance has its own memory. It should move to a database table (Phase 2 follow-up).
5. **Medium — storage is public-only.** Fine for product photos; unusable for patient documents,
   lab results or photos. Clinic files need a **private** bucket, server-checked access and
   short-lived signed URLs (Phase 6).
6. **Medium — serverless limits.** Netlify Functions cap request bodies at ~6 MB and execution
   time at 10 s by default (26 s maximum on most plans). Large uploads (PDF lab results, videos)
   must go directly from the browser to Supabase Storage via signed upload URLs. Long jobs (bulk
   imports, AI summaries, reminder runs) need Netlify Background or Scheduled Functions.
7. **Low — staff sign-out after role change matched session IDs loosely** (`staffId 5` also matched
   `50`). Fixed in Phase 2.
8. **Deployment ambiguity.** The README says Netlify builds `main`, but the repository's default
   branch is `ccr-1b4f9340-qkold8` and there is no `main`. Please confirm which branch the live
   site deploys from before anything is merged.

## 4. Privacy, HIPAA and scope of practice (needs your decision before Phase 6)

- **HIPAA may or may not apply.** It generally applies to "covered entities" (e.g. providers who
  bill health insurance electronically) and their business associates. Many herbal practices are
  not covered entities — but state laws can still apply to consumer health data (for example
  Washington's My Health My Data Act). This needs a short conversation with a lawyer; I can't
  decide it for you.
- **Using Supabase or Netlify does not make anything HIPAA-compliant.** If HIPAA applies, every
  service that stores or transmits patient data needs a signed Business Associate Agreement:
  Supabase offers one on its Team plan and above with the HIPAA add-on; Netlify's standard plans
  do not, as far as I know (verify with Netlify sales). Email, SMS and AI providers would need
  BAAs too, and messages must not carry clinical detail.
- **Recommendation:** build the clinic modules with privacy designed in (private storage, per-
  patient access checks, audit trail, minimum-necessary notifications), but **don't put real
  patient records into production** until the legal question is answered and any required BAAs are
  signed.
- **Wording carries legal risk.** In most US states herbalists are unlicensed, and words like
  "prescription", "diagnosis" and "treatment" can imply practising medicine. I recommend the
  system use "recommendation", "protocol" or "care plan" in patient-facing text, with the exact
  wording set by you.

## 5. Architecture decision

**Recommendation: keep the existing Express + EJS + Postgres architecture and grow it in place.**

- It already works, is tested, and owns the storefront URLs and customer experience the brief says
  to preserve. Rewriting into a React/Supabase-client app would be a from-scratch rebuild in all but
  name.
- **One authentication system** is kept: the app's own sessions, now with role-based permissions
  enforced on the server for every admin route. Customers and patients share the existing
  `customers` login (a patient is a customer with a clinic record), so there's no second login.
- **Row Level Security** is used as a deny-all wall in front of the Supabase Data API, because the
  browser never talks to Supabase directly. Fine-grained rules ("a practitioner sees only assigned
  patients") are enforced in server code, in one place per module, and covered by tests. If you
  later want browser-side Supabase access, per-user RLS policies can be added then.
- New modules plug into the same shell, navigation (`src/admin-nav.js`), permissions
  (`src/permissions.js`), audit log (`src/audit.js`) and migrations (`src/migrations.js`).

## 6. Reuse map: proposed tables → what already exists

The brief's table list is a logical design. Where something already exists it is reused, not duplicated.

| Proposed | Existing / decision |
|---|---|
| profiles, staff_profiles | `staff` (extend with profile fields when needed) |
| user_roles, permissions | `staff.role` → `roles`; `permissions`; `role_permissions` (Phase 2) |
| business_settings, system_settings | `settings` (JSON groups) |
| products, product_images | `products`, `product_images` |
| product_variants | `variants` (already has `cost`, `sku`, `barcode`, stock) |
| product_categories | `collections` + `products.product_type` |
| product_tags | `products.tags` (normalise later only if filtering needs it) |
| customers, customer_addresses | `customers`, `addresses` |
| orders, order_items | `orders`, `order_items` |
| payments, refunds | today: `orders.financial_status`, `payment_ref`, `refunded_total` + `order_events`. New `payments`/`refunds` ledger tables in Phase 8, back-filled from these. |
| discounts, coupons | `discounts` (codes); gift cards are new |
| email_logs | `email_outbox` |
| audit_logs | new (Phase 2) |
| patients | new, linked 1:1 to `customers` |
| everything else (herbs, formulas, inventory lots, batches, clinic, education, scheduling, finance) | new tables, per phase |
