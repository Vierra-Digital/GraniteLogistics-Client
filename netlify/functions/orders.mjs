// API-first ingest: a store/carrier POSTs orders; they become packages.
import { CORS, json, db, tenantOf, ensureTable, readState, writeState, makeOrder } from "./_lib.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const tenant = tenantOf(req);
  if (!tenant) return json({ error: "unauthorized" }, 401);
  if (!process.env.DATABASE_URL) return json({ error: "DATABASE_URL not configured" }, 500);

  const body = await req.json().catch(() => null);
  const orders = Array.isArray(body) ? body : (Array.isArray(body?.orders) ? body.orders : [body || {}]);

  const sql = db();
  await ensureTable(sql);
  const state = await readState(sql, tenant);
  if (!Array.isArray(state.packages)) state.packages = [];
  const created = orders.map((d) => { const p = makeOrder(d, state); state.packages.push(p); return p; });
  await writeState(sql, tenant, state);
  return json({ ok: true, tenant, created: created.length, packages: created }, 201);
};

export const config = { path: "/api/orders" };
