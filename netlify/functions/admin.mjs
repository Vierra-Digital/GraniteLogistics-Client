// Role administration. Admin-only.
//
// Lets an Admin grant and revoke operations roles without a config change and redeploy.
// Environment config (GL_ADMIN_EMAILS / GL_ROLES) still outranks everything here and
// cannot be edited through this endpoint, which is the recovery path: if the stored grants
// are wrong, or the last admin revokes themselves through some path nobody anticipated,
// an operator can always restore access by editing the site's environment variables.
//
// Rules enforced here, not in the UI:
//   - only an Admin may read or write anything
//   - you cannot change your own role (the obvious way to lock everyone out)
//   - the workspace must always retain at least one Admin
//   - a role granted by env config cannot be revoked in-app
//   - only known ops roles can be granted; "Customer" means revoke
//
// The caller's own role is re-derived on every request rather than read from their token,
// because a token lives 30 days and a revoked admin must lose access immediately.
import {
  CORS, json, verifyToken, bearer, getUser, sessionSuperseded, userStore,
  effectiveRoleFor, envRoleFor, readGrants, writeGrants, grantedRole,
  listUsers, normalizeEmail, ROLES, OPS_ROLES,
} from "./_auth.mjs";

const HEADERS = { ...CORS, "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const fail = (error, status, extra) => json({ ok: false, error, ...(extra || {}) }, status);

async function requireAdmin(req) {
  const p = verifyToken(bearer(req));
  if (!p || p.kind || !p.email) return { err: fail("Sign in required.", 401) };
  const u = await getUser(p.email);
  if (!u) return { err: fail("Sign in required.", 401) };
  if (sessionSuperseded(p, u)) return { err: fail("Session ended because the password changed.", 401) };

  const grants = await readGrants();
  const role = await effectiveRoleFor(p.email, grants);
  // Deliberately vague: this endpoint should not confirm its own existence to a
  // non-admin who goes looking for it.
  if (role !== "Admin") return { err: fail("Not found.", 404) };
  return { email: normalizeEmail(p.email), grants };
}

// One row per account, with where its role comes from so the UI can explain itself.
function describe(users, grants) {
  return users.map((u) => {
    const email = normalizeEmail(u.email);
    const fromEnv = envRoleFor(email);
    const granted = grantedRole(grants, email);
    const entry = grants[email];
    const role = fromEnv !== "Customer" ? fromEnv : (granted || "Customer");
    return {
      email, name: u.name, createdAt: u.createdAt, role,
      // "env" rows are read-only here; "granted" rows can be changed.
      source: fromEnv !== "Customer" ? "env" : (granted ? "granted" : "default"),
      grantedBy: entry ? entry.by || null : null,
      grantedAt: entry ? entry.at || null : null,
    };
  }).sort((a, b) => a.email.localeCompare(b.email));
}

const adminCount = (rows) => rows.filter((r) => r.role === "Admin").length;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const who = await requireAdmin(req);
  if (who.err) return who.err;

  try {
    if (req.method === "GET") {
      const users = await listUsers();
      const rows = describe(users, who.grants);
      return json({ ok: true, you: who.email, roles: ROLES, opsRoles: OPS_ROLES, users: rows });
    }

    if (req.method === "POST") {
      let d = {};
      try { d = await req.json(); } catch (e) {}
      const target = normalizeEmail(d.email);
      const role = String(d.role || "");

      if (!target) return fail("An email address is required.", 400);
      if (!ROLES.includes(role)) return fail("Unknown role.", 400, { roles: ROLES });
      if (target === who.email) {
        return fail("You can't change your own role. Ask another administrator.", 409);
      }

      const account = await getUser(target);
      if (!account) return fail("No account exists for that address. They need to sign up first.", 404);

      if (envRoleFor(target) !== "Customer") {
        return fail("That role is set in this site's environment configuration and can't be changed here.", 409);
      }

      const users = await listUsers();
      const before = describe(users, who.grants);
      const grants = { ...who.grants };

      if (role === "Customer") {
        // Revoking: make sure we are not removing the last administrator.
        const wouldRemain = before.filter((r) => r.role === "Admin" && r.email !== target).length;
        if (grantedRole(who.grants, target) === "Admin" && wouldRemain === 0) {
          return fail("That's the only administrator left. Grant someone else Admin first.", 409);
        }
        delete grants[target];
      } else {
        grants[target] = { role, by: who.email, at: new Date().toISOString() };
      }
      await writeGrants(grants);

      // Keep the stored account in step so the client shows the right role without
      // waiting for a re-login. /api/state re-derives anyway, so this is presentation.
      const nextRole = await effectiveRoleFor(target, grants);
      if (account.role !== nextRole) await userStore().setJSON(target, { ...account, role: nextRole });

      const rows = describe(await listUsers(), grants);
      return json({
        ok: true,
        changed: { email: target, role: nextRole },
        // Roles are baked into the session token, so the affected person sees their new
        // navigation at their next sign-in even though access changes immediately.
        note: nextRole === "Customer"
          ? "Access revoked immediately. Their view updates when they next sign in."
          : "Access granted immediately. Their view updates when they next sign in.",
        admins: adminCount(rows),
        users: rows,
      });
    }

    return fail("Method not allowed", 405);
  } catch (e) {
    return fail("storage error", 500, { detail: String((e && e.message) || e) });
  }
};

export const config = { path: "/api/admin" };
