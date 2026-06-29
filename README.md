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
