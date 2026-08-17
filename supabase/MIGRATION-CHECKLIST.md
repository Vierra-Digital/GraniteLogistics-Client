# Supabase migration — the manual steps

Everything here needs a person: a dashboard, a credential, or money. The code-side work is
separate and is listed at the end so you can see what you are unblocking.

The four open decisions from the first draft are now settled and folded in, so nothing below
is a question. They were: region, tier, whether the Netlify Functions stay as the API layer,
and whether the photo bucket is public. Recorded where each one lands.

Order matters. Steps 1–3 are prerequisites, not housekeeping — skipping step 1 in particular
will strand every account, including possibly your own.

**No backup step, at your instruction.** That is a real change to the shape of this migration,
not a step deleted: with no export held aside, the live Netlify Blobs data is your only way
back, so it must survive untouched through cutover. That is why the old backend is deleted
last (step 18) and not before, and why step 10 takes a fresh export as *migration input*
rather than reusing an archived one.

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

Verify:

```bash
curl -s https://usegl.com/api/health
```

`passwordReset` should read `ok`.

### 2. Rotate `GL_AUTH_SECRET`.

Unrelated to Supabase, but do it now rather than during a cutover. It is the single HMAC key
behind every session, and it was exposed in conversation. Anyone holding it can mint a valid
token for any address; for an address in `GL_ADMIN_EMAILS` that is full ops access.

Set a new value, redeploy. Passwords are unaffected (per-user salts, independent of this
key). Everyone signs in again. In-flight reset and verification links die.

### 3. Push the 10 unpushed commits.

They include the driver-scan fix, the local-account warning, and the admin password reset —
which is your only recovery path until step 1 lands.

---

## Phase 1 — create the project

### 4. Create the Supabase project.

- **Region: `us-east-1` (N. Virginia).** Nearest to Dayton of the US options, and the region
  cannot be changed afterwards.
- **Tier: paid, if this carries real shipments.** Free-tier projects are paused after a period
  of inactivity — fine for a demo, not fine for a system a driver opens at 6am to a dead
  database. This is the one item here that costs money, so it is yours to veto; if you veto
  it, treat the result as a demo environment and do not cut production over to it.
- **Database password**: generate a strong one and store it in a password manager. You will
  need it for direct Postgres connections.

### 5. Collect three credentials.

From Project Settings → API (the dashboard moves things around; look for "API keys"):

| Credential | Who needs it | Sensitivity |
| --- | --- | --- |
| Project URL | client + server | public |
| `anon` key | client | designed to ship in a browser bundle |
| `service_role` key | server only | **full access, bypasses RLS** |

The `service_role` key must never reach the browser. If you paste it in a chat — with me or
anyone — treat it as burned and rotate it afterwards. I only need the Project URL and the
`anon` key; the `service_role` key goes straight into Netlify at step 15 and I never see it.

**Architecture, decided: the Netlify Functions stay as the API layer.** Supabase becomes what
they talk to instead of Blobs. `/api/orders` is your API-first pitch and its contract is
published on your own landing page, so keeping it makes this a swap behind the boundary rather
than a re-implementation and re-documentation of your public API — and it keeps the
`service_role` key in one server-side place you already control. Edge Functions stay
available later for anything genuinely new; nothing here forecloses them.

---

## Phase 2 — database and storage

### 6. Apply the schema.

Run `supabase/schema-relational.sql` in the SQL Editor. **Read it first, and watch the first
run** — it has never been executed against a real Postgres, so treat the first application as
a review, not a formality.

### 7. Seed `bootstrap_admins`.

```sql
insert into public.bootstrap_admins (email, note) values
  ('business@alexshick.com', 'founder'),
  ('kenfilbert@hotmail.com', 'ops');
```

This replaces `GL_ADMIN_EMAILS`. **Note the change in how you recover from a lockout:** today
it is "edit a Netlify variable and redeploy"; afterwards it is "run SQL in the Supabase
dashboard". Same guarantee, different break-glass. Make sure you will still have dashboard
access when you need it.

### 8. Create the storage bucket.

Name `condition-photos`, **private** — not public. Not a preference; the alternative is a
disclosure.

Your public tracking page deliberately exposes status, dates and destination city only — no
name, address, phone, or contents. A public bucket would turn a tracking number into a
permanent link to someone's delivery photos, undoing exactly that. Access is via short-lived
signed URLs minted server-side.

---

## Phase 3 — move the data

### 9. Take a fresh export — as migration input.

**Settings → Data Management → Export full backup (JSON)**, or the body of
`GET /api/state`.

You said you do not need a backup, and this is not one: it is the file the transform reads.
Take it as late as you can before the cutover so the least amount of live activity is
stranded. It costs nothing to keep it afterwards, and if you do, you have a rollback you
would otherwise not have.

### 10. Generate the migration output.

```bash
npm run migrate:supabase path/to/export.json
```

Writes `supabase/migration-out/`: `01-packages.sql`, `02-accounts.csv`, `photos/`, and a
`MIGRATION.md` with the counts. Touches no network and no live system.

### 11. Upload the photos.

Upload `migration-out/photos/` into the `condition-photos` bucket **preserving the directory
paths** — the SQL rows point at `tenant/GL-####/pickup.webp`. If the paths shift, every photo
reference breaks silently.

### 12. Run `01-packages.sql`.

### 13. Create the accounts.

Invite or create every address in `02-accounts.csv`. Each one sets a new password (step 1 is
what makes this bearable). Assign ops roles via `public.role_grants`, or rely on
`bootstrap_admins` for the admins.

### 14. Verify RLS **as each role**, before trusting it.

This is the step people skip and regret. A policy that wrongly returns zero rows looks
exactly like an empty table, and a policy that is too permissive looks exactly like working
software.

Sign in as a customer, a Viewer, a Runner and an Admin, and confirm for each:

- a customer sees **only** their own parcels, and cannot write any
- a Viewer reads the tenant and cannot write
- a Runner/Admin reads and writes the tenant
- nobody reads another tenant

With no backup held aside, this is the gate. Do not go past it on the assumption that the
policies are fine because the app looks fine.

---

## Phase 4 — cutover

### 15. Add the credentials to Netlify.

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
```

Redeploy.

### 16. Configure Supabase Auth.

- **Site URL**: `https://usegl.com`
- **Redirect URLs**: include `https://usegl.com/app.html`
- **SMTP**: point it at Brevo with the same credentials from step 1. Supabase's built-in mail
  is rate-limited and intended for development.

### 17. Cut over, then watch.

**Leave the Netlify Blobs data completely untouched for at least a week.** With no export held
aside, it is the only copy of anything the migration got wrong. Do not clear a store, do not
delete a key, do not "tidy up".

### 18. Only then, delete the old backend.

This is the step you asked me to do earlier. It is safe **here** and not before, because until
step 14 passes and step 17 has run quiet for a week, there is nothing to fall back to.

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

Needing only the Project URL and the `anon` key. Step 5's architecture decision is settled, so
this is now a fixed plan rather than a branch:

1. A Supabase data layer behind the existing `provider === "supabase"` seam, read and written
   by the Netlify Functions — the public `/api/*` contract does not change.
2. Photos to Storage with signed, expiring URLs.
3. Retire `appendOrderWithRepair` and the tombstone merge — a unique constraint and
   `deleted_at` replace them.
4. Auth last: Supabase Auth plus the throttle, the role chain, and session supersession, then
   re-earning the 146 tests that currently cover them.

Give me a Supabase project or install Docker — with Docker I can run Supabase locally and
verify the schema against a real Postgres, which is the one claim in this document I currently
cannot make — and I can start on 1 and 2 immediately.
