// API-first ingest: a store/carrier POSTs orders; they become packages.
//
// Each order is appended and verified individually (see appendOrderWithRepair), because
// webhooks arrive whenever the sender feels like it. Two overlapping deliveries used to be
// able to drop orders or hand two parcels the same tracking number, which for an ingest
// endpoint means a shipment nobody knows about.
import { CORS, json, tenantOf, appendOrderWithRepair, makeOrder } from "./_lib.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const tenant = tenantOf(req);
  if (!tenant) return json({ error: "unauthorized" }, 401);

  try {
    const body = await req.json().catch(() => null);
    const orders = Array.isArray(body) ? body : (Array.isArray(body?.orders) ? body.orders : [body || {}]);

    const created = [];
    const failed = [];
    for (const d of orders) {
      const r = await appendOrderWithRepair(tenant, (fresh) => makeOrder(d, fresh));
      if (r.unverified) failed.push(r.order && r.order.id); else created.push(r.order);
    }

    // Partial success is reported honestly: a sender that is told 201 for an order we
    // could not store would never retry it, and that parcel would simply not exist.
    if (failed.length) {
      return json({
        ok: false, tenant, created: created.length, failed: failed.length, packages: created,
        error: "Some orders could not be stored. Retry the ones missing from `packages`.",
      }, 503);
    }
    return json({ ok: true, tenant, created: created.length, packages: created }, 201);
  } catch (e) {
    return json({ error: "storage error", detail: String(e && e.message || e) }, 500);
  }
};

export const config = { path: "/api/orders" };
