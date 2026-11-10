# Changelog

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
