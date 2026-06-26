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

## Two pages

- **`index.html`** — the public marketing landing: a single shipping-themed hero
  with a working **Install the App** (PWA) button and a **Track a shipment** bar
  that deep-links into the platform (`app.html#tracking=GL-1042`).
- **`app.html`** — the operations platform (the demo dashboard).
  Installing the PWA opens straight to this page.

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
