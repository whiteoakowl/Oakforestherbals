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

## Phase 4 — Herbal database and materia medica ✅
Done: normalised herb schema with traditions kept separate, standard vocabularies, combined-filter
search engine with full-text index, synonyms, autocomplete, exact-name lookup, history, saved
searches, favourites, related herbs, A–Z and category browsing, profiles with evidence levels and
numbered references, sourced-only safety and research, private practitioner notes, references and
category management, CSV import/export with duplicate detection, bulk editing and photos.
No herb content is shipped: entries come from your sources via the editor or CSV import.
Next, with Phase 5: the formula builder reads herbs and their safety entries from here.

## Phase 5 — Apothecary, formulas and manufacturing ✅
Done: lots with landed cost, FEFO/FIFO consumption, suppliers, purchase orders and receiving,
adjustments/waste/counts, locations, expiry and reorder alerts, valuation; formulas (amounts, parts,
percentages, scaling, costs, herb safety, versions, approval); components; production batches with
QC, actual cost, quarantine/release, batch records and labels; finished-goods lots consumed by
sales; full traceability and recall. Barcode label printing uses lot codes as text (scanner input
works in search fields); generating barcode images is a later addition.

## Phase 6 — Clinic management (core ✅)
You chose to keep real patient records on the current setup (Supabase free plan, no BAA). The
clinic is built privacy-first: app-level encryption, private storage, need-to-know access, signed
notes and a full audit trail — see `docs/PRIVACY.md`, including what that does and doesn't cover.
Patient-facing wording uses "recommendation" and "care plan", never "prescription" or "diagnosis".
- Done: patients, consent, profile, health history, practitioner assignments, clinical notes with
  signing and amendments, encrypted documents, timeline, permanent deletion.
- Next: intake form builder (and patient-completed forms in the portal), note templates, care
  plans with versions, recommendations linked to formulas, progress tracking, two-factor sign-in
  for clinical staff.

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
