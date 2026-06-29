# Granite Logistics — Enterprise Platform (Demo)

A high-fidelity, installable PWA demo of the Granite Logistics enterprise vision:
the full **Auction Win → Delivery Confirmed** journey, with API-first order ingest,
UPS/FedEx carrier integration, a real Code 128 chain-of-custody, and condition photos.

Built for executive pitches. **All external integrations are simulated** (no real
carrier/e-commerce credentials required) so it runs anywhere, offline, with zero setup.

## Run it

It's static files — no build step.

```bash
# from this folder, any static server works:
python -m http.server 8080
# then open http://localhost:8080
```

(Service worker / install prompt need a server, not a `file://` open.)

## Pages

- **`index.html`** — public marketing landing: a single shipping-themed hero with a
  working **Install the App** (PWA) button and a **Track a shipment** bar.
- **`track.html`** — public, customer-facing tracking page (status stepper, ETA,
  condition photos). The landing's track bar routes here (`track.html?n=GL-1042`).
- **`app.html`** — the operations platform (the demo dashboard). Installing the
  PWA opens straight to this page.

## Deploy to a live URL

Drop the folder onto any static host — Netlify, Vercel, GitHub Pages, Cloudflare Pages,
or an S3 bucket. No backend needed for the demo.

## What's in the demo

| View | Shows the pitch story for… |
|------|----------------------------|
| **Executive Overview** | KPIs, live pipeline funnel, carrier mix, active shipments |
| **Order Ingest** | Orders pulled automatically from Shopify / WooCommerce / MacBid — no manual entry |
| **Runner Dashboard** | Condition photos + Code 128 label generation/printing |
| **Batch & Lane Routing** | Grouping items into a carrier manifest at a dock lane |
| **Driver Scan** | Scan-to-retrieve, status updates, carrier tracking numbers |
| **Chain of Custody** | Tamper-evident, end-to-end timeline per package |

**▶ Run Live Demo** (bottom-left) auto-walks one package through the entire journey
with nar/toast callouts — the one-click pitch flow.

## Real functionality (not just simulated)

These work for real, no backend required:

- **Local persistence** — every order and status change is saved to the device
  (localStorage) and survives reloads. **Reset demo data** restores the seed.
- **Manual order intake** — a real form on *Order Ingest* creates orders.
- **CSV import** — upload a CSV of orders (with a downloadable template); rows
  become live packages.
- **CSV export** — download all shipments as a CSV.
- **Real condition photos** — *Photo & Bin* and delivery use the device camera /
  file picker (downscaled + timestamp-stamped); falls back to a placeholder.
- **Live barcode scanning** — *Driver Scan* uses the browser `BarcodeDetector` +
  camera where supported (Chromium/Android); the dropdown is the fallback.
- **Label printing** — the label dialog prints a clean 4" label via the browser.
- **Search** — filter the chain-of-custody list by id, customer, city, etc.
- **Reports & Analytics** — a dashboard with KPIs (avg transit time, delivery rate,
  value delivered) and charts computed live from the chain-of-custody timestamps.
- **Manifests** — batches are recorded as manifests you can **print** or **export
  to CSV** for the carrier.
- **Edit / delete packages** — full CRUD from the package detail dialog.
- **Customer tracking page** (`track.html`) — public status lookup with a delivery
  stepper, ETA, and condition photos.
- **Role-based access** — a workspace picker (Admin / Runner / Driver / Viewer) on
  entry; grouped navigation shows only the tools each role should see, with a role
  badge + one-click "Switch".
- **Field mode** — Runner and Driver land on a focused, big-button **Home** (task
  tiles + large actions / a scan CTA), distinct from the admin's data-dense overview.
- **Notifications** — a top-bar alerts bell with a live count of open exceptions and
  SLA breaches; click any alert to jump straight to the package.
- **Dark mode** — a platform-wide light/dark toggle that persists per device.
- **Returns / reverse logistics** — initiate a return on any delivered package and
  move it through Requested → In Transit → Received, with a dedicated Returns queue.
- **Command palette** — Ctrl/⌘-K to jump to any view or open any package fast.
- **Settings** — editable company profile that flows onto printed labels &
  manifests, default carrier/lane, and **full JSON backup / restore** to move data
  between devices.
- **Activity Log** — a tamper-evident audit trail of every chain-of-custody event,
  searchable, newest first.
- **Operational logistics** (facility prep before carrier handoff):
  - **ZIP-code pre-sort** — groups outbound parcels by destination ZIP zone and
    routes each to a dock lane to bypass initial hub handling.
  - **Palletized / load-ready staging** — consolidates parcels into standardized
    load units with weight + density metrics.
  - **Streamlined manifesting** — transmits a manifest to the carrier as a
    structured ASN / EDI-214-style payload (with SCAC), and prints/exports it.
- **Exceptions & SLA** — every package has a promised-delivery (SLA) date with
  live On-time / At-risk / Late status; delivery exceptions (address issue, damage,
  weather, failed attempt, customs hold) can be flagged and resolved. Open
  exceptions and SLA breaches surface in an **Alerts** panel, on the customer
  tracking page, and in the Reports on-time rate.

## Backend & cloud sync (optional)

The app runs fully standalone (localStorage). To share data across devices, there's
a **zero-dependency Node backend** (`server/server.js`, no npm install):

```bash
node server/server.js     # serves the app AND the API on http://localhost:8080
# API key defaults to "granite-dev-key" (override with GL_API_KEY=...)
```

API (all but health require header `x-api-key`):
- `GET /api/health` — open status (reports tenant count)
- `GET / PUT /api/state` — read / replace the caller's workspace
- `GET /api/packages` — list packages
- `POST /api/orders` — **API-first ingest** (single or `{orders:[...]}`); supports an
  optional `x-signature` HMAC-SHA256 of the body (secret = `GL_WEBHOOK_SECRET`)
- `GET /api/label/:id` — **Puppeteer-rendered 4×6 PDF shipping label** (Code 128)
- `GET /api/manifest/:id/labels` — every label in a manifest as one multi-page PDF

**Labels (Puppeteer):** `npm install` (root) pulls Puppeteer. The bundled Chromium
download may be blocked; the label service auto-detects a system **Chrome or Edge**,
or set `GL_CHROME` to a Chromium executable path. Labels are rendered server-side, so
the package must exist on the server (via Cloud Sync push / auto-sync, or `POST /api/orders`).
These endpoints also accept the key as `?key=` so a label opens as a normal link.

**DB options (no cloud API):** the server stores per-tenant JSON files under `server/data/`.
For an embedded database with no external service, swap that for **SQLite** (Node 24 ships
`node:sqlite`); for a pure-browser/static deploy, **IndexedDB** is the zero-infra store.

**Multi-tenant:** each API key maps to an isolated tenant (default keys:
`granite-dev-key`→default, `acme-key`→acme, `globex-key`→globex; override with
`GL_TENANTS='{"key":"tenant"}'`). State persists per tenant under `server/data/`.

In the platform, **Settings → Cloud Sync**: pick a **provider**, then **Push** / **Pull**
— or enable **Auto-sync** (debounced push on change, pull on load).

### Run free on Netlify + Supabase (no server)
The app can sync straight to Supabase from the browser, so the whole thing is static:
1. **Supabase** → create a free project; SQL Editor → run `supabase/schema.sql`.
2. **Netlify** → deploy this repo (drag-drop the folder, or connect the repo; `netlify.toml`
   needs no build step).
3. In the deployed app: **Settings → Cloud Sync → Provider: Supabase**, paste your
   **Project URL** + **anon key**, set a **workspace** name, and Push / enable Auto-sync.

Security note: the anon key is public, so the default schema lets anyone with it + the
workspace name read/write that row — fine for a pilot (use a non-guessable workspace
name); harden with Supabase Auth + RLS (commented in `schema.sql`) for production.
The bundled Node server (and `POST /api/orders` webhooks) is the alternative provider
for self-hosting.

### Run free on Netlify + Neon (serverless functions)
Everything on Netlify — functions are the API, Neon is free Postgres (no separate server,
and `DATABASE_URL` never touches the browser):
1. **Neon** → create a free project, copy the connection string.
2. **Netlify** → deploy this repo, then Site settings → Environment variables:
   - `DATABASE_URL` = your Neon connection string (required)
   - `GL_TENANTS` = `{"your-key":"your-tenant"}` (optional; defaults include `granite-dev-key`)
3. In the app: **Settings → Cloud Sync → Provider: Granite API**, leave **Server URL blank**
   (same origin), set **API key** to a tenant key, then Push / enable **Auto-sync**.

The functions (`netlify/functions/`) serve `/api/health`, `/api/state` (GET/PUT) and
`/api/orders` (POST) — multi-tenant by API key, auto-creating the `workspaces` table on
first call. Because they reuse the same `/api/*` contract as the Node server, the existing
"Granite API" Cloud Sync provider talks to them with no client change.

GitHub Pages is static-only, so it serves the PWA; for live cloud sync, host
`server/server.js` on any Node host (Render, Railway, Fly, a VM) and point the
Cloud Sync URL at it.

## Files

- `index.html` + `landing.css` + `landing.js` — public hero landing + PWA install
- `app.html` + `styles.css` — the operations platform shell / all views
- `app.js` — state machine, demo data, simulated integrations, navigation, deep-links
- `barcode.js` — pure-JS Code 128 (Set B) generator → SVG (scannable)
- `manifest.webmanifest` + `sw.js` — installable, offline-capable PWA

## Note on "simulated"

Carrier (UPS/FedEx) and e-commerce calls are mocked to demonstrate UX. The real
versions are buildable against carrier sandboxes and platform order APIs once the
commercial accounts/partnerships are in place — see the architecture roadmap.
