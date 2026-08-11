// Web Push for customers: "out for delivery" on the lock screen.
//
// Same trigger as the status emails (see _notify.mjs): the transition is detected inside
// PUT /api/state by diffing what ops pushed against what was stored. This is the delivery
// channel, not the detection.
//
// Needs a VAPID keypair, which identifies this server to the browser push services. Run
// `npm run vapid` to generate one, then set:
//
//   GL_VAPID_PUBLIC    the public key, also handed to the browser at subscribe time
//   GL_VAPID_PRIVATE   the private key. A secret; it signs the requests to the push service
//   GL_MAIL_FROM       reused as the VAPID contact address (push services want a mailto)
//
// With no keys set this degrades to nothing at all: the client is told push is unavailable
// and never asks for notification permission, which is better than prompting for a
// capability the deployment cannot deliver.
import { getStore } from "@netlify/blobs";
import webpushDefault from "web-push";
import { parseSender } from "./_email.mjs";

// web-push is CommonJS; under ESM the module object arrives as the default export.
const webpush = webpushDefault && webpushDefault.sendNotification ? webpushDefault : (webpushDefault.default || webpushDefault);

export function pushConfigured() {
  return !!(process.env.GL_VAPID_PUBLIC && process.env.GL_VAPID_PRIVATE);
}
export function pushPublicKey() {
  return process.env.GL_VAPID_PUBLIC || null;
}

// Push services require a contact so they can reach the operator about a misbehaving
// sender. GL_MAIL_FROM already holds one; fall back to the site itself.
function vapidSubject() {
  const from = parseSender(process.env.GL_MAIL_FROM).email;
  return from ? "mailto:" + from : "https://usegl.com";
}

function store() { return getStore({ name: "granite-push", consistency: "strong" }); }

// One record per account holding every device that opted in. Keyed by the endpoint URL,
// which is what uniquely identifies a browser subscription.
export async function readSubscriptions(email) {
  const list = await store().get(String(email || "").toLowerCase(), { type: "json" });
  return Array.isArray(list) ? list : [];
}
async function writeSubscriptions(email, list) {
  const key = String(email || "").toLowerCase();
  if (!list.length) await store().delete(key);
  else await store().setJSON(key, list);
}

// A subscription is only usable with all three parts, so anything less is rejected rather
// than stored to fail later at send time.
export function validSubscription(sub) {
  return !!(sub && typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint)
    && sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string");
}

// One person has a phone, a laptop, maybe a tablet. A cap keeps a scripted loop from
// growing one account's record without bound, and keeps a single status change from
// fanning out into an unbounded number of sends. Oldest devices drop off first.
export const MAX_DEVICES = 10;

export async function saveSubscription(email, sub) {
  if (!validSubscription(sub)) return { ok: false, error: "That subscription is incomplete." };
  const list = await readSubscriptions(email);
  // Re-subscribing the same device replaces its keys rather than adding a duplicate, or
  // the customer would get one notification per visit.
  const others = list.filter((s) => s && s.endpoint !== sub.endpoint);
  const kept = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: new Date().toISOString() };
  const next = others.concat([kept]).slice(-MAX_DEVICES);
  await writeSubscriptions(email, next);
  return { ok: true, devices: next.length };
}

export async function removeSubscription(email, endpoint) {
  const list = await readSubscriptions(email);
  const left = list.filter((s) => s && s.endpoint !== endpoint);
  await writeSubscriptions(email, left);
  return { ok: true, devices: left.length };
}

// Send to every device on the account. Never throws.
//
// A 404 or 410 from the push service means that subscription is permanently dead (browser
// uninstalled, permission revoked), so it is dropped. Leaving it would mean retrying a
// gone endpoint on every future shipment forever.
export async function sendPush(email, payload) {
  if (!pushConfigured()) return { sent: 0, reason: "push-not-configured" };
  try {
    const list = await readSubscriptions(email);
    if (!list.length) return { sent: 0 };

    webpush.setVapidDetails(vapidSubject(), process.env.GL_VAPID_PUBLIC, process.env.GL_VAPID_PRIVATE);
    const body = JSON.stringify(payload);

    let sent = 0;
    const dead = [];
    for (const sub of list) {
      try {
        await webpush.sendNotification(sub, body);
        sent++;
      } catch (e) {
        const code = e && (e.statusCode || e.status);
        if (code === 404 || code === 410) dead.push(sub.endpoint);
      }
    }
    if (dead.length) await writeSubscriptions(email, list.filter((s) => dead.indexOf(s.endpoint) < 0));
    return { sent, pruned: dead.length };
  } catch (e) {
    return { sent: 0, reason: "failed", detail: String((e && e.message) || e) };
  }
}

// What the service worker receives. Kept small: a push payload travels through a third
// party, so it carries the tracking id and status, never the recipient's address.
export function pushPayload(pkg, stageLabel) {
  const id = (pkg && pkg.id) || "Your order";
  const what = (pkg && pkg.item && pkg.item.description) || "Your shipment";
  return {
    title: what + " is " + stageLabel,
    body: id + " · tap to track",
    tag: id,                     // collapses repeat notifications for one parcel
    url: "/track.html?n=" + encodeURIComponent(id),
  };
}
