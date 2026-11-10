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
