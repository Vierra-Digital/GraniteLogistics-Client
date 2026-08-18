// A customer's own account: export everything we hold, or close it.
//
//   GET     everything this deployment holds about the signed-in account, as JSON.
//   DELETE  close the account.
//
// The email always comes from the verified token, never the body, so a caller can only
// ever act on itself.
//
// Closing an account is not a simple delete, because a logistics record is not only
// personal data. A parcel that is physically moving cannot have its delivery address
// forgotten: somebody is expecting it, and the driver needs the address to hand it over.
// So:
//
//   - orders not yet collected are cancelled and removed outright
//   - orders already delivered are detached from the account and their recipient details
//     scrubbed, keeping the shipment record (id, dates, city/state) as operational history
//   - if anything is in flight, the request is refused and says which, because the honest
//     answer is "not until this is delivered", not a silent partial delete
//
// Everything tied to the person rather than the parcel goes unconditionally: credentials,
// push subscriptions, and rate-limit counters.
import { getStore } from "@netlify/blobs";
import { CORS, json, verifyToken, bearer, getUser, userStore, sessionSuperseded } from "./_auth.mjs";
import { readState, writeState, soloTenant, forgetPhotos } from "./_lib.mjs";
import { readSubscriptions } from "./_push.mjs";

const HEADERS = { ...CORS, "Access-Control-Allow-Methods": "GET, DELETE, OPTIONS" };

// Between collection and delivery the parcel is in our custody and its address is needed
// to complete the job.
const IN_FLIGHT = ["Intake", "PickedUp", "Staged", "InTransit", "OutforDelivery"];

async function requireCustomer(req) {
  const p = verifyToken(bearer(req));
  if (!p || p.kind || !p.email) return { err: json({ ok: false, error: "Sign in required." }, 401) };
  const u = await getUser(p.email);
  if (!u) return { err: json({ ok: false, error: "Sign in required." }, 401) };
  if (sessionSuperseded(p, u)) return { err: json({ ok: false, error: "Session ended because the password changed." }, 401) };
  return { email: String(p.email).toLowerCase(), user: u };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const who = await requireCustomer(req);
  if (who.err) return who.err;

  try {
    const state = await readState(soloTenant());
    const mine = (state.packages || []).filter((p) => p && String(p.customerEmail || "").toLowerCase() === who.email);

    if (req.method === "GET") {
      // Deliberately includes the shipment records, since the addresses in them are the
      // customer's own data. Never includes the password hash or salt.
      const subs = await readSubscriptions(who.email);
      return json({
        ok: true,
        exportedAt: new Date().toISOString(),
        account: { email: who.user.email, name: who.user.name, role: who.user.role, createdAt: who.user.createdAt || null },
        orders: mine,
        notificationDevices: subs.map((s) => ({ addedAt: s.at || null })), // endpoints are device identifiers, not useful to the person
        note: "This is everything Granite Logistics holds that is linked to your account. Your password is stored only as a salted hash and cannot be exported.",
      });
    }

    if (req.method === "DELETE") {
      const inFlight = mine.filter((p) => IN_FLIGHT.indexOf(p.status) >= 0);
      if (inFlight.length) {
        return json({
          ok: false,
          error: "You have " + inFlight.length + " shipment(s) on the way. We can't close the account until they're delivered, because we need the delivery address to complete them.",
          inFlight: inFlight.map((p) => ({ id: p.id, status: p.status })),
        }, 409);
      }

      // Not yet collected: nothing has happened, so remove it entirely.
      const removeIds = new Set(mine.filter((p) => p.status === "Won").map((p) => p.id));
      // Delivered: keep the shipment, drop the person.
      const scrubIds = new Set(mine.filter((p) => p.status === "Delivered").map((p) => p.id));

      state.packages = (state.packages || [])
        .filter((p) => !removeIds.has(p.id))
        .map((p) => {
          if (!scrubIds.has(p.id)) return p;
          return {
            ...p,
            customerEmail: null,
            customer: {
              // City and state stay: they are the lane, not the person.
              name: "(closed account)", address: "", phone: "",
              city: p.customer?.city || "", state: p.customer?.state || "", zip: "",
            },
            photos: {},          // condition photos can show a doorway or a street number
          };
        });
      await writeState(soloTenant(), state);

      // The bytes, not just the reference. Done after the write so a failure here cannot leave
      // the record still pointing at a photo that has been deleted.
      const photos = await forgetPhotos(mine.filter((p) => removeIds.has(p.id) || scrubIds.has(p.id)));

      // Everything that identifies the person rather than the parcel.
      await userStore().delete(who.email);
      try { await getStore({ name: "granite-push", consistency: "strong" }).delete(who.email); } catch (e) {}
      for (const scope of ["login", "reset"]) {
        try { await getStore({ name: "granite-throttle", consistency: "strong" }).delete(scope + ":" + who.email); } catch (e) {}
      }

      return json({
        ok: true,
        closed: who.email,
        ordersRemoved: removeIds.size,
        ordersAnonymised: scrubIds.size,
        photosDeleted: photos.removed,
        // Said only when it is true. A cleanup that failed leaves the reference gone and the
        // object behind, which is exactly the case somebody would otherwise never find out about.
        note: photos.ok
          ? "Your account and sign-in details are gone. Delivered shipments are kept as operational records with your name, address and photos removed."
          : "Your account and sign-in details are gone, and your details have been removed from delivered shipments. Some condition photos could not be deleted from storage; we have been notified and will remove them.",
      });
    }

    return json({ ok: false, error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ ok: false, error: "storage error", detail: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: "/api/account" };
