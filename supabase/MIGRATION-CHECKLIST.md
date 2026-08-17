# Supabase migration — the manual steps

Everything here needs a person: a dashboard, a credential, or a decision. The code-side work
is separate and is listed at the end so you can see what you are unblocking.

Order matters. Steps 1–4 are prerequisites, not housekeeping — skipping step 1 in particular
will strand every account, including possibly your own.

---

## Phase 0 — before touching Supabase at all

### 1. Configure email, and deploy it. **Do this first.**

Netlify → Site configuration → Environment variables (Production):

```
GL_BREVO_KEY=<your Brevo API key>
GL_MAIL_FROM=Granite Logistics <ken@usegl.com>
```

Then **redeploy** — Netlify bakes environment variables at build time, which is why
`GL_ADMIN_EMAILS` appeared unset until a redeploy earlier.

Why first: accounts here are hashed with **scrypt** (`hashPw` in
`netlify/functions/_auth.mjs`). Supabase Auth stores its own bcrypt hashes in
`auth.users.encrypted_password` and cannot import a foreign hash, so **every account will
have to set a new password**. With email unconfigured there is no self-service reset — the
only route is Team & Roles → Reset password, one account at a time, performed by an admin who
can still sign in. Configure email and the same migration becomes "everyone gets a reset
link".

Verify: `curl -s https://usegl.com/api/health` should show `passwordReset` as `ok`.

### 2. Rotate `GL_AUTH_SECRET`.

Unrelated to Supabase, but do it now rather than during a cutover. It is the single HMAC key
behind every session, and it was exposed in conversation. Anyone holding it can mint a valid
token for any address; for an address in `GL_ADMIN_EMAILS` that is full ops access.

Set a new value, redeploy. Passwords are unaffected (per-user salts, independent of this
key). Everyone signs in again. In-flight reset and verification links die.

### 3. Push the 10 unpushed commits.

They include the driver-scan fix, the local-account warning, and the admin password reset —
which is your only recovery path until step 1 lands.

### 4. Take a backup, and keep it.

In the app: **Settings → Data Management → Export full backup (JSON)**.

This file is both the migration input and your rollback. Do not delete the Netlify Blobs data
after cutover until you are confident — Blobs is your only way back.

---

## Phase 1 — create the project

### 5. Create the Supabase project.

- **Region**: pick the one nearest your operators. You are in Dayton, Ohio, so an
  `us-east` region will give the lowest latency. Region cannot be changed later.
- **Tier**: check the current terms on project pausing. Free-tier projects are paused after a
  period of inactivity, which is fine for a demo and not fine for a system a driver depends
  on at 6am. If this is going to carry real shipments, budget for a paid tier.
- **Database password**: generate a strong one and store it in a password manager. You will
  need it for direct Postgres connections.

### 6. Collect three credentials.

From Project Settings → API (the dashboard moves things around; look for "API keys"):

| Credential | Who needs it | Sensitivity |
| --- | --- | --- |
| Project URL | client + server | public |
| `anon` key | client | designed to ship in a browser bundle |
| `service_role` key | server only | **full access, bypasses RLS** |

The `service_role` key must never reach the browser. If you paste it in a chat — with me or
anyone — treat it as burned and rotate it afterwards.

### 7. Decide one architecture question.

**Do the Netlify Functions stay as the API layer in front of Supabase, or move to Supabase
Edge Functions?**

I would keep the Netlify Functions. `/api/orders` is your API-first pitch and its contract is
published on your own landing page; keeping it means the migration is "swap what the
functions talk to" rather than "re-implement and re-document the public API". It also keeps
the `service_role` key server-side in one place you already control.

Moving to Edge Functions is defensible if you want to drop Netlify entirely, but it changes
your public API surface and every integration built against it.

**This decision changes what I build, so tell me which before I start.**

---

## Phase 2 — database and storage

### 8. Apply the schema.

Run `supabase/schema-relational.sql` in the SQL Editor. **Read it first, and watch the first
run** — it has never been executed against a real Postgres, so treat the first application as
a review, not a formality.

### 9. Seed `bootstrap_admins`.

```sql
insert into public.bootstrap_admins (email, note) values
  ('business@alexshick.com', 'founder'),
  ('kenfilbert@hotmail.com', 'ops');
```

This replaces `GL_ADMIN_EMAILS`. **Note the change in how you recover from a lockout:** today
it is "edit a Netlify variable and redeploy"; afterwards it is "run SQL in the Supabase
dashboard". Same guarantee, different break-glass. Make sure you will still have dashboard
access when you need it.

### 10. Create the storage bucket.

Name `condition-photos`, **private** (not public).

It must be private. Your public tracking page deliberately exposes status, dates and
destination city only — no name, address, phone, or contents. A public bucket would turn a
tracking number into a permanent link to someone's delivery photos. Access has to be via
short-lived signed URLs minted server-side.

---

## Phase 3 — move the data

### 11. Generate the migration output.

```bash
npm run migrate:supabase path/to/your-backup.json
```

Writes `supabase/migration-out/`: `01-packages.sql`, `02-accounts.csv`, `photos/`, and a
`MIGRATION.md` with the counts.

### 12. Upload the photos.

Upload `migration-out/photos/` into the `condition-photos` bucket **preserving the directory
paths** — the SQL rows point at `tenant/GL-####/pickup.webp`. If the paths shift, every photo
reference breaks silently.

### 13. Run `01-packages.sql`.

### 14. Create the accounts.

Invite or create every address in `02-accounts.csv`. Each one sets a new password (step 1 is
what makes this bearable). Assign ops roles via `public.role_grants`, or rely on
`bootstrap_admins` for the admins.

### 15. Verify RLS **as each role**, before trusting it.

This is the step people skip and regret. A policy that wrongly returns zero rows looks
exactly like an empty table, and a policy that is too permissive looks exactly like working
software.

Sign in as a customer, a Viewer, a Runner and an Admin, and confirm for each:

- a customer sees **only** their own parcels, and cannot write any
- a Viewer reads the tenant and cannot write
- a Runner/Admin reads and writes the tenant
- nobody reads another tenant

---

## Phase 4 — cutover

### 16. Add the credentials to Netlify.

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
```

Redeploy.

### 17. Configure Supabase Auth.

- **Site URL**: `https://usegl.com`
- **Redirect URLs**: include `https://usegl.com/app.html`
- **SMTP**: point it at Brevo with the same credentials from step 1. Supabase's built-in mail
  is rate-limited and intended for development.

### 18. Cut over, then watch.

Keep the Netlify Blobs data untouched for at least a week. If something is wrong, that data
plus the backup from step 4 is your only way back.

### 19. Only then, delete the old backend.

This is the step you asked me to do earlier. It is safe **here** and not before, because
until step 15 passes there is nothing to fall back to.

---

## What Supabase does not fix

Worth being clear so the migration is not asked to carry weight it cannot:

- **Carrier tracking** still needs UPS/FedEx sandbox credentials. Everything above
  `fetchScans` is already built and unaffected by any of this.
- **Payments** still do not exist and need product decisions, not a database.
- **The photo ceiling** is fixed by moving photos out of `localStorage` — which Netlify Blobs
  could do today, without any migration. Supabase Storage is a fine place to land, but the
  migration is not what fixes it.

---

## What I do once you are through Phase 1

Needing only the Project URL and `anon` key, plus your answer to step 7:

1. Supabase-backed data layer behind the existing `provider === "supabase"` seam.
2. Photos to Storage with signed, expiring URLs.
3. Retire `appendOrderWithRepair` and the tombstone merge — a unique constraint and
   `deleted_at` replace them.
4. Auth last: Supabase Auth plus the throttle, the role chain, and session supersession,
   then re-earning the 146 tests that currently cover them.

Give me a Supabase project or install Docker (I can run Supabase locally and verify the
schema against a real Postgres) and I can start on 1 and 2 immediately.
