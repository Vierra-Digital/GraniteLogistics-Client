# Granite Logistics

An installable PWA covering the full **order to delivery-confirmed** journey: a
customer-facing ordering app, an operations platform, API-first order ingest, a real
Code 128 chain of custody, and condition photos.

Two audiences share one codebase:

- **Customers** get a focused three-tab app (Home / Orders / Account) with real
  accounts, order placement, tracking, and cancellation.
- **Ops** (Admin / Runner / Driver / Viewer) get the dense platform: ingest, labels,
  pre-sort, manifests, driver scan, returns, reports, and an audit log.

Mobile is customer-only for now. On a viewport of 980px or narrower the app always
renders the customer experience, whatever role is saved, because the ops tools assume
a desktop-sized screen.

## Run it locally

Static files, no build step:

```bash
python -m http.server 8080
# open http://localhost:8080
```

A server (not `file://`) is required for the service worker and install prompt.

Note that `/api/*` does not exist under a plain static server, so the app falls back to
local-only accounts and local order storage. That fallback is deliberate and also covers
being offline. To exercise the real API, deploy to Netlify or run `netlify dev`.

## Tests

```bash
npm test
```

121 tests, no network and no browser required, in two layers:

- **Unit** (`test/functions.test.mjs`) covers the pure logic: workspace merging, id
  allocation, session tokens, tenant and api-key resolution, role assignment, the public
  tracking sanitizer, order rate limiting, and the outbound email payload.
- **Integration** (`test/integration.test.mjs`) drives the **real function handlers**
  with `@netlify/blobs` swapped for an in-memory store, so it verifies the pieces
  actually fit together. Most importantly it proves the end-to-end loop: a customer
  places an order, ops sees that package in the shared workspace, ops advances it, and
  the customer sees the new status. It also covers cross-account isolation, cancellation
  rules, stale-push protection, tombstoned deletions, forged and expired tokens,
  password-change session invalidation, the legacy order migration, and the authorization
  rules on the ops workspace (customer sessions refused, demo keys refused, `Viewer`
  read-only, no self-granted roles), per-account order rate limiting, role administration
  (a non-admin gets 404, you cannot change your own role or remove the last Admin, env-set
  roles are read-only, every change is audited), the concurrent-write repairs, and that
  neither the public `/api/health` report nor the admin account list discloses a secret.

The integration layer needs `--experimental-test-module-mocks`, which the npm script
already passes.

## Deploy (Netlify)

Connect the repo. `netlify.toml` needs no build command; the functions in
`netlify/functions/` are picked up automatically and storage is Netlify Blobs, so
there is no database to provision.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `GL_AUTH_SECRET` | **Yes, for production** | HMAC secret for session tokens. Without it a public fallback constant is used, which means anyone reading this repo could forge a session. Use a 32-byte random hex string. |
| `GL_BREVO_KEY` | For password reset | [Brevo](https://www.brevo.com) API key (starts `xkeysib-`), from **SMTP & API > API keys**. Without it the reset endpoint returns a clear "not set up" error instead of failing silently. Sent over Brevo's transactional HTTP endpoint rather than SMTP, so no SMTP client is bundled and no socket is held open inside a function invocation. |
| `GL_MAIL_FROM` | For password reset | Verified sender, e.g. `Granite Logistics <no-reply@usegl.com>`. |
| `GL_ADMIN_EMAILS` | To use the ops platform | Comma-separated emails granted the `Admin` role, e.g. `you@co.com,ops@co.com`. Without this, every account is a Customer and nobody can reach the ops workspace. |
| `GL_ROLES` | Optional | JSON map of email to a non-Admin ops role, e.g. `{"dana@co.com":"Runner"}`. Valid roles are `Admin`, `Runner`, `Driver`, `Viewer`. |
| `GL_VAPID_PUBLIC` | For push notifications | Public half of the VAPID keypair, handed to browsers at subscribe time. Not a secret. Generate with `npm run vapid`. |
| `GL_VAPID_PRIVATE` | For push notifications | Private half. **A secret** — it signs every push this server sends. Rotating both invalidates every existing subscription; devices re-opt-in and the dead ones are pruned on first refusal. |
| `GL_TENANTS` | Optional | JSON map of api key to tenant, e.g. `{"my-key":"my-tenant"}`. Setting it **replaces** the built-in demo keys rather than adding to them, which switches the public keys off. |

Changing `GL_AUTH_SECRET` invalidates every existing session, which is the correct
behaviour when rotating it.

### Roles are assigned by the operator, never by the client

A role comes from env config first, then from grants made on the **Team & Roles** screen,
and the role stored on the account is never trusted (registration once accepted a
client-supplied role). Effective role is re-derived on every login and on every
`/api/state` request, so revoking someone takes effect immediately rather than whenever
their 30-day token happens to expire.

**Env config outranks the admin screen and cannot be edited from it.** That is the recovery
path: if the stored grants are wrong, or nobody can sign in as an Admin any more, set
`GL_ADMIN_EMAILS` and that account is an Admin at its next login. To bootstrap a new
deployment, set `GL_ADMIN_EMAILS`, sign up with that address, sign in, then grant everyone
else from **Team & Roles** — no further redeploys needed.

The screen lives at **Team & Roles** in the sidebar and appears only for an Admin with a
real server session; in local/offline demo mode it is removed rather than shown broken. It
also shows an **access history**: who granted or revoked whose role, and when. That log
matters because the grants record only holds what is true now, so a revocation would
otherwise erase every trace that access had ever existed.

### The built-in api keys are public

`granite-dev-key` and friends appear in this repo and in the client bundle, so they are
not secrets. They stay valid for `POST /api/orders`, which only writes, and they are
rejected by `/api/state`, which reads. For a real machine integration set `GL_TENANTS`.

## API

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/health` | none | Liveness and storage backend. |
| `GET /api/track?n=` | none | Public shipment lookup behind shareable tracking links. Returns a deliberately minimal view (status, dates, destination city, carrier) because tracking numbers are sequential and guessable. No recipient details, contents, or photos. |
| `POST /api/auth` | none | `register`, `login`, `reset-request`, `reset-confirm`. `login` and `reset-request` are throttled per address and answer `429` with `Retry-After`. |
| `GET /api/auth` | Bearer token | Validates a session and returns the current user. |
| `GET/POST/DELETE /api/my-orders` | Bearer token | A customer's own orders. Email comes from the verified token, so callers can only reach their own rows. `DELETE` cancels, and only before pickup. `POST` is rate limited per account (3/minute, 12/hour) and answers `429` with `Retry-After`; reads and cancellations are never limited. |
| `GET/PUT /api/state` | Bearer token with an ops role, or a `GL_TENANTS` key | An ops client's whole workspace. Every recipient's name, address and phone lives here, so this is the one endpoint with real authorization: a Customer session gets 403, `Viewer` may read but not `PUT`, and the public demo keys are refused. |
| `GET/POST /api/admin` | Bearer token, Admin only | Role administration. `GET` lists accounts with where each role comes from, plus the recent access history; `POST {email, role}` grants or revokes (`Customer` revokes). Answers `404` to a non-admin so the endpoint does not confirm it exists. Refuses changing your own role, removing the last Admin, editing an env-set role, or granting to an address with no account. Every change is appended to an audit trail, including revocations, which otherwise leave no trace. |
| `GET/POST/DELETE /api/push` | `GET` none; writes need a Bearer token | Web Push subscriptions. `GET` reports whether push is configured here and returns the public VAPID key, unauthenticated because the client needs it before deciding whether to offer the option. Writes take the account from the verified token, never the body, so a device cannot be registered against someone else's account. |
| `POST /api/orders` | `x-api-key` | Webhook ingest, single order or `{orders:[...]}`. Write-only, so a demo key here means at worst junk orders, not disclosure. |

Passwords are salted and scrypt-hashed. Sessions are HMAC-signed, stateless, and carry
an issued-at so that a password change invalidates every session minted before it.

**Credential endpoints are throttled per email address.** Six failed sign-ins inside 15
minutes locks that address for 15 minutes; a correct password clears the count immediately,
and completing a password reset clears a lock, so somebody locked out by an attacker can
always recover through their inbox. Unknown addresses are counted exactly like real ones —
counting only real accounts would turn the throttle into an account-enumeration oracle.
Reset requests are held tighter (three per 15 minutes) because there the request itself is
the harm: it mails a third party. Counting is per address rather than per IP, since an
attacker rotates IPs trivially while the target of a credential-stuffing run is one account.

## Storage model, and why it matters

Everything for one tenant lives in a single Netlify Blobs record. Customer orders are
rows in that same record, tagged with `customerEmail`. That is what makes a customer
order visible to ops, and an ops status change visible to the customer.

Three consequences worth knowing before changing this code:

1. **Ops clients push their entire local workspace.** That state can be minutes old, so
   `PUT /api/state` does not blindly replace. It preserves any customer order missing
   from the payload (created since that client last pulled) unless the client explicitly
   tombstoned it in `deleted`. Without this, a routine ops push would delete recent customer
   orders and webhook-ingested shipments. The rule covers anything created server-side
   (identified by `uid`), not just customer orders; packages an ops client created itself are
   not preserved, so its own deletions and a local demo reset still behave normally. See
   `mergePushedPackages` in `netlify/functions/_lib.mjs`.
2. **Ids are allocated across the whole workspace.** Customer orders are numbered
   server-side, so clients call `syncSeqFromPackages()` whenever server-numbered
   packages arrive, otherwise a local package could reuse an existing id.

Customers never push the whole workspace; they only ever go through `/api/my-orders`.

### Where customer status updates come from

`PUT /api/state` is the server-side event. Ops clients do not mutate storage directly; they
push the whole workspace through that handler, which therefore holds both the stored state
and the incoming one and can see exactly what moved. `_notify.mjs` diffs them and emails the
owner of any customer order that reached a stage worth announcing.

Both channels, email and push, share one record of what has been announced, so a customer
with push enabled gets one of each per real transition and never two of either.

Three things keep that safe inside a handler ops calls every ~1.5 seconds: the work is gated
on a transition actually being found; only four of the seven stages are announced, because a
parcel that emails on all of them is a parcel people mute; and what has already been
announced is recorded in a store no client writes. That last record is not decoration —
ops pushes stale whole state, so a parcel can be pushed backwards and re-advance, which
looks like a brand new transition. Without it the customer is emailed twice for one real
move. A mail failure never fails the push, which has already been stored.

3. **There is no compare-and-swap.** `@netlify/blobs` v8 has no conditional writes, so two
   simultaneous orders can clobber each other. That race has two outcomes: an order is
   lost, or both orders are handed the same id because both computed `nextId` from the same
   snapshot (two parcels, one tracking number). Neither can be *prevented* without CAS, but
   both are detectable, so `appendOrderWithRepair` writes, re-reads, and checks that exactly
   one copy of its `uid` is present holding an id nobody else holds. If not, it rebuilds onto
   the newest state, taking a fresh id if its own was taken. A caller that exhausts its
   attempts gets a `503` rather than a false confirmation. Both `/api/my-orders` and the
   webhook ingest go through it.

   This makes the outcome self-correcting, not the write atomic. A writer holding a much
   older snapshot can still overwrite an order that was already confirmed; that is what the
   preserve rule in point 1 covers on `/api/state`.

## Cloud sync providers

**Settings → Cloud Sync** offers two providers for the ops workspace:

- **Granite API** (default): the Netlify Functions above, or the bundled Node server.
  Leave Server URL blank for same origin. Auto-sync is on by default for ops roles. The
  client sends both its session token and the api key, because Netlify authorizes by role
  while the bundled Node server authorizes by key. On Netlify you must be **signed in as
  an ops user** for sync to work; the key alone is no longer enough.
- **Supabase**: browser-to-Postgres, for a fully static deploy. Run
  `supabase/schema.sql`, then paste the Project URL and anon key. The anon key is
  public, so use a non-guessable workspace name for a pilot and add Auth plus RLS
  (commented in the schema) for production.

## Self-hosted Node server (optional)

`server/server.js` is a zero-dependency server that hosts both the app and the API,
useful for label rendering:

```bash
node server/server.js   # http://localhost:8080
```

It adds `GET /api/label/:id` and `GET /api/manifest/:id/labels`, which render real
4x6 PDF labels via Puppeteer. `npm install` pulls Puppeteer; if the bundled Chromium
download is blocked it auto-detects system Chrome or Edge, or set `GL_CHROME`. Labels
render server-side, so the package must already exist on the server. `POST /api/orders`
also accepts an optional `x-signature` HMAC of the body using `GL_WEBHOOK_SECRET`.

## Pages

- `index.html` public landing: one hero section, PWA install, track bar.
- `track.html` public tracking lookup (status stepper, ETA, condition photos).
- `app.html` the app itself. Installing the PWA opens here.

## What works for real

- Real accounts with hashed passwords, cross-device sessions, and password reset.
- Server-side authorization: the ops workspace is gated on the signed-in account's role,
  re-derived per request, so revoking access takes effect immediately.
- **Team & Roles**: an Admin grants and revokes operations access in-app, with an audit
  trail of who changed whose role.
- Customer ordering: a three-step guided form, order list with search, a clean status
  tracker, shareable tracking links, and cancellation before pickup.
- Orders placed offline are kept and retried, and survive a later server pull.
- Order intake by manual form, CSV import, and webhook.
- Condition photos from the device camera, downscaled and timestamped.
- Live barcode scanning via `BarcodeDetector` where supported, with a dropdown fallback.
- Label printing (4 inch label via the browser) and PDF labels via the Node server.
- ZIP pre-sort, palletized load units, manifests with SCAC and ASN-style payloads.
- SLA tracking (on-time / at-risk / late) and delivery exceptions.
- Returns through Requested, In Transit, Received.
- Reports computed live from chain-of-custody timestamps.
- Role-based navigation, in-app notifications, dark mode, command palette (Ctrl/Cmd-K),
  JSON backup and restore, and a searchable audit log.
- Customer status updates on pickup, in transit, out for delivery and delivered, by email
  and by browser push (opt-in per device, from the customer's Account tab).
- A readiness report at `/api/health` naming any configuration still missing.
- One motion system across the app, with a `prefers-reduced-motion` opt-out.

## What is still simulated

Carrier (UPS/FedEx) and e-commerce calls are mocked, so tracking numbers and carrier scans
are generated locally rather than fetched, and there are no payments. Both need a commercial
account before they can be real.

Everything else is real, including customer status updates by **email and browser push**.

## Files

- `index.html`, `landing.css`, `landing.js` public landing
- `app.html`, `styles.css`, `app.js` the app shell and all views
- `scripts/vapid.mjs` generates a VAPID keypair for push (`npm run vapid`)
- `netlify/functions/` the API (auth, role administration, push, customer orders, workspace
  state, ingest, public tracking, health)
- `test/` regression tests for the function logic
- `barcode.js` pure-JS Code 128 (Set B) to SVG
- `manifest.webmanifest`, `sw.js` installable, offline-capable PWA
- `server/` optional self-hosted Node server and Puppeteer label rendering
- `supabase/schema.sql` schema for the Supabase sync provider
