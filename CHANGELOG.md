# Changelog

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
