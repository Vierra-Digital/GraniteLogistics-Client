// Shared session-token helpers for Granite Logistics functions.
// Both /api/auth and /api/my-orders use these so there is one signing secret.
// Set GL_AUTH_SECRET in the Netlify env for production; a dev fallback is used otherwise.
import crypto from "node:crypto";

export const SECRET = process.env.GL_AUTH_SECRET || "granite-dev-secret-change-me";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
