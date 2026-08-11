// Manage a customer's push subscriptions.
//
//   GET     tells the client whether push is available here and hands out the public key.
//           Unauthenticated, because the client needs it before it can decide whether to
//           offer the option at all. The public key is public by design.
//   POST    store a subscription for the signed-in account.
//   DELETE  forget one (the customer turned notifications off, or signed out).
//
// A subscription belongs to whoever is signed in: the email comes from the verified token,
// never the body, so nobody can register a device against another account and receive
// their shipment updates.
import { CORS, json, verifyToken, bearer } from "./_auth.mjs";
import { pushConfigured, pushPublicKey, saveSubscription, removeSubscription, readSubscriptions } from "./_push.mjs";

const HEADERS = { ...CORS, "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  if (req.method === "GET") {
    return json({ ok: true, configured: pushConfigured(), publicKey: pushPublicKey() });
  }

  const p = verifyToken(bearer(req));
  if (!p || p.kind || !p.email) return json({ ok: false, error: "Sign in required." }, 401);
  if (!pushConfigured()) {
    return json({ ok: false, error: "Push notifications aren't set up on this deployment yet." }, 503);
  }

  try {
    if (req.method === "POST") {
      let d = {};
      try { d = await req.json(); } catch (e) {}
      const r = await saveSubscription(p.email, d.subscription || d);
      return r.ok ? json(r) : json(r, 400);
    }

    if (req.method === "DELETE") {
      let d = {};
      try { d = await req.json(); } catch (e) {}
      const endpoint = d.endpoint || new URL(req.url).searchParams.get("endpoint");
      if (!endpoint) return json({ ok: false, error: "An endpoint is required." }, 400);
      return json(await removeSubscription(p.email, endpoint));
    }

    if (req.method === "HEAD") return json({ ok: true, devices: (await readSubscriptions(p.email)).length });

    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ ok: false, error: "storage error", detail: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: "/api/push" };
