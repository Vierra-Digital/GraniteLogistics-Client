# Granite Logistics — Executive Demo Run-of-Show

A tight, repeatable script for a live pitch. Total runtime ~5–6 minutes.

## Before the meeting
1. Start the app: `python -m http.server 8080` → open `http://localhost:8080`.
2. Hard-refresh once (Ctrl/Cmd+Shift+R) so you're on the latest build.
3. In the platform, click **⟲ Reset demo data** so the numbers are clean.
4. Have two tabs ready: the **landing** (`index.html`) and the **platform** (`app.html`).

## The narrative (one sentence)
> "We give enterprise shippers a single source of truth from the moment an order is
> won to the moment it's confirmed delivered — pulled straight from their store,
> handed to UPS/FedEx automatically, and photographed at every handoff."

## Run-of-show

**1. Landing (15s) — set the frame.**
Open the landing. "This is the front door. Notice it installs as an app — no app
store — and customers can track a shipment right here." Point at the shipping label
graphic. *(Optional: click Install the App.)*

**2. One-click story (90s) — the centerpiece.**
Open the platform → click **▶ Run Live Demo** (bottom-left).
Narrate as the toasts fire:
- "An auction is won — the order is **pulled via API**, no manual entry."
- "We generate a **real Code 128 label**."
- "The runner photographs condition before it leaves the dock — that's our liability shield."
- "It's **batched to a carrier manifest** and a dock lane."
- "**UPS issues a tracking number via API.**"
- "Out for delivery… **Delivered, with a proof-of-delivery photo.**"
Land on the **chain-of-custody timeline** — "Every step, time-stamped and tamper-evident."

**3. Executive Overview (45s) — the value.**
Click **Executive Overview**. "Real-time KPIs — packages in motion, goods in custody,
all photo-verified." Point at the **Alerts** panel: "We surface delivery exceptions and
SLA breaches the moment they happen — an address issue here, a late shipment there."
Click an alert → show the full custody record, the exception, and the barcode.

**4. Reports (30s) — the operational proof.**
Click **Reports**. "Average transit time, value by carrier, time spent in each stage —
all computed live from the custody timestamps."

**5. Customer view (30s) — close the loop.**
Open `track.html`, enter a tracking number (e.g. one from the Overview). "This is what
*their* customer sees — status, ETA, condition photos. The answer to 'where's my package?'"

**6. Operational logistics (40s) — the facility edge.**
Click **Pre-Sort & Staging** → **Run ZIP Pre-Sort**. "Before anything touches a carrier,
we sort outbound by ZIP zone to **bypass initial hub handling**." Click **Build Load Unit**
on a zone. "We consolidate small parcels into **standardized load-ready units** — better
transport density." Stage one to a manifest, then in **Batch & Lane Routing** hit
**⇈ Transmit** on the manifest. "And we transmit clean **ASN/EDI data straight to the
carrier network** — no manual keying, no errors."

**7. Roles & control (30s) — enterprise readiness.**
Click the **role badge → Switch → Store Runner** (or Driver). "Every role gets its own
workspace. A runner lands on a focused, big-button **field home** — pickups, pre-sort,
manifests — and never sees the admin's reports or settings. A driver gets a scan-first
screen." Switch back to **Administrator**. Mention **Settings** brands every label/manifest.

## Handling the obvious question
**"Is this live with UPS/FedEx today?"** — Be straight:
> "The experience is real and complete; the carrier and e-commerce calls are
> **simulated in this build** so we can demo anywhere. Both UPS and FedEx expose
> production REST APIs we can build against in their sandbox immediately — the gate
> is the commercial account, not the engineering."

**"Where does the data live?"** — "Today it's on-device for the demo. The production
step is a hosted database + API so it's shared, multi-user, and audit-grade — that's
the build we scope once there's a signed partner."

## Don't-fumble checklist
- [ ] Reset demo data before presenting
- [ ] Run the live demo once yourself beforehand
- [ ] Pick a tracking number for the customer-page moment in advance
- [ ] Know your one-sentence narrative cold
