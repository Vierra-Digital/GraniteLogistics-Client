// Real authentication for Granite Logistics.
// Accounts live in Netlify Blobs (store "granite-users", keyed by email).
// Passwords are salted + scrypt-hashed; sessions are HMAC-signed tokens.
// Set GL_AUTH_SECRET in the Netlify env for production; a dev fallback is used otherwise.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { CORS, json, sign, verifyToken, bearer } from "./_auth.mjs";

const VALID_ROLES = ["Customer", "Admin", "Runner", "Driver", "Viewer"];
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function store() { return getStore({ name: "granite-users", consistency: "strong" }); }
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
function tokenFor(u) { return sign({ email: u.email, name: u.name, role: u.role, exp: Date.now() + SESSION_MS }); }
const publicUser = (u) => ({ email: u.email, name: u.name, role: u.role });

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const s = store();

  // GET — validate the current session token (Authorization: Bearer <token>)
  if (req.method === "GET") {
    const p = verifyToken(bearer(req));
    if (!p) return json({ ok: false, error: "Invalid or expired session" }, 401);
    return json({ ok: true, user: { email: p.email, name: p.name, role: p.role } });
  }
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  let d = {};
  try { d = await req.json(); } catch (e) {}
  const action = d.action;
  const email = String(d.email || "").trim().toLowerCase();
  const pw = String(d.pw || "");
  if (!email || !pw) return json({ ok: false, error: "Email and password are required." }, 400);
  if (pw.length < 4) return json({ ok: false, error: "Password must be at least 4 characters." }, 400);

  if (action === "register") {
    const existing = await s.get(email, { type: "json" });
    if (existing) return json({ ok: false, error: "That account already exists — sign in instead." }, 409);
    const salt = crypto.randomBytes(16).toString("hex");
    const role = VALID_ROLES.includes(d.role) ? d.role : "Customer";
    const name = String(d.name || "").trim() || email.split("@")[0];
    const user = { email, name, role, salt, hash: hashPw(pw, salt), createdAt: new Date().toISOString() };
    await s.setJSON(email, user);
    return json({ ok: true, token: tokenFor(user), user: publicUser(user) });
  }

  if (action === "login") {
    const u = await s.get(email, { type: "json" });
    if (!u || !u.hash) return json({ ok: false, error: "Incorrect email or password." }, 401);
    const cand = Buffer.from(hashPw(pw, u.salt), "hex"), real = Buffer.from(u.hash, "hex");
    if (cand.length !== real.length || !crypto.timingSafeEqual(cand, real)) {
      return json({ ok: false, error: "Incorrect email or password." }, 401);
    }
    return json({ ok: true, token: tokenFor(u), user: publicUser(u) });
  }

  return json({ ok: false, error: "Unknown action" }, 400);
};

export const config = { path: "/api/auth" };
