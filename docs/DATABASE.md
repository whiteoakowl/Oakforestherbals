# Database changes

The base store schema is in `src/db.js` (`SCHEMA`, created with `IF NOT EXISTS`). Everything after
that is a numbered migration in `src/migrations.js`, applied once per database at boot, inside a
transaction, and recorded in `schema_migrations`. Migrations are additive; nothing existing is
dropped, renamed or rewritten without explicit approval.

## Always on: Row Level Security lockdown
On every boot, any table in the `public` schema without RLS gets `ENABLE ROW LEVEL SECURITY`. No
policies are added, so the Supabase Data API (anon/authenticated roles) can't read or write any
table. The app connects as the table owner, which bypasses RLS, so it's unaffected. **Do not add
`FORCE ROW LEVEL SECURITY`** — that would lock the app out too.

## 0001_roles_permissions_audit
| Table | Purpose |
|---|---|
| `roles` | `key` (referenced by `staff.role`), name, description, `is_system` (built-in roles can be edited but not deleted). Seeded with `owner` and `staff` so existing accounts keep their access. |
| `permissions` | The catalog from `src/permissions.js`, synced at boot. `sensitive` marks clinical-record permissions (later phases). |
| `role_permissions` | Which role holds which permission. The owner role is implicit (always everything) and has no rows. |
| `audit_logs` | Append-only security trail. A trigger rejects every `UPDATE` and `DELETE`. Never contains secrets (keys matching pass/secret/token/key/card are redacted) or clinical content. |

Also: `staff.role` gained a foreign key to `roles.key` (`ON UPDATE CASCADE`; deleting a role in use
is refused).

New permissions added in later releases are granted once to the built-in roles listed in
`ROLE_DEFAULTS` when they first appear; after that, the owner's edits are never overwritten.

## 0002_costing_wholesale_pos
| Change | Purpose |
|---|---|
| `login_attempts` | Sign-in/registration throttle shared by every Netlify instance (10 attempts per 15 minutes per IP and form). |
| `materials` | Master list of herbs, ingredients, containers, closures, labels and packaging, costed per purchase pack (`pack_size` + `pack_unit` + `pack_cost` in cents). Phase 5 adds lots and stock to these rows instead of a second list. |
| `material_price_history` | Every pack-price change, with who made it. |
| `variant_materials` | Bill of materials: what one unit of a variant uses (quantity + unit, converted to the material's unit). Materials in use can't be deleted (`ON DELETE RESTRICT`); archive them instead. |
| `variant_costing` | Labour minutes, waste % and overhead % overrides (NULL = store default), other cost, whether the calculated cost is applied, and the last calculated cost. |
| `variants.wholesale_price` | Price charged to customers in the Wholesale group (NULL = retail price). |
| `customers.customer_group` | `retail` (default), `wholesale` or `practitioner`. |
| `products.ingredients`, `directions`, `warnings` | Shown on the product page when filled in. |
| `products.publish_at` | A draft with a past `publish_at` is made active (and `publish_at` cleared) by a sweep that runs at most once a minute per instance. |
| `order_items.unit_cost` | The variant's cost at the moment of sale, so profit reports don't shift when costs change later. NULL for orders placed before this migration. |
| `orders.source` | `web` (default, includes all existing orders), `admin` (manual order) or `pos`. |

### How a variant's cost is calculated
materials (each line converted to the material's unit × pack price) + waste % of materials +
labour (minutes × hourly rate) + other cost, then overhead % on that subtotal, rounded to the cent.
When the variant has a recipe and "use calculated cost" is on, the result is written to the
existing `variants.cost`, which the product editor's margin display already reads. Changing a
material's price recalculates every variant that uses it, in one transaction.

## 0003_clinic_core
All `_enc` columns hold AES-256-GCM ciphertext (`v1:<base64>`) from `src/vault.js`. See `docs/PRIVACY.md`.

| Table | Purpose |
|---|---|
| `patients` | One per customer (`customer_id` UNIQUE, `ON DELETE RESTRICT`). Status, encrypted profile (DOB, preferred name, pronouns, occupation, emergency contact, summary), consent time and who recorded it. |
| `patient_health_items` | Concerns, conditions, medications, supplements, allergies, sensitivities and history entries; `category` in plain text, content encrypted; `active` = current vs past. |
| `practitioner_assignments` | Which staff are assigned to which patient (one can be primary). Drives what practitioners can see. |
| `clinical_notes` | Consultation, SOAP, follow-up, progress, assessment and internal notes; encrypted body; `amends_note_id` links corrections. A trigger blocks any change or deletion once `signed_at` is set (cascading deletes from an owner's permanent record deletion are allowed). |
| `patient_documents` | Metadata for encrypted files in the private bucket: kind, encrypted title, storage key, type, size, uploader. |

## 0004_herbal_database
Seeds only controlled vocabularies (names of categories). **No herb entries, safety data or
citations are shipped** — herbs come from the editor or CSV import.

| Table | Purpose |
|---|---|
| `herbal_traditions` | Western herbalism, Ayurveda, Traditional Chinese Medicine (more can be added). |
| `herb_terms` | Controlled vocabularies: actions (26), energetics, tastes, body systems (14), plant parts, preparation methods, phytochemical classes. `tradition_id` marks terms that belong to one tradition (e.g. TCM nature *Warm (wen)*, Ayurvedic rasa *Tikta*), so traditions are never merged with general terms. |
| `plant_families` | Botanical families, created as herbs are added. |
| `herbs` | Identification (common/Latin name, genus, species, family), botany, history, status (draft/published), and `search_text` + `search_vector` (GIN-indexed) maintained by the app for fast search. |
| `herb_names` | Other common names, botanical synonyms and names within a tradition — all searchable and used for exact-match lookup and duplicate detection. |
| `herb_term_links` | Herb ↔ term, optionally with a source and note. |
| `herb_tradition_profiles` | A tradition's own description of the herb, in its own terms, with its source. |
| `herb_constituents` | Constituents with phytochemical class, part and source. |
| `herb_preparations` | Method, part, menstruum/solvent, ratio, notes, source. |
| `herb_uses` | Traditional applications and research, with evidence level (`traditional`, `preliminary`, `clinical`). A database CHECK requires a source for anything but traditional use. |
| `herb_safety` | Contraindications, cautions, interactions, pregnancy, lactation, children, dosage. `source_id` is NOT NULL: nothing safety-related can be stored without a reference. |
| `herb_sources` | References (books, monographs, articles, reviews, websites). A cited source can't be deleted. |
| `herb_images` | Plant photos (public storage) with credit/licence. |
| `herb_favorites`, `herb_saved_searches`, `herb_search_history`, `herb_staff_notes` | Per-person favourites, saved searches, last 15 searches, and private materia medica notes. |

Search: all selected categories must match (AND); free text matches names, synonyms, family,
categories, constituents, conditions and tradition names via the full-text index plus substring
matching. An exact common, Latin, synonym or tradition name opens the profile directly.

## 0005_apothecary_manufacturing
Works like Craftybase: every purchase is a **lot** with its own landed unit cost; production uses
lots first-expiring-first, then oldest-first, so each batch carries its **actual** cost next to the
estimate from the recipe. Quantities are stored in base units (g, ml, each).

| Table | Purpose |
|---|---|
| `suppliers` | Supplier directory (contact, website, certifications, lead time, minimum order). Existing free-text supplier names on materials were copied in. |
| `inventory_locations` | Storage locations (seeded with "Main apothecary"). |
| `materials` (new columns) | `supplier_id`, `herb_id` (link to the herbal database), `plant_part`, `sku`, `stock_unit`, `reorder_point`/`reorder_qty` (base units), `storage_instructions`, `organic`, `track_stock`, `formula_id` (set on a component made from a formula). |
| `purchase_orders`, `purchase_order_items` | Draft → ordered → partly received → received (or cancelled). Shipping and tax are spread over lines by value into each lot's cost. Receiving updates the material's replacement price and recalculates product costs. |
| `material_lots` | One receipt or one production output: lot code, supplier lot, harvest and expiry dates, location, organic, quality notes, quantity received/remaining, unit cost, status (available, quarantine, recalled, depleted). |
| `inventory_transactions` | Every movement (receive, production use/output, adjustment, waste, count, transfer, recall) with signed quantity, value, reason and who. |
| `formulas`, `formula_ingredients`, `formula_versions` | Formulas with amounts, parts or percentages; yield; instructions; storage; shelf life; labour; visibility (shared/private); status draft → approved (with reviewer) → archived; version snapshots saved on each approval. A formula can create a **component** material whose price follows the formula. |
| `production_batches`, `production_batch_inputs`, `production_quality_checks`, `production_batch_events` | Planned → in progress → awaiting QC → completed (output in quarantine) → released → archived. Inputs record the exact lot, quantity and cost used (one row per lot). QC checklist from settings. |
| `finished_goods_lots` | Finished products made in a batch, with unit cost and best-before; sales draw from them oldest-first. |
| `order_item_lots` | Which batch lot each sold unit came from, so recalls reach orders and restocks return units to their lot. |

Cost changes cascade: a material price change recalculates products that use it **and** formulas
that use it, which re-price their components, which recalculate the products using those.

## 0006_clinic_plans_portal_education
Patient content (`_enc` columns) is encrypted; templates (forms, lessons) are not patient data.

| Table | Purpose |
|---|---|
| `intake_forms` | Form builder templates: questions (text, long text, choice, checkboxes, dropdown, date, 0–10 scale, file, signature, headings), required and conditional questions, versions. |
| `form_assignments`, `form_submissions` | Forms sent to a patient, and their encrypted answers with the exact questions they saw, typed signature, and review. Uploaded files become encrypted patient documents. |
| `care_plans`, `care_plan_items`, `care_plan_versions`, `care_plan_completions` | Care plans with goals and overview, items (herbal recommendations, approved formulas, products, supplements, nutrition, diet, lifestyle, routines, lessons, resources, recipes, goals, checklist items, follow-ups, assessments) with dose, frequency, timing, duration, preparation and cautions; shared with the patient when ready; previous versions kept when an active plan changes; daily task completion by the patient. |
| `patient_logs` | Journal entries, symptom scores and wellness scores (energy, sleep, mood, stress, digestion) by the patient, and practitioner progress reviews. |
| `message_threads`, `messages` | Secure two-way messages. Email notifications say a message is waiting and never include its content. |
| `note_templates` | Reusable clinical note templates (private or shared). |
| `lessons`, `lesson_questions`, `courses`, `course_lessons`, `lesson_assignments`, `lesson_progress` | Education library (lessons, information sheets, guides, recipes, preparation instructions, videos, checklists, quizzes), courses, assignments to patients and their progress. |
| `patient_documents` (new columns) | `shared_with_patient`, `uploaded_by_patient`. |
| `patients.portal_enabled` | Whether the patient can use My clinic. |

## 0007_scheduling_invoices_finance
| Table | Purpose |
|---|---|
| `practitioner_profiles` | Public name, title, bio, qualifications, areas, photo, whether they show on the booking page and accept online bookings, and a private calendar-feed token. |
| `appointment_types`, `appointment_type_staff` | Consultations, follow-ups, group sessions, workshops: length, buffer, price, deposit, in person/online, capacity, online booking, who offers them. |
| `practitioner_hours`, `practitioner_time_off` | Weekly hours (clinic time zone, two blocks a day) and days off. |
| `appointments` | Bookings with status (booked, confirmed, completed, no-show, cancelled), mode, location/video link, price/deposit, invoice, weekly series, encrypted internal notes, reminder tracking. |
| `appointment_waitlist` | Clients waiting for a type/practitioner; emailed when a slot opens. |
| `invoices`, `invoice_items` | Invoices (draft, open, partial, paid, void) with a private link for the client and card payment through Stripe. |
| `payments` | One ledger of money in and refunds out for orders and invoices (back-filled from existing paid/refunded orders). |
| `expenses` | Business expenses by category. |

Booking is conflict-safe: a slot is re-checked inside a transaction under a per-practitioner lock.
Calendar feeds and appointment emails contain the appointment type, time and place — never client
names or health details.

## 0008_notifications_automation
| Table | Purpose |
|---|---|
| `notifications`, `notification_reads` | In-app staff notifications, addressed to one staff member or to everyone holding a permission; de-duplicated by key; read state per person. |
| `notification_templates` | Edited versions of the email/SMS templates (missing row = the built-in default). |
| `sms_outbox` | Every SMS: number, text, template, status (`logged` when Twilio isn't configured, `sent`, `failed`). |
| `email_outbox.template` (new column) | Which template produced an email. |
| `customers` (new columns) | `sms_opt_in`, `sms_opt_in_at`, `email_reminders` — the customer's reminder preferences. |
| `invoices.reminded_at` | When the last overdue reminder went out. |
| `automation_runs` | Each run of the hourly automations (trigger, start/finish, summary or error). |
| `staff_preferences` | Per-staff settings, e.g. hidden dashboard widgets. |

Each automation claims its row before sending (`reminder_sent_at`, `reminded_at`, the digest day),
so overlapping or repeated runs never send twice. The AI assistant adds no tables: it stores neither
questions nor answers.

## 0009_performance_indexes
Indexes only (no data changes): herb uses, preparations, tradition profiles and images by herb;
invoice lines by invoice; invoices by customer and by status/due date; batches by status; staff
notifications by recipient; order lines by variant; orders by payment status and date.

## 0010_two_factor_key_rotation
| Change | Purpose |
|---|---|
| `staff.totp_secret_enc`, `totp_enabled_at`, `totp_last_step` | Two-step sign-in: the authenticator secret (encrypted with the site key), when it was turned on, and the last code's time step (so a code can't be reused). |
| `staff_recovery_codes` | Ten single-use recovery codes per person, stored as bcrypt hashes. |
| `patient_documents.key_id` | Which encryption key each private file was last written with (used by key rotation). |
| `clinical_notes_lock_signed()` (replaced) | Signed notes stay locked, except that the re-encryption tool may rewrite their encrypted columns — and nothing else — after a key change. |

Encrypted values are now written as `v2:<key id>:<data>` (older `v1:` values are still read).

## 0011_reviews_gift_cards_bundles_downloads
| Change | Purpose |
|---|---|
| `products.kind` | `standard`, `bundle`, `digital` or `gift_card`. |
| `order_items.product_kind`, `properties`, `bundle_snapshot` | What kind of item was sold, gift card recipient details, and a bundle's parts at the time of sale (used to restock). |
| `product_reviews` | One review per customer per product: rating, text, verified-buyer flag, status (pending/published/hidden), public reply. |
| `gift_cards`, `gift_card_transactions` | Cards (SHA-256 of the code, last 4 characters, value, balance, expiry, recipient) and every change to a balance. |
| `orders.gift_card_total`, `gift_card_id` | How much of an order a gift card paid. |
| `bundle_components` | Which variants (and how many of each) make up a bundle variant. |
| `digital_files`, `download_links` | Files sold as downloads (in private storage) and each buyer's limited link. |

Selling a gift card is left out of "product sales" in Financials (the money is owed to the customer until
it's spent); the order where it's spent counts as the sale. The payments ledger records the gift card's
share of an order as its own line.
