// Carrier status.
//
//   GET   which carriers are configured on this deployment. Unauthenticated, because the
//         answer is a property of the deployment and the ops UI needs it to decide whether
//         to label its tracking numbers as simulated.
//   POST  refresh tracking for in-flight packages from the carrier. Ops roles only, since
//         it reads and writes the shared workspace.
//
// With no carrier configured, POST reports exactly that and changes nothing, rather than
// inventing scans. The whole point of this endpoint is to stop the app pretending.
import { CORS, json, readState, writeState } from "./_lib.mjs";
import { verifyToken, bearer, getUser, sessionSuperseded, effectiveRoleFor, WRITE_ROLES } from "./_auth.mjs";
import { configuredCarriers, anyCarrierConfigured, fetchScans, applyScans, isForwardStep } from "./_carriers.mjs";
import { notifyStatusChanges } from "./_notify.mjs";

const TENANT = "default";
const HEADERS = { ...CORS, "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

// Only a parcel that is actually moving is worth asking a carrier about.
const inFlight = (p) => p && p.tracking && p.carrier && p.status !== "Delivered";

async function requireWriter(req) {
  const p = verifyToken(bearer(req));
  if (!p || p.kind || !p.email) return { err: json({ ok: false, error: "Sign in required." }, 401) };
  const u = await getUser(p.email);
  if (!u) return { err: json({ ok: false, error: "Sign in required." }, 401) };
  if (sessionSuperseded(p, u)) return { err: json({ ok: false, error: "Session ended because the password changed." }, 401) };
  const role = await effectiveRoleFor(p.email);
  if (!WRITE_ROLES.includes(role)) {
    return { err: json({ ok: false, error: "forbidden", hint: "refreshing carrier tracking needs an operations role that can write" }, 403) };
  }
  return { email: p.email, role };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  if (req.method === "GET") {
    const configured = configuredCarriers();
    return json({
      ok: true,
      configured,
      // Said plainly so the UI can label it, rather than leaving anyone to assume these
      // tracking numbers mean something to a carrier.
      simulated: configured.length === 0,
      detail: configured.length
        ? configured.join(", ") + " configured"
        : "no carrier credentials set; tracking numbers and scans are generated locally",
    });
  }

  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const who = await requireWriter(req);
  if (who.err) return who.err;

  if (!anyCarrierConfigured()) {
    return json({
      ok: false, reason: "not-configured", refreshed: 0,
      error: "No carrier is configured, so there is nothing to refresh. Tracking numbers on this deployment are generated locally.",
    }, 503);
  }

  try {
    const state = await readState(TENANT);
    const before = (state.packages || []).map((p) => ({ ...p }));
    const targets = (state.packages || []).filter(inFlight);

    let refreshed = 0, moved = 0;
    const failures = [];
    for (const pkg of targets) {
      let result;
      try {
        result = await fetchScans(pkg.carrier, pkg.tracking);
      } catch (e) {
        // A configured-but-unimplemented carrier lands here. Recorded per package and
        // reported, never swallowed.
        failures.push({ id: pkg.id, carrier: pkg.carrier, error: String((e && e.message) || e) });
        continue;
      }
      if (!result || !result.ok) { failures.push({ id: pkg.id, carrier: pkg.carrier, error: (result && result.reason) || "no-result" }); continue; }
      refreshed++;

      const decision = applyScans(pkg, result.scans);
      if (decision.exception && !pkg.exception) pkg.exception = { type: "Carrier exception", note: null };
      if (decision.stage && isForwardStep(pkg.status, decision.stage)) {
        pkg.status = decision.stage;
        pkg.history = (pkg.history || []).concat([{ stage: decision.stage, ts: Date.now(), note: pkg.carrier + " scan" }]);
        moved++;
      }
    }

    if (moved || failures.length < targets.length) await writeState(TENANT, state);

    // A carrier scan is a status change like any other, so it reaches the customer through
    // the same path an ops push does.
    const notified = moved ? await notifyStatusChanges(TENANT, before, state.packages) : { sent: 0, pushed: 0 };

    return json({ ok: failures.length === 0, checked: targets.length, refreshed, moved, notified, failures });
  } catch (e) {
    return json({ ok: false, error: "storage error", detail: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: "/api/carriers" };
