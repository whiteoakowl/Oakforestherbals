# Clinic records: privacy safeguards

The clinic module stores real patient health information. This page describes what the software
does to protect it, what it can't do on its own, and what you need to do.

**This is not a statement of HIPAA compliance.** The site runs on Supabase's free plan and Netlify,
and neither has a Business Associate Agreement (BAA) with you. If HIPAA applies to your practice,
storing patient records here is not compliant whatever the software does; you would need a plan
with a signed BAA from every service that stores or carries the data. State health-privacy laws
can apply even when HIPAA doesn't. Please confirm your position with a lawyer.

## What the software does
| Safeguard | How |
|---|---|
| Encryption before storage | Profiles (date of birth, emergency contact, summary), every health-history entry, every clinical note, document titles and document files are encrypted with AES-256-GCM inside the app, using `CLINIC_ENCRYPTION_KEY`. Supabase, its backups and its dashboard only ever see ciphertext. Patient names, emails and phone numbers stay readable because they are the customer account (needed for login, orders and search). |
| Private files | Documents go to a **private** Supabase bucket (`clinic-private`), never the public image bucket. The app refuses to use the bucket if someone makes it public. Files are only served through an access-checked page, with `no-store` caching. |
| Need-to-know access | Practitioners see only patients assigned to them; clinic managers see all. Administrators and every other role get **no** clinical access unless the owner grants it. Records a person can't see are reported as "not found". |
| Permission guard rails | Nobody can grant a permission they don't hold, so an administrator can't give themselves clinical access. |
| Signed notes | A signed note can't be edited or deleted — enforced by the database itself, not only the app. Corrections are added as linked amendments. Drafts can only be changed by their author. |
| Audit trail | Every record view, change, download, refused access, assignment and deletion is logged (who, when, which record, from which IP), in an append-only table. Clinical content is never written to the log. |
| Consent | A record can't be created until staff confirm the patient's consent to storing health information; the time and staff member are recorded. |
| Deletion | Only an owner can permanently delete a clinic record (typed confirmation). It removes notes, history and files; the customer account and orders stay. A customer with a clinic record can't be deleted from the Customers screen. |
| Email and SMS | Reminders and notices say only that something is waiting (a message, a form, a plan) or give the appointment type, time and place — never health details. SMS goes only to customers who opted in on their account page (the opt-in time is recorded). |
| AI assistant | Off until `ANTHROPIC_API_KEY` is set. It can only read what the person asking can already see, and it can't change anything. Patient records are sent to Anthropic **only** for staff whose role holds "Let the AI assistant read records of patients they can see", which no role has by default. Questions and answers are not stored; the audit log records that it was used and which look-ups ran. |
| Database API closed | Row Level Security is on for every table, so Supabase's public Data API can't read anything. |

## What you need to do
1. **Set the encryption key.** Generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, add it in Netlify as
   `CLINIC_ENCRYPTION_KEY`, and redeploy. Until then the clinic shows "records locked".
2. **Back the key up** in a password manager. If it's lost, no one — including Supabase or me —
   can recover the records. If it leaks, treat it like a breach.
3. **Change the key only with the rotation steps** in Settings → Security (set the old key as
   `CLINIC_ENCRYPTION_KEY_PREVIOUS` first). Replacing it without that makes existing records unreadable.
4. **Back up the database yourself.** The free plan has no automatic backups. Backups contain only
   ciphertext for clinical data, so the key is needed to restore anything useful.
5. **Keep accounts tight:** give clinical roles only to people who need them, use strong unique
   passwords, remove staff who leave, and review Settings → Audit log regularly.
6. **Keep clinical detail out of email and SMS.** The store's emails don't include clinical
   information; don't add any to templates.
7. Devices used to view records should have screen locks and disk encryption.

| Two-step sign-in | Staff can (and, if you choose, must) enter a code from an authenticator app after their password; ten single-use recovery codes cover a lost phone; owners can reset it for others. Settings → Security sets who must use it — "owners and anyone who can see patient records" is recommended. |
| Idle sign-out | Staff who can see patient records are signed out after 30 minutes without activity (adjustable in Settings → Security). |
| Key rotation | Settings → Security re-encrypts every record and file with a new key while the old one is still loaded (`CLINIC_ENCRYPTION_KEY_PREVIOUS`), then the old key can be retired. |

## Known limits (planned work)
- Anthropic does not sign a BAA on ordinary API plans. If you grant the assistant's patient-record
  permission, patient details leave your systems for Anthropic's API; leave it off if that isn't acceptable.
