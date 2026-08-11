// Real authentication for Granite Logistics.
// Accounts live in Netlify Blobs (store "granite-users", keyed by email).
// Passwords are salted + scrypt-hashed; sessions are HMAC-signed tokens.
// Set GL_AUTH_SECRET in the Netlify env for production; a dev fallback is used otherwise.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { CORS, json, sign, verifyToken, bearer, sessionSuperseded, effectiveRoleFor } from "./_auth.mjs";
import { sendEmail, resetEmail, emailConfigured } from "./_email.mjs";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_MS = 30 * 60 * 1000;             // reset links are short-lived

function store() { return getStore({ name: "granite-users", consistency: "strong" }); }
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
// iat lets us invalidate sessions minted before a password change (see GET below).
function tokenFor(u) { return sign({ email: u.email, name: u.name, role: u.role, iat: Date.now(), exp: Date.now() + SESSION_MS }); }
const publicUser = (u) => ({ email: u.email, name: u.name, role: u.role });
function samePw(pw, u) {
  const cand = Buffer.from(hashPw(pw, u.salt), "hex"), real = Buffer.from(u.hash, "hex");
  return cand.length === real.length && crypto.timingSafeEqual(cand, real);
}
function siteBase(req) {
  return process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
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

  // ---- Password reset (handled before the shared email+password validation,
  // since these two actions take different inputs) ----

  // Step 1: ask for a reset link. Always answers the same way whether or not the
  // account exists, so this can't be used to discover who has an account.
  if (action === "reset-request") {
    if (!email) return json({ ok: false, error: "Enter your email address." }, 400);
    if (!emailConfigured()) {
      return json({ ok: false, error: "Password reset isn't set up on this deployment yet. Contact support and we'll reset it for you." }, 503);
    }
    const u = await s.get(email, { type: "json" });
    if (u) {
      const token = sign({ email, kind: "reset", exp: Date.now() + RESET_MS });
      const link = siteBase(req) + "/app.html?reset=" + encodeURIComponent(token);
      const msg = resetEmail(u.name, link);
      await sendEmail({ to: email, subject: msg.subject, html: msg.html, text: msg.text });
    }
    return json({ ok: true, sent: true });
  }

  // Step 2: redeem the emailed token and set a new password.
  if (action === "reset-confirm") {
    const p = verifyToken(String(d.token || ""));
    if (!p || p.kind !== "reset" || !p.email) {
      return json({ ok: false, error: "That reset link is invalid or has expired. Request a new one." }, 400);
    }
    if (pw.length < 4) return json({ ok: false, error: "Password must be at least 4 characters." }, 400);
    const u = await s.get(p.email, { type: "json" });
    if (!u) return json({ ok: false, error: "That account no longer exists." }, 404);
    const salt = crypto.randomBytes(16).toString("hex");
    const updated = { ...u, salt, hash: hashPw(pw, salt), pwChangedAt: Date.now() };
    await s.setJSON(p.email, updated);
    return json({ ok: true, token: tokenFor(updated), user: publicUser(updated) });
  }

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
    const u = await s.get(email, { type: "json" });
    if (!u || !u.hash || !samePw(pw, u)) {
      return json({ ok: false, error: "Incorrect email or password." }, 401);
    }
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
