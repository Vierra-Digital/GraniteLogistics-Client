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
  effectiveRoleFor, envRoleFor, readGrants, writeGrants, grantedRole, grantsStore,
  listUsers, normalizeEmail, ROLES, OPS_ROLES,
  withNewPassword, MIN_PASSWORD,
} from "./_auth.mjs";

import { clearThrottle } from "./_throttle.mjs";

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
      // Only attributed when the grant is the thing actually in force. A leftover entry
      // carrying an unknown role must not look like it granted anything.
      grantedBy: granted && entry ? entry.by || null : null,
      grantedAt: granted && entry ? entry.at || null : null,
    };
  }).sort((a, b) => a.email.localeCompare(b.email));
}

const adminCount = (rows) => rows.filter((r) => r.role === "Admin").length;

// Who changed whose access, and when.
//
// The grants record only holds the role in force now, so a revocation used to erase every
// trace that access had ever been given. For a platform where a role decides who can read
// every customer's address, that history is the point. Capped so one record cannot grow
// without bound; a privilege change is rare enough that 500 covers a long time.
const AUDIT_LIMIT = 500;

export async function readRoleAudit() {
  const a = await grantsStore().get("audit", { type: "json" });
  return Array.isArray(a) ? a : [];
}
async function recordRoleChange(entry) {
  try {
    const log = await readRoleAudit();
    log.unshift({ ...entry, at: new Date().toISOString() });
    await grantsStore().setJSON("audit", log.slice(0, AUDIT_LIMIT));
  } catch (e) {
    // A lost audit line must not fail the change the caller already committed. The
    // alternative is reporting failure for something that did happen.
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const who = await requireAdmin(req);
  if (who.err) return who.err;

  try {
    if (req.method === "GET") {
      const listed = await listUsers();
      const rows = describe(listed.users, who.grants);
      return json({
        ok: true, you: who.email, roles: ROLES, opsRoles: OPS_ROLES, users: rows,
        admins: adminCount(rows),
        total: listed.total, truncated: listed.truncated,
        audit: (await readRoleAudit()).slice(0, 50),
      });
    }

    if (req.method === "POST") {
      let d = {};
      try { d = await req.json(); } catch (e) {}
      const target = normalizeEmail(d.email);

      // ---- Reset a password on behalf of an account ----
      //
      // The recovery path when email is not configured, which is every deployment until
      // GL_BREVO_KEY and GL_MAIL_FROM are set: without this, a forgotten password means
      // deleting the user record out of Blobs by hand.
      //
      // Reaching this requires an already-signed-in Admin, so it can only ever help
      // somebody else -- an admin who has forgotten their own password cannot sign in to
      // use it. That case still needs the environment route: add the address to
      // GL_ADMIN_EMAILS, remove the stored account, and register it again.
      if (d.action === "set-password") {
        const pw = String(d.pw || "");
        if (!target) return fail("An email address is required.", 400);
        if (pw.length < MIN_PASSWORD) {
          return fail("Password must be at least " + MIN_PASSWORD + " characters.", 400);
        }
        // Self-reset is refused rather than supported: it would supersede the caller's own
        // session mid-request and sign them out, and they must already know their password
        // to be here at all.
        if (target === who.email) {
          return fail("You can't reset your own password here. Ask another administrator.", 409);
        }
        const acct = await getUser(target);
        if (!acct) return fail("No account exists for that address.", 404);

        await userStore().setJSON(target, withNewPassword(acct, pw));
        // They may have locked themselves out trying to remember it.
        await clearThrottle("login", target);
        await recordRoleChange({ email: target, kind: "password-reset", by: who.email });
        return json({
          ok: true, email: target,
          // Said plainly because it is the surprising part: pwChangedAt moved, so every
          // token issued to them before now is dead.
          note: "Password set. Their other sessions have ended, and they should change it after signing in.",
        });
      }

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

      const listed = await listUsers();
      const before = describe(listed.users, who.grants);
      const previousRole = (before.find((r) => r.email === target) || {}).role || "Customer";
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

      // The check above read state that another admin may have changed before this write
      // landed, and Blobs has no compare-and-swap, so two simultaneous revocations could
      // each see one remaining admin and both go through. Zero admins is only recoverable
      // by editing environment config, so it is worth re-reading to confirm.
      const settled = await readGrants();
      if (adminCount(describe((await listUsers()).users, settled)) === 0) {
        // Put back what this request was working from. That may discard a concurrent
        // change, which is the lesser harm compared with locking everyone out.
        await writeGrants(who.grants);
        return fail("Another administrator was removed at the same moment, which would have left none. Nothing was changed.", 409);
      }

      await recordRoleChange({ email: target, from: previousRole, to: role, by: who.email });

      // Keep the stored account in step so the client shows the right role without
      // waiting for a re-login. /api/state re-derives anyway, so this is presentation.
      const nextRole = await effectiveRoleFor(target, grants);
      if (account.role !== nextRole) await userStore().setJSON(target, { ...account, role: nextRole });

      const rows = describe((await listUsers()).users, grants);
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
        audit: (await readRoleAudit()).slice(0, 50),
      });
    }

    return fail("Method not allowed", 405);
  } catch (e) {
    return fail("storage error", 500, { detail: String((e && e.message) || e) });
  }
};

export const config = { path: "/api/admin" };
