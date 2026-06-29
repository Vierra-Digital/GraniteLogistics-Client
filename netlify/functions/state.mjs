// GET/PUT the caller's workspace state — Netlify Blobs, key-authed.
import { CORS, json, tenantOf, readState, writeState } from "./_lib.mjs";

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const tenant = tenantOf(req);
  if (!tenant) return json({ error: "unauthorized", hint: "send a valid x-api-key (header or ?key=)" }, 401);

  try {
    if (req.method === "GET") return json(await readState(tenant));
    if (req.method === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body || !Array.isArray(body.packages)) return json({ error: "expected { packages: [...] }" }, 400);
      await writeState(tenant, body);
      return json({ ok: true, tenant, packages: body.packages.length });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    return json({ error: "storage error", detail: String(e && e.message || e) }, 500);
  }
};

export const config = { path: "/api/state" };
