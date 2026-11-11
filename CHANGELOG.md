# Changelog

## Unreleased — Phase 9: communications, automation and AI

### Added
- **Communications** (Settings → Communications): editable email and SMS templates for every
  automatic message, with placeholders, preview and reset; email and SMS logs; automation settings
  and run history; "Run now".
- **Automations** every hour (Netlify Scheduled Function `scheduled`): appointment reminders (email,
  and SMS for opted-in customers), overdue-invoice reminders, and a daily digest of low stock,
  expiring lots, care plans due for review and batches awaiting release. Each step is safe to run twice.
- **Notifications**: a bell in the admin header and a notification centre for every staff member —
  patient messages, submitted forms, online bookings, completed batches and the daily digest go to
  the people whose role covers them.
- **Command centre** home page: widgets for notifications, appointments, clinic counts (no names),
  inventory, production, finance, revenue and customers, shown by role and hideable per person.
- **Reminder preferences** on the customer account page: email reminders on/off, SMS opt-in with a
  mobile number.
- **AI assistant** (`/admin/assistant`, needs `ANTHROPIC_API_KEY`): answers questions using read-only
  look-ups of the herbal database, formulas (with costs, scaling and safety entries), apothecary
  stock and sales — each limited by the asker's own permissions. Patient summaries need the new
  sensitive permission "assistant.clinic", granted to no role by default. It cites only stored
  sources, keeps traditions and evidence levels apart, and never diagnoses, prescribes or changes data.
- New permissions: `assistant.use` (given to administrators, clinic managers, practitioners and
  apothecary managers) and `assistant.clinic`.

### Changed
- Every automatic email (forms, care plans, lessons, messages, appointments, waitlist, invoices)
  now goes through the editable templates.

## Unreleased — Phase 8: scheduling, invoices and finance

### Added
- **Online booking** (`/book`): appointment types with practitioners, open times computed from
  each practitioner's weekly hours, time off, existing bookings, buffers, notice and lookahead,
  in the clinic's time zone (daylight saving handled); group sessions with capacity; booking needs
  an account (the chosen time waits through log-in/registration); deposits by card through Stripe
  when configured; confirmation emails; waitlist.
- **My appointments** in the customer account: upcoming and past, add to calendar (.ics), invoice
  link, cancel or change time online up to the cancellation window.
- **Schedule** (Clinic → Schedule): week calendar per practitioner (practitioners see their own),
  staff bookings with weekly repeats and an outside-hours override, statuses (confirmed, completed,
  no-show, cancelled), video links, encrypted internal notes, moving appointments, waitlist, appointment
  types, weekly hours and time off, practitioner profiles, booking rules, and a private calendar feed
  for Google/Apple/Outlook that never includes client names.
- **Invoices**: from appointments or by hand, issue, email a private link, record payments and
  refunds (overpayment refused), card payment by Stripe, print.
- **Financials**: revenue (products and services), cost of goods, gross profit, expenses, net,
  sales tax collected, inventory bought, outstanding invoices, expenses by category, practitioner
  revenue, by month; CSV exports (summary, payments, invoices, expenses). **Expenses** screen.
- A **payments ledger**: every order payment and refund, and every invoice payment, is recorded;
  existing paid orders were imported.


## Unreleased — Phases 6–7: clinic, patient portal and education

### Added
- **Form builder** (Clinic → Forms): intake, health history, lifestyle, digestive, stress, sleep,
  follow-up, consent and custom forms with required and conditional questions, file uploads and
  typed signatures; starter templates; versions. Send a form to a patient; their answers arrive
  encrypted in their record for review.
- **Care plans**: goals, overview and items — herbal recommendations, approved formulas only,
  products the patient can buy, supplements, nutrition, diet, lifestyle, routines, lessons,
  resources, recipes, checklists, follow-ups and assessments — with dose, frequency, timing,
  duration, preparation and cautions. Shared when ready; previous versions kept; printable.
- **Progress tracking**: patient journal, symptom and wellness scores with trend lines, task
  completion, and practitioner progress reviews.
- **Secure messages** between patients and their practitioners; emails only say a message is waiting.
- **Clinic inbox**: unread messages, forms to review, plan reviews due, and your unsigned notes.
- **Note templates**, and **document sharing** with the patient.
- **Education** (Clinic → Education): lessons, information sheets, guides (PDF/Word uploads),
  recipes, preparation instructions, YouTube/Vimeo videos, quizzes and courses; assign to patients
  directly or through a care plan; track reading, completion and quiz scores.
- **My clinic** in the customer account: forms to fill in, shared care plans with daily tasks,
  products from the plan straight to the cart, learning centre, wellness journal, secure messages,
  and documents (shared with them, or uploaded by them). Patients see only their own, shared
  information; clinical notes are never shown. Every portal view and change is audited.
- Stripe and SMTP secrets can now come from Netlify environment variables (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `SMTP_PASS`), overriding values stored in the database.


## Unreleased — Phase 5: apothecary, formulas and manufacturing

### Added
- **Inventory** (Apothecary → Inventory): stock on hand by lot with landed cost, value, reorder
  points, expiry warnings, locations, waste/loss, stock counts and corrections (with reasons), and
  a full movement history per material. CSV export.
- **Suppliers and purchase orders**: draft, order, print, receive in part or in full; shipping and
  tax spread into each lot's cost; supplier lot numbers, harvest and expiry dates and organic status
  recorded on receipt; reorder suggestions from low stock.
- **Formulas** (Apothecary → Formulas): ingredients by amount, parts or percentage, with automatic
  weights, shares, ratios, costs and scaling to any batch size; linked to the herbal database to show
  cautions and flag missing safety information; approval with a safety-review confirmation; version
  history; private or shared; printable formula and weighing sheets.
- **Components**: a formula (e.g. a bulk tincture) can become a stock item used in product
  recipes; its cost follows the formula, Craftybase-style.
- **Production** (Apothecary → Production): batches from approved formulas or product recipes,
  quality checklist, completion that deducts the exact lots in one transaction and records actual
  cost, quarantine and release, printable batch manufacturing records and labels.
- **Traceability and recall**: from any lot, see every batch, component, finished product and order
  it reached; from any batch, see every lot (and supplier lot) it was made from. Recall marks the lot
  and everything made from it, and pulls unsold stock.
- **Actual cost of goods**: sales draw finished units from batch lots oldest-first at their actual
  cost; restocking returns them. The product cost page shows a cost breakdown bar, each material's
  share, actual cost per unit from recent batches, and cost of goods sold.
- New permissions for inventory, formulas (view, manage, approve) and production (manage, approve).


## Unreleased — Phase 4: herbal database and materia medica

### Added
- **Herbalist → Herbal database**: a searchable professional reference. Combine any filters —
  actions, energetics, tastes, body systems, plant parts, preparations, family, tradition,
  constituent or phytochemical class — and every one must match (e.g. Warm + Bitter + Digestive +
  Carminative). Free-text search covers names, synonyms, families, categories, constituents and
  conditions; an exact Latin name, common name or synonym opens the herb. Autocomplete, A–Z and
  category browsing, favourites, saved searches and recent searches.
- **Herb profiles**: identification, names and synonyms, classification grouped by tradition,
  each tradition's own description, uses and research labelled by evidence level (traditional,
  preliminary, clinical), safety (contraindications, cautions, interactions, pregnancy, lactation,
  children, dosage), preparations and extraction, constituents, photos, numbered references,
  related herbs, a "missing information" banner, and private notes for each practitioner.
- **Administration**: add/edit herbs with duplicate detection, manage categories and references,
  CSV import (skip or merge duplicates; unknown categories are reported, never invented), CSV
  export and template, bulk publish and bulk categorise.
- Standard vocabularies for Western herbalism, Ayurveda (rasa, virya) and TCM (nature, flavour),
  kept separate. No herb entries are included.
- Permissions: *herbal database (view)* for every built-in role except customer service; *manage*
  for administrators, clinic managers and apothecary managers.

### Safety rules (enforced by the database)
- Safety and dosage entries must cite a reference.
- Preliminary and clinical research must cite a reference.


## Unreleased — Clinic core

### Added
- **Clinic → Patients**: patient records linked to customer accounts, with consent recorded before
  a record can be created; profile (date of birth, pronouns, emergency contact, summary); health
  history in seven sections (concerns, conditions, medications, supplements, allergies,
  sensitivities, history) with current/past status; allergy banner on every record page.
- **Clinical notes**: consultation, SOAP, follow-up, progress, assessment and internal notes. Drafts
  are editable by their author; signing locks a note permanently; corrections are linked amendments.
- **Documents**: upload lab results, photos, consent and intake forms and other files (PDF, images,
  Word, text, up to 4 MB), stored encrypted in a private bucket.
- **Practitioner assignments** and a per-patient **timeline** (record events plus the customer's orders).
- New sensitive permissions: see assigned patients, see all patients, manage records, assign
  practitioners. Practitioners and clinic managers get them by default; administrators don't.

### Security and privacy
- Clinical content and files are encrypted in the app before storage (`CLINIC_ENCRYPTION_KEY`).
- Every record view and change is audited without clinical content.
- Fixed: saving a role could silently remove permissions the editor didn't hold.


## Unreleased — Phase 3: store management and product costing

### Added
- **Costing** (Store → Costing): a materials list for herbs, ingredients, bottles, caps, labels and
  packaging, priced per pack in g, kg, oz, lb, ml, L, fl oz or each, with price history.
- **Product recipes**: from any product, choose *Recipe and costs* to list what one unit uses, plus
  labour minutes, waste %, overhead % and other costs. The calculated cost per unit feeds the
  product's existing "cost per item" and margin.
- **Price change impact**: when a material's price changes, every product using it is
  recalculated and the page shows old cost, new cost and new margin for each.
- **Store cost settings**: labour rate per hour, default waste % and default overhead %.
- **Profitability report** (Costing → Profitability): margin, units sold, cost of goods and gross
  profit by product and by category, for 30/90/365 days or all time, with CSV export. Orders now
  record each item's cost at the time of sale.
- **Wholesale pricing**: set a wholesale price per variant and put customers in the Wholesale,
  Practitioner or Retail group. Wholesale customers pay wholesale prices in the cart, at checkout
  and on manual orders. New customer segments for wholesale and practitioners.
- **Product details**: ingredients, directions for use and cautions, shown on the product page.
- **Scheduled publishing**: a draft can be set to go live at a chosen time.
- **Point of sale** (Store → Point of sale): search or scan barcodes, attach a customer or sell to a
  walk-in, discount codes, sales tax for your shop's location, cash (with change), card terminal or
  other payment, and a printable receipt. Sales are paid, fulfilled orders that deduct stock.
- New permissions: *Costing* and *Point of sale*, granted to the store roles (and costing to the
  inventory and apothecary roles; point of sale to customer service).

### Security
- The sign-in and registration throttle now works across all Netlify instances (it used to be
  per instance).


## Unreleased — Phase 2: core infrastructure

### Security
- Row Level Security is now enabled on every database table at startup. This closes access through
  Supabase's public Data API; the store itself is unaffected.
- Every admin area is now checked against the signed-in person's permissions on the server.
- Fixed: removing or changing a staff member could also sign out a different staff member whose
  ID started with the same digits.

### Added
- Roles and permissions (Settings → Roles and permissions): built-in roles for Administrator,
  Clinic manager, Herbalist/Practitioner, Apothecary manager, Inventory manager, Store manager and
  Customer service, plus custom roles with editable permissions. Only an owner can grant ownership,
  and nobody can grant a permission they don't hold.
- Staff roles can be changed from Settings → Users; the person is signed out so the change applies
  immediately.
- Audit log (Settings → Audit log): sign-ins, failed sign-ins, refused access, staff, role and
  settings changes. Secrets are never recorded, and entries can't be edited or deleted.
- Versioned database migrations.
- Admin navigation is grouped into sections and only shows what your role can open. Staff with no
  store access get a simple home page instead of the sales dashboard.

### Unchanged
- Existing owner and staff accounts keep exactly the access they had. All storefront, checkout,
  account and admin URLs are unchanged.
