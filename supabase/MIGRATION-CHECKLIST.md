# Supabase migration — status and what is left

Project `yjafrhkrcdldvfcqxcol`, **us-east-2**, Postgres 17.6.

## Done, and verified against the live project

- **Schema applied.** All fourteen tables, RLS enabled on every one, eleven policies, the
  helper functions, the `gl_role` enum, and the seeded `default` tenant. Sent as one
  multi-statement query, so it committed atomically rather than part-way.
- **Re-runnable.** The whole file was applied a second time and succeeded. That is what
  recovery from a failed statement depends on, and it did not hold until the enum was guarded
  and every policy taught to drop itself first.
- **`condition-photos` bucket created, private**, 5 MB per object, restricted to
  webp/jpeg/png. Verified: the anon key cannot read an object directly, there is no public
  URL, and a signed URL serves the bytes with no credentials for exactly 600 seconds.
- **The data layer round-trips against the real service.** A worst-case workspace — every
  field the app stores, two photos, exception, return, custody history, manifest, load unit,
  activity entry, settings — written and read back unchanged. Photos land in Storage as bytes
  and come back as signed URLs; no data URL reaches the database. Repeated pushes do not
  duplicate custody or activity entries. An update persists, a deletion soft-deletes and stays
  gone, and two appended orders cannot share an id.
- **RLS verified by contrast, not by absence.** With rows present, the service key reads
  them and the anon key reads **zero** from every table, is refused (401) on every write
  including `bootstrap_admins` and `role_grants`, and cannot self-grant a role.
- **Verification data removed.** The database is back to one row: the `default` tenant. The
  bucket is empty.

## Left to do

### 1. Rotate three credentials. All were pasted into a chat transcript.

| Credential | Where |
| --- | --- |
| secret API key (`sb_secret_…`) | Settings → API Keys |
| database password | Settings → Database → Reset database password |
| `GL_AUTH_SECRET` | Netlify, unrelated to Supabase but overdue |

The bucket and the schema survive rotation, so nothing above needs redoing.

### 2. Seed `bootstrap_admins` — yours, because it grants full access.

Left empty on purpose. Confirm the addresses first; the transcript has
`business@alexshick.com` and `kenfilbert@hotmail.com`, but the account running this is
`alex@ndimensions.xyz`, so I am not guessing.

```sql
insert into public.bootstrap_admins (email, note) values
  ('you@example.com', 'founder');
```

This replaces `GL_ADMIN_EMAILS`, and it is service-role-only: a lockout is recovered by
running SQL in the dashboard, not by editing a Netlify variable.

### 3. Switch Netlify over.

```
SUPABASE_URL=https://yjafrhkrcdldvfcqxcol.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<the rotated secret key>
```

Both together are the switch; either alone changes nothing, so a half-configured deployment
keeps reading the store its data is actually in. **Redeploy** — Netlify bakes variables at
build time.

Then confirm from outside:

```bash
curl -s https://usegl.com/api/health
```

`storage` should read `supabase`.

### 4. Configure email, and redeploy.

`GL_BREVO_KEY` + `GL_MAIL_FROM`. Unrelated to the data migration, but it is the prerequisite
for ever moving **auth**, because scrypt hashes cannot import into Supabase Auth and every
account would need a new password.

### 5. Push the commits.

## Not migrated, deliberately

- **Auth stays on Netlify Blobs.** scrypt with per-user salts, HMAC sessions, `pwChangedAt`
  supersession, a throttle built so it cannot enumerate accounts, roles re-derived per
  request. Nothing above required moving it, and moving it trades audited for unverified.
- **Carrier tracking** still needs UPS/FedEx credentials.
- **Payments** still need product decisions.

## Two things worth knowing

- **Condition photos no longer work offline.** They are signed URLs now, not data URLs. That
  is the trade for the ~23-parcel device ceiling disappearing.
- **The region is us-east-2**, not the us-east-1 an earlier draft of this file recommended.
  Region is permanent; us-east-2 (Ohio) is closer to Dayton anyway.
