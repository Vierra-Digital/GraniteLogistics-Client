# Granite Logistics: Executive Demo Run-of-Show

A tight, repeatable script for a live pitch. Total runtime about 6 to 7 minutes.

## Before the meeting
1. Open the deployed site (usegl.com) on a laptop, not a phone. Mobile shows the
   customer app only, so the ops views need a desktop-sized window.
2. Hard-refresh once (Ctrl/Cmd+Shift+R) so you're on the latest build.
3. In the platform, click **⟲ Reset demo data** so the numbers are clean.
4. Have a customer account signed in on a phone if you want to show both sides live.
5. Have two tabs ready: the **landing** (`index.html`) and the **platform** (`app.html`).

## The narrative (one sentence)
> "We give enterprise shippers a single source of truth from the moment an order is
> placed to the moment it's confirmed delivered: pulled straight from their store,
> handed to UPS/FedEx automatically, and photographed at every handoff."

## Run-of-show

**1. Landing (15s), set the frame.**
Open the landing. "This is the front door. Notice it installs as an app, no app store
required, and customers can track a shipment right here." *(Optional: click Install
the App.)*

**2. The customer app (45s), who this is for.**
Open the app on a phone, or narrow the browser window. "A customer signs up and gets
exactly three things: Home, Orders, Account. They place an order in three steps."
Place one. "That's it. They can track it, share a tracking link, or cancel it before
we pick it up." Point at the bell: "and they're notified as it moves."

**3. One-click story (90s), the centerpiece.**
Switch to the platform on desktop, then click **▶ Guided tour**. Narrate as the
toasts fire:
- "An order lands, **pulled via API**, no manual entry."
- "We generate a **real Code 128 label**."
- "The runner photographs condition before it leaves the dock. That's our liability shield."
- "It's **batched to a carrier manifest** and a dock lane."
- "**UPS issues a tracking number via API.**"
- "Out for delivery, then **delivered, with a proof-of-delivery photo.**"
Land on the **chain-of-custody timeline**: "Every step, time-stamped and tamper-evident."

**4. Close the loop (30s), the part that sells it.**
Find the order the customer placed in step 2 in the ops queue. Advance it. Then show
the customer's phone reflecting the new status. "Same record, both sides. The customer
and the warehouse are never out of sync."

**5. Executive Overview (45s), the value.**
Click **Executive Overview**. "Real-time KPIs: packages in motion, goods in custody,
all photo-verified." Point at the **Alerts** panel: "We surface delivery exceptions and
SLA breaches the moment they happen, an address issue here, a late shipment there."
Click an alert to show the full custody record, the exception, and the barcode.

**6. Reports (30s), the operational proof.**
Click **Reports**. "Average transit time, value by carrier, time spent in each stage,
all computed live from the custody timestamps."

**7. Operational logistics (40s), the facility edge.**
Click **Pre-Sort & Staging**, then **Run ZIP Pre-Sort**. "Before anything touches a
carrier, we sort outbound by ZIP zone to **bypass initial hub handling**." Click
**Build Load Unit** on a zone. "We consolidate small parcels into **standardized
load-ready units** for better transport density." Stage one to a manifest, then in
**Batch & Lane Routing** hit **⇈ Transmit**. "And we transmit clean **ASN/EDI data
straight to the carrier network**, no manual keying, no errors."

**8. Roles and control (30s), enterprise readiness.**
Click the **role badge → Switch → Store Runner** (or Driver). "Every role gets its own
workspace. A runner lands on a focused, big-button **field home**: pickups, pre-sort,
manifests, and never sees the admin's reports or settings. A driver gets a scan-first
screen." Switch back to **Administrator**. Mention **Settings** brands every label and
manifest.

## Handling the obvious questions

**"Is this live with UPS/FedEx today?"** Be straight:
> "The experience is real and complete, and the carrier and e-commerce calls are
> **simulated in this build** so we can demo anywhere. Both UPS and FedEx expose
> production REST APIs we can build against in their sandbox immediately. The gate is
> the commercial account, not the engineering."

**"Where does the data live?"**
> "On a real backend, today. Accounts are server-side with hashed passwords and signed
> sessions, and orders are stored per-account so a customer sees them on any device
> they sign in from. It's serverless, so there's no infrastructure to run."

**"Can customers pay through it?"** Be straight: not yet. Ordering, tracking, and
proof of delivery are built; pricing and checkout are a scoped next step.

## Don't-fumble checklist
- [ ] Present from a laptop; mobile is customer-only
- [ ] Reset demo data before presenting
- [ ] Run the guided tour once yourself beforehand
- [ ] Place a customer order in advance if you want the close-the-loop moment
- [ ] Know your one-sentence narrative cold
