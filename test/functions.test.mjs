// Regression tests for the pure logic behind the Netlify Functions.
//
// These cover the parts that are easy to get subtly wrong and expensive to get wrong
// in production: workspace merging (data loss), id allocation (duplicate tracking
// numbers), token handling (auth bypass), and tenant resolution (cross-tenant leaks).
// No network, no Blobs runtime, no browser. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergePushedPackages, nextId, tenantOf, resolveKey, makeOrder, EMPTY, publicTrackingView } from "../netlify/functions/_lib.mjs";
import { roleFor, OPS_ROLES, WRITE_ROLES } from "../netlify/functions/_auth.mjs";
import { sign, verifyToken, bearer, sessionSuperseded } from "../netlify/functions/_auth.mjs";
import { emailConfigured, sendEmail, resetEmail } from "../netlify/functions/_email.mjs";

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
test("roleFor grants Customer unless the operator says otherwise", () => {
  const saved = [process.env.GL_ADMIN_EMAILS, process.env.GL_ROLES];
  delete process.env.GL_ADMIN_EMAILS; delete process.env.GL_ROLES;
  try {
    assert.equal(roleFor("anyone@example.com"), "Customer");
    assert.equal(roleFor(""), "Customer");
    assert.equal(roleFor(undefined), "Customer");

    process.env.GL_ADMIN_EMAILS = " Boss@Example.com , other@example.com ";
    assert.equal(roleFor("boss@example.com"), "Admin", "email match must be trimmed and case-insensitive");
    assert.equal(roleFor("nobody@example.com"), "Customer");

    process.env.GL_ROLES = JSON.stringify({ "dave@example.com": "Runner", "eve@example.com": "Wizard" });
    assert.equal(roleFor("dave@example.com"), "Runner");
    // An unrecognised role name must not become a privilege.
    assert.equal(roleFor("eve@example.com"), "Customer");
  } finally {
    if (saved[0] === undefined) delete process.env.GL_ADMIN_EMAILS; else process.env.GL_ADMIN_EMAILS = saved[0];
    if (saved[1] === undefined) delete process.env.GL_ROLES; else process.env.GL_ROLES = saved[1];
  }
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

test("the reset email includes the link and no stray em dashes", () => {
  const m = resetEmail("Jane Doe", "https://usegl.com/app.html?reset=tok");
  assert.ok(m.subject.length > 0);
  assert.ok(m.html.includes("https://usegl.com/app.html?reset=tok"));
  assert.ok(m.text.includes("https://usegl.com/app.html?reset=tok"));
  assert.ok(m.html.includes("Jane"));   // greets by first name
  assert.ok(!m.html.includes("Doe"));   // not the full name
  assert.ok(!/—/.test(m.html + m.text + m.subject));
});
