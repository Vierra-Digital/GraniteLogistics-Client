// API-first ingest: a store/carrier POSTs orders; they become packages.
import { CORS, json, tenantOf, readState, writeState, makeOrder } from "./_lib.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const tenant = tenantOf(req);
  if (!tenant) return json({ error: "unauthorized" }, 401);

  try {
    const body = await req.json().catch(() => null);
    const orders = Array.isArray(body) ? body : (Array.isArray(body?.orders) ? body.orders : [body || {}]);
    const state = await readState(tenant);
    if (!Array.isArray(state.packages)) state.packages = [];
    const created = orders.map((d) => { const p = makeOrder(d, state); state.packages.push(p); return p; });
    await writeState(tenant, state);
    return json({ ok: true, tenant, created: created.length, packages: created }, 201);
  } catch (e) {
    return json({ error: "storage error", detail: String(e && e.message || e) }, 500);
  }
};

export const config = { path: "/api/orders" };
