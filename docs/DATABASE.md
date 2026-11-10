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
