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

let authFn, ordersFn, stateFn, trackFn, healthFn, ingestFn, adminFn, pushFn, carrierFn, acctFn, sign;
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
  pushFn = (await import("../netlify/functions/push.mjs")).default;
  carrierFn = (await import("../netlify/functions/carriers.mjs")).default;
  acctFn = (await import("../netlify/functions/account.mjs")).default;
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

// ---- account export and closure ----

const acctReq = (init = {}) => new Request("https://x/api/account", {
  method: init.method || "GET",
  headers: init.token === null ? {} : { authorization: "Bearer " + init.token },
});

test("a customer can export everything held about them, minus the password", async () => {
  const email = "export-me@example.com";
  const token = await register(email, "pass1234", "Export Me");
  await ordersFn(asUser(token, { method: "POST", body: { item: "Exported TV", address: "9 Elm St", city: "Dayton", state: "OH" } }));

  const j = await body(await acctFn(acctReq({ token })));
  assert.equal(j.ok, true);
  assert.equal(j.account.email, email);
  assert.equal(j.account.name, "Export Me");
  assert.equal(j.orders.length, 1);
  // Their own address is their data and belongs in the export.
  assert.equal(j.orders[0].customer.address, "9 Elm St");

  // The password must never leave, in any form. Checked as JSON keys rather than as
  // substrings, because the explanatory note legitimately contains the word "salted".
  const raw = JSON.stringify(j);
  ['"salt"', '"hash"', '"pwChangedAt"'].forEach((k) => assert.ok(!raw.includes(k), "export leaked the " + k + " field"));
  assert.ok(!raw.includes("pass1234"), "export leaked the password itself");
  assert.deepEqual(Object.keys(j.account).sort(), ["createdAt", "email", "name", "role"]);
  assert.equal((await acctFn(acctReq({ token: null }))).status, 401);
});

test("closing an account is refused while a parcel is on the way", async () => {
  const email = "midflight@example.com";
  const token = await register(email);
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Moving parcel" } })));

  // Ops picks it up: now it is in our custody and the address is needed to finish the job.
  const view = await body(await stateFn(asOps()));
  view.packages.find((p) => p.id === placed.order.id).status = "InTransit";
  await stateFn(asOps({ method: "PUT", body: view }));

  const res = await acctFn(acctReq({ method: "DELETE", token }));
  assert.equal(res.status, 409);
  const j = await body(res);
  assert.match(j.error, /on the way/i);
  assert.equal(j.inFlight[0].id, placed.order.id);
  // Refused means nothing changed: the account still works.
  assert.equal((await acctFn(acctReq({ token }))).status, 200);
});

test("closing an account removes uncollected orders and anonymises delivered ones", async () => {
  const email = "closeme@example.com";
  const token = await register(email, "pass1234", "Close Me");
  const a = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Not collected yet" } })));
  const b = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Already delivered", address: "5 Oak Ave", city: "Dayton", state: "OH", phone: "937-555-0199" } })));

  const view = await body(await stateFn(asOps()));
  view.packages.find((p) => p.id === b.order.id).status = "Delivered";
  await stateFn(asOps({ method: "PUT", body: view }));

  const j = await body(await acctFn(acctReq({ method: "DELETE", token })));
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.ordersRemoved, 1);
  assert.equal(j.ordersAnonymised, 1);

  const after = await body(await stateFn(asOps()));
  // The uncollected order is gone entirely.
  assert.ok(!after.packages.find((p) => p.id === a.order.id), "an uncollected order survived closure");
  // The delivered one survives as a record, with the person removed.
  const kept = after.packages.find((p) => p.id === b.order.id);
  assert.ok(kept, "a delivered shipment record was destroyed");
  assert.equal(kept.customerEmail, null);
  assert.equal(kept.customer.address, "");
  assert.equal(kept.customer.phone, "");
  assert.deepEqual(kept.photos, {});
  // The lane is kept, since city and state describe the shipment not the person.
  assert.equal(kept.customer.city, "Dayton");
  assert.equal(kept.customer.state, "OH");
  const raw = JSON.stringify(kept);
  ["5 Oak Ave", "937-555-0199", email].forEach((s) => assert.ok(!raw.includes(s), "closure left behind " + s));

  // And the credentials are gone: the old session and the old password both stop working.
  assert.equal((await acctFn(acctReq({ token }))).status, 401);
  const relogin = await authFn(post({ action: "login", email, pw: "pass1234" }));
  assert.equal(relogin.status, 401, "a closed account could still sign in");
});

// ---- carrier tracking ----

const carrierReq = (init = {}) => new Request("https://x/api/carriers", {
  method: init.method || "GET",
  headers: init.token === null ? {} : { authorization: "Bearer " + (init.token || adminToken) },
});

test("carrier status is public and says plainly that tracking is simulated", async () => {
  // Unauthenticated on purpose: the ops UI needs this to decide whether to label its
  // tracking numbers as real, before anyone is signed in.
  const j = await body(await carrierFn(carrierReq({ token: null })));
  assert.equal(j.ok, true);
  assert.deepEqual(j.configured, []);
  assert.equal(j.simulated, true);
  assert.match(j.detail, /generated locally/);
});

test("refreshing carrier tracking needs a writing ops role", async () => {
  const customer = await register("carrier-nosy@example.com");
  assert.equal((await carrierFn(carrierReq({ method: "POST", token: customer }))).status, 403);
  // Viewer is an ops role but read-only, and this writes the workspace.
  assert.equal((await carrierFn(carrierReq({ method: "POST", token: viewerToken }))).status, 403);
  assert.equal((await carrierFn(carrierReq({ method: "POST", token: null }))).status, 401);
});

test("with no carrier configured, a refresh reports that instead of inventing scans", async () => {
  const res = await carrierFn(carrierReq({ method: "POST" }));
  assert.equal(res.status, 503);
  const j = await body(res);
  assert.equal(j.ok, false);
  assert.equal(j.reason, "not-configured");
  assert.equal(j.refreshed, 0);
  assert.match(j.error, /generated locally/);
});

test("a configured but unimplemented carrier fails loudly, per package", async () => {
  // The request layer is deliberately not written. That must surface as a located error,
  // not as a silent no-op that looks like everything is fine.
  const saved = [process.env.GL_UPS_CLIENT_ID, process.env.GL_UPS_CLIENT_SECRET];
  process.env.GL_UPS_CLIENT_ID = "id"; process.env.GL_UPS_CLIENT_SECRET = "secret";
  try {
    // Put an in-flight UPS parcel in the workspace.
    const view = await body(await stateFn(asOps()));
    view.packages.push({
      id: "GL-9500", status: "InTransit", carrier: "UPS", tracking: "1Z999AA10123456784",
      item: { description: "Carrier probe" }, customer: { name: "N" }, history: [], photos: {},
    });
    await stateFn(asOps({ method: "PUT", body: view }));

    const j = await body(await carrierFn(carrierReq({ method: "POST" })));
    assert.equal(j.ok, false, "an unimplemented carrier reported success");
    assert.ok(j.checked >= 1, "the in-flight parcel was not even attempted");
    assert.equal(j.moved, 0);
    const failure = j.failures.find((f) => f.id === "GL-9500");
    assert.ok(failure, "no failure recorded for the probe package: " + JSON.stringify(j.failures));
    assert.match(failure.error, /not implemented/i);
    // The error has to say where to implement it.
    assert.match(failure.error, /_carriers\.mjs/);
  } finally {
    if (saved[0] === undefined) delete process.env.GL_UPS_CLIENT_ID; else process.env.GL_UPS_CLIENT_ID = saved[0];
    if (saved[1] === undefined) delete process.env.GL_UPS_CLIENT_SECRET; else process.env.GL_UPS_CLIENT_SECRET = saved[1];
  }
});

// ---- email verification ----
//
// Verification confirms we can reach someone about a shipment. It is deliberately not a
// gate on using the service, so the tests check that the account works throughout.

test("signup sends a confirmation link and the account works unverified", async () => {
  const mail = captureMail();
  try {
    const email = "verify-me@example.com";
    const reg = await body(await authFn(post({ action: "register", email, pw: "pass1234", name: "Vera Fyer" })));
    assert.equal(reg.ok, true);
    assert.equal(reg.user.emailVerified, false);
    assert.equal(reg.verification.available, true);
    assert.equal(reg.verification.sent, true);
    assert.equal(mail.sent.length, 1);
    assert.match(mail.sent[0].subject, /confirm your email/i);
    assert.match(mail.sent[0].htmlContent, /app\.html\?verify=/);

    // Unverified must not block anything: they can place an order straight away.
    const placed = await body(await ordersFn(asUser(reg.token, { method: "POST", body: { item: "Unverified order" } })));
    assert.equal(placed.ok, true, "an unverified account was blocked from ordering");
  } finally { mail.restore(); }
});

test("a confirmation link verifies the address, and is safe to click twice", async () => {
  const email = "clicktwice@example.com";
  await register(email);
  const token = sign({ email, kind: "verify", exp: Date.now() + 60000 });

  const first = await body(await authFn(post({ action: "verify-confirm", token })));
  assert.equal(first.ok, true);
  assert.equal(first.user.emailVerified, true);

  // People click the link again, or a mail client prefetches it. That is not an error.
  const second = await body(await authFn(post({ action: "verify-confirm", token })));
  assert.equal(second.ok, true);
  assert.equal(second.user.emailVerified, true);

  // And it sticks across a fresh sign-in.
  const login = await body(await authFn(post({ action: "login", email, pw: "pass1234" })));
  assert.equal(login.user.emailVerified, true);
});

test("a verification token is not a session, and a session is not a verification token", async () => {
  const email = "crosstoken@example.com";
  const token = await register(email);
  // A verify token must not authenticate anything.
  const verifyTok = sign({ email, kind: "verify", exp: Date.now() + 60000 });
  assert.equal((await authFn(new Request("https://x/api/auth", { headers: { authorization: "Bearer " + verifyTok } }))).status, 401);
  assert.equal((await stateFn(stateReq({ token: verifyTok }))).status, 401);
  // And a session token must not be redeemable as a confirmation.
  const asVerify = await authFn(post({ action: "verify-confirm", token }));
  assert.equal(asVerify.status, 400);
  // A reset token must not verify an address either.
  const resetTok = sign({ email, kind: "reset", exp: Date.now() + 60000 });
  assert.equal((await authFn(post({ action: "verify-confirm", token: resetTok }))).status, 400);
});

test("resending a confirmation needs a session and is throttled", async () => {
  const mail = captureMail();
  try {
    const email = "resend@example.com";
    const token = await register(email);
    mail.sent.length = 0; // ignore the signup email

    // No session: cannot be used to mail strangers.
    assert.equal((await authFn(post({ action: "verify-request" }))).status, 401);

    const req = () => authFn(new Request("https://x/api/auth", {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ action: "verify-request" }),
    }));
    for (let i = 0; i < 3; i++) assert.equal((await req()).status, 200);
    const limited = await req();
    assert.equal(limited.status, 429, "resend was not throttled");
    assert.equal(mail.sent.length, 3, "sent more confirmations than the limit allows");

    // Once verified, resending is a no-op rather than more mail.
    await authFn(post({ action: "verify-confirm", token: sign({ email, kind: "verify", exp: Date.now() + 60000 }) }));
    // Throttle is still engaged, so clear it the way a real flow would: a fresh window.
    const { clearThrottle } = await import("../netlify/functions/_throttle.mjs");
    await clearThrottle("verify", email);
    const after = await body(await req());
    assert.equal(after.alreadyVerified, true);
    assert.equal(mail.sent.length, 3, "mailed an already-verified address");
  } finally { mail.restore(); }
});

test("with no mail provider, signup does not pretend a confirmation was sent", async () => {
  const email = "nomail@example.com";
  const reg = await body(await authFn(post({ action: "register", email, pw: "pass1234" })));
  assert.equal(reg.verification.available, false);
  assert.equal(reg.verification.sent, false);
  // And asking for one says so plainly rather than failing silently.
  const res = await authFn(new Request("https://x/api/auth", {
    method: "POST", headers: { authorization: "Bearer " + reg.token, "content-type": "application/json" },
    body: JSON.stringify({ action: "verify-request" }),
  }));
  assert.equal(res.status, 503);
  assert.match((await body(res)).error, /isn't set up/i);
});

// ---- credential throttling ----

test("repeated wrong passwords lock an address, and the right one still works before that", async () => {
  const email = "bruteforce@example.com";
  await register(email, "correct-horse");
  const wrong = () => authFn(post({ action: "login", email, pw: "wrong" }));

  // Five wrong attempts, then the correct password must still be accepted: a person who
  // mistyped a few times must not be locked out of their own account.
  for (let i = 0; i < 5; i++) assert.equal((await wrong()).status, 401);
  const ok = await body(await authFn(post({ action: "login", email, pw: "correct-horse" })));
  assert.equal(ok.ok, true, "a legitimate sign-in was blocked too early");

  // Success clears the count, so the allowance starts over.
  for (let i = 0; i < 6; i++) await wrong();
  const locked = await wrong();
  assert.equal(locked.status, 429);
  const j = await body(locked);
  assert.ok(j.retryAfter > 0);
  assert.equal(locked.headers.get("Retry-After"), String(j.retryAfter));

  // And the lock holds even against the correct password: otherwise it would be an oracle
  // telling an attacker exactly when they had guessed right.
  assert.equal((await authFn(post({ action: "login", email, pw: "correct-horse" }))).status, 429);
});

test("throttling does not reveal whether an account exists", async () => {
  // An unknown address has to lock exactly like a real one, or the difference tells an
  // attacker which addresses are worth attacking.
  const ghost = "no-such-person@example.com";
  for (let i = 0; i < 6; i++) {
    assert.equal((await authFn(post({ action: "login", email: ghost, pw: "guess" + i }))).status, 401);
  }
  const res = await authFn(post({ action: "login", email: ghost, pw: "guess-again" }));
  assert.equal(res.status, 429, "unknown addresses were not throttled, which leaks their absence");
});

test("throttling is per address, so one attacker cannot lock everyone out", async () => {
  const victim = "victim@example.com";
  await register(victim, "victim-pass");
  for (let i = 0; i < 7; i++) await authFn(post({ action: "login", email: "attacked@example.com", pw: "guess" + i }));
  const ok = await body(await authFn(post({ action: "login", email: victim, pw: "victim-pass" })));
  assert.equal(ok.ok, true, "an attack on one address locked a different one");
});

test("completing a password reset clears a lock", async () => {
  const email = "lockedout@example.com";
  await register(email, "old-pass");
  for (let i = 0; i < 7; i++) await authFn(post({ action: "login", email, pw: "wrong" }));
  assert.equal((await authFn(post({ action: "login", email, pw: "old-pass" }))).status, 429);

  // Somebody locked out by an attacker must be able to recover through their inbox rather
  // than waiting the lock out.
  const resetToken = sign({ email, kind: "reset", exp: Date.now() + 60000 });
  const done = await body(await authFn(post({ action: "reset-confirm", token: resetToken, pw: "new-pass" })));
  assert.equal(done.ok, true);
  const after = await body(await authFn(post({ action: "login", email, pw: "new-pass" })));
  assert.equal(after.ok, true, "the lock survived a completed password reset");
});

test("reset requests are throttled harder, since each one mails somebody", async () => {
  const email = "resetspam@example.com";
  // Registered before mail capture starts: signup now sends a verification email of its
  // own, and counting it here would make the assertion about resets untrue.
  await register(email);
  const mail = captureMail();
  try {
    // Three go through, the fourth is refused.
    for (let i = 0; i < 3; i++) {
      assert.equal((await authFn(post({ action: "reset-request", email }))).status, 200);
    }
    const res = await authFn(post({ action: "reset-request", email }));
    assert.equal(res.status, 429);
    assert.match((await body(res)).error, /already sent a reset link/i);
    assert.equal(mail.sent.length, 3, "sent more mail than the limit allows");
  } finally { mail.restore(); }
});

// ---- web push subscriptions ----

const SUB = (endpoint) => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } });
const pushReq = (init = {}) => new Request("https://x/api/push" + (init.qs || ""), {
  method: init.method || "GET",
  headers: Object.assign(
    init.token === null ? {} : { authorization: "Bearer " + init.token },
    init.body ? { "content-type": "application/json" } : {}),
  body: init.body ? JSON.stringify(init.body) : undefined,
});

function withVapid() {
  const saved = { pub: process.env.GL_VAPID_PUBLIC, priv: process.env.GL_VAPID_PRIVATE };
  process.env.GL_VAPID_PUBLIC = "BFakePublicKeyForTests";
  process.env.GL_VAPID_PRIVATE = "fake-private-key-for-tests";
  return () => {
    if (saved.pub === undefined) delete process.env.GL_VAPID_PUBLIC; else process.env.GL_VAPID_PUBLIC = saved.pub;
    if (saved.priv === undefined) delete process.env.GL_VAPID_PRIVATE; else process.env.GL_VAPID_PRIVATE = saved.priv;
  };
}

test("push availability is public, but subscribing needs a session", async () => {
  // The client has to know whether to offer the option before it can sign anyone in.
  let j = await body(await pushFn(pushReq({ token: null })));
  assert.equal(j.ok, true);
  assert.equal(j.configured, false, "push should report unconfigured with no VAPID keys");
  assert.equal(j.publicKey, null);

  const restore = withVapid();
  try {
    j = await body(await pushFn(pushReq({ token: null })));
    assert.equal(j.configured, true);
    assert.equal(j.publicKey, "BFakePublicKeyForTests");

    // Writing requires a token.
    assert.equal((await pushFn(pushReq({ method: "POST", token: null, body: { subscription: SUB("https://push.example/a") } }))).status, 401);
  } finally { restore(); }
});

test("a subscription is stored against the signed-in account, not one named in the body", async () => {
  const restore = withVapid();
  try {
    const mine = "pushme@example.com";
    const victim = "pushvictim@example.com";
    const token = await register(mine);
    await register(victim);

    // The body names someone else; the token is what counts.
    const j = await body(await pushFn(pushReq({
      method: "POST", token,
      body: { email: victim, subscription: SUB("https://push.example/mine") },
    })));
    assert.equal(j.ok, true);
    assert.equal(j.devices, 1);

    const { readSubscriptions } = await import("../netlify/functions/_push.mjs");
    assert.equal((await readSubscriptions(mine)).length, 1, "not stored against the caller");
    assert.equal((await readSubscriptions(victim)).length, 0, "stored against the account named in the body");
  } finally { restore(); }
});

test("re-subscribing the same device replaces it instead of duplicating", async () => {
  const restore = withVapid();
  try {
    const email = "pushdup@example.com";
    const token = await register(email);
    const { readSubscriptions } = await import("../netlify/functions/_push.mjs");

    await pushFn(pushReq({ method: "POST", token, body: { subscription: SUB("https://push.example/same") } }));
    await pushFn(pushReq({ method: "POST", token, body: { subscription: SUB("https://push.example/same") } }));
    assert.equal((await readSubscriptions(email)).length, 1, "one device became two, so it would be notified twice");

    // A genuinely different device is additive.
    await pushFn(pushReq({ method: "POST", token, body: { subscription: SUB("https://push.example/other") } }));
    assert.equal((await readSubscriptions(email)).length, 2);

    // Turning it off on one device leaves the other alone.
    const j = await body(await pushFn(pushReq({ method: "DELETE", token, body: { endpoint: "https://push.example/same" } })));
    assert.equal(j.devices, 1);
    assert.equal((await readSubscriptions(email))[0].endpoint, "https://push.example/other");
  } finally { restore(); }
});

test("devices per account are capped", async () => {
  const restore = withVapid();
  try {
    const email = "pushmany@example.com";
    const token = await register(email);
    const { readSubscriptions, MAX_DEVICES } = await import("../netlify/functions/_push.mjs");

    // A scripted loop must not grow one account's record without bound, nor turn one
    // status change into an unbounded fan-out of sends.
    for (let i = 0; i < MAX_DEVICES + 5; i++) {
      await pushFn(pushReq({ method: "POST", token, body: { subscription: SUB("https://push.example/dev-" + i) } }));
    }
    const stored = await readSubscriptions(email);
    assert.equal(stored.length, MAX_DEVICES, "device list grew past the cap");
    // Newest kept, oldest dropped.
    assert.ok(stored.some((s) => s.endpoint.endsWith("dev-" + (MAX_DEVICES + 4))));
    assert.ok(!stored.some((s) => s.endpoint.endsWith("dev-0")));
  } finally { restore(); }
});

test("an incomplete subscription is refused rather than stored to fail later", async () => {
  const restore = withVapid();
  try {
    const token = await register("pushbad@example.com");
    const bad = [
      {}, { endpoint: "https://push.example/x" },
      { endpoint: "https://push.example/x", keys: { p256dh: "only-one" } },
      { endpoint: "not-a-url", keys: { p256dh: "a", auth: "b" } },
    ];
    for (const sub of bad) {
      const res = await pushFn(pushReq({ method: "POST", token, body: { subscription: sub } }));
      assert.equal(res.status, 400, "accepted an unusable subscription: " + JSON.stringify(sub));
    }
  } finally { restore(); }
});

test("subscribing reports clearly when push is not configured", async () => {
  const token = await register("pushnokeys@example.com");
  const res = await pushFn(pushReq({ method: "POST", token, body: { subscription: SUB("https://push.example/z") } }));
  assert.equal(res.status, 503);
  assert.match((await body(res)).error, /aren't set up/i);
});

test("the push payload carries no recipient details", async () => {
  const { pushPayload } = await import("../netlify/functions/_push.mjs");
  const p = pushPayload({
    id: "GL-1041", item: { description: "LG OLED TV" },
    customer: { name: "Jane Doe", address: "742 Birchwood Ln", phone: "555-0100" },
  }, "out for delivery");
  assert.match(p.title, /out for delivery/);
  assert.equal(p.tag, "GL-1041");
  assert.match(p.url, /track\.html\?n=GL-1041/);
  const raw = JSON.stringify(p);
  // A push payload passes through a third-party service.
  ["742 Birchwood Ln", "555-0100", "Jane Doe"].forEach((secret) =>
    assert.ok(!raw.includes(secret), "push payload leaked " + secret));
});

// ---- customer status notifications ----
//
// Driven through the real PUT handler, because the whole point is that the transition is
// detected from what ops pushed versus what was stored.

// Mail has to be genuinely configured and captured for these to mean anything: with no
// provider set, `sent` is 0 for every push and a broken dedupe would look identical to a
// working one.
function captureMail() {
  const saved = { key: process.env.GL_BREVO_KEY, from: process.env.GL_MAIL_FROM, fetch: globalThis.fetch };
  const sent = [];
  process.env.GL_BREVO_KEY = "xkeysib-test";
  process.env.GL_MAIL_FROM = "Granite <no-reply@usegl.com>";
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.brevo.com")) {
      sent.push(JSON.parse(init.body));
      return new Response("{}", { status: 201 });
    }
    return saved.fetch(url, init);
  };
  return {
    sent,
    restore() {
      globalThis.fetch = saved.fetch;
      if (saved.key === undefined) delete process.env.GL_BREVO_KEY; else process.env.GL_BREVO_KEY = saved.key;
      if (saved.from === undefined) delete process.env.GL_MAIL_FROM; else process.env.GL_MAIL_FROM = saved.from;
    },
  };
}

test("advancing a customer order emails once, not on every push", async () => {
  const email = "notify@example.com";
  const token = await register(email);
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Notified TV" } })));
  const id = placed.order.id;
  const mail = captureMail();

  const advance = async (status) => {
    const view = await body(await stateFn(asOps()));
    view.packages.find((p) => p.id === id).status = status;
    return body(await stateFn(asOps({ method: "PUT", body: view })));
  };
  const repush = async () => {
    const view = await body(await stateFn(asOps()));
    return body(await stateFn(asOps({ method: "PUT", body: view })));
  };

  try {
    let r = await advance("OutforDelivery");
    assert.equal(r.notified.sent, 1, "expected one send: " + JSON.stringify(r.notified));
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to[0].email, email);
    assert.match(mail.sent[0].subject, /out for delivery/i);

    // Ops keeps pushing the same state every 1.5s. No further mail may go out.
    for (let i = 0; i < 3; i++) {
      r = await repush();
      assert.equal(r.notified.sent, 0, "a repeat push sent another email");
    }
    assert.equal(mail.sent.length, 1, "the 1.5s push loop mailed the customer repeatedly");

    // A genuinely new stage does send.
    r = await advance("Delivered");
    assert.equal(r.notified.sent, 1, "the delivered stage was not announced");
    assert.equal(mail.sent.length, 2);
    assert.match(mail.sent[1].subject, /delivered/i);

    // And re-pushing Delivered does not.
    await repush();
    assert.equal(mail.sent.length, 2);
  } finally { mail.restore(); }
});

test("a parcel that flaps backwards and forwards is not announced twice", async () => {
  // The case the dedupe record exists for. Ops clients push whole, possibly stale state,
  // so a client that pulled before the change can push the parcel back to an earlier
  // status; when it advances again the transition looks new. Without the server-side
  // record of what was already announced, the customer gets the same email twice.
  const token = await register("flap@example.com");
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Flapper" } })));
  const id = placed.order.id;
  const mail = captureMail();
  const setStatus = async (status) => {
    const view = await body(await stateFn(asOps()));
    view.packages.find((p) => p.id === id).status = status;
    return body(await stateFn(asOps({ method: "PUT", body: view })));
  };
  try {
    await setStatus("InTransit");
    assert.equal(mail.sent.length, 1, "first advance should notify");

    // A stale client pushes it back, then it advances again.
    await setStatus("Won");
    await setStatus("InTransit");
    assert.equal(mail.sent.length, 1, "the customer was emailed twice for one real transition");

    // A later, genuinely different stage still gets through.
    await setStatus("Delivered");
    assert.equal(mail.sent.length, 2);
  } finally { mail.restore(); }
});

test("internal stages and ops-only packages send no mail at all", async () => {
  const token = await register("quiet-mail@example.com");
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Quiet TV" } })));
  const mail = captureMail();
  try {
    const view = await body(await stateFn(asOps()));
    view.packages.find((p) => p.id === placed.order.id).status = "Staged";
    view.packages.push({ id: "GL-9002", status: "Delivered", item: { description: "Ops only" }, customer: { name: "N" }, history: [], photos: {} });
    const r = await body(await stateFn(asOps({ method: "PUT", body: view })));
    assert.equal(r.notified.sent, 0);
    assert.equal(mail.sent.length, 0, "mailed about an internal stage or an ops-only package");
  } finally { mail.restore(); }
});

test("internal stages and ops-only packages raise nothing", async () => {
  const token = await register("quiet@example.com");
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Quiet TV" } })));

  const view = await body(await stateFn(asOps()));
  // An internal step on the customer's parcel, plus an ops-only package going all the way
  // to Delivered. Neither has anyone to tell.
  view.packages.find((p) => p.id === placed.order.id).status = "Intake";
  view.packages.push({ id: "GL-9001", status: "Delivered", item: { description: "Ops only" }, customer: { name: "N" }, history: [], photos: {} });
  const r = await body(await stateFn(asOps({ method: "PUT", body: view })));
  assert.equal(r.notified.sent, 0);
  assert.equal(r.notified.deferred, 0);
  assert.ok(!r.notified.reason, "unexpected reason: " + r.notified.reason);
});

test("a failing mail provider does not fail the workspace push", async () => {
  const saved = { key: process.env.GL_BREVO_KEY, from: process.env.GL_MAIL_FROM, fetch: globalThis.fetch };
  const token = await register("mailfail@example.com");
  const placed = await body(await ordersFn(asUser(token, { method: "POST", body: { item: "Unsendable" } })));

  process.env.GL_BREVO_KEY = "xkeysib-test";
  process.env.GL_MAIL_FROM = "Granite <no-reply@usegl.com>";
  globalThis.fetch = async () => { throw new TypeError("provider down"); };
  try {
    const view = await body(await stateFn(asOps()));
    view.packages.find((p) => p.id === placed.order.id).status = "InTransit";
    const res = await stateFn(asOps({ method: "PUT", body: view }));
    // The push itself must succeed: the workspace was already stored before mailing.
    assert.equal(res.status, 200);
    const r = await body(res);
    assert.equal(r.ok, true);
    assert.equal(r.notified.sent, 0);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.GL_BREVO_KEY; else process.env.GL_BREVO_KEY = saved.key;
    if (saved.from === undefined) delete process.env.GL_MAIL_FROM; else process.env.GL_MAIL_FROM = saved.from;
  }

  // And the status change still landed.
  const mine = await body(await ordersFn(asUser(token)));
  assert.equal(mine.orders.find((o) => o.id === placed.order.id).status, "InTransit");
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

test("every role change is recorded, including the revocation", async () => {
  const email = "audited@example.com";
  await register(email);
  await grant(email, "Driver");
  const j = await body(await grant(email, "Customer"));

  // Revoking deletes the grant, so without the audit log there would be nothing left to
  // show that this account ever had access.
  const mine = j.audit.filter((a) => a.email === email);
  assert.equal(mine.length, 2, "expected a grant and a revoke: " + JSON.stringify(mine));
  // Newest first.
  assert.deepEqual([mine[0].from, mine[0].to], ["Driver", "Customer"]);
  assert.deepEqual([mine[1].from, mine[1].to], ["Customer", "Driver"]);
  mine.forEach((a) => {
    assert.equal(a.by, ADMIN_EMAIL, "the acting admin was not recorded");
    assert.ok(a.at, "no timestamp");
  });

  // And it is readable on a later GET, not just returned by the write.
  const later = await body(await adminFn(adminReq()));
  assert.ok(later.audit.some((a) => a.email === email && a.to === "Customer"));
});

test("two simultaneous revocations cannot leave zero administrators", async () => {
  const savedEnv = process.env.GL_ADMIN_EMAILS;
  const savedRoles = process.env.GL_ROLES;
  const savedGrants = blobs.get(k("granite-roles", "grants"));
  try {
    // Two granted admins and no env admins, so the stored grants are the only thing
    // keeping anyone in.
    const a = "race-admin-a@example.com";
    const b = "race-admin-b@example.com";
    await register(a); await register(b);
    await grant(a, "Admin"); await grant(b, "Admin");
    delete process.env.GL_ADMIN_EMAILS;
    delete process.env.GL_ROLES;

    const aToken = (await body(await authFn(post({ action: "login", email: a, pw: "pass1234" })))).token;
    const bToken = (await body(await authFn(post({ action: "login", email: b, pw: "pass1234" })))).token;

    // As A's revocation of B is written, simulate B's request revoking A landing at the
    // same instant. Each saw one admin remaining; together they would leave none.
    let once = false;
    setAfterWrite(({ store, key }) => {
      if (store !== "granite-roles" || key !== "grants" || once) return;
      once = true;
      blobs.set(k("granite-roles", "grants"), JSON.stringify({}));
    });
    let res;
    try {
      res = await grant(b, "Customer", aToken);
    } finally { setAfterWrite(null); }

    assert.equal(res.status, 409, "the lockout was allowed through");
    assert.match((await body(res)).error, /would have left none/i);

    // At least one admin must still be able to get in.
    const stillIn = (await adminFn(adminReq({ token: aToken }))).status === 200
      || (await adminFn(adminReq({ token: bToken }))).status === 200;
    assert.ok(stillIn, "nobody can administer roles any more");
  } finally {
    setAfterWrite(null);
    if (savedEnv === undefined) delete process.env.GL_ADMIN_EMAILS; else process.env.GL_ADMIN_EMAILS = savedEnv;
    if (savedRoles === undefined) delete process.env.GL_ROLES; else process.env.GL_ROLES = savedRoles;
    if (savedGrants === undefined) blobs.delete(k("granite-roles", "grants"));
    else blobs.set(k("granite-roles", "grants"), savedGrants);
  }
});

test("the account list reports its own total, and flags a truncated page", async () => {
  const j = await body(await adminFn(adminReq()));
  assert.equal(typeof j.total, "number");
  assert.equal(j.users.length, j.total, "unexpected truncation at this size");
  assert.equal(j.truncated, false);

  // Truncation has to be visible, not silent: a partial list that looked complete would
  // make an admin think an account does not exist.
  const { listUsers } = await import("../netlify/functions/_auth.mjs");
  const small = await listUsers(2);
  assert.equal(small.users.length, 2);
  assert.ok(small.total > 2);
  assert.equal(small.truncated, true);
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
  saved.vapidPub = process.env.GL_VAPID_PUBLIC; saved.vapidPriv = process.env.GL_VAPID_PRIVATE;
  const restore = () => Object.entries({ GL_ADMIN_EMAILS: saved.admins, GL_ROLES: saved.roles, GL_AUTH_SECRET: saved.secret, GL_BREVO_KEY: saved.key, GL_MAIL_FROM: saved.from, GL_TENANTS: saved.tenants, GL_VAPID_PUBLIC: saved.vapidPub, GL_VAPID_PRIVATE: saved.vapidPriv })
    .forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  const savedGrants = blobs.get(k("granite-roles", "grants"));
  try {
    // Nothing configured at all: both blocking checks must fail. In-app grants count
    // toward ops access, so they have to be cleared too, not just the env vars.
    delete process.env.GL_ADMIN_EMAILS; delete process.env.GL_ROLES;
    delete process.env.GL_AUTH_SECRET; delete process.env.GL_BREVO_KEY;
    delete process.env.GL_MAIL_FROM; delete process.env.GL_TENANTS;
    delete process.env.GL_VAPID_PUBLIC; delete process.env.GL_VAPID_PRIVATE;
    blobs.delete(k("granite-roles", "grants"));

    let j = await body(await healthFn(new Request("https://x/api/health")));
    assert.equal(j.readiness.ready, false);
    assert.deepEqual(j.readiness.blocking.sort(), ["authSecret", "opsAccess"]);
    assert.match(j.readiness.checks.opsAccess.detail, /no ops roles granted/);
    // With neither email nor push, transitions are recorded but reach nobody. Reported,
    // but not blocking: the platform still works, customers just hear nothing.
    assert.equal(j.readiness.checks.statusUpdates.ok, false);
    assert.match(j.readiness.checks.statusUpdates.detail, /recorded but nothing is delivered/);
    assert.equal(j.readiness.checks.pushNotifications.ok, false);
    assert.ok(!j.readiness.blocking.includes("statusUpdates"));
    assert.ok(!j.readiness.blocking.includes("pushNotifications"));

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

    // Configuring a channel satisfies statusUpdates.
    assert.equal(j.readiness.checks.statusUpdates.ok, true, "email is configured at this point");

    // The env diagnostic must name variables, never reveal their contents.
    assert.ok(j.env.present.includes("GL_AUTH_SECRET"));
    assert.ok(j.env.present.includes("GL_ADMIN_EMAILS"));
    assert.ok(j.env.missing.includes("GL_UPS_CLIENT_ID"));
    // A misspelled variable is the thing this exists to catch.
    process.env.GL_ADMIN_EMAIL = "typo@example.com";       // singular: read by nothing
    try {
      const t = await body(await healthFn(new Request("https://x/api/health")));
      assert.ok(t.env.unrecognised.includes("GL_ADMIN_EMAIL"), "a misspelled variable was not flagged");
      assert.match(t.env.hint, /spelling/i);
      assert.ok(!JSON.stringify(t.env).includes("typo@example.com"), "the diagnostic leaked a value");
    } finally { delete process.env.GL_ADMIN_EMAIL; }

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
