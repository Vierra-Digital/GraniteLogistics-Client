// Shared helpers for the Granite Netlify Functions.
// Storage = Netlify Blobs (built-in, free, no external DB or env vars).
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { supabaseConfigured, sbReadState, sbWriteState, sbAppendOrder, renumber } from "./_supabase.mjs";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Content-Type": "application/json",
};
export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}

// apiKey -> tenant; override with GL_TENANTS='{"key":"tenant"}'.
export function tenants() {
  try { return process.env.GL_TENANTS ? JSON.parse(process.env.GL_TENANTS) : null; } catch (e) { return null; }
}

// These are published in this repo and shipped in the client bundle, so they are public
// knowledge. They stay usable for /api/orders, which is write-only ingest, but they must
// never unlock a read of the whole workspace. See resolveKey's `source`.
const DEMO_KEYS = { "granite-dev-key": "default", "acme-key": "acme", "globex-key": "globex" };

// Resolve an api key to a tenant, and say where the key came from.
//   source "config" = operator-configured via GL_TENANTS, i.e. actually secret
//   source "demo"   = one of the public DEMO_KEYS above
// Callers that expose data must require "config".
export function resolveKey(req) {
  const url = new URL(req.url);
  const key = req.headers.get("x-api-key") || url.searchParams.get("key") || "";
  if (!key) return { tenant: null, source: null };
  // GL_TENANTS replaces the demo keys rather than extending them, so configuring it
  // switches the public keys off completely.
  const configured = tenants();
  if (configured) {
    return configured[key] ? { tenant: configured[key], source: "config" } : { tenant: null, source: null };
  }
  return DEMO_KEYS[key] ? { tenant: DEMO_KEYS[key], source: "demo" } : { tenant: null, source: null };
}
export function tenantOf(req) { return resolveKey(req).tenant; }

// The tenant for requests that carry no api key: a customer order, a public tracking lookup,
// an account deletion, a carrier scan. state.mjs resolves its tenant FROM the key, so these
// four used to hardcode "default" and silently disagreed with it the moment GL_TENANTS named
// anything else -- ops writing one workspace while customers wrote another.
//
// When GL_TENANTS defines exactly one tenant there is no ambiguity, so use it. A genuinely
// multi-tenant deployment cannot be resolved from a request with no key, and falls back to
// "default"; such a deployment has to keep a key mapped to "default" for these paths.
export function soloTenant() {
  const configured = tenants();
  if (!configured) return "default";
  const distinct = [...new Set(Object.values(configured))];
  return distinct.length === 1 ? distinct[0] : "default";
}

export const EMPTY = { packages: [], manifests: [], loadUnits: [], events: [], settings: {} };

// Storage is one of two providers, chosen by whether Supabase credentials are present:
//
//   Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set) -- a row per parcel.
//   Netlify Blobs (otherwise)                               -- one JSON blob per tenant.
//
// Every function that touches a workspace goes through readState/writeState, so this pair is
// the entire seam. Blobs stays the default so an existing deployment is unaffected until the
// credentials are added, and stays working afterwards as the way back.
function store() { return getStore({ name: "granite-workspaces", consistency: "strong" }); }

export function storageProvider() { return supabaseConfigured() ? "supabase" : "blobs"; }

export async function readState(tenant) {
  if (supabaseConfigured()) return { ...EMPTY, ...(await sbReadState(tenant)) };
  const data = await store().get(tenant, { type: "json" });
  return data || { ...EMPTY };
}
export async function writeState(tenant, data) {
  if (supabaseConfigured()) return sbWriteState(tenant, data);
  await store().setJSON(tenant, { ...data, updatedAt: new Date().toISOString() });
}

// What a public tracking link is allowed to reveal.
//
// Tracking numbers are sequential, so anyone can enumerate them. This returns only
// what carriers themselves publish: where it is, when it's due, and where it's headed
// at city level. Recipient name, street address, email, contents, declared value and
// condition photos are all withheld, as is the internal note on an exception.
export function publicTrackingView(p) {
  if (!p) return null;
  return {
    id: p.id,
    status: p.status,
    barcode: p.barcode || null,
    carrier: p.carrier || null,
    tracking: p.tracking || null,
    promisedTs: p.promisedTs || null,
    history: (p.history || []).map((h) => ({ stage: h.stage, ts: h.ts })),
    destination: p.customer ? { city: p.customer.city || "", state: p.customer.state || "" } : null,
    exception: p.exception ? { type: p.exception.type } : null,
  };
}

// Merge an ops client's pushed workspace with what's already stored.
//
// Ops clients push their entire local state, which may be minutes stale, while
// customers write orders straight into the same record via /api/my-orders. A blind
// replace would delete any order placed since that client's last pull, so customer
// orders missing from the payload are preserved. `deleted` carries ids the client
// removed on purpose, which are allowed through so real deletions still stick.
// Pure function, kept here so it can be unit tested without the Blobs runtime.
// A row this server created, which an ops client may therefore not have pulled yet.
// `uid` is set by appendOrderWithRepair, so it covers both customer orders and webhook
// ingest; customerEmail also matches customer orders created before uid existed. Packages
// an ops client made itself are not in this set, so its own deletions still apply
// normally and a local demo reset still clears the workspace.
const serverCreated = (p) => !!(p && (p.uid || p.customerEmail));

export function mergePushedPackages(currentPackages, pushedPackages, deleted) {
  const pushed = Array.isArray(pushedPackages) ? pushedPackages : [];
  const pushedIds = new Set(pushed.map((p) => p && p.id));
  const tombstoned = new Set((Array.isArray(deleted) ? deleted : []).map((t) => (t && t.id) || t));
  const preserved = (currentPackages || []).filter(
    (p) => serverCreated(p) && !pushedIds.has(p.id) && !tombstoned.has(p.id)
  );
  return { packages: preserved.length ? pushed.concat(preserved) : pushed, preserved: preserved.length };
}

// ---- Order rate limiting ----
//
// Without this, one authenticated account can POST orders in a loop and fill the shared
// ops queue with junk. The count is derived from the caller's own orders already in the
// workspace rather than a separate counter, so it costs no extra storage and no second
// read-modify-write. Two windows: a burst guard, and an hourly ceiling.
//
// Known gap: cancelling an order frees its slot, so create/cancel churn is not capped.
// That churn leaves nothing behind in the queue, which is the thing being protected.
export const ORDER_LIMITS = [
  { ms: 60 * 1000, max: 3, per: "minute" },
  { ms: 60 * 60 * 1000, max: 12, per: "hour" },
];

// When an order was placed. New orders carry createdAt; older ones only have the "Won"
// history entry, so fall back to that before giving up and treating it as ancient.
export function orderCreatedAt(o) {
  if (!o) return 0;
  if (typeof o.createdAt === "number") return o.createdAt;
  const first = (o.history || [])[0];
  return (first && typeof first.ts === "number") ? first.ts : 0;
}

// Returns { limited } or { limited:true, retryAfter (seconds), error }.
export function orderRateLimit(orders, now, limits = ORDER_LIMITS) {
  const times = (orders || []).map(orderCreatedAt).filter((t) => t > 0);
  for (const lim of limits) {
    const inWindow = times.filter((t) => t > now - lim.ms);
    if (inWindow.length < lim.max) continue;
    // Wait until the oldest order in this window falls out of it.
    const oldest = Math.min(...inWindow);
    const retryAfter = Math.max(1, Math.ceil((oldest + lim.ms - now) / 1000));
    return {
      limited: true,
      retryAfter,
      error: "You've placed " + inWindow.length + " orders in the last " + lim.per +
        ". Please wait a moment before placing another, or contact us if you need to ship in bulk.",
    };
  }
  return { limited: false };
}

// ---- Appending an order safely without compare-and-swap ----
//
// Two customers can read the workspace, both add an order, and both write it back. There
// is no conditional write in @netlify/blobs v8, so that race has two outcomes:
//
//   1. one order is silently lost (the second write did not contain it), and
//   2. both orders get the SAME id, because both computed nextId from the same snapshot.
//
// The second is worse: two different parcels would carry one tracking number.
//
// Neither can be prevented without CAS, but both can be detected afterwards and repaired.
// Every order carries a `uid` that no other order shares, so after writing we re-read and
// ask two questions: is exactly one copy of my uid present, and is my id unique? If not,
// we rebuild onto the newest state (taking a fresh id if ours was taken) and try again.
//
// This does not make the write atomic. It makes the *outcome* self-correcting, which turns
// a silent loss into a retry. A caller that exhausts its attempts is told so rather than
// being given a false success.
// node:crypto rather than the global, which was still flagged experimental on the Node
// versions these functions may run on.
function orderUid() { return crypto.randomUUID(); }

export { renumber as renumberOrder } from "./_supabase.mjs";

// `build(state)` must return a fresh order numbered from the state it is given.
// Returns { order, state, attempts, repaired, unverified }.
export async function appendOrderWithRepair(tenant, build, attempts = 4) {
  // On Supabase none of the below is needed: uid is the primary key and (tenant, id) is
  // unique, so the two failures this function repairs after the fact are refused outright.
  if (supabaseConfigured()) return sbAppendOrder(tenant, build, attempts + 1);

  let order = null;
  let repaired = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const state = await readState(tenant);
    if (!Array.isArray(state.packages)) state.packages = [];

    if (!order) {
      order = build(state);
      if (!order.uid) order.uid = orderUid();
    }

    // Everything except any earlier copy of this same order.
    const others = state.packages.filter((p) => p && p.uid !== order.uid);
    // If another order has taken our id in the meantime, take the next free one.
    if (others.some((p) => p && p.id === order.id)) {
      renumber(order, nextId({ packages: others }));
      repaired++;
    }

    state.packages = others.concat([order]);
    await writeState(tenant, state);

    // Did it survive, exactly once, with an id nobody else holds?
    const after = await readState(tenant);
    const pkgs = after.packages || [];
    const mine = pkgs.filter((p) => p && p.uid === order.uid);
    const idHolders = pkgs.filter((p) => p && p.id === order.id);
    if (mine.length === 1 && idHolders.length === 1) {
      return { order, state: after, attempts: attempt, repaired };
    }
    repaired++;
  }

  return { order, state: await readState(tenant), attempts, repaired, unverified: true };
}

export function nextId(state) {
  let max = 1040;
  (state.packages || []).forEach((p) => { const m = /GL-(\d+)/.exec(p.id || ""); if (m) max = Math.max(max, +m[1]); });
  return "GL-" + (max + 1);
}
export function makeOrder(d, state) {
  const id = nextId(state), now = Date.now();
  return {
    id, source: d.source || "API", orderRef: d.orderRef || ("#" + (10000 + Math.floor(Math.random() * 89999))),
    customer: {
      name: (d.name || "–").toString().trim(), address: (d.address || "").toString().trim(),
      city: (d.city || "").toString().trim(), state: (d.state || "").toString().trim().toUpperCase(),
      zip: (d.zip || "").toString().trim(), phone: (d.phone || "").toString().trim(),
    },
    item: { description: (d.item || "Item").toString().trim(), value: Math.max(0, parseInt(d.value, 10) || 0), weight: Math.max(1, parseInt(d.weight, 10) || (2 + Math.floor(Math.random() * 38))) },
    barcode: id.replace(/-/g, ""), carrier: null, lane: null, batchId: null, tracking: null, photos: {},
    history: [{ stage: "Won", ts: now, note: "Order received via API webhook." }],
    promisedTs: now + (3 + Math.floor(Math.random() * 3)) * 86400000, exception: null, status: "Won",
  };
}
