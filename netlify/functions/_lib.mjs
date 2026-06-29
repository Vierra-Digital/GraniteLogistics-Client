// Shared helpers for the Granite Netlify Functions (Neon-backed).
import { neon } from "@neondatabase/serverless";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Content-Type": "application/json",
};
export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
export function db() { return neon(process.env.DATABASE_URL); }

// apiKey -> tenant; override with GL_TENANTS='{"key":"tenant"}'.
export function tenants() {
  try { return process.env.GL_TENANTS ? JSON.parse(process.env.GL_TENANTS) : null; } catch (e) { return null; }
}
export function tenantOf(req) {
  const url = new URL(req.url);
  const key = req.headers.get("x-api-key") || url.searchParams.get("key") || "";
  const map = tenants() || { "granite-dev-key": "default", "acme-key": "acme", "globex-key": "globex" };
  return map[key] || null;
}

export const EMPTY = { packages: [], manifests: [], loadUnits: [], events: [], settings: {} };

export async function ensureTable(sql) {
  await sql`create table if not exists workspaces (
    tenant text primary key,
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  )`;
}
export async function readState(sql, tenant) {
  const rows = await sql`select data from workspaces where tenant = ${tenant}`;
  return rows[0]?.data || { ...EMPTY };
}
export async function writeState(sql, tenant, data) {
  await sql`insert into workspaces (tenant, data, updated_at)
            values (${tenant}, ${JSON.stringify(data)}::jsonb, now())
            on conflict (tenant) do update set data = excluded.data, updated_at = now()`;
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
      name: (d.name || "—").toString().trim(), address: (d.address || "").toString().trim(),
      city: (d.city || "").toString().trim(), state: (d.state || "").toString().trim().toUpperCase(),
      zip: (d.zip || "").toString().trim(), phone: (d.phone || "").toString().trim(),
    },
    item: { description: (d.item || "Item").toString().trim(), value: Math.max(0, parseInt(d.value, 10) || 0), weight: Math.max(1, parseInt(d.weight, 10) || (2 + Math.floor(Math.random() * 38))) },
    barcode: id.replace(/-/g, ""), carrier: null, lane: null, batchId: null, tracking: null, photos: {},
    history: [{ stage: "Won", ts: now, note: "Order received via API webhook." }],
    promisedTs: now + (3 + Math.floor(Math.random() * 3)) * 86400000, exception: null, status: "Won",
  };
}
