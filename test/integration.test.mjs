// End-to-end tests against the REAL Netlify Function handlers.
//
// @netlify/blobs is swapped for an in-memory store, so these exercise the actual
// request/response code (auth, customer orders, workspace sync, public tracking)
// rather than reimplementations. That covers the thing unit tests can't: whether the
// pieces genuinely fit together, in particular that a customer order reaches the ops
// queue and an ops status change reaches the customer.
//
// Requires --experimental-test-module-mocks (see the npm test script).
import { test, before, mock } from "node:test";
import assert from "node:assert/strict";

// ---- in-memory stand-in for Netlify Blobs ----
const blobs = new Map(); // "store\u0000key" -> serialized value
const k = (store, key) => store + "\u0000" + key;
function getStore({ name }) {
  return {
    async get(key, opts) {
      const raw = blobs.get(k(name, key));
      if (raw === undefined) return null;
      return opts && opts.type === "json" ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) { blobs.set(k(name, key), JSON.stringify(value)); },
    async set(key, value) { blobs.set(k(name, key), String(value)); },
    async delete(key) { blobs.delete(k(name, key)); },
  };
}

let authFn, ordersFn, stateFn, trackFn, sign;
// Tokens for the operator-granted ops accounts. /api/state authorizes by role now, not by
// the public demo key, so these tests have to sign in the way a real ops user does.
let adminToken, viewerToken;

const ADMIN_EMAIL = "ops-admin@example.com";
const VIEWER_EMAIL = "ops-viewer@example.com";

before(async () => {
  // Roles come from the operator config only. Set before any handler runs.
  process.env.GL_ADMIN_EMAILS = ADMIN_EMAIL;
  process.env.GL_ROLES = JSON.stringify({ [VIEWER_EMAIL]: "Viewer" });

  mock.module("@netlify/blobs", { exports: { getStore } });
  authFn = (await import("../netlify/functions/auth.mjs")).default;
  ordersFn = (await import("../netlify/functions/my-orders.mjs")).default;
  stateFn = (await import("../netlify/functions/state.mjs")).default;
  trackFn = (await import("../netlify/functions/track.mjs")).default;
  sign = (await import("../netlify/functions/_auth.mjs")).sign;

  adminToken = await register(ADMIN_EMAIL, "pass1234", "Ops Admin");
  viewerToken = await register(VIEWER_EMAIL, "pass1234", "Ops Viewer");
});

// ---- request helpers ----
const OPS_KEY = "granite-dev-key"; // a public demo key: valid for ingest, not for /api/state
const post = (body) => new Request("https://x/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const asUser = (token, init = {}) => new Request("https://x/api/my-orders" + (init.qs || ""), {
  method: init.method || "GET",
  headers: Object.assign({ authorization: "Bearer " + token }, init.body ? { "content-type": "application/json" } : {}),
  body: init.body ? JSON.stringify(init.body) : undefined,
});
// A workspace request. Defaults to the Admin session; pass {token} or {key} to vary it.
const stateReq = (init = {}) => {
  const headers = {};
  if (init.key) headers["x-api-key"] = init.key;
  const token = init.token === undefined ? adminToken : init.token;
  if (token) headers.authorization = "Bearer " + token;
  if (init.body) headers["content-type"] = "application/json";
  return new Request("https://x/api/state", {
    method: init.method || "GET",
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
};
const asOps = stateReq;
const body = async (res) => await res.json();

async function register(email, pw = "pass1234", name = "Test User") {
  const res = await authFn(post({ action: "register", email, pw, name }));
  const j = await body(res);
  assert.equal(j.ok, true, "register failed: " + JSON.stringify(j));
  return j.token;
}

test("a customer order reaches the ops queue, and an ops status change reaches the customer", async () => {
  const token = await register("loop@example.com");

  // 1. Customer places an order.
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "LG OLED TV", name: "Jane", city: "Dayton", state: "oh" } })));
  assert.equal(placed.ok, true);
  const id = placed.order.id;
  assert.equal(placed.order.customerEmail, "loop@example.com");

  // 2. Ops reads the shared workspace and sees that exact package. This is the join
  //    that used to be missing entirely (two separate stores).
  const opsView = await body(await stateFn(asOps()));
  const seen = opsView.packages.find((p) => p.id === id);
  assert.ok(seen, "ops cannot see the customer order");
  assert.equal(seen.source, "Customer Order");

  // 3. Ops advances it and pushes the workspace back.
  seen.status = "InTransit";
  seen.history.push({ stage: "InTransit", ts: Date.now(), note: "Carrier scan" });
  const pushed = await body(await stateFn(asOps({ method: "PUT", body: opsView })));
  assert.equal(pushed.ok, true);

  // 4. The customer sees the new status. Loop closed.
  const mine = await body(await ordersFn(asUser(token)));
  assert.equal(mine.orders.length, 1);
  assert.equal(mine.orders[0].status, "InTransit");
});

test("a stale ops push does not delete an order placed since that client last pulled", async () => {
  const token = await register("stale@example.com");
  await ordersFn(asUser(token, { method: "POST", body: { item: "Order A" } }));

  // Ops pulls a snapshot...
  const snapshot = await body(await stateFn(asOps()));
  const countAtPull = snapshot.packages.length;

  // ...then the customer places another order before ops pushes.
  const later = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Order B" } })));
  const laterId = later.order.id;

  // Ops pushes its now-stale snapshot, which knows nothing about Order B.
  await stateFn(asOps({ method: "PUT", body: snapshot }));

  const after = await body(await stateFn(asOps()));
  assert.ok(after.packages.find((p) => p.id === laterId), "the newer customer order was destroyed by a stale push");
  assert.equal(after.packages.length, countAtPull + 1);
});

test("an ops deletion of a customer order sticks when tombstoned", async () => {
  const token = await register("tombstone@example.com");
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Doomed" } })));
  const id = placed.order.id;

  const snapshot = await body(await stateFn(asOps()));
  snapshot.packages = snapshot.packages.filter((p) => p.id !== id);
  snapshot.deleted = [{ id, ts: Date.now() }];
  await stateFn(asOps({ method: "PUT", body: snapshot }));

  const after = await body(await stateFn(asOps()));
  assert.ok(!after.packages.find((p) => p.id === id), "tombstoned order came back");
});

test("customers only ever see their own orders", async () => {
  const a = await register("a-iso@example.com");
  const b = await register("b-iso@example.com");
  await ordersFn(asUser(a, { method: "POST", body: { item: "A's parcel" } }));

  const bOrders = await body(await ordersFn(asUser(b)));
  assert.deepEqual(bOrders.orders, []);

  const aOrders = await body(await ordersFn(asUser(a)));
  assert.equal(aOrders.orders.length, 1);
  assert.equal(aOrders.orders[0].item.description, "A's parcel");
});

test("orders are numbered uniquely across the whole shared workspace", async () => {
  const a = await register("seq-a@example.com");
  const b = await register("seq-b@example.com");
  const r1 = await body(await ordersFn(asUser(a, { method: "POST", body: { item: "one" } })));
  const r2 = await body(await ordersFn(asUser(b, { method: "POST", body: { item: "two" } })));
  const r3 = await body(await ordersFn(asUser(a, { method: "POST", body: { item: "three" } })));
  const ids = [r1.order.id, r2.order.id, r3.order.id];
  assert.equal(new Set(ids).size, 3, "duplicate ids handed out: " + ids.join(","));
});

test("a customer can cancel before pickup, but not once it is moving", async () => {
  const token = await register("cancel@example.com");
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Cancel me" } })));
  const id = placed.order.id;

  const gone = await body(await ordersFn(asUser(token, { method: "DELETE", qs: "?id=" + id })));
  assert.equal(gone.ok, true);
  assert.equal(gone.orders.length, 0);

  // Place another, let ops move it, then try to cancel.
  const second = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Already shipping" } })));
  const snapshot = await body(await stateFn(asOps()));
  snapshot.packages.find((p) => p.id === second.order.id).status = "InTransit";
  await stateFn(asOps({ method: "PUT", body: snapshot }));

  const res = await ordersFn(asUser(token, { method: "DELETE", qs: "?id=" + second.order.id }));
  assert.equal(res.status, 409);
  const j = await body(res);
  assert.match(j.error, /no longer be cancelled/i);
});

test("one customer cannot cancel another customer's order", async () => {
  const owner = await register("owner@example.com");
  const attacker = await register("attacker@example.com");
  const placed = await body(await ordersFn(asUser(owner, { method: "POST", body: { item: "Not yours" } })));

  const res = await ordersFn(asUser(attacker, { method: "DELETE", qs: "?id=" + placed.order.id }));
  assert.equal(res.status, 404, "cross-account cancellation was permitted");

  const still = await body(await ordersFn(asUser(owner)));
  assert.equal(still.orders.length, 1);
});

test("customer order endpoints reject missing and forged tokens", async () => {
  const noTok = await ordersFn(new Request("https://x/api/my-orders"));
  assert.equal(noTok.status, 401);
  const forged = await ordersFn(new Request("https://x/api/my-orders", { headers: { authorization: "Bearer forged.token.here" } }));
  assert.equal(forged.status, 401);
});

test("workspace sync requires a known tenant key", async () => {
  const bad = await stateFn(new Request("https://x/api/state", { headers: { "x-api-key": "not-a-key" } }));
  assert.equal(bad.status, 401);
  const none = await stateFn(new Request("https://x/api/state"));
  assert.equal(none.status, 401);
});

test("public tracking finds a real shipment and withholds private fields", async () => {
  const token = await register("track@example.com", "pass1234", "Jane Doe");
  const placed = await body(await ordersFn(asUser(token, {
    method: "POST",
    body: { item: "Secret Contents TV", value: 1400, name: "Jane Doe", address: "742 Birchwood Ln", city: "Columbus", state: "OH", zip: "43004" },
  })));
  const id = placed.order.id;

  const res = await trackFn(new Request("https://x/api/track?n=" + id));
  assert.equal(res.status, 200);
  const j = await body(res);
  assert.equal(j.shipment.id, id);
  assert.deepEqual(j.shipment.destination, { city: "Columbus", state: "OH" });

  const blob = JSON.stringify(j);
  for (const secret of ["Jane Doe", "742 Birchwood Ln", "43004", "Secret Contents TV", "1400", "track@example.com"]) {
    assert.ok(!blob.includes(secret), "public tracking leaked: " + secret);
  }
});

test("public tracking rejects a blank number and reports unknown ones", async () => {
  assert.equal((await trackFn(new Request("https://x/api/track"))).status, 400);
  assert.equal((await trackFn(new Request("https://x/api/track?n=GL-999999"))).status, 404);
});

test("registering twice with the same email is refused", async () => {
  await register("dupe@example.com");
  const res = await authFn(post({ action: "register", email: "dupe@example.com", pw: "pass1234" }));
  assert.equal(res.status, 409);
});

test("login rejects a wrong password and accepts the right one", async () => {
  await register("login@example.com", "correct-horse");
  assert.equal((await authFn(post({ action: "login", email: "login@example.com", pw: "wrong" }))).status, 401);
  const good = await body(await authFn(post({ action: "login", email: "login@example.com", pw: "correct-horse" })));
  assert.equal(good.ok, true);
  assert.ok(good.token);
});

test("a session validates, and a password change invalidates the old one", async () => {
  const token = await register("session@example.com");
  const okRes = await authFn(new Request("https://x/api/auth", { headers: { authorization: "Bearer " + token } }));
  assert.equal(okRes.status, 200);

  // Redeem a reset token (as the emailed link would) to set a new password.
  const resetToken = sign({ email: "session@example.com", kind: "reset", exp: Date.now() + 60000 });
  const changed = await body(await authFn(post({ action: "reset-confirm", token: resetToken, pw: "brand-new-pw" })));
  assert.equal(changed.ok, true, "reset-confirm failed: " + JSON.stringify(changed));

  // The pre-change session is now dead; the freshly issued one works.
  const staleRes = await authFn(new Request("https://x/api/auth", { headers: { authorization: "Bearer " + token } }));
  assert.equal(staleRes.status, 401);
  const freshRes = await authFn(new Request("https://x/api/auth", { headers: { authorization: "Bearer " + changed.token } }));
  assert.equal(freshRes.status, 200);

  // And the new password is the one that works.
  assert.equal((await authFn(post({ action: "login", email: "session@example.com", pw: "pass1234" }))).status, 401);
  assert.equal((await authFn(post({ action: "login", email: "session@example.com", pw: "brand-new-pw" }))).status, 200);
});

test("a reset token cannot be used as a session, and a session cannot reset a password", async () => {
  const token = await register("kinds@example.com");
  const resetToken = sign({ email: "kinds@example.com", kind: "reset", exp: Date.now() + 60000 });

  // reset token presented as a session
  assert.equal((await authFn(new Request("https://x/api/auth", { headers: { authorization: "Bearer " + resetToken } }))).status, 401);
  // session token presented as a reset
  assert.equal((await authFn(post({ action: "reset-confirm", token, pw: "hijacked" }))).status, 400);
});

test("expired reset links are refused", async () => {
  await register("expired@example.com");
  const stale = sign({ email: "expired@example.com", kind: "reset", exp: Date.now() - 1000 });
  assert.equal((await authFn(post({ action: "reset-confirm", token: stale, pw: "whatever" }))).status, 400);
});

test("reset requests report clearly when email is not configured", async () => {
  await register("noemail@example.com");
  const res = await authFn(post({ action: "reset-request", email: "noemail@example.com" }));
  assert.equal(res.status, 503);
  const j = await body(res);
  assert.match(j.error, /isn't set up/i);
});

test("legacy per-customer orders are migrated into the shared workspace", async () => {
  const token = await register("legacy@example.com");
  // Seed the old store the way an earlier build would have.
  blobs.set(k("granite-customer-orders", "legacy@example.com"), JSON.stringify([
    { id: "GL-8001", status: "Won", item: { description: "Old order" }, customer: { city: "Dayton", state: "OH" }, history: [{ stage: "Won", ts: 1 }] },
  ]));

  const mine = await body(await ordersFn(asUser(token)));
  assert.ok(mine.orders.find((o) => o.id === "GL-8001"), "legacy order was lost");

  // Ops sees it too, and the legacy record is cleared so it can't be re-imported.
  const opsView = await body(await stateFn(asOps()));
  assert.ok(opsView.packages.find((p) => p.id === "GL-8001"));
  assert.equal(blobs.get(k("granite-customer-orders", "legacy@example.com")), undefined);
});

// ---- order rate limiting ----

test("a burst of orders is refused with 429 and a Retry-After header", async () => {
  const token = await register("burst@example.com");
  const place = () => ordersFn(asUser(token, { method: "POST", body: { item: "Spam" } }));

  // The burst cap is 3 per minute; the first three must succeed.
  for (let i = 0; i < 3; i++) {
    const ok = await body(await place());
    assert.equal(ok.ok, true, "order " + (i + 1) + " should have been accepted");
  }

  const res = await place();
  assert.equal(res.status, 429);
  const retry = Number(res.headers.get("Retry-After"));
  assert.ok(retry > 0 && retry <= 60, "Retry-After should be within the burst window, got " + retry);
  const j = await body(res);
  assert.equal(j.ok, false);
  assert.match(j.error, /orders in the last minute/);

  // The refused order must not have reached the shared workspace.
  const opsView = await body(await stateFn(asOps()));
  assert.equal(opsView.packages.filter((p) => p.customerEmail === "burst@example.com").length, 3);
});

test("rate limiting is per account, not global", async () => {
  const a = await register("rl-a@example.com");
  const b = await register("rl-b@example.com");
  for (let i = 0; i < 3; i++) await ordersFn(asUser(a, { method: "POST", body: { item: "A" } }));
  assert.equal((await ordersFn(asUser(a, { method: "POST", body: { item: "A" } }))).status, 429);

  // B has its own budget and must be unaffected by A hitting the cap.
  const bRes = await ordersFn(asUser(b, { method: "POST", body: { item: "B" } }));
  assert.equal(bRes.status, 200);
});

test("rate limiting does not block reads or cancellations", async () => {
  const token = await register("rl-read@example.com");
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const j = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Item " + i } })));
    ids.push(j.order.id);
  }
  assert.equal((await ordersFn(asUser(token, { method: "POST", body: { item: "over" } }))).status, 429);

  // A capped account can still see and cancel what it has.
  const mine = await body(await ordersFn(asUser(token)));
  assert.equal(mine.orders.length, 3);
  const del = await ordersFn(asUser(token, { method: "DELETE", qs: "?id=" + ids[0] }));
  assert.equal(del.status, 200);
});

// ---- authorization on the ops workspace ----
//
// /api/state exposes every recipient's name, address and phone in the tenant. It used to
// be guarded by a single api key that shipped inside the client bundle, so any customer
// could read the entire workspace. These tests pin the fix.

test("a customer's session cannot read or write the ops workspace", async () => {
  const token = await register("nosy@example.com");

  const read = await stateFn(stateReq({ token }));
  assert.equal(read.status, 403, "a customer could read the whole workspace");

  const write = await stateFn(stateReq({ token, method: "PUT", body: { packages: [] } }));
  assert.equal(write.status, 403, "a customer could overwrite the whole workspace");
});

test("the public demo api key cannot read the ops workspace", async () => {
  // Valid enough for /api/orders ingest, but it is published, so it must not read.
  const res = await stateFn(stateReq({ token: null, key: OPS_KEY }));
  assert.equal(res.status, 403);
  const j = await body(res);
  assert.match(j.hint, /demo api keys/);

  const write = await stateFn(stateReq({ token: null, key: OPS_KEY, method: "PUT", body: { packages: [] } }));
  assert.equal(write.status, 403);
});

test("an operator-configured api key still works for machine callers", async () => {
  process.env.GL_TENANTS = JSON.stringify({ "real-secret-key": "default" });
  try {
    const ok = await stateFn(stateReq({ token: null, key: "real-secret-key" }));
    assert.equal(ok.status, 200);
    // Configuring GL_TENANTS switches the public demo keys off entirely.
    const demo = await stateFn(stateReq({ token: null, key: OPS_KEY }));
    assert.equal(demo.status, 401);
  } finally {
    delete process.env.GL_TENANTS;
  }
});

test("the Viewer role can read the workspace but not change it", async () => {
  const read = await stateFn(stateReq({ token: viewerToken }));
  assert.equal(read.status, 200);

  const write = await stateFn(stateReq({ token: viewerToken, method: "PUT", body: { packages: [] } }));
  assert.equal(write.status, 403);
  assert.match((await body(write)).hint, /Viewer/);
});

test("registration cannot grant itself a role", async () => {
  // The old code took `role` straight from the request body, so this signed you up as Admin.
  const res = await authFn(post({ action: "register", email: "climber@example.com", pw: "pass1234", role: "Admin" }));
  const j = await body(res);
  assert.equal(j.ok, true);
  assert.equal(j.user.role, "Customer", "registration granted a self-requested role");

  const denied = await stateFn(stateReq({ token: j.token }));
  assert.equal(denied.status, 403);
});

test("login re-derives the role, revoking an ops role the operator never granted", async () => {
  const email = "planted@example.com";
  await register(email);

  // Simulate an account that got Admin through the old escalation hole.
  const stored = JSON.parse(blobs.get(k("granite-users", email)));
  blobs.set(k("granite-users", email), JSON.stringify({ ...stored, role: "Admin" }));

  const j = await body(await authFn(post({ action: "login", email, pw: "pass1234" })));
  assert.equal(j.ok, true);
  assert.equal(j.user.role, "Customer", "a planted Admin role survived login");
  assert.equal(JSON.parse(blobs.get(k("granite-users", email))).role, "Customer", "the stored role was not corrected");

  const denied = await stateFn(stateReq({ token: j.token }));
  assert.equal(denied.status, 403);
});

test("a granted ops role is picked up on the next login", async () => {
  const email = "promoted@example.com";
  await register(email);
  assert.equal((await stateFn(stateReq({ token: await register("promoted2@example.com") }))).status, 403);

  process.env.GL_ADMIN_EMAILS = ADMIN_EMAIL + "," + email;
  try {
    const j = await body(await authFn(post({ action: "login", email, pw: "pass1234" })));
    assert.equal(j.user.role, "Admin");
    assert.equal((await stateFn(stateReq({ token: j.token }))).status, 200);
  } finally {
    process.env.GL_ADMIN_EMAILS = ADMIN_EMAIL;
  }
});

test("a password-reset token cannot be used to reach the ops workspace", async () => {
  const resetish = sign({ email: ADMIN_EMAIL, kind: "reset", exp: Date.now() + 60000 });
  const res = await stateFn(stateReq({ token: resetish }));
  assert.equal(res.status, 401);
});
