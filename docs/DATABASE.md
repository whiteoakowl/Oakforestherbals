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
