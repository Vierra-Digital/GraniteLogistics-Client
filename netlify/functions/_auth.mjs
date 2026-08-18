// Shared session-token helpers for Granite Logistics functions.
// Both /api/auth and /api/my-orders use these so there is one signing secret.
// Set GL_AUTH_SECRET in the Netlify env for production; a dev fallback is used otherwise.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const SECRET = process.env.GL_AUTH_SECRET || "granite-dev-secret-change-me";

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

export const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

// Privileges granted by environment config. These outrank anything set in the app and
// cannot be revoked from the admin screen, so an operator who edits config can always
// recover access even if the stored grants are wrong or someone has locked themselves out.
export function envRoleFor(email) {
  const e = normalizeEmail(email);
  if (!e) return "Customer";
  if (adminEmails().includes(e)) return "Admin";
  const named = roleMap()[e];
  return OPS_ROLES.includes(named) ? named : "Customer";
}

// Privileges granted in-app by an Admin, stored as { email: { role, by, at } }.
// One record, because a role list is small and always read whole.
export function grantsStore() { return getStore({ name: "granite-roles", consistency: "strong" }); }
export async function readGrants() {
  const g = await grantsStore().get("grants", { type: "json" });
  return (g && typeof g === "object") ? g : {};
}
export async function writeGrants(grants) { await grantsStore().setJSON("grants", grants); }

export function grantedRole(grants, email) {
  const entry = grants && grants[normalizeEmail(email)];
  const role = entry && entry.role;
  return OPS_ROLES.includes(role) ? role : null;
}

// The single source of truth for a caller's privileges: env config first, then in-app
// grants, then Customer. Deliberately ignores whatever role is stored on the account,
// because registration once accepted a client-supplied role, so a stored ops role nobody
// granted is not trustworthy.
export async function effectiveRoleFor(email, grants) {
  const fromEnv = envRoleFor(email);
  if (fromEnv !== "Customer") return fromEnv;
  const g = grants || await readGrants();
  return grantedRole(g, email) || "Customer";
}

// Accounts, without the password material. Used by the admin screen.
//
// One read per account, because a name is only in the record. That is fine for an
// operations team and would not be fine for a large customer base, so it is capped and
// reports truncation rather than quietly issuing thousands of reads. If this ever needs to
// scale, the fix is an index record maintained on registration, not a bigger cap.
const USER_LIST_LIMIT = 500;

export async function listUsers(limit = USER_LIST_LIMIT) {
  const { blobs } = await userStore().list();
  const keys = (blobs || []).map((b) => b.key);
  const page = keys.slice(0, limit);
  const users = await Promise.all(page.map(async (key) => {
    const u = await userStore().get(key, { type: "json" });
    return u ? { email: u.email || key, name: u.name || "", createdAt: u.createdAt || null } : null;
  }));
  return { users: users.filter(Boolean), total: keys.length, truncated: keys.length > page.length };
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

// ---- Passwords ----
//
// scrypt with a per-user salt. This lived privately in auth.mjs; it moved here unchanged
// so the admin reset path uses the identical scheme rather than a second copy of it. The
// parameters are load-bearing: altering them invalidates every stored hash.
export const MIN_PASSWORD = 4;
export function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
// Returns the user with a fresh salt+hash and pwChangedAt bumped, which is what makes
// sessionSuperseded() invalidate every token issued before the change.
export function withNewPassword(user, pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { ...user, salt, hash: hashPw(pw, salt), pwChangedAt: Date.now() };
}
