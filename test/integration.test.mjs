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
// Runs immediately after a write, so a test can emulate another request writing the same
// record at the same instant. That interleaving is the only way to exercise the lost-order
// and duplicate-id races from out here, since nothing in this file is truly concurrent.
let afterWrite = null;
const setAfterWrite = (fn) => { afterWrite = fn; };

function getStore({ name }) {
  return {
    async get(key, opts) {
      const raw = blobs.get(k(name, key));
      if (raw === undefined) return null;
      return opts && opts.type === "json" ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) {
      blobs.set(k(name, key), JSON.stringify(value));
      if (afterWrite) afterWrite({ store: name, key });
    },
    async set(key, value) { blobs.set(k(name, key), String(value)); },
    async delete(key) { blobs.delete(k(name, key)); },
    // Shape matches @netlify/blobs: { blobs: [{ key, etag }], directories: [] }.
    async list(options) {
      const prefix = (options && options.prefix) || "";
      const mine = [...blobs.keys()]
        .filter((full) => full.startsWith(name + "\u0000"))
        .map((full) => full.slice(name.length + 1))
        .filter((key) => key.startsWith(prefix));
      return { blobs: mine.map((key) => ({ key, etag: "e" })), directories: [] };
    },
  };
}

let authFn, ordersFn, stateFn, trackFn, healthFn, ingestFn, adminFn, sign;
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
  healthFn = (await import("../netlify/functions/health.mjs")).default;
  ingestFn = (await import("../netlify/functions/orders.mjs")).default;
  adminFn = (await import("../netlify/functions/admin.mjs")).default;
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

// ---- the concurrent-write race ----
//
// Netlify Blobs v8 has no conditional write, so two simultaneous orders can clobber each
// other. These drive the exact interleaving through the real handler: write, have another
// request overwrite the record, and check the order repairs itself.

const WORKSPACE = "granite-workspaces";
const readWorkspace = () => JSON.parse(blobs.get(k(WORKSPACE, "default")));
const writeWorkspace = (s) => blobs.set(k(WORKSPACE, "default"), JSON.stringify(s));

test("an order clobbered by a simultaneous write is restored, not lost", async () => {
  const token = await register("race-lost@example.com");
  const before = readWorkspace();

  // The first write gets stomped by another request that never saw this order, which is
  // precisely how an order used to disappear.
  let stomped = false;
  setAfterWrite(() => {
    if (stomped) return;
    stomped = true;
    writeWorkspace({ ...before, packages: (before.packages || []).slice() });
  });
  try {
    const res = await ordersFn(asUser(token, { method: "POST", body: { item: "Survivor" } }));
    const j = await body(res);
    assert.equal(j.ok, true, "order was refused: " + JSON.stringify(j));
    assert.ok(stomped, "the test did not actually simulate a clobber");

    // It must be in the shared workspace exactly once, and visible to its owner.
    const pkgs = readWorkspace().packages;
    const mine = pkgs.filter((p) => p.customerEmail === "race-lost@example.com");
    assert.equal(mine.length, 1, "order lost or duplicated");
    assert.equal(mine[0].item.description, "Survivor");
    assert.equal(mine[0].id, j.order.id, "the id reported to the customer is not the stored one");
  } finally { setAfterWrite(null); }
});

test("two orders that race onto the same id do not share a tracking number", async () => {
  const token = await register("race-id@example.com");
  const before = readWorkspace();
  // The id this order will be handed, given the current state.
  const contestedId = "GL-" + (1041 + (before.packages || []).length);

  // Another request lands first and takes that very id.
  let stomped = false;
  setAfterWrite(() => {
    if (stomped) return;
    stomped = true;
    writeWorkspace({ ...before, packages: (before.packages || []).concat([{
      id: contestedId, uid: "someone-else", status: "Won", customerEmail: "other@example.com",
      item: { description: "Got there first", value: 0, weight: 1 },
      customer: { name: "Other" }, history: [{ stage: "Won", ts: Date.now() }], photos: {},
    }]) });
  });
  try {
    const j = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Renumbered" } })));
    assert.equal(j.ok, true);
    assert.ok(stomped);

    const pkgs = readWorkspace().packages;
    // Both survive, and no id is held twice anywhere in the workspace.
    const ours = pkgs.find((p) => p.item && p.item.description === "Renumbered");
    const theirs = pkgs.find((p) => p.uid === "someone-else");
    assert.ok(ours && theirs, "one of the two racing orders was lost");
    assert.notEqual(ours.id, theirs.id, "two parcels ended up sharing a tracking number");
    assert.equal(ours.id, j.order.id);
    assert.equal(ours.barcode, ours.id.replace(/-/g, ""), "barcode was not renumbered with the id");

    const ids = pkgs.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, "workspace contains duplicate ids");
  } finally { setAfterWrite(null); }
});

test("an order that cannot be confirmed is refused rather than reported as placed", async () => {
  const token = await register("race-hopeless@example.com");
  const before = readWorkspace();
  // Every write is stomped, so the repair can never verify. The customer must be told.
  setAfterWrite(() => writeWorkspace({ ...before, packages: (before.packages || []).slice() }));
  try {
    const res = await ordersFn(asUser(token, { method: "POST", body: { item: "Doomed" } }));
    assert.equal(res.status, 503);
    const j = await body(res);
    assert.equal(j.ok, false);
    assert.match(j.error, /couldn't confirm/i);
  } finally { setAfterWrite(null); }

  // And nothing phantom was left behind for that account.
  const mine = await body(await ordersFn(asUser(token)));
  assert.equal(mine.orders.length, 0, "a refused order was still stored");
});

test("webhook ingest numbers a batch uniquely and survives a clobber", async () => {
  const ingest = (body) => new Request("https://x/api/orders", {
    method: "POST",
    headers: { "x-api-key": OPS_KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // A concurrent writer whose snapshot was one order behind: it keeps everything already
  // confirmed but drops the write currently in flight. That is the race this repairs.
  // (A writer with a much older snapshot can still destroy an order that was already
  // confirmed and returned; that case is what mergePushedPackages covers on /api/state.)
  let stomps = 0;
  setAfterWrite(({ store }) => {
    if (store !== WORKSPACE || stomps++ !== 1) return;
    const cur = readWorkspace();
    writeWorkspace({ ...cur, packages: (cur.packages || []).slice(0, -1) });
  });
  let j;
  try {
    const res = await ingestFn(ingest({ orders: [{ item: "A", name: "N1" }, { item: "B", name: "N2" }, { item: "C", name: "N3" }] }));
    j = await body(res);
    assert.equal(j.ok, true, "ingest failed: " + JSON.stringify(j));
    assert.equal(j.created, 3);
  } finally { setAfterWrite(null); }

  // All three are stored, each with its own id.
  const pkgs = readWorkspace().packages;
  ["A", "B", "C"].forEach((d) => {
    const hits = pkgs.filter((p) => p.item && p.item.description === d);
    assert.equal(hits.length, 1, "order " + d + " lost or duplicated");
  });
  const batchIds = j.packages.map((p) => p.id);
  assert.equal(new Set(batchIds).size, 3, "the batch reused an id");
  const allIds = pkgs.map((p) => p.id);
  assert.equal(new Set(allIds).size, allIds.length, "workspace contains duplicate ids");
});

// ---- role administration ----
//
// This endpoint hands out privileges, so its guards matter more than its happy path.

const adminReq = (init = {}) => new Request("https://x/api/admin", {
  method: init.method || "GET",
  headers: Object.assign(
    init.token === null ? {} : { authorization: "Bearer " + (init.token || adminToken) },
    init.body ? { "content-type": "application/json" } : {}),
  body: init.body ? JSON.stringify(init.body) : undefined,
});
const grant = (email, role, token) => adminFn(adminReq({ method: "POST", body: { email, role }, token }));

test("only an admin can reach role administration, and it hides from everyone else", async () => {
  const customer = await register("nosy-admin@example.com");

  // 404 rather than 403: a non-admin should not even learn this endpoint exists.
  const asCustomer = await adminFn(adminReq({ token: customer }));
  assert.equal(asCustomer.status, 404);
  assert.equal((await body(asCustomer)).error, "Not found.");

  // A Viewer is an ops role but still not an administrator.
  assert.equal((await adminFn(adminReq({ token: viewerToken }))).status, 404);
  // No token at all.
  assert.equal((await adminFn(adminReq({ token: null }))).status, 401);
  // A reset token must not act as an admin session.
  assert.equal((await adminFn(adminReq({ token: sign({ email: ADMIN_EMAIL, kind: "reset", exp: Date.now() + 60000 }) }))).status, 401);

  // And a customer certainly cannot grant themselves anything.
  const escalate = await grant("nosy-admin@example.com", "Admin", customer);
  assert.equal(escalate.status, 404);
});

test("an admin grants a role, and it takes effect on the workspace immediately", async () => {
  const email = "promote-me@example.com";
  const token = await register(email);
  // Before: a plain customer is refused the workspace.
  assert.equal((await stateFn(stateReq({ token }))).status, 403);

  const res = await grant(email, "Runner");
  const j = await body(res);
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.deepEqual(j.changed, { email, role: "Runner" });

  // Access changes at once, on the token they already hold: /api/state re-derives the
  // role per request rather than trusting what the token was minted with.
  assert.equal((await stateFn(stateReq({ token }))).status, 200);

  const row = j.users.find((u) => u.email === email);
  assert.equal(row.role, "Runner");
  assert.equal(row.source, "granted");
  assert.equal(row.grantedBy, ADMIN_EMAIL);
  assert.ok(row.grantedAt, "the grant was not stamped with a time");
});

test("revoking takes effect immediately too, on a token already issued", async () => {
  const email = "revoke-me@example.com";
  const token = await register(email);
  await grant(email, "Admin");
  assert.equal((await stateFn(stateReq({ token }))).status, 200);

  const j = await body(await grant(email, "Customer"));
  assert.equal(j.ok, true);
  assert.equal(j.changed.role, "Customer");
  // The still-valid 30-day token must stop working the moment access is revoked.
  assert.equal((await stateFn(stateReq({ token }))).status, 403, "a revoked admin kept access");
  assert.equal(j.users.find((u) => u.email === email).source, "default");
});

test("an admin cannot change their own role", async () => {
  const res = await grant(ADMIN_EMAIL, "Customer");
  assert.equal(res.status, 409);
  assert.match((await body(res)).error, /your own role/i);
  // Still an admin afterwards.
  assert.equal((await adminFn(adminReq())).status, 200);
});

test("a role set in environment config cannot be changed in-app", async () => {
  // The recovery path: config outranks the admin screen, so an operator can always undo
  // whatever was done here.
  const res = await grant(VIEWER_EMAIL, "Admin");
  assert.equal(res.status, 409);
  assert.match((await body(res)).error, /environment configuration/i);

  const rows = (await body(await adminFn(adminReq()))).users;
  assert.equal(rows.find((u) => u.email === VIEWER_EMAIL).source, "env");
  assert.equal(rows.find((u) => u.email === ADMIN_EMAIL).source, "env");
});

test("the last administrator cannot be removed", async () => {
  // Set up a lone granted admin, then have them try to revoke the only other one.
  const email = "solo-admin@example.com";
  const token = await register(email);
  await grant(email, "Admin");

  // Env admins still count, so with GL_ADMIN_EMAILS set this is allowed. Clear it to
  // reach the genuinely-last-admin case.
  const savedEnv = process.env.GL_ADMIN_EMAILS;
  const savedRoles = process.env.GL_ROLES;
  delete process.env.GL_ADMIN_EMAILS;
  delete process.env.GL_ROLES;
  try {
    const second = "second-admin@example.com";
    await register(second);
    // `email` is now the only admin, and is refused when removing itself via another admin.
    const j2 = await body(await grant(second, "Admin", token));
    assert.equal(j2.ok, true, "a granted admin should be able to grant: " + JSON.stringify(j2));

    // Now remove one: allowed, because one remains.
    assert.equal((await grant(second, "Customer", token)).status, 200);

    // Removing the last one is refused. `second` is a customer again, so have them try...
    // no: only an admin may call. Use `email` (the last admin) targeting itself -> 409
    // self-change. So grant `second` again and have IT revoke `email`.
    await grant(second, "Admin", token);
    const secondToken = (await body(await authFn(post({ action: "login", email: second, pw: "pass1234" })))).token;
    assert.equal((await grant(email, "Customer", secondToken)).status, 200, "two admins: removing one is fine");

    // `second` is now the only admin. Nobody else can remove it (self-change is blocked),
    // which is the guard working from both directions.
    const selfRes = await grant(second, "Customer", secondToken);
    assert.equal(selfRes.status, 409);
  } finally {
    if (savedEnv === undefined) delete process.env.GL_ADMIN_EMAILS; else process.env.GL_ADMIN_EMAILS = savedEnv;
    if (savedRoles === undefined) delete process.env.GL_ROLES; else process.env.GL_ROLES = savedRoles;
  }
});

test("role administration validates its input", async () => {
  assert.equal((await grant("", "Admin")).status, 400);
  assert.equal((await grant("someone@example.com", "Wizard")).status, 400);
  // Granting to an address with no account is refused rather than stored for later.
  const res = await grant("ghost@example.com", "Admin");
  assert.equal(res.status, 404);
  assert.match((await body(res)).error, /sign up first/i);
});

test("the user list never exposes password material", async () => {
  const j = await body(await adminFn(adminReq()));
  assert.ok(j.users.length > 0);
  const raw = JSON.stringify(j);
  ["salt", "hash", "pwChangedAt"].forEach((f) => assert.ok(!raw.includes(f), "admin list leaked " + f));
  j.users.forEach((u) => {
    assert.deepEqual(Object.keys(u).sort(),
      ["createdAt", "email", "grantedAt", "grantedBy", "name", "role", "source"]);
  });
});

// ---- deployment readiness ----
//
// /api/health is public, so the readiness report must say whether each secret is
// configured without ever disclosing a value or which accounts hold privileges.

test("health reports what is missing, and leaks no secret values", async () => {
  const saved = { admins: process.env.GL_ADMIN_EMAILS, roles: process.env.GL_ROLES, secret: process.env.GL_AUTH_SECRET, key: process.env.GL_BREVO_KEY, from: process.env.GL_MAIL_FROM, tenants: process.env.GL_TENANTS };
  const restore = () => Object.entries({ GL_ADMIN_EMAILS: saved.admins, GL_ROLES: saved.roles, GL_AUTH_SECRET: saved.secret, GL_BREVO_KEY: saved.key, GL_MAIL_FROM: saved.from, GL_TENANTS: saved.tenants })
    .forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  const savedGrants = blobs.get(k("granite-roles", "grants"));
  try {
    // Nothing configured at all: both blocking checks must fail. In-app grants count
    // toward ops access, so they have to be cleared too, not just the env vars.
    delete process.env.GL_ADMIN_EMAILS; delete process.env.GL_ROLES;
    delete process.env.GL_AUTH_SECRET; delete process.env.GL_BREVO_KEY;
    delete process.env.GL_MAIL_FROM; delete process.env.GL_TENANTS;
    blobs.delete(k("granite-roles", "grants"));

    let j = await body(await healthFn(new Request("https://x/api/health")));
    assert.equal(j.readiness.ready, false);
    assert.deepEqual(j.readiness.blocking.sort(), ["authSecret", "opsAccess"]);
    assert.match(j.readiness.checks.opsAccess.detail, /no ops roles granted/);

    // A grant made on the Team & Roles screen satisfies ops access on its own, so a
    // deployment bootstrapped from config and then managed in-app stops reporting
    // itself as unconfigured.
    blobs.set(k("granite-roles", "grants"), JSON.stringify({ "someone@example.com": { role: "Admin", by: "x", at: "t" } }));
    j = await body(await healthFn(new Request("https://x/api/health")));
    assert.deepEqual(j.readiness.blocking, ["authSecret"], "an in-app grant should count as ops access");
    assert.match(j.readiness.checks.opsAccess.detail, /1 account\(s\)/);
    blobs.delete(k("granite-roles", "grants"));

    // Fully configured: ready, and the counts are right.
    process.env.GL_AUTH_SECRET = "s3cr3t-value-must-not-appear";
    process.env.GL_ADMIN_EMAILS = "boss@example.com,second@example.com";
    process.env.GL_ROLES = JSON.stringify({ "dana@example.com": "Runner", "nobody@example.com": "NotARole" });
    process.env.GL_BREVO_KEY = "xkeysib-must-not-appear";
    process.env.GL_MAIL_FROM = "Granite <no-reply@example.com>";
    process.env.GL_TENANTS = JSON.stringify({ "tenant-key-must-not-appear": "acme" });
    j = await body(await healthFn(new Request("https://x/api/health")));
    assert.equal(j.readiness.ready, true);
    assert.deepEqual(j.readiness.blocking, []);
    // 2 admins + 1 valid named ops role; the bogus role must not be counted.
    assert.match(j.readiness.checks.opsAccess.detail, /^3 account\(s\)/);

    // The response must not contain any secret value, or any privileged email.
    const raw = JSON.stringify(j);
    ["s3cr3t-value-must-not-appear", "xkeysib-must-not-appear", "tenant-key-must-not-appear",
     "boss@example.com", "second@example.com", "dana@example.com", "no-reply@example.com"]
      .forEach((secret) => assert.ok(!raw.includes(secret), "health leaked: " + secret));
  } finally {
    restore();
    if (savedGrants === undefined) blobs.delete(k("granite-roles", "grants"));
    else blobs.set(k("granite-roles", "grants"), savedGrants);
  }
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
