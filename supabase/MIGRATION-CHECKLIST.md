# Supabase migration — what is left, and what is done

Project `yjafrhkrcdldvfcqxcol` exists and its publishable key works. The code is written: the
Netlify Functions read and write Postgres rows through `netlify/functions/_supabase.mjs`, and
condition photos go to a private Storage bucket behind signed URLs. `GET /api/health` reports
which store is live under `storage`.

**Two things gate the switch, and only one of them is a real task.**

1. The schema has to be applied. There is no psql, Docker or Supabase CLI on the machine this
   was built on, so it has never touched a real Postgres and the first run has to be watched
   by a person. That is step 2 below.
2. Email has to be configured before **auth** moves. Auth has not moved and is not part of
   this; workspaces can switch today without touching a single password.

You said there is no data in the old system you care about. If that still holds, skip Phase 3
entirely — there is nothing to migrate, and a fresh empty workspace is one less thing to get
wrong.

---

## Phase 1 — rotate what leaked

### 1. Rotate the secret API key, and the database password.

Both were pasted into a chat transcript. Settings → API Keys for the first, Settings →
Database → Reset database password for the second.

The new secret key goes into Netlify at step 5 and nowhere else. The database password is only
needed for direct psql connections and is not used by any of this code.

---

## Phase 2 — apply the schema

### 2. Run `schema-relational.sql` in the SQL Editor. **Read it as it goes.**

SQL Editor → New query → paste the whole file → Run.

It was corrected before you run it. Checking it against what the app actually stores turned up
five things that would each have looked like working software and then silently lost data:

| Was missing | What would have happened |
| --- | --- |
| `packages.load_unit`, `sort_zone`, `presort_lane` | pre-sorting a parcel survives until the next pull, then vanishes |
| `manifests.transmitted` | handing a manifest to a carrier does not stick |
| `load_units` had `zip_prefix`/`city`/`state` | columns for data the app never writes, and none for the zone, lane and weight it does |
| no `activity_events` table | the Activity Log comes back empty and the client's entries are dropped |
| no `workspace_settings` table | company name, default carrier and lane are not stored |
| no unique constraint on `package_events` | every sync appends another copy of every custody entry |

If a statement errors, paste me the message and the statement. A failure part-way leaves the
earlier tables created, so tell me rather than re-running blind.

### 3. Seed `bootstrap_admins`.

```sql
insert into public.bootstrap_admins (email, note) values
  ('business@alexshick.com', 'founder'),
  ('kenfilbert@hotmail.com', 'ops');
```

Confirm both addresses first. This table is service-role-only and replaces `GL_ADMIN_EMAILS`,
so a lockout is recovered by running SQL here rather than by editing a Netlify variable.

### 4. Create the bucket: `condition-photos`, **Public off**.

Not a preference. A public bucket turns a tracking number into a permanent link to someone's
delivery photos, which is what the public tracking page is built to prevent. The code mints
signed URLs that expire in ten minutes.

---

## Phase 3 — only if you want the old data

Skip if the current contents do not matter.

### 5. Export, transform, upload, run.

```bash
npm run migrate:supabase path/to/export.json
```

Settings → Data Management → Export full backup (JSON) produces the input. The output is
`01-packages.sql`, `02-accounts.csv`, and `photos/`. Upload `photos/` into the bucket
**preserving directory paths** — the rows point at `tenant/GL-####/pickup.webp` — then run the
SQL. The transform now also carries the activity log and the settings, and its SQL is checked
against the schema by the test suite.

---

## Phase 4 — switch

### 6. Add the credentials to Netlify, and redeploy.

```
SUPABASE_URL=https://yjafrhkrcdldvfcqxcol.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<the rotated secret key>
```

Both together are the switch. Either one alone changes nothing, deliberately: a half-configured
deployment keeps reading the store its data is actually in rather than an empty project.

Netlify bakes environment variables at build time, so **redeploy** or nothing changes.

### 7. Confirm the switch from outside.

```bash
curl -s https://usegl.com/api/health
```

`storage` should read `supabase`, and `readiness.checks.workspaceStorage.detail` should mention
a row per parcel. If it still says Netlify Blobs, the redeploy has not happened.

### 8. Then exercise it, in this order.

1. Sign in as an ops user and pull. An empty workspace is the correct result on a fresh project.
2. Place a customer order. It should appear in the ops queue.
3. Photograph a pickup on Runner. Then confirm the photo is a signed URL, not a data URL —
   this is the ceiling fix, and the point at which the old ~23-parcel limit is gone.
4. Build a manifest, transmit it, reload. `transmitted` is one of the columns that was missing.
5. Delete a parcel, then pull. It must stay deleted — that is `deleted_at` replacing tombstones.

### 9. Leave Netlify Blobs alone for a week.

You are keeping no backup, so the Blobs data is the only copy of anything this gets wrong.
Do not clear a store, do not delete a key. Setting the two variables back to empty is a
complete rollback for as long as it survives.

---

## Not part of this, and why

- **Auth stays on Blobs.** scrypt with per-user salts, HMAC sessions, `pwChangedAt`
  supersession, a throttle built so it cannot enumerate accounts, and roles re-derived
  server-side per request — the most audited part of the system. Moving it trades that for
  new and unverified, and every account would need a new password, which is why email has to
  be configured first. Nothing above requires it.
- **Carrier tracking** still needs UPS/FedEx credentials. Unaffected by any of this.
- **Payments** still need product decisions, not a database.

## Still outstanding from before, unrelated to Supabase

- `GL_BREVO_KEY` + `GL_MAIL_FROM`, and a redeploy. Without them there is no password reset.
- `GL_AUTH_SECRET` rotation. It was exposed in conversation.
- Seven unpushed commits.
