// A customer's own orders, authenticated by their session token.
//
// These live in the SHARED workspace state (the same Blobs record the ops platform
// reads and writes via /api/state), not a separate per-customer store. That's what
// makes the product coherent: a customer places an order, ops sees that exact
// package in their queue, ops advances it, and the customer sees the new status.
// The customer's email comes from the verified token, so callers can only ever
// read or change their own rows out of the shared state.
import { getStore } from "@netlify/blobs";
import { CORS, json, verifyToken, bearer } from "./_auth.mjs";
import { readState, writeState, nextId, orderRateLimit, appendOrderWithRepair, soloTenant } from "./_lib.mjs";

// Single-company platform for now, so every customer order lands in one workspace.
const S = (v) => (v == null ? "" : String(v)).trim();

function makeCustomerOrder(d, owner, state) {
  const id = nextId(state), now = Date.now();
  return {
    id,
    source: "Customer Order",
    orderRef: "#" + (10000 + Math.floor(Math.random() * 89999)),
    customer: {
      name: S(d.name) || owner.name || "–",
      address: S(d.address), city: S(d.city),
      state: S(d.state).toUpperCase(), zip: S(d.zip), phone: S(d.phone),
    },
    item: {
      description: S(d.item) || "Item",
      value: Math.max(0, parseInt(d.value, 10) || 0),
      weight: Math.max(1, parseInt(d.weight, 10) || (2 + Math.floor(Math.random() * 38))),
    },
    barcode: id.replace(/-/g, ""),
    carrier: null, lane: null, batchId: null, tracking: null, photos: {},
    createdAt: now, // explicit, so rate limiting doesn't depend on history[0] surviving edits
    history: [{ stage: "Won", ts: now, note: "Order placed by customer." }],
    promisedTs: now + (3 + Math.floor(Math.random() * 3)) * 86400000,
    exception: null, status: "Won",
    customerEmail: owner.email,
  };
}

// Earlier builds kept customer orders in their own "granite-customer-orders" store,
// invisible to ops. Fold any of those into the shared workspace once, then drop them
// so nobody's existing order is lost in the move.
async function migrateLegacyOrders(email, state) {
  try {
    const legacy = getStore({ name: "granite-customer-orders", consistency: "strong" });
    const old = await legacy.get(email, { type: "json" });
    if (!Array.isArray(old) || !old.length) return false;
    const known = new Set((state.packages || []).map((p) => p.id));
    let added = 0;
    old.forEach((o) => {
      if (o && o.id && !known.has(o.id)) { state.packages.push({ ...o, customerEmail: email }); added++; }
    });
    await legacy.delete(email);
    return added > 0;
  } catch (e) { return false; }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const p = verifyToken(bearer(req));
  if (!p || !p.email) return json({ ok: false, error: "Sign in required." }, 401);

  const state = await readState(soloTenant());
  if (!Array.isArray(state.packages)) state.packages = [];
  const migrated = await migrateLegacyOrders(p.email, state);
  const mine = () => state.packages.filter((o) => o.customerEmail === p.email);

  if (req.method === "GET") {
    if (migrated) await writeState(soloTenant(), state);
    return json({ ok: true, orders: mine() });
  }

  if (req.method === "POST") {
    let d = {};
    try { d = await req.json(); } catch (e) {}
    if (!S(d.item)) return json({ ok: false, error: "An item description is required." }, 400);

    // Cap how fast one account can add to the shared ops queue.
    const rl = orderRateLimit(mine(), Date.now());
    if (rl.limited) {
      return new Response(JSON.stringify({ ok: false, error: rl.error, retryAfter: rl.retryAfter }), {
        status: 429,
        headers: { ...CORS, "Retry-After": String(rl.retryAfter) },
      });
    }

    // Append-and-verify rather than a plain read-modify-write: two customers ordering at
    // the same moment could otherwise lose one order, or be handed the same tracking
    // number. See appendOrderWithRepair.
    const result = await appendOrderWithRepair(soloTenant(), (fresh) =>
      makeCustomerOrder(d, { email: p.email, name: p.name }, fresh));

    if (result.unverified) {
      // Repeated interference. Better to ask the customer to retry than to confirm an
      // order we cannot prove is stored.
      return json({ ok: false, error: "We couldn't confirm that order was saved. Please try again." }, 503);
    }

    const orders = (result.state.packages || []).filter((o) => o.customerEmail === p.email);
    return json({ ok: true, order: result.order, orders });
  }

  // Cancel one of the caller's own orders. Only allowed while the parcel is still
  // at "Won" (nothing physical has happened yet), so a shipment already moving
  // through the network can't be pulled out from under ops.
  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return json({ ok: false, error: "An order id is required." }, 400);
    const target = state.packages.find((o) => o.id === id && o.customerEmail === p.email);
    if (!target) return json({ ok: false, error: "Order not found." }, 404);
    if (target.status !== "Won") {
      return json({ ok: false, error: "This order is already on its way and can no longer be cancelled." }, 409);
    }
    state.packages = state.packages.filter((o) => o.id !== id);
    await writeState(soloTenant(), state);
    return json({ ok: true, cancelled: id, orders: mine() });
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
};

export const config = { path: "/api/my-orders" };
