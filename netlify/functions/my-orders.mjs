// Per-customer orders, scoped to the authenticated account.
// Requires a valid Bearer session token (from /api/auth); the customer's email
// comes from the token, so a user can only read/write their own orders.
// Stored in Netlify Blobs: store "granite-customer-orders", key = email -> [orders].
import { getStore } from "@netlify/blobs";
import { CORS, json, verifyToken, bearer } from "./_auth.mjs";

function store() { return getStore({ name: "granite-customer-orders", consistency: "strong" }); }

function nextId(orders) {
  let max = 1040;
  (orders || []).forEach((o) => { const m = /GL-(\d+)/.exec(o.id || ""); if (m) max = Math.max(max, +m[1]); });
  return "GL-" + (max + 1);
}

const S = (v) => (v == null ? "" : String(v)).trim();

function makeOrder(d, owner, orders) {
  const id = nextId(orders), now = Date.now();
  return {
    id,
    source: "Customer Order",
    orderRef: "#" + (10000 + Math.floor(Math.random() * 89999)),
    customer: {
      name: S(d.name) || owner.name || "—",
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
    history: [{ stage: "Won", ts: now, note: "Order placed by customer." }],
    promisedTs: now + (3 + Math.floor(Math.random() * 3)) * 86400000,
    exception: null, status: "Won",
    customerEmail: owner.email,
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const p = verifyToken(bearer(req));
  if (!p || !p.email) return json({ ok: false, error: "Sign in required." }, 401);

  const s = store();
  const key = p.email;
  const orders = (await s.get(key, { type: "json" })) || [];

  if (req.method === "GET") return json({ ok: true, orders });

  if (req.method === "POST") {
    let d = {};
    try { d = await req.json(); } catch (e) {}
    if (!S(d.item)) return json({ ok: false, error: "An item description is required." }, 400);
    const order = makeOrder(d, { email: p.email, name: p.name }, orders);
    orders.push(order);
    await s.setJSON(key, orders);
    return json({ ok: true, order, orders });
  }

  return json({ ok: false, error: "Method not allowed" }, 405);
};

export const config = { path: "/api/my-orders" };
