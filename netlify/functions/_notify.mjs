// Telling a customer their parcel moved.
//
// I had this filed as impossible: status changes happen in the ops user's browser, so
// there is "no server-side event to push from". That was wrong. Ops clients do not mutate
// storage directly, they PUT the whole workspace, and that handler already holds both the
// stored state and the incoming one. The transition IS visible server-side; it just had to
// be looked for.
//
// Two things make this safe to run inside a routine push:
//
//   1. Ops clients push every ~1.5 seconds, almost always with nothing changed, so the
//      work is gated on an actual transition being found.
//   2. What has already been announced is recorded server-side, in a record no client
//      writes. Storing it on the package would not survive: ops pushes its own copy of
//      each package, so the flag would be overwritten on the very next push.
import { getStore } from "@netlify/blobs";
import { sendEmail, statusEmail, emailConfigured } from "./_email.mjs";
import { sendPush, pushPayload, pushConfigured } from "./_push.mjs";

// Stages worth an email. Deliberately not every step: "Intake" and "Staged" are internal
// choreography, and a parcel that emails on all seven is a parcel people mute.
export const NOTIFY_STAGES = {
  PickedUp: "picked up",
  InTransit: "in transit",
  OutforDelivery: "out for delivery",
  Delivered: "delivered",
};

// "Won" is excluded on purpose: the customer just placed the order and already saw the
// confirmation screen, so mailing them about it is noise.
export function isNotifiable(stage) {
  return Object.prototype.hasOwnProperty.call(NOTIFY_STAGES, stage);
}

// One request should not fan out into hundreds of sends. A legitimate ops session advances
// a handful of parcels at a time; anything far beyond that is a bulk edit or a bug, and
// the remainder is reported rather than silently dropped.
export const MAX_PER_PUSH = 25;

// Pure: which customer-owned packages changed to a stage worth announcing.
// `before` and `after` are package arrays. Anything without a customerEmail is ops' own
// work and has nobody to tell.
export function detectStatusChanges(before, after) {
  const was = new Map();
  (before || []).forEach((p) => { if (p && p.id) was.set(p.id, p.status); });

  const changes = [];
  (after || []).forEach((p) => {
    if (!p || !p.id || !p.customerEmail) return;
    const from = was.has(p.id) ? was.get(p.id) : null;
    if (from === p.status) return;             // nothing moved
    if (!isNotifiable(p.status)) return;       // internal step, or back to Won
    // A package appearing for the first time already at a late stage is an import, not a
    // transition this customer was waiting on.
    if (from === null) return;
    changes.push({ id: p.id, email: p.customerEmail, from, to: p.status, pkg: p });
  });
  return changes;
}

function store() { return getStore({ name: "granite-notify", consistency: "strong" }); }

// A parcel is finished once it has been announced as delivered: nothing further will ever
// happen to it, so its entry is dead weight. Without pruning this record grows by one entry
// per shipment forever, in a single Blobs value that is read and written on every ops push.
export const ANNOUNCED_LIMIT = 5000;

export function pruneAnnounced(announced) {
  const entries = Object.entries(announced || {});
  const live = entries.filter(([, stages]) => !(Array.isArray(stages) && stages.indexOf("Delivered") >= 0));
  // Delivered parcels first out. If that is somehow not enough, drop the oldest remaining
  // entries: losing one means at worst a repeated notification, never a missed shipment.
  const kept = live.length <= ANNOUNCED_LIMIT ? live : live.slice(-ANNOUNCED_LIMIT);
  return Object.fromEntries(kept);
}

// { "GL-1041": ["InTransit", "Delivered"] } per tenant. Server-owned.
export async function readAnnounced(tenant) {
  const a = await store().get(tenant, { type: "json" });
  return (a && typeof a === "object") ? a : {};
}
export async function writeAnnounced(tenant, announced) {
  await store().setJSON(tenant, announced);
}

// Drop transitions already announced, so the 1.5s push loop cannot mail the same stage
// twice, and neither can two ops clients pushing the same change.
export function unannounced(changes, announced) {
  return (changes || []).filter((c) => {
    const seen = announced[c.id];
    return !(Array.isArray(seen) && seen.indexOf(c.to) >= 0);
  });
}

// Returns { sent, skipped, deferred, reason } and never throws: a failed notification must
// not fail the workspace push that triggered it, which has already been stored.
export async function notifyStatusChanges(tenant, before, after) {
  try {
    const changes = detectStatusChanges(before, after);
    if (!changes.length) return { sent: 0, pushed: 0, skipped: 0, deferred: 0 };

    const announced = await readAnnounced(tenant);
    const todo = unannounced(changes, announced);
    if (!todo.length) return { sent: 0, pushed: 0, skipped: changes.length, deferred: 0 };

    const batch = todo.slice(0, MAX_PER_PUSH);
    const deferred = todo.length - batch.length;

    // Record before sending. A duplicate email is a worse failure than a missing one, and
    // recording afterwards would re-send everything if the function timed out mid-batch.
    batch.forEach((c) => {
      announced[c.id] = (announced[c.id] || []).concat([c.to]);
    });
    // Pruned on write rather than on a schedule, because there is no scheduler here and
    // this is the only place the record is touched.
    await writeAnnounced(tenant, pruneAnnounced(announced));

    if (!emailConfigured() && !pushConfigured()) {
      // No channel available yet. The stages are still recorded, so switching mail or push
      // on later does not produce a flood of backdated updates.
      return { sent: 0, pushed: 0, skipped: 0, deferred, reason: "no-channel-configured" };
    }

    // Both channels share the announced record above, so a customer with push enabled and
    // an email address gets one of each per real transition, never two of either.
    let sent = 0, pushed = 0;
    for (const c of batch) {
      const label = NOTIFY_STAGES[c.to];
      if (emailConfigured()) {
        const msg = statusEmail(c.pkg, label);
        const r = await sendEmail({ to: c.email, subject: msg.subject, html: msg.html, text: msg.text });
        if (r && r.ok) sent++;
      }
      if (pushConfigured()) {
        const r = await sendPush(c.email, pushPayload(c.pkg, label));
        pushed += (r && r.sent) || 0;
      }
    }
    return { sent, pushed, skipped: changes.length - todo.length, deferred };
  } catch (e) {
    return { sent: 0, pushed: 0, skipped: 0, deferred: 0, reason: "failed", detail: String((e && e.message) || e) };
  }
}
