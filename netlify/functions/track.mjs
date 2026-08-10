// Public shipment tracking. No auth, because this backs the shareable tracking links
// customers send to whoever is receiving the parcel.
//
// Because the endpoint is open and tracking numbers are sequential, the response is
// deliberately minimal (see publicTrackingView): status, dates, destination city, and
// carrier only. Nothing that identifies the recipient or the contents.
import { CORS, json, readState, publicTrackingView } from "./_lib.mjs";

const TENANT = "default";
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);

  const q = norm(new URL(req.url).searchParams.get("n"));
  if (!q) return json({ ok: false, error: "A tracking number is required." }, 400);

  try {
    const state = await readState(TENANT);
    const hit = (state.packages || []).find(
      (p) => p && (norm(p.id) === q || norm(p.barcode) === q || norm(p.tracking) === q)
    );
    if (!hit) return json({ ok: false, error: "No shipment found for that tracking number." }, 404);
    return json({ ok: true, shipment: publicTrackingView(hit) });
  } catch (e) {
    return json({ ok: false, error: "storage error", detail: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: "/api/track" };
