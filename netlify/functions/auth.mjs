// Real authentication for Granite Logistics.
//
// There is no password reset and no email verification: the email feature was removed, so
// nothing here can send mail. A forgotten password is recovered by an Admin through
// Team & Roles -> Reset password (admin.mjs, action set-password). That means the LAST admin
// locking themselves out is recovered by editing GL_ADMIN_EMAILS and redeploying.
// Accounts live in Netlify Blobs (store "granite-users", keyed by email).
// Passwords are salted + scrypt-hashed; sessions are HMAC-signed tokens.
// Set GL_AUTH_SECRET in the Netlify env for production; a dev fallback is used otherwise.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { CORS, json, sign, verifyToken, bearer, sessionSuperseded, effectiveRoleFor, hashPw, withNewPassword} from "./_auth.mjs";
import { checkThrottle, recordAttempt, clearThrottle, LOGIN_LIMITS } from "./_throttle.mjs";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function store() { return getStore({ name: "granite-users", consistency: "strong" }); }
// iat lets us invalidate sessions minted before a password change (see GET below).
function tokenFor(u) { return sign({ email: u.email, name: u.name, role: u.role, iat: Date.now(), exp: Date.now() + SESSION_MS }); }
const publicUser = (u) => ({ email: u.email, name: u.name, role: u.role });

function samePw(pw, u) {
  const cand = Buffer.from(hashPw(pw, u.salt), "hex"), real = Buffer.from(u.hash, "hex");
  return cand.length === real.length && crypto.timingSafeEqual(cand, real);
}
export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const s = store();

  // GET: validate the current session token (Authorization: Bearer <token>)
  if (req.method === "GET") {
    const p = verifyToken(bearer(req));
    if (!p || p.kind) return json({ ok: false, error: "Invalid or expired session" }, 401);
    // A password change invalidates every session issued before it.
    const u = await s.get(p.email, { type: "json" });
    if (!u) return json({ ok: false, error: "Invalid or expired session" }, 401);
    if (sessionSuperseded(p, u)) {
      return json({ ok: false, error: "Session ended because the password changed." }, 401);
    }
    return json({ ok: true, user: publicUser(u) });
  }
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let d = {};
  try { d = await req.json(); } catch (e) {}
  const action = d.action;
  const email = String(d.email || "").trim().toLowerCase();
  const pw = String(d.pw || "");

  // ---- Register / login ----
  if (!email || !pw) return json({ ok: false, error: "Email and password are required." }, 400);
  if (pw.length < 4) return json({ ok: false, error: "Password must be at least 4 characters." }, 400);

  if (action === "register") {
    const existing = await s.get(email, { type: "json" });
    if (existing) return json({ ok: false, error: "That account already exists. Sign in instead." }, 409);
    const salt = crypto.randomBytes(16).toString("hex");
    // d.role is ignored on purpose: the caller does not get to pick its own privileges.
    const role = await effectiveRoleFor(email);
    const name = String(d.name || "").trim() || email.split("@")[0];
    const user = { email, name, role, salt, hash: hashPw(pw, salt), createdAt: new Date().toISOString() };
    await s.setJSON(email, user);
    return json({ ok: true, token: tokenFor(user), user: publicUser(user) });
  }

  if (action === "login") {
    // Checked before the password is even looked at, so a locked address costs an attacker
    // a rejection rather than a scrypt hash, and the answer does not depend on whether the
    // account exists.
    const gate = await checkThrottle("login", email, LOGIN_LIMITS);
    if (!gate.allowed) {
      return new Response(JSON.stringify({
        ok: false,
        error: "Too many sign-in attempts. Please wait a few minutes and try again.",
        retryAfter: gate.retryAfter,
      }), { status: 429, headers: { ...CORS, "Retry-After": String(gate.retryAfter) } });
    }

    const u = await s.get(email, { type: "json" });
    if (!u || !u.hash || !samePw(pw, u)) {
      // Counted for unknown addresses too: doing otherwise would turn the throttle into an
      // account-enumeration oracle, since only real accounts would ever lock.
      await recordAttempt("login", email, LOGIN_LIMITS);
      return json({ ok: false, error: "Incorrect email or password." }, 401);
    }
    await clearThrottle("login", email);
    // Re-derive privileges on every login from env config and the in-app grants, so a
    // change made on the admin screen (or in config) takes effect at the next sign-in.
    const role = await effectiveRoleFor(email);
    const fresh = role === u.role ? u : { ...u, role };
    if (fresh !== u) await s.setJSON(email, fresh);
    return json({ ok: true, token: tokenFor(fresh), user: publicUser(fresh) });
  }

  return json({ ok: false, error: "Unknown action" }, 400);
};

export const config = { path: "/api/auth" };
