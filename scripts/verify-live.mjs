// Live smoke test against a real deployment.
//
//   GL_ADMIN_EMAIL=you@co.com GL_ADMIN_PW='your password' npm run verify:live
//
// Your password stays in your shell. Nothing here prints a token, a password, or any
// customer's details: the output is PASS/FAIL lines that are safe to paste anywhere.
//
// What it proves is the one path unit tests cannot: that a customer order placed against
// the real API appears in the real ops workspace, that an ops status change written back
// reaches that customer, and that the authorization boundary holds on the live site.
const BASE = process.env.GL_BASE || "https://usegl.com";
const ADMIN = process.env.GL_ADMIN_EMAIL;
const PW = process.env.GL_ADMIN_PW;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  → " + detail : "")); }
  return cond;
};

const call = async (path, { method = "GET", token, key, body } = {}) => {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (key) headers["x-api-key"] = key;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
};

if (!ADMIN || !PW) {
  console.error("Set GL_ADMIN_EMAIL and GL_ADMIN_PW. They are read from the environment and never printed.");
  process.exit(2);
}

console.log("\nGranite Logistics — live verification against " + BASE + "\n");

// ---- readiness ----
const health = await call("/api/health");
ok("deployment reports ready", health.json?.readiness?.ready === true,
   "blocking: " + JSON.stringify(health.json?.readiness?.blocking));

// ---- sign in as the operator ----
const login = await call("/api/auth", { method: "POST", body: { action: "login", email: ADMIN, pw: PW } });
const adminToken = login.json?.token;
if (!ok("operator can sign in", !!adminToken, "status " + login.status + " " + (login.json?.error || ""))) {
  console.log("\nCannot continue without an operator session.\n");
  process.exit(1);
}
ok("operator holds an ops role", login.json?.user?.role && login.json.user.role !== "Customer",
   "role is " + login.json?.user?.role);

// ---- a throwaway customer places an order ----
const custEmail = "verify-" + Date.now() + "@granitetest.dev";
const reg = await call("/api/auth", { method: "POST", body: { action: "register", email: custEmail, pw: "verify-pass-123" } });
const custToken = reg.json?.token;
ok("a customer can register", !!custToken, reg.json?.error || ("status " + reg.status));
ok("a new account is a Customer, never self-granted", reg.json?.user?.role === "Customer",
   "role is " + reg.json?.user?.role);

const placed = await call("/api/my-orders", { method: "POST", token: custToken,
  body: { item: "Live verification parcel", name: "Verify Bot", address: "1 Test St", city: "Dayton", state: "OH", zip: "45402" } });
const orderId = placed.json?.order?.id;
ok("customer can place an order", !!orderId, "status " + placed.status + " " + (placed.json?.error || ""));

// ---- the join: ops sees that order ----
const opsView = await call("/api/state", { token: adminToken });
ok("operator can read the workspace", opsView.status === 200, "status " + opsView.status);
const found = (opsView.json?.packages || []).find((p) => p.id === orderId);
ok("the customer order is in the ops queue", !!found);
ok("ops can see which account placed it", found?.customerEmail === custEmail);

// ---- ops advances it, customer sees the change ----
if (found) {
  found.status = "InTransit";
  found.history = (found.history || []).concat([{ stage: "InTransit", ts: Date.now(), note: "live verification" }]);
  const pushed = await call("/api/state", { method: "PUT", token: adminToken, body: opsView.json });
  ok("operator can write the workspace", pushed.status === 200 && pushed.json?.ok === true,
     "status " + pushed.status + " " + (pushed.json?.error || ""));

  const mine = await call("/api/my-orders", { token: custToken });
  const seen = (mine.json?.orders || []).find((o) => o.id === orderId);
  ok("the customer sees the new status", seen?.status === "InTransit", "status is " + seen?.status);

  // Notifications ride the same path. With no channel configured this reports it rather
  // than pretending something was sent.
  const n = pushed.json?.notified;
  console.log("  INFO  status alerts: " + (n ? (n.reason || ("email " + n.sent + ", push " + n.pushed)) : "not reported"));
}

// ---- the boundary still holds ----
const custState = await call("/api/state", { token: custToken });
ok("a customer cannot read the workspace", custState.status === 403, "status " + custState.status);
const custAdmin = await call("/api/admin", { token: custToken });
ok("role administration is hidden from a customer", custAdmin.status === 404, "status " + custAdmin.status);
const demoKey = await call("/api/state", { key: "granite-dev-key" });
ok("the public demo key cannot read the workspace", demoKey.status === 403, "status " + demoKey.status);

// ---- public tracking reveals only what a carrier would ----
const track = await call("/api/track?n=" + encodeURIComponent(orderId));
const s = track.json?.shipment;
ok("public tracking finds the shipment", !!s);
ok("public tracking withholds recipient details",
   !!s && !JSON.stringify(s).includes("1 Test St") && !JSON.stringify(s).includes("Verify Bot"));

// ---- tidy up: cancel the verification order so it does not sit in the real queue ----
const cancelled = await call("/api/my-orders?id=" + encodeURIComponent(orderId), { method: "DELETE", token: custToken });
console.log("  INFO  verification order " + orderId +
  (cancelled.json?.ok ? " cancelled" : " could NOT be cancelled (status " + cancelled.status + ") — remove it by hand"));

console.log("\n  " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
