// The seam where a real carrier plugs in.
//
// Today carrier assignment and tracking numbers are generated locally, which is fine for a
// demo and useless for a shipment somebody is waiting on. This module exists so that
// swapping in UPS or FedEx is one contained change rather than an archaeology exercise
// across app.js.
//
// WHAT IS DELIBERATELY NOT HERE: the HTTP calls. Both carriers use OAuth2 REST APIs whose
// exact request and response shapes I cannot verify without sandbox credentials, and code
// written from memory against an API nobody has exercised is worse than an honest gap: it
// looks finished. `fetchScans` throws "not-implemented" for a configured carrier, so the
// failure is loud and located, not silent.
//
// WHAT IS HERE, and is the part worth having in advance:
//   - which carriers are configured, from env, so the app can stop pretending
//   - the mapping from carrier status vocabularies to this app's seven stages
//   - a canonical scan shape, so the rest of the system never sees carrier-specific JSON
//   - the simulated behaviour, named as such instead of scattered through the client
//
// The mapping is data, and its failure mode is inert: an unrecognised code maps to null and
// the package's status is left exactly as it was. That is safe to write ahead of testing in
// a way that request payloads are not.

// This app's stage vocabulary. Anything a carrier says has to land on one of these.
const STAGES = ["Won", "Intake", "PickedUp", "Staged", "InTransit", "OutforDelivery", "Delivered"];

// Per-carrier credentials. Names are ours; the values come from each carrier's developer
// portal once an account exists.
const CARRIERS = {
  UPS: { label: "UPS", env: ["GL_UPS_CLIENT_ID", "GL_UPS_CLIENT_SECRET"] },
  FedEx: { label: "FedEx", env: ["GL_FEDEX_CLIENT_ID", "GL_FEDEX_CLIENT_SECRET"] },
};

export function carrierConfigured(name) {
  const c = CARRIERS[name];
  return !!c && c.env.every((k) => !!process.env[k]);
}
export function configuredCarriers() {
  return Object.keys(CARRIERS).filter(carrierConfigured);
}
export function anyCarrierConfigured() { return configuredCarriers().length > 0; }

// ---- Status mapping ----
//
// Each carrier publishes a short, stable set of top-level status codes. Only the ones that
// correspond to a stage this app tracks are mapped; everything else is intentionally absent
// so it resolves to null and changes nothing.
//
// "Exception" is not a stage here. It is a flag on the package, so it maps to null too and
// is surfaced separately by `isException`.
const UPS_STATUS = {
  M: null,              // manifest received, nothing has physically happened
  P: "PickedUp",
  I: "InTransit",
  O: "OutforDelivery",
  D: "Delivered",
  X: null,              // exception
  RS: null,             // returning to sender
  DE: null,             // delivery attempt failed
};
const FEDEX_STATUS = {
  OC: null,             // order created / label issued
  PU: "PickedUp",
  IT: "InTransit",
  AR: "InTransit",      // arrived at a facility, still moving
  DP: "InTransit",      // departed a facility
  OD: "OutforDelivery",
  DL: "Delivered",
  DE: null,             // delivery exception
  SE: null,             // shipment exception
  CA: null,             // cancelled
};
const EXCEPTION_CODES = { UPS: ["X", "DE", "RS"], FedEx: ["DE", "SE"] };

// Returns one of STAGES, or null when the code says nothing this app models.
export function mapCarrierStatus(carrier, code) {
  const key = String(code || "").trim().toUpperCase();
  const table = carrier === "UPS" ? UPS_STATUS : carrier === "FedEx" ? FEDEX_STATUS : null;
  if (!table || !Object.prototype.hasOwnProperty.call(table, key)) return null;
  return table[key] || null;
}
export function isException(carrier, code) {
  const list = EXCEPTION_CODES[carrier] || [];
  return list.indexOf(String(code || "").trim().toUpperCase()) >= 0;
}

// A stage only ever moves forward. A carrier can report an out-of-order or repeated scan,
// and a parcel that has been delivered must not be dragged back to "in transit" by a
// late-arriving facility scan.
export function isForwardStep(current, next) {
  if (!next) return false;
  const from = STAGES.indexOf(current);
  const to = STAGES.indexOf(next);
  if (to < 0) return false;
  return from < 0 ? true : to > from;
}

// ---- Canonical scan ----
//
// Every adapter returns this shape, so nothing downstream ever parses carrier JSON.
export function normalizeScan(carrier, raw) {
  const code = raw && (raw.status || raw.code || raw.derivedStatusCode);
  return {
    carrier,
    code: String(code || "").toUpperCase() || null,
    stage: mapCarrierStatus(carrier, code),
    exception: isException(carrier, code),
    at: raw && (raw.date || raw.timestamp || raw.at) ? String(raw.date || raw.timestamp || raw.at) : null,
    where: raw && raw.location ? String(raw.location) : null,
    note: raw && (raw.description || raw.eventDescription) ? String(raw.description || raw.eventDescription) : null,
  };
}

// ---- Adapters ----

// Generated locally, exactly as the client does today, so the demo keeps working when no
// carrier is configured. Named here so it is obvious which numbers are real and which
// are not.
const rnd = (n) => Math.floor(Math.random() * n);
export function simulatedTracking(carrier) {
  if (carrier === "UPS") return "1Z" + Math.random().toString(36).slice(2, 8).toUpperCase() + rnd(99) + "0394" + rnd(9999);
  if (carrier === "FedEx") return "" + (7700 + rnd(299)) + " " + (1000 + rnd(8999)) + " " + (1000 + rnd(8999));
  return "PRO-" + (4000000 + rnd(999999));
}

// Fetch scans for one tracking number.
//
// Unconfigured carriers say so, which is the state every deployment is in right now.
// A configured carrier throws, because the request layer is the part I will not guess at:
// this must be implemented against the carrier's sandbox and verified there.
export async function fetchScans(carrier, trackingNumber) {
  if (!CARRIERS[carrier]) return { ok: false, reason: "unknown-carrier", carrier };
  if (!carrierConfigured(carrier)) return { ok: false, reason: "not-configured", carrier };
  throw new Error(
    carrier + " tracking is configured but not implemented. Implement fetchScans in " +
    "netlify/functions/_carriers.mjs against the carrier sandbox, returning scans through " +
    "normalizeScan(). The status mapping and forward-only guard are already in place."
  );
}

// Apply a set of scans to a package, returning what should change. Pure, so the decision
// logic is testable without any carrier at all.
export function applyScans(pkg, scans) {
  const sorted = (scans || []).filter(Boolean);
  let stage = null;
  let exception = false;
  sorted.forEach((s) => {
    if (s.exception) exception = true;
    if (isForwardStep(stage || (pkg && pkg.status), s.stage)) stage = s.stage;
  });
  return {
    stage,                                   // null when nothing moved it forward
    exception,
    changed: !!stage || exception,
  };
}
