// GET/PUT the caller's ops workspace, from Netlify Blobs.
//
// This endpoint exposes every package in a tenant, including recipient names, addresses
// and phone numbers, so it needs real authorization:
//
//   - A signed-in user with an ops role (Bearer token). Viewer is read-only.
//   - A machine caller holding an operator-configured api key from GL_TENANTS.
//
// The built-in demo keys are explicitly NOT enough. They are published in this repo and
// shipped in the client bundle, so treating them as a read credential would mean anyone
// could dump the whole workspace. They remain valid for /api/orders, which only writes.
import { CORS, json, resolveKey, readState, writeState, mergePushedPackages } from "./_lib.mjs";
import { verifyToken, bearer, getUser, sessionSuperseded, effectiveRoleFor, OPS_ROLES, WRITE_ROLES } from "./_auth.mjs";

const HEADERS = { ...CORS, "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization" };
const fail = (error, status, extra) => json({ error, ...(extra || {}) }, status);

// Resolve the caller to { tenant, role } or an error to return.
async function authorize(req) {
  const token = bearer(req);
  if (token) {
    const p = verifyToken(token);
    // p.kind marks a password-reset token, which must never act as a session.
    if (!p || p.kind || !p.email) return { err: fail("Invalid or expired session", 401) };
    const u = await getUser(p.email);
    if (!u) return { err: fail("Invalid or expired session", 401) };
    if (sessionSuperseded(p, u)) return { err: fail("Session ended because the password changed.", 401) };
    // Re-derived per request rather than read off the stored account, so revoking someone
    // on the admin screen takes effect at once instead of at their next sign-in. A
    // revoked operator holding a valid 30-day token would otherwise keep full access.
    const role = await effectiveRoleFor(p.email);
    if (!OPS_ROLES.includes(role)) {
      return { err: fail("forbidden", 403, { hint: "this workspace is for operations roles; customers use /api/my-orders" }) };
    }
    return { tenant: "default", role, email: u.email };
  }

  const { tenant, source } = resolveKey(req);
  if (!tenant) return { err: fail("unauthorized", 401, { hint: "sign in as an operations user, or send a configured x-api-key" }) };
  if (source !== "config") {
    return { err: fail("forbidden", 403, { hint: "the demo api keys cannot read a workspace; sign in as an operations user or configure GL_TENANTS" }) };
  }
  return { tenant, role: "Admin", machine: true };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const who = await authorize(req);
  if (who.err) return who.err;

  try {
    if (req.method === "GET") return json(await readState(who.tenant));
    if (req.method === "PUT") {
      if (!WRITE_ROLES.includes(who.role)) {
        return fail("forbidden", 403, { hint: "the " + who.role + " role is read-only" });
      }
      const body = await req.json().catch(() => null);
      if (!body || !Array.isArray(body.packages)) return fail("expected { packages: [...] }", 400);

      const current = await readState(who.tenant);
      const merged = mergePushedPackages(current.packages, body.packages, body.deleted);
      await writeState(who.tenant, { ...body, packages: merged.packages, deleted: undefined });
      return json({ ok: true, tenant: who.tenant, packages: merged.packages.length, preserved: merged.preserved });
    }
    return fail("method not allowed", 405);
  } catch (e) {
    return fail("storage error", 500, { detail: String((e && e.message) || e) });
  }
};

export const config = { path: "/api/state" };
