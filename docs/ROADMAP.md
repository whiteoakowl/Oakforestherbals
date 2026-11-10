# Implementation roadmap

How the store grows into the full herbal business system. Each phase ships on its own, is tested
before the next starts, adds to the schema through migrations only, and keeps every existing URL
and feature working. See `ASSESSMENT.md` for the reasoning.

Status key: ✅ done · 🔜 next · ⏸ waiting on a decision from you

## Phase 1 — Audit ✅
`docs/ASSESSMENT.md`.

## Phase 2 — Core infrastructure ✅ (this branch)
- Versioned migrations (`src/migrations.js`, `schema_migrations` table).
- RLS enabled on every table, on every boot (closes the Supabase Data API).
- Roles and permissions: 9 built-in roles plus custom roles, editable permission sets, server-side
  enforcement on every admin route, permission-aware navigation. Existing owner and staff accounts
  keep exactly the access they had.
- Append-only audit log (sign-ins, failed sign-ins, access denials, staff/role/settings changes),
  with secrets redacted.
- Sectioned, data-driven admin navigation that later modules plug into.
- Login throttle moved into the database (done in Phase 3).

## Phase 3 — Store management and product costing ✅ (core)
- **Materials and costing:** cost per unit for ingredients and packaging (bottle, cap, label…),
  labour rate, overhead and waste %; a bill of materials per variant. This builds a calculated cost
  that feeds the existing `variants.cost` field, so the current margin display keeps working.
- Retail/wholesale price, gross profit and margin per product and per category; "what's affected"
  when a material price changes.
- Product extras: ingredients, directions, warnings, scheduled publishing, archive status.
- Customer groups (retail/wholesale/practitioner) and wholesale pricing.
- Point of sale screen (in-person orders, cash/card, stock deduction, receipt) built on the
  existing manual-order flow.
- Done: materials, recipes, cost roll-up, price-change impact, profitability report, wholesale
  groups and prices, product details, scheduled publishing, point of sale.
- Still to do in this area: product reviews, gift cards, abandoned-checkout emails, bundles/kits,
  digital downloads, subscriptions (Stripe Billing) and card payments at the point of sale
  through Stripe Terminal. Each is its own piece of work; they're scheduled alongside Phase 8.

## Phase 4 — Herbal database and materia medica 🔜
- Normalised schema: herbs, botanical names and synonyms, plant families, actions, energetics,
  tastes, body systems, constituents, preparations, parts used, traditions (Western, Ayurvedic,
  TCM… kept separate, never merged), safety information, references.
- Every claim tied to a source and an evidence level (traditional / preliminary / clinical).
  **No herb data or citations will be invented.** The database ships with the controlled
  vocabularies only (action, energetic, taste and body-system lists); herb entries come from you,
  your references or a licensed dataset, via the admin editor or CSV import.
- Combined-filter search (e.g. warming + bitter + digestive + carminative), autocomplete,
  synonym matching, saved searches and favourites, using Postgres full-text and trigram indexes.

## Phase 5 — Apothecary, formulas and manufacturing
- Raw herbs and supplies as inventory items with **lots** (supplier, lot number, cost, harvest and
  expiry dates, location, certificates), suppliers and purchase orders, receiving, adjustments,
  waste, expiry and reorder alerts.
- Formula builder linked to the herb database: parts/ratios/percentages, unit conversion,
  scaling, cost roll-up, versions, safety flags, practitioner review before use.
- Production batches: planned → in progress → QC → completed → released. Completing a batch, in
  one transaction, deducts the exact lots used, records every movement, creates finished-goods stock
  (linked to a store variant), and writes the actual cost.
- Full traceability: lot → batches → finished goods → orders and patients, and the reverse
  (recall lookup). Printable batch records, weighing sheets and labels.

## Phase 6 — Clinic management ⏸ (built privacy-first; no real patient data until cleared)
Decision so far: Supabase **free plan**, which has no Business Associate Agreement. So the clinic
module will be built and tested with test data only, behind its own permission, and real patient
records must not be entered on the live site until you're on a plan with a signed BAA (if HIPAA
applies) or have confirmed it doesn't. Patient-facing wording uses "recommendation" and "care plan",
never "prescription" or "diagnosis".
Patients (linked to customers), private practitioner assignments, intake form builder, clinical
notes and templates, care plans with versions, recommendations linked to formulas, progress
tracking, private document storage with signed URLs, access-logged record views.

## Phase 7 — Patient portal and education
"My Clinic", "My Learning", "My Wellness" inside the existing `/account` area; lessons, courses,
quizzes and assignments; purchase-from-care-plan.

## Phase 8 — Scheduling, payments and finance
Appointment types, availability, booking with deposits and policies, reminders; a payments and
refunds ledger (back-filled from existing orders); invoices; expenses; financial dashboards and
accounting exports; Stripe and SMTP secrets moved to environment variables.

## Phase 9 — Communications, automation and AI
Message centre, email/SMS templates and consent, scheduled reminders (Netlify Scheduled
Functions), and an optional AI assistant limited to each user's permissions, with clinical output
always practitioner-reviewed and never turned into a recommendation automatically.

## Phase 10 — Hardening
Permission matrix tests across every role, privacy tests, the two end-to-end workflows from the
brief, mobile and accessibility passes, performance checks with large herb and order volumes.

## What I'll need from you along the way
| When | What |
|---|---|
| Before deploying anything | Which branch Netlify deploys from; a fresh Supabase backup (Database → Backups, or `pg_dump`) |
| Phase 3 | Your labour rate, overhead approach and packaging costs (or I'll leave them as editable settings) |
| Phase 4 | Your herb reference sources, and whether you have an existing herb list/spreadsheet to import |
| Phase 6 | The HIPAA/privacy answer, your Supabase plan, and the patient-facing wording you want |
| Phase 8 | Stripe account access (for Billing/subscriptions), calendar provider choice |
| Phase 9 | Email and SMS provider accounts (e.g. Postmark, Twilio) and an AI API key |
