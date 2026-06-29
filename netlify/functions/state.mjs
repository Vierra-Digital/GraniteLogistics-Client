// GET/PUT the caller's workspace state — Neon-backed, key-authed.
import { CORS, json, db, tenantOf, ensureTable, readState, writeState } from "./_lib.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const tenant = tenantOf(req);
  if (!tenant) return json({ error: "unauthorized", hint: "send a valid x-api-key (header or ?key=)" }, 401);
  if (!process.env.DATABASE_URL) return json({ error: "DATABASE_URL not configured" }, 500);

  const sql = db();
  await ensureTable(sql);

  if (req.method === "GET") return json(await readState(sql, tenant));
  if (req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.packages)) return json({ error: "expected { packages: [...] }" }, 400);
    await writeState(sql, tenant, body);
    return json({ ok: true, tenant, packages: body.packages.length });
  }
  return json({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/state" };
