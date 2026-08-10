// Shared session-token helpers for Granite Logistics functions.
// Both /api/auth and /api/my-orders use these so there is one signing secret.
// Set GL_AUTH_SECRET in the Netlify env for production; a dev fallback is used otherwise.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

export const SECRET = process.env.GL_AUTH_SECRET || "granite-dev-secret-change-me";

// Accounts store, shared by /api/auth and anything that needs to check a caller's role.
export function userStore() { return getStore({ name: "granite-users", consistency: "strong" }); }
export async function getUser(email) {
  if (!email) return null;
  return userStore().get(String(email).trim().toLowerCase(), { type: "json" });
}

export const ROLES = ["Customer", "Admin", "Runner", "Driver", "Viewer"];
// Roles allowed to touch the shared ops workspace at all, and the subset allowed to
// change it. Viewer is deliberately read-only.
export const OPS_ROLES = ["Admin", "Runner", "Driver", "Viewer"];
export const WRITE_ROLES = ["Admin", "Runner", "Driver"];

// Roles are assigned by the operator, never by the client. Registration used to accept a
// `role` from the request body, which let anyone sign up as Admin. The only way to get an
// ops role is to be listed in GL_ADMIN_EMAILS.
// GL_ADMIN_EMAILS='a@x.com,b@x.com' is the shorthand for granting Admin.
// GL_ROLES='{"c@x.com":"Runner"}' grants any other ops role.
export function adminEmails() {
  return String(process.env.GL_ADMIN_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export function roleMap() {
  try { return process.env.GL_ROLES ? JSON.parse(process.env.GL_ROLES) : {}; } catch (e) { return {}; }
}

// The single source of truth for a caller's privileges. Deliberately ignores whatever
// role is stored on the account: registration used to accept a client-supplied role, so
// any stored ops role that the operator did not grant here is not trustworthy and is
// downgraded to Customer on the next login.
export function roleFor(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return "Customer";
  if (adminEmails().includes(e)) return "Admin";
  const named = roleMap()[e];
  return OPS_ROLES.includes(named) ? named : "Customer";
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Content-Type": "application/json",
};
export const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CORS });

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
export function verifyToken(token) {
  try {
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
export function bearer(req) { return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""); }

// A password change invalidates every session minted before it. Tokens are stateless
// HMACs so they can't be revoked individually; instead we compare the token's issued-at
// against the account's pwChangedAt. Tokens from before `iat` existed are treated as
// stale, which is the safe direction. Pure so it can be unit tested.
export function sessionSuperseded(tokenPayload, user) {
  if (!user || !user.pwChangedAt) return false;
  return !tokenPayload || !tokenPayload.iat || user.pwChangedAt > tokenPayload.iat;
}
