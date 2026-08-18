// Regression tests for the pure logic behind the Netlify Functions.
//
// These cover the parts that are easy to get subtly wrong and expensive to get wrong
// in production: workspace merging (data loss), id allocation (duplicate tracking
// numbers), token handling (auth bypass), and tenant resolution (cross-tenant leaks).
// No network, no Blobs runtime, no browser. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergePushedPackages, nextId, tenantOf, resolveKey, makeOrder, EMPTY, publicTrackingView, orderRateLimit, orderCreatedAt, ORDER_LIMITS } from "../netlify/functions/_lib.mjs";
import { envRoleFor, OPS_ROLES, WRITE_ROLES } from "../netlify/functions/_auth.mjs";
import { sign, verifyToken, bearer, sessionSuperseded } from "../netlify/functions/_auth.mjs";
import { emailConfigured, sendEmail, resetEmail, parseSender, statusEmail } from "../netlify/functions/_email.mjs";
import { detectStatusChanges, unannounced, isNotifiable, NOTIFY_STAGES, pruneAnnounced, ANNOUNCED_LIMIT } from "../netlify/functions/_notify.mjs";
import { evaluate, afterFailure, LOGIN_LIMITS, RESET_LIMITS } from "../netlify/functions/_throttle.mjs";
import { carrierConfigured, configuredCarriers, mapCarrierStatus, isException, isForwardStep,
         normalizeScan, applyScans, fetchScans, simulatedTracking } from "../netlify/functions/_carriers.mjs";

const opsPkg = (id, status = "Won") => ({ id, status });
const custPkg = (id, status = "Won", email = "jane@x.com") => ({ id, status, customerEmail: email });
const ids = (r) => r.packages.map((p) => p.id).sort().join(",");

// ---------------------------------------------------------------------------
// Workspace merge. Ops clients push their whole (possibly stale) local state while
// customers write orders into the same record, so a blind replace loses orders.
// ---------------------------------------------------------------------------
test("stale ops push preserves a customer order it never saw", () => {
  const r = mergePushedPackages([opsPkg("GL-1"), custPkg("GL-2")], [opsPkg("GL-1")], []);
  assert.equal(ids(r), "GL-1,GL-2");
  assert.equal(r.preserved, 1);
});

test("ops can still advance a customer order's status, with no duplicate row", () => {
  const r = mergePushedPackages([custPkg("GL-2", "Won")], [custPkg("GL-2", "InTransit")], []);
  assert.equal(r.packages.length, 1);
  assert.equal(r.packages[0].status, "InTransit");
  assert.equal(r.preserved, 0);
});

test("a tombstoned customer order stays deleted", () => {
  const r = mergePushedPackages([custPkg("GL-2")], [], [{ id: "GL-2", ts: Date.now() }]);
  assert.equal(r.packages.length, 0);
});

test("tombstones are accepted as bare id strings too", () => {
  const r = mergePushedPackages([custPkg("GL-2")], [], ["GL-2"]);
  assert.equal(r.packages.length, 0);
});

test("a webhook-ingested order survives a stale ops push", () => {
  // Ingested orders have no customerEmail, so they used to fall outside the preserve rule
  // and a routine ops push would silently delete a shipment nobody had pulled yet.
  const ingested = { id: "GL-7", uid: "u-7", source: "API" };
  const r = mergePushedPackages([opsPkg("GL-1"), ingested], [opsPkg("GL-1")], []);
  assert.equal(ids(r), "GL-1,GL-7");
  assert.equal(r.preserved, 1);
});

test("a tombstoned ingested order still deletes", () => {
  const r = mergePushedPackages([{ id: "GL-7", uid: "u-7" }], [], [{ id: "GL-7" }]);
  assert.equal(r.packages.length, 0);
});

test("ops' own packages need no tombstone to delete", () => {
  const r = mergePushedPackages([opsPkg("GL-9")], [], []);
  assert.equal(r.packages.length, 0);
  assert.equal(r.preserved, 0);
});

test("orders from several customers all survive one stale push", () => {
  const r = mergePushedPackages(
    [{ id: "GL-3", customerEmail: "a@x.com" }, { id: "GL-4", customerEmail: "b@x.com" }],
    [opsPkg("GL-1")], []);
  assert.equal(ids(r), "GL-1,GL-3,GL-4");
  assert.equal(r.preserved, 2);
});

test("merge tolerates null/malformed input instead of throwing", () => {
  assert.equal(mergePushedPackages(null, [opsPkg("GL-1")], null).packages.length, 1);
  assert.equal(mergePushedPackages([custPkg("GL-2")], null, null).packages.length, 1);
  assert.doesNotThrow(() => mergePushedPackages([null, custPkg("GL-2")], [null], [null]));
});

// ---------------------------------------------------------------------------
// Id allocation. Customer orders and ops packages share one workspace, so ids must
// be unique across the whole record, not per-caller.
// ---------------------------------------------------------------------------
test("nextId spans the whole workspace", () => {
  assert.equal(nextId({ packages: [{ id: "GL-1041" }, { id: "GL-1099" }] }), "GL-1100");
});

test("nextId on an empty or malformed workspace", () => {
  assert.equal(nextId({ packages: [] }), "GL-1041");
  assert.equal(nextId({}), "GL-1041");
  assert.equal(nextId({ packages: [{ id: "not-an-id" }, {}] }), "GL-1041");
});

// ---------------------------------------------------------------------------
// Session tokens. A break here is an auth bypass.
// ---------------------------------------------------------------------------
test("a signed token round-trips", () => {
  const p = verifyToken(sign({ email: "a@b.com", role: "Customer", exp: Date.now() + 60000 }));
  assert.equal(p.email, "a@b.com");
  assert.equal(p.role, "Customer");
});

test("expired tokens are rejected", () => {
  assert.equal(verifyToken(sign({ email: "a@b.com", exp: Date.now() - 1000 })), null);
});

test("tampered and malformed tokens are rejected", () => {
  const t = sign({ email: "a@b.com", exp: Date.now() + 60000 });
  assert.equal(verifyToken(t.slice(0, -3) + "xxx"), null); // bad signature
  assert.equal(verifyToken("garbage"), null);              // no separator
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken(null), null);
});

test("a reset token is distinguishable from a session token", () => {
  // /api/auth GET refuses any token carrying `kind`, so a reset link can't be
  // used as a session, and a session can't be redeemed as a reset.
  assert.equal(verifyToken(sign({ email: "a@b.com", kind: "reset", exp: Date.now() + 60000 })).kind, "reset");
  assert.equal(verifyToken(sign({ email: "a@b.com", iat: Date.now(), exp: Date.now() + 60000 })).kind, undefined);
});

test("bearer() pulls the token out of an Authorization header", () => {
  assert.equal(bearer({ headers: new Headers({ authorization: "Bearer abc.def" }) }), "abc.def");
  assert.equal(bearer({ headers: new Headers({ authorization: "bearer abc" }) }), "abc"); // case-insensitive
  assert.equal(bearer({ headers: new Headers() }), "");
});

// ---------------------------------------------------------------------------
// Password changes must end sessions minted beforehand.
// ---------------------------------------------------------------------------
test("sessions from before a password change are superseded", () => {
  const user = { pwChangedAt: 3000 };
  assert.equal(sessionSuperseded({ iat: 1000 }, user), true);  // older session
  assert.equal(sessionSuperseded({ iat: 5000 }, user), false); // newer session
  assert.equal(sessionSuperseded({}, user), true);             // legacy, no iat
  assert.equal(sessionSuperseded({ iat: 1000 }, {}), false);   // password never changed
  assert.equal(sessionSuperseded({ iat: 1000 }, null), false);
});

// ---------------------------------------------------------------------------
// Tenant resolution. A wrong answer here leaks one tenant's data to another.
// ---------------------------------------------------------------------------
test("tenantOf resolves a key from the header or the query string", () => {
  assert.equal(tenantOf({ url: "https://x/api/state", headers: new Headers({ "x-api-key": "acme-key" }) }), "acme");
  assert.equal(tenantOf({ url: "https://x/api/state?key=globex-key", headers: new Headers() }), "globex");
});

test("tenantOf rejects unknown or missing keys", () => {
  assert.equal(tenantOf({ url: "https://x/api/state", headers: new Headers({ "x-api-key": "nope" }) }), null);
  assert.equal(tenantOf({ url: "https://x/api/state", headers: new Headers() }), null);
});

test("a header key takes precedence over the query string", () => {
  assert.equal(
    tenantOf({ url: "https://x/api/state?key=globex-key", headers: new Headers({ "x-api-key": "acme-key" }) }),
    "acme");
});

// resolveKey reports whether a key is operator-configured or one of the public demo
// keys. Endpoints that expose data require "config", so conflating the two would put
// the whole workspace behind a key that is published in this repo.
const req = (key) => ({ url: "https://x/api/state", headers: new Headers(key ? { "x-api-key": key } : {}) });

test("resolveKey marks the built-in demo keys as demo, not config", () => {
  assert.deepEqual(resolveKey(req("granite-dev-key")), { tenant: "default", source: "demo" });
  assert.deepEqual(resolveKey(req("nope")), { tenant: null, source: null });
  assert.deepEqual(resolveKey(req(null)), { tenant: null, source: null });
});

test("resolveKey marks a GL_TENANTS key as config, and disables the demo keys", () => {
  process.env.GL_TENANTS = JSON.stringify({ "secret-key": "acme" });
  try {
    assert.deepEqual(resolveKey(req("secret-key")), { tenant: "acme", source: "config" });
    // Configuring GL_TENANTS replaces the demo map rather than extending it.
    assert.deepEqual(resolveKey(req("granite-dev-key")), { tenant: null, source: null });
  } finally {
    delete process.env.GL_TENANTS;
  }
});

test("malformed GL_TENANTS falls back to the demo keys rather than throwing", () => {
  process.env.GL_TENANTS = "{not json";
  try {
    assert.deepEqual(resolveKey(req("granite-dev-key")), { tenant: "default", source: "demo" });
  } finally {
    delete process.env.GL_TENANTS;
  }
});

// ---------------------------------------------------------------------------
// Role assignment. The operator config is the only source of privileges.
// ---------------------------------------------------------------------------
test("envRoleFor grants Customer unless the operator config says otherwise", () => {
  const saved = [process.env.GL_ADMIN_EMAILS, process.env.GL_ROLES];
  delete process.env.GL_ADMIN_EMAILS; delete process.env.GL_ROLES;
  try {
    assert.equal(envRoleFor("anyone@example.com"), "Customer");
    assert.equal(envRoleFor(""), "Customer");
    assert.equal(envRoleFor(undefined), "Customer");

    process.env.GL_ADMIN_EMAILS = " Boss@Example.com , other@example.com ";
    assert.equal(envRoleFor("boss@example.com"), "Admin", "email match must be trimmed and case-insensitive");
    assert.equal(envRoleFor("nobody@example.com"), "Customer");

    process.env.GL_ROLES = JSON.stringify({ "dave@example.com": "Runner", "eve@example.com": "Wizard" });
    assert.equal(envRoleFor("dave@example.com"), "Runner");
    // An unrecognised role name must not become a privilege.
    assert.equal(envRoleFor("eve@example.com"), "Customer");
  } finally {
    if (saved[0] === undefined) delete process.env.GL_ADMIN_EMAILS; else process.env.GL_ADMIN_EMAILS = saved[0];
    if (saved[1] === undefined) delete process.env.GL_ROLES; else process.env.GL_ROLES = saved[1];
  }
});

// ---------------------------------------------------------------------------
// Carrier seam. The HTTP layer is deliberately unimplemented, so what is tested is
// the part that exists: config detection, status mapping, and the guarantee that a
// carrier can never drag a parcel backwards.
// ---------------------------------------------------------------------------
test("carriers report as unconfigured until their credentials are set", () => {
  const saved = [process.env.GL_UPS_CLIENT_ID, process.env.GL_UPS_CLIENT_SECRET];
  delete process.env.GL_UPS_CLIENT_ID; delete process.env.GL_UPS_CLIENT_SECRET;
  try {
    assert.equal(carrierConfigured("UPS"), false);
    // Half-configured is not configured: one key without the other cannot authenticate.
    process.env.GL_UPS_CLIENT_ID = "id-only";
    assert.equal(carrierConfigured("UPS"), false, "a partial credential set read as configured");
    process.env.GL_UPS_CLIENT_SECRET = "secret";
    assert.equal(carrierConfigured("UPS"), true);
    assert.ok(configuredCarriers().includes("UPS"));
    assert.equal(carrierConfigured("Pigeon"), false);
  } finally {
    if (saved[0] === undefined) delete process.env.GL_UPS_CLIENT_ID; else process.env.GL_UPS_CLIENT_ID = saved[0];
    if (saved[1] === undefined) delete process.env.GL_UPS_CLIENT_SECRET; else process.env.GL_UPS_CLIENT_SECRET = saved[1];
  }
});

test("carrier status codes map onto this app's stages", () => {
  assert.equal(mapCarrierStatus("UPS", "I"), "InTransit");
  assert.equal(mapCarrierStatus("UPS", "D"), "Delivered");
  assert.equal(mapCarrierStatus("UPS", "O"), "OutforDelivery");
  assert.equal(mapCarrierStatus("FedEx", "DL"), "Delivered");
  assert.equal(mapCarrierStatus("FedEx", "OD"), "OutforDelivery");
  // A facility arrival or departure still means in transit.
  assert.equal(mapCarrierStatus("FedEx", "AR"), "InTransit");
  assert.equal(mapCarrierStatus("FedEx", "DP"), "InTransit");
  // Case and whitespace come from a wire format, not a keyboard.
  assert.equal(mapCarrierStatus("FedEx", " dl "), "Delivered");
});

test("an unknown or non-stage code changes nothing", () => {
  // This is what makes the table safe to write before it can be tested against a sandbox:
  // anything unrecognised is inert rather than wrong.
  ["ZZ", "", null, undefined, "42"].forEach((c) =>
    assert.equal(mapCarrierStatus("UPS", c), null, "code " + JSON.stringify(c) + " produced a stage"));
  assert.equal(mapCarrierStatus("Pigeon", "I"), null);
  // Label-created and cancelled are real codes that correspond to no stage here.
  assert.equal(mapCarrierStatus("UPS", "M"), null);
  assert.equal(mapCarrierStatus("FedEx", "OC"), null);
  assert.equal(mapCarrierStatus("FedEx", "CA"), null);
});

test("exceptions are flagged, not treated as a stage", () => {
  assert.equal(isException("UPS", "X"), true);
  assert.equal(isException("FedEx", "DE"), true);
  assert.equal(isException("UPS", "I"), false);
  // An exception must not also move the parcel.
  assert.equal(mapCarrierStatus("UPS", "X"), null);
});

test("a carrier can never drag a parcel backwards", () => {
  // Carriers repeat and reorder scans, and a late facility scan arriving after delivery
  // must not un-deliver the parcel.
  assert.equal(isForwardStep("InTransit", "Delivered"), true);
  assert.equal(isForwardStep("Delivered", "InTransit"), false);
  assert.equal(isForwardStep("InTransit", "InTransit"), false);
  assert.equal(isForwardStep("Won", "PickedUp"), true);
  assert.equal(isForwardStep("InTransit", null), false);
  assert.equal(isForwardStep("InTransit", "Nonsense"), false);
  // An unknown current status should not block a legitimate first scan.
  assert.equal(isForwardStep("???", "InTransit"), true);
});

test("applyScans takes the furthest forward scan and reports exceptions", () => {
  const pkg = { status: "PickedUp" };
  const scan = (code, carrier = "FedEx") => normalizeScan(carrier, { status: code });

  // Out of order on purpose: the result must be the furthest along, not the last seen.
  const r = applyScans(pkg, [scan("DL"), scan("AR"), scan("OD")]);
  assert.equal(r.stage, "Delivered");
  assert.equal(r.exception, false);
  assert.equal(r.changed, true);

  // Nothing forward means no change at all.
  const none = applyScans({ status: "Delivered" }, [scan("AR"), scan("IT")]);
  assert.equal(none.stage, null);
  assert.equal(none.changed, false);

  // An exception is reported even when the parcel did not move.
  const exc = applyScans({ status: "InTransit" }, [scan("DE")]);
  assert.equal(exc.stage, null);
  assert.equal(exc.exception, true);
  assert.equal(exc.changed, true);

  assert.equal(applyScans(pkg, []).changed, false);
  assert.equal(applyScans(pkg, null).changed, false);
});

test("normalizeScan hides carrier-specific field names", () => {
  const s = normalizeScan("UPS", { status: "I", date: "2026-08-11T10:00:00Z", location: "Columbus, OH", description: "Departed" });
  assert.deepEqual(s, {
    carrier: "UPS", code: "I", stage: "InTransit", exception: false,
    at: "2026-08-11T10:00:00Z", where: "Columbus, OH", note: "Departed",
  });
  // Missing fields become null rather than undefined, so the shape is stable.
  const bare = normalizeScan("FedEx", {});
  assert.equal(bare.code, null);
  assert.equal(bare.stage, null);
  assert.equal(bare.at, null);
});

test("fetchScans refuses rather than inventing scans", async () => {
  const saved = [process.env.GL_UPS_CLIENT_ID, process.env.GL_UPS_CLIENT_SECRET];
  delete process.env.GL_UPS_CLIENT_ID; delete process.env.GL_UPS_CLIENT_SECRET;
  try {
    assert.deepEqual(await fetchScans("Pigeon", "X"), { ok: false, reason: "unknown-carrier", carrier: "Pigeon" });
    assert.deepEqual(await fetchScans("UPS", "1Z999"), { ok: false, reason: "not-configured", carrier: "UPS" });

    // Configured but unimplemented must be loud, so nobody ships believing it works.
    process.env.GL_UPS_CLIENT_ID = "id"; process.env.GL_UPS_CLIENT_SECRET = "secret";
    await assert.rejects(() => fetchScans("UPS", "1Z999"), /not implemented/i);
  } finally {
    if (saved[0] === undefined) delete process.env.GL_UPS_CLIENT_ID; else process.env.GL_UPS_CLIENT_ID = saved[0];
    if (saved[1] === undefined) delete process.env.GL_UPS_CLIENT_SECRET; else process.env.GL_UPS_CLIENT_SECRET = saved[1];
  }
});

test("simulated tracking numbers look like each carrier's format", () => {
  assert.match(simulatedTracking("UPS"), /^1Z/);
  assert.match(simulatedTracking("FedEx"), /^\d{4} \d{4} \d{4}$/);
  assert.match(simulatedTracking("Dayton Freight"), /^PRO-/);
});

// ---------------------------------------------------------------------------
// Attempt throttling. Too loose and a password list runs unimpeded; too tight and
// a real person who mistyped is locked out of their own account.
// ---------------------------------------------------------------------------
const T0 = 1_700_000_000_000;

test("a fresh caller is allowed, and failures accumulate within the window", () => {
  assert.equal(evaluate(null, T0).allowed, true);
  let rec = null;
  for (let i = 1; i < 6; i++) {
    rec = afterFailure(rec, T0);
    assert.equal(rec.fails, i);
    assert.equal(evaluate(rec, T0).allowed, true, "locked after only " + i + " failures");
  }
  // The sixth trips it.
  rec = afterFailure(rec, T0);
  const gate = evaluate(rec, T0);
  assert.equal(gate.allowed, false);
  assert.ok(gate.retryAfter > 0 && gate.retryAfter <= 900, "retryAfter out of range: " + gate.retryAfter);
});

test("a lock expires on its own, and comes back with a full allowance", () => {
  let rec = null;
  for (let i = 0; i < 6; i++) rec = afterFailure(rec, T0);
  assert.equal(evaluate(rec, T0).allowed, false);

  // After the lock, allowed again.
  const later = T0 + 15 * 60 * 1000 + 1;
  assert.equal(evaluate(rec, later).allowed, true);
  // And one more failure must not immediately re-lock, or a locked-out person would be
  // stuck in a loop of single-attempt lockouts.
  rec = afterFailure(rec, later);
  assert.equal(evaluate(rec, later).allowed, true, "one attempt after a lock re-locked the account");
});

test("failures outside the window are forgotten", () => {
  let rec = null;
  for (let i = 0; i < 5; i++) rec = afterFailure(rec, T0);
  // Someone who mistyped five times this morning starts clean this afternoon.
  const tomorrow = T0 + 24 * 60 * 60 * 1000;
  assert.equal(evaluate(rec, tomorrow).fails, 0);
  const fresh = afterFailure(rec, tomorrow);
  assert.equal(fresh.fails, 1, "an old window carried over");
});

test("delivered parcels are pruned from the announced record", () => {
  // Otherwise this single Blobs value, read and written on every ops push, grows by one
  // entry per shipment forever.
  const announced = {
    "GL-1": ["InTransit", "Delivered"],   // finished, nothing more can happen to it
    "GL-2": ["InTransit"],                // still moving
    "GL-3": ["PickedUp", "Delivered"],    // finished
  };
  const pruned = pruneAnnounced(announced);
  assert.deepEqual(Object.keys(pruned), ["GL-2"]);
  // Malformed input must not throw or wipe live entries.
  assert.deepEqual(pruneAnnounced({}), {});
  assert.deepEqual(pruneAnnounced(null), {});
  assert.deepEqual(pruneAnnounced({ "GL-4": "not-an-array" }), { "GL-4": "not-an-array" });
});

test("the announced record stays bounded even with nothing delivered", () => {
  const many = {};
  for (let i = 0; i < ANNOUNCED_LIMIT + 250; i++) many["GL-" + i] = ["InTransit"];
  const pruned = pruneAnnounced(many);
  assert.equal(Object.keys(pruned).length, ANNOUNCED_LIMIT);
  // Newest kept: losing an old entry means at worst a repeated notification.
  assert.ok(pruned["GL-" + (ANNOUNCED_LIMIT + 249)]);
});

test("the reset limit is tighter than the login limit", () => {
  // Mailing a stranger is the harm itself, so it gets fewer attempts than guessing.
  assert.ok(RESET_LIMITS.max < LOGIN_LIMITS.max);
  let rec = null;
  for (let i = 0; i < RESET_LIMITS.max; i++) rec = afterFailure(rec, T0, RESET_LIMITS);
  assert.equal(evaluate(rec, T0, RESET_LIMITS).allowed, false);
});

// ---------------------------------------------------------------------------
// Customer status notifications. The transition is detected by diffing what ops
// pushed against what was stored, so getting this wrong means either silence or
// mailing somebody every 1.5 seconds.
// ---------------------------------------------------------------------------
const cust = (id, status, email = "jane@x.com") => ({ id, status, customerEmail: email });

test("detectStatusChanges finds a customer parcel that moved", () => {
  const c = detectStatusChanges([cust("GL-1", "PickedUp")], [cust("GL-1", "InTransit")]);
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].id, c[0].from, c[0].to, c[0].email], ["GL-1", "PickedUp", "InTransit", "jane@x.com"]);
});

test("detectStatusChanges stays silent when nothing moved", () => {
  // This is the common case: ops pushes the same state every 1.5 seconds.
  assert.deepEqual(detectStatusChanges([cust("GL-1", "InTransit")], [cust("GL-1", "InTransit")]), []);
  assert.deepEqual(detectStatusChanges([], []), []);
  assert.deepEqual(detectStatusChanges(null, null), []);
});

test("detectStatusChanges ignores stages a customer should not be mailed about", () => {
  // Internal choreography, and the confirmation they already saw on screen.
  assert.deepEqual(detectStatusChanges([cust("GL-1", "Won")], [cust("GL-1", "Intake")]), []);
  assert.deepEqual(detectStatusChanges([cust("GL-1", "PickedUp")], [cust("GL-1", "Staged")]), []);
  assert.deepEqual(detectStatusChanges([cust("GL-1", "Intake")], [cust("GL-1", "Won")]), []);
  assert.equal(detectStatusChanges([cust("GL-1", "Staged")], [cust("GL-1", "OutforDelivery")]).length, 1);
});

test("detectStatusChanges has nobody to tell about ops' own packages", () => {
  assert.deepEqual(detectStatusChanges([{ id: "GL-9", status: "PickedUp" }], [{ id: "GL-9", status: "Delivered" }]), []);
});

test("a package appearing already in flight is not treated as a transition", () => {
  // An import or a first sync must not mail a backlog of updates.
  assert.deepEqual(detectStatusChanges([], [cust("GL-5", "Delivered")]), []);
});

test("unannounced drops stages already sent, per stage not per parcel", () => {
  const changes = [
    { id: "GL-1", to: "InTransit" }, { id: "GL-2", to: "Delivered" },
  ];
  const announced = { "GL-1": ["InTransit"], "GL-2": ["InTransit"] };
  const left = unannounced(changes, announced);
  // GL-1's InTransit was already sent; GL-2 reaching Delivered is new even though an
  // earlier stage of the same parcel was announced.
  assert.deepEqual(left.map((c) => c.id), ["GL-2"]);
  assert.deepEqual(unannounced(changes, {}).map((c) => c.id), ["GL-1", "GL-2"]);
  assert.deepEqual(unannounced([], announced), []);
});

test("the status email names the parcel and links to public tracking only", () => {
  const m = statusEmail({ id: "GL-1041", item: { description: "LG OLED TV" }, customer: { name: "Jane Doe", address: "742 Birchwood Ln", phone: "555-0100" }, promisedTs: Date.UTC(2026, 7, 20) }, "out for delivery");
  assert.match(m.subject, /GL-1041/);
  assert.match(m.text, /out for delivery/);
  assert.match(m.html, /track\.html\?n=GL-1041/);
  assert.match(m.text, /Hi Jane,/);
  // The address and phone must not travel in an email that will sit in an inbox.
  ["742 Birchwood Ln", "555-0100"].forEach((secret) => {
    assert.ok(!m.html.includes(secret), "status email leaked " + secret);
    assert.ok(!m.text.includes(secret), "status email leaked " + secret);
  });
});

test("the status email survives a sparse package", () => {
  const m = statusEmail({ id: "GL-2" }, "delivered");
  assert.match(m.subject, /GL-2/);
  assert.match(m.text, /Hi there,/);
  assert.ok(!/undefined|NaN|Invalid Date/.test(m.html + m.text), "placeholder leaked into the email");
});

// ---------------------------------------------------------------------------
// Order rate limiting. Too strict blocks a real customer; too loose lets one
// account fill the shared ops queue.
// ---------------------------------------------------------------------------
const NOW = 1_700_000_000_000;
const at = (ms) => ({ createdAt: NOW - ms });

test("orderRateLimit allows normal ordering", () => {
  assert.equal(orderRateLimit([], NOW).limited, false);
  // Two in the last minute is under the burst cap of 3.
  assert.equal(orderRateLimit([at(1000), at(20_000)], NOW).limited, false);
  // Eleven spread across the hour is under the hourly cap of 12.
  const spread = Array.from({ length: 11 }, (_, i) => at((i + 1) * 5 * 60_000));
  assert.equal(orderRateLimit(spread, NOW).limited, false);
});

test("orderRateLimit blocks a burst and says when to retry", () => {
  const burst = [at(1000), at(2000), at(3000)];
  const r = orderRateLimit(burst, NOW);
  assert.equal(r.limited, true);
  // The oldest is 3s into a 60s window, so ~57s until a slot frees.
  assert.equal(r.retryAfter, 57);
  assert.match(r.error, /3 orders in the last minute/);
});

test("orderRateLimit blocks the hourly ceiling even when spread out", () => {
  // 12 orders evenly spread: no 3 within any minute, so only the hour rule can catch it.
  const spread = Array.from({ length: 12 }, (_, i) => at((i + 1) * 4 * 60_000));
  const r = orderRateLimit(spread, NOW);
  assert.equal(r.limited, true);
  assert.match(r.error, /in the last hour/);
  assert.ok(r.retryAfter > 0 && r.retryAfter <= 3600, "retryAfter should be inside the window");
});

test("orderRateLimit ignores orders that have aged out of the window", () => {
  const old = Array.from({ length: 30 }, (_, i) => at(60 * 60_000 + (i + 1) * 1000));
  assert.equal(orderRateLimit(old, NOW).limited, false, "orders older than an hour must not count");
});

test("orderCreatedAt falls back to the first history entry, then to zero", () => {
  assert.equal(orderCreatedAt({ createdAt: 123 }), 123);
  assert.equal(orderCreatedAt({ history: [{ stage: "Won", ts: 456 }] }), 456);
  // An order with neither must not read as "created now" and consume quota.
  assert.equal(orderCreatedAt({}), 0);
  assert.equal(orderCreatedAt(null), 0);
  assert.equal(orderRateLimit([{}, {}, {}, {}, {}], NOW).limited, false);
});

test("the burst window is tighter than the hourly one", () => {
  // A limit list sorted the other way would report the wrong reason first.
  const [burst, hourly] = ORDER_LIMITS;
  assert.ok(burst.ms < hourly.ms);
  assert.ok(burst.max < hourly.max);
});

// ---------------------------------------------------------------------------
// Brevo needs the sender as {name, email}, so GL_MAIL_FROM has to be split.
// Getting this wrong means every reset email is rejected at send time.
// ---------------------------------------------------------------------------
test("parseSender splits a display-name sender", () => {
  assert.deepEqual(parseSender("Granite Logistics <no-reply@usegl.com>"),
    { name: "Granite Logistics", email: "no-reply@usegl.com" });
  // Quoted display name, and stray whitespace.
  assert.deepEqual(parseSender('  "Granite Logistics"  <  no-reply@usegl.com  >  '),
    { name: "Granite Logistics", email: "no-reply@usegl.com" });
});

test("parseSender accepts a bare address and degrades safely", () => {
  assert.deepEqual(parseSender("no-reply@usegl.com"), { email: "no-reply@usegl.com" });
  assert.deepEqual(parseSender("  no-reply@usegl.com  "), { email: "no-reply@usegl.com" });
  // Angle brackets with no display name must not produce name:"".
  assert.deepEqual(parseSender("<no-reply@usegl.com>"), { name: undefined, email: "no-reply@usegl.com" });
  assert.deepEqual(parseSender(""), { email: "" });
  assert.deepEqual(parseSender(undefined), { email: "" });
});

test("Viewer is an ops role but not a writing one", () => {
  assert.ok(OPS_ROLES.includes("Viewer"));
  assert.ok(!WRITE_ROLES.includes("Viewer"));
  assert.ok(!OPS_ROLES.includes("Customer"), "Customer must never reach the ops workspace");
  WRITE_ROLES.forEach((r) => assert.ok(OPS_ROLES.includes(r), r + " can write but is not an ops role"));
});

// ---------------------------------------------------------------------------
// Webhook order shape.
// ---------------------------------------------------------------------------
test("makeOrder produces a well-formed package", () => {
  const o = makeOrder({ name: " Jane ", item: " TV ", value: "250", city: "dayton", state: "oh", zip: "45402" }, { packages: [] });
  assert.equal(o.id, "GL-1041");
  assert.equal(o.barcode, "GL1041");
  assert.equal(o.customer.name, "Jane");          // trimmed
  assert.equal(o.customer.state, "OH");           // upper-cased
  assert.equal(o.item.value, 250);                // coerced to a number
  assert.equal(o.status, "Won");
  assert.equal(o.history.length, 1);
  assert.ok(o.promisedTs > Date.now());
});

test("makeOrder defends against missing and negative values", () => {
  const o = makeOrder({}, { packages: [] });
  assert.equal(o.item.description, "Item");
  assert.equal(o.item.value, 0);
  assert.ok(o.item.weight >= 1);
  const neg = makeOrder({ value: "-99" }, { packages: [] });
  assert.equal(neg.item.value, 0); // never negative
});

test("EMPTY state has every collection the app expects", () => {
  for (const k of ["packages", "manifests", "loadUnits", "events", "settings"]) {
    assert.ok(k in EMPTY, "missing " + k);
  }
});

// ---------------------------------------------------------------------------
// Public tracking view. /api/track is unauthenticated and tracking numbers are
// sequential, so anything leaking through here is world-readable.
// ---------------------------------------------------------------------------
const fullPkg = () => ({
  id: "GL-1041", barcode: "GL1041", status: "InTransit", carrier: "UPS", lane: "Lane 2",
  tracking: "1Z999AA10123456784", promisedTs: 1893456000000, batchId: "BATCH-701",
  customer: { name: "Jane Doe", address: "742 Birchwood Ln", city: "Columbus", state: "OH", zip: "43004", phone: "(614) 555-0142" },
  item: { description: "Samsung 65in QLED TV", value: 1400, weight: 30 },
  customerEmail: "jane@example.com",
  history: [{ stage: "Won", ts: 1, note: "Order placed by customer." }, { stage: "InTransit", ts: 2, note: "internal ops note" }],
  exception: { type: "Address Issue", note: "Suite number missing, courier follow-up requested" },
  photos: { pickup: "data:image/png;base64,AAAA", delivery: "data:image/png;base64,BBBB" },
});

test("public tracking view exposes only carrier-grade fields", () => {
  const v = publicTrackingView(fullPkg());
  assert.deepEqual(Object.keys(v).sort(),
    ["barcode", "carrier", "destination", "exception", "history", "id", "promisedTs", "status", "tracking"]);
  assert.equal(v.id, "GL-1041");
  assert.equal(v.status, "InTransit");
  assert.equal(v.tracking, "1Z999AA10123456784");
  assert.deepEqual(v.destination, { city: "Columbus", state: "OH" });
});

test("public tracking view leaks no recipient details, contents, or photos", () => {
  const blob = JSON.stringify(publicTrackingView(fullPkg()));
  for (const secret of [
    "Jane Doe", "742 Birchwood Ln", "43004", "555-0142",   // recipient identity
    "jane@example.com",                                     // account
    "QLED", "1400",                                         // contents and declared value
    "base64", "Lane 2", "BATCH-701",                        // photos and internal routing
    "Suite number missing", "internal ops note",            // internal notes
  ]) {
    assert.ok(!blob.includes(secret), "public view leaked: " + secret);
  }
});

test("public tracking view keeps stage timings but drops per-stage notes", () => {
  const v = publicTrackingView(fullPkg());
  assert.equal(v.history.length, 2);
  assert.deepEqual(v.history[0], { stage: "Won", ts: 1 });
  assert.ok(!("note" in v.history[0]));
});

test("public tracking view reports an exception type without its note", () => {
  const v = publicTrackingView(fullPkg());
  assert.deepEqual(v.exception, { type: "Address Issue" });
});

test("public tracking view tolerates sparse packages", () => {
  assert.equal(publicTrackingView(null), null);
  const v = publicTrackingView({ id: "GL-1", status: "Won" });
  assert.equal(v.carrier, null);
  assert.equal(v.exception, null);
  assert.equal(v.destination, null);
  assert.deepEqual(v.history, []);
});

// ---------------------------------------------------------------------------
// Email. Must degrade cleanly when no provider key is configured.
// ---------------------------------------------------------------------------
test("email reports not-configured without provider keys", async () => {
  assert.equal(emailConfigured(), false);
  const r = await sendEmail({ to: "a@b.com", subject: "x", html: "y" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-configured");
});

test("sendEmail posts the shape Brevo expects", async () => {
  const saved = { key: process.env.GL_BREVO_KEY, from: process.env.GL_MAIL_FROM, fetch: globalThis.fetch };
  process.env.GL_BREVO_KEY = "xkeysib-test";
  process.env.GL_MAIL_FROM = "Granite Logistics <no-reply@usegl.com>";
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response("{}", { status: 201 });
  };
  try {
    const r = await sendEmail({ to: "jane@example.com", subject: "Reset", html: "<b>hi</b>", text: "hi" });
    assert.equal(r.ok, true);
    assert.equal(seen.url, "https://api.brevo.com/v3/smtp/email");
    // Brevo authenticates with an api-key header, not a Bearer token.
    assert.equal(seen.init.headers["api-key"], "xkeysib-test");
    assert.ok(!("Authorization" in seen.init.headers));
    // Field names are Brevo's, not Resend's: sender/to[].email/htmlContent/textContent.
    assert.deepEqual(seen.body.sender, { name: "Granite Logistics", email: "no-reply@usegl.com" });
    assert.deepEqual(seen.body.to, [{ email: "jane@example.com" }]);
    assert.equal(seen.body.htmlContent, "<b>hi</b>");
    assert.equal(seen.body.textContent, "hi");
    assert.equal(seen.body.subject, "Reset");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.GL_BREVO_KEY; else process.env.GL_BREVO_KEY = saved.key;
    if (saved.from === undefined) delete process.env.GL_MAIL_FROM; else process.env.GL_MAIL_FROM = saved.from;
  }
});

test("sendEmail reports a provider rejection instead of throwing", async () => {
  const saved = { key: process.env.GL_BREVO_KEY, from: process.env.GL_MAIL_FROM, fetch: globalThis.fetch };
  process.env.GL_BREVO_KEY = "xkeysib-test";
  process.env.GL_MAIL_FROM = "no-reply@usegl.com";
  globalThis.fetch = async () => new Response('{"message":"sender not verified"}', { status: 400 });
  try {
    const r = await sendEmail({ to: "a@b.com", subject: "x", html: "y" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "send-failed");
    assert.equal(r.status, 400);
    assert.match(r.detail, /sender not verified/);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.GL_BREVO_KEY; else process.env.GL_BREVO_KEY = saved.key;
    if (saved.from === undefined) delete process.env.GL_MAIL_FROM; else process.env.GL_MAIL_FROM = saved.from;
  }
});

test("the reset email includes the link and no stray em dashes", () => {
  const m = resetEmail("Jane Doe", "https://usegl.com/app.html?reset=tok");
  assert.ok(m.subject.length > 0);
  assert.ok(m.html.includes("https://usegl.com/app.html?reset=tok"));
  assert.ok(m.text.includes("https://usegl.com/app.html?reset=tok"));
  assert.ok(m.html.includes("Jane"));   // greets by first name
  assert.ok(!m.html.includes("Doe"));   // not the full name
  assert.ok(!/—/.test(m.html + m.text + m.subject));
});

// ---- Supabase migration transform ----
//
// Emits SQL, so quoting is the thing that matters: everything it writes came out of a
// user-entered JSON export. Also checks photos really leave the record as files, which is
// the point of the exercise.
test("the migration transform quotes its input and extracts photos as files", async () => {
  const { transform } = await import("../scripts/migrate-to-supabase.mjs");
  const out = mkdtempSync(join(tmpdir(), "gl-mig-"));
  // a 34-byte valid WebP
  const webp = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4TBUAAAAvAAAAEAcQERGIiP4HAA==";

  const res = transform({
    packages: [{
      id: "GL-1041", status: "Delivered", source: "Customer Order",
      // an apostrophe in every string field a person can type into
      item: { description: "O'Brien's 55\" TV", value: 1290 },
      customer: { name: "D'Angelo O'Hara", address: "1 O'Connell St", city: "Dayton" },
      customerEmail: "Mixed.Case@Example.com",
      photos: { pickup: webp, delivery: webp },
      history: [{ stage: "Won", ts: 1700000000000, note: "it's here" }, { stage: "Delivered", ts: 1700000100000 }],
    }],
    manifests: [{ id: "BATCH-701", carrier: "UPS", lane: "Lane 2", ts: 1700000000000 }],
    loadUnits: [],
  }, out, "default");

  // Every apostrophe doubled, and none left single anywhere in the emitted SQL.
  assert.match(res.sql, /O''Brien''s/);
  assert.match(res.sql, /D''Angelo O''Hara/);
  assert.match(res.sql, /it''s here/);
  const unbalanced = (res.sql.match(/'/g) || []).length % 2;
  assert.equal(unbalanced, 0, "quotes should balance, so no literal is left open");

  // Photos are out of the record and on disk as real images, with the row pointing at a path.
  assert.equal(res.counts.photos, 2);
  assert.match(res.sql, /'default\/GL-1041\/pickup\.webp'/);
  const file = join(out, "photos", "default", "GL-1041", "delivery.webp");
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString(), "WEBP");

  // History becomes rows, and the email is normalised for the account list.
  assert.equal(res.counts.events, 2);
  assert.equal(res.accounts.length, 1);
  assert.equal(res.accounts[0].email, "mixed.case@example.com");

  rmSync(out, { recursive: true, force: true });
});

// ---- the tenant for requests that carry no api key ----
test("soloTenant agrees with the key-resolved tenant when there is only one", async () => {
  const { soloTenant } = await import("../netlify/functions/_lib.mjs");
  const saved = process.env.GL_TENANTS;
  try {
    // Unconfigured: the demo keys all sit under "default".
    delete process.env.GL_TENANTS;
    assert.equal(soloTenant(), "default");

    // One tenant under several keys is unambiguous, and used to be the case that broke:
    // state.mjs wrote to "acme" while customer orders and public tracking read "default".
    process.env.GL_TENANTS = JSON.stringify({ live: "acme", backup: "acme" });
    assert.equal(soloTenant(), "acme");

    // Genuinely multi-tenant cannot be resolved from a keyless request.
    process.env.GL_TENANTS = JSON.stringify({ a: "acme", g: "globex" });
    assert.equal(soloTenant(), "default");

    // Malformed config must not throw here; resolveKey already treats it as unset.
    process.env.GL_TENANTS = "{not json";
    assert.equal(soloTenant(), "default");
  } finally {
    if (saved === undefined) delete process.env.GL_TENANTS; else process.env.GL_TENANTS = saved;
  }
});
