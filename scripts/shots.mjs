// Render the app's screens to PNGs so they can actually be looked at.
//
//   npm run shots                 # against http://localhost:8080
//   GL_BASE=https://usegl.com npm run shots
//
// This exists because the in-app browser pane does not always composite frames, which
// makes screenshots impossible from inside the editor. Puppeteer is already a dependency
// here for PDF label rendering, so rendering a page is free.
//
// Output goes to shots/ (gitignored). Each shot seeds localStorage before the app boots,
// so a screen that needs a signed-in customer or an operator gets one without touching a
// real account.
import { launch } from "./_browser.mjs";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { customerSeed, opsSeed, emptyCustomerSeed, emptyOpsSeed, dark, stressSeed, stressCustomerSeed, roleSeed, firstRunSeed } from "./_seeds.mjs";

const BASE = process.env.GL_BASE || "http://localhost:8080";
const OUT = "shots";

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { width: 1440, height: 900, deviceScaleFactor: 1 };

const SHOTS = [
  { name: "01-landing-desktop", url: "/", viewport: DESK },
  { name: "02-landing-phone", url: "/", viewport: PHONE },
  { name: "03-privacy-desktop", url: "/privacy.html", viewport: DESK },
  { name: "04-track-desktop", url: "/track.html?n=GL-1041", viewport: DESK },
  { name: "05-customer-home-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "custhome" },
  { name: "06-customer-order-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "order" },
  { name: "07-customer-account-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "account" },
  { name: "08-ops-overview-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "overview" },
  { name: "09-ops-tracking-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "tracking" },
  { name: "10-ops-roles-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "admin" },
  // Every remaining operator view. These had never been rendered, so nothing had ever
  // checked their layout at a real viewport.
  { name: "11-ops-ingest-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "ingest" },
  { name: "12-ops-runner-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "runner" },
  { name: "13-ops-presort-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "presort" },
  { name: "14-ops-batch-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "batch" },
  { name: "15-ops-driver-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "driver" },
  { name: "16-ops-returns-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "returns" },
  { name: "17-ops-reports-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "reports" },
  { name: "18-ops-activity-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "activity" },
  { name: "19-ops-settings-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "settings" },
  // Empty states: what a brand-new account and a brand-new workspace actually look like.
  { name: "20-customer-empty-phone", full: true, url: "/app.html", viewport: PHONE, seed: emptyCustomerSeed(), view: "custhome" },
  { name: "21-ops-empty-desktop", url: "/app.html", viewport: DESK, seed: emptyOpsSeed(), view: "runner" },
  // The demo workspace carries the connector source names, so this is the only shot that
  // exercises a source actually receiving orders rather than sitting idle.
  { name: "22-ops-ingest-receiving-desktop", url: "/app.html", viewport: DESK, seed: emptyOpsSeed(), view: "ingest" },
  // Dark mode. The header has had a theme toggle all along and no screen had ever been
  // rendered with it on, so nothing had checked the dark palette against real content.
  { name: "23-ops-overview-dark", url: "/app.html", viewport: DESK, seed: dark(opsSeed()), view: "overview" },
  { name: "24-ops-reports-dark", url: "/app.html", viewport: DESK, seed: dark(opsSeed()), view: "reports" },
  { name: "25-ops-batch-dark", url: "/app.html", viewport: DESK, seed: dark(opsSeed()), view: "batch" },
  { name: "26-customer-home-dark-phone", full: true, url: "/app.html", viewport: PHONE, seed: dark(customerSeed()), view: "custhome" },
  // Worst-case content: long part names, hyphenated surnames, seven-figure values. Every
  // other seed uses tidy short strings, so these are the only shots that show what the
  // layouts do when real data arrives.
  { name: "27-stress-overview-desktop", url: "/app.html", viewport: DESK, seed: stressSeed(), view: "overview" },
  { name: "28-stress-tracking-desktop", url: "/app.html", viewport: DESK, seed: stressSeed(), view: "tracking" },
  { name: "29-stress-runner-desktop", url: "/app.html", viewport: DESK, seed: stressSeed(), view: "runner" },
  { name: "30-stress-customer-home-phone", full: true, url: "/app.html", viewport: PHONE, seed: stressCustomerSeed(), view: "custhome" },

  // States that only exist after an interaction. Everything above is a view at rest.
  { name: "31-modal-shipment-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "overview",
    act: () => document.querySelector('#overview-table tr[data-id]').click() },
  { name: "32-command-palette-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "overview",
    act: () => document.getElementById("search-trigger").click() },
  { name: "33-notifications-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "overview",
    act: () => document.getElementById("notif-btn").click() },
  { name: "34-modal-shipment-dark", url: "/app.html", viewport: DESK, seed: dark(opsSeed()), view: "overview",
    act: () => document.querySelector('#overview-table tr[data-id]').click() },
  // The end of the customer's primary flow. Driven through the real three-step form rather
  // than by setting .is-success directly, so the confirmation shows what a real order
  // produces instead of an empty panel.
  { name: "35-order-success-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "order",
    act: () => {
      const f = document.getElementById("cust-order-form");
      // querySelector, not f.elements[n]: a repeated name yields a RadioNodeList, which
      // has no dispatchEvent.
      const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (!el) return;
        el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set("item", "Herman Miller Aeron chair, size B");
      set("value", "1290");
      f.querySelector("[data-next]").click();
      set("name", "Jane Doe"); set("address", "142 Birchwood Lane");
      set("city", "Dayton"); set("state", "OH"); set("zip", "45402");
      set("phone", "937-555-0142");
      f.querySelectorAll("[data-next]")[1].click();
      f.querySelector('[type="submit"]').click();
    } },

  // The entry point every user meets, and the two steps of the order form between the
  // first screen and the confirmation. None of these had ever been rendered.
  { name: "36-register-desktop", url: "/app.html", viewport: DESK },
  { name: "37-register-phone", full: true, url: "/app.html", viewport: PHONE },
  { name: "38-signin-phone", full: true, url: "/app.html", viewport: PHONE,
    act: () => document.querySelector("#login-alt .linkbtn")?.click() },
  { name: "39-order-step2-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "order",
    act: () => {
      const f = document.getElementById("cust-order-form");
      const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (!el) return;
        el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set("item", "Herman Miller Aeron chair, size B"); set("value", "1290");
      f.querySelector("[data-next]").click();
    } },
  { name: "40-order-step3-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "order",
    act: () => {
      const f = document.getElementById("cust-order-form");
      const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (!el) return;
        el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set("item", "Herman Miller Aeron chair, size B"); set("value", "1290");
      f.querySelector("[data-next]").click();
      set("name", "Jane Doe"); set("address", "142 Birchwood Lane");
      set("city", "Dayton"); set("state", "OH"); set("zip", "45402"); set("phone", "937-555-0142");
      f.querySelectorAll("[data-next]")[1].click();
    } },
  // What a customer sees when they get it wrong, and the prompt guarding a destructive
  // action. Both are states the app spends real time in and neither had been rendered.
  { name: "41-order-validation-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "order",
    act: () => document.querySelector("#cust-order-form [data-next]").click() },
  { name: "42-confirm-dialog-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "account",
    act: () => document.getElementById("acct-close").click() },
  // The two roles that work on a phone. Their screens were unreachable below 980px until
  // MOBILE_ROLES, so nothing had ever rendered them at the width they are actually used at.
  { name: "43-driver-phone", full: true, url: "/app.html", viewport: PHONE, seed: roleSeed("Driver"), view: "driver" },
  { name: "44-runner-phone", full: true, url: "/app.html", viewport: PHONE, seed: roleSeed("Runner"), view: "runner" },
  // Settings has three tabs and only the first had ever been rendered.
  { name: "45-settings-data-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "settings",
    act: () => document.querySelectorAll("#view-settings .tab-btn")[1].click() },
  { name: "46-settings-cloud-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "settings",
    act: () => document.querySelectorAll("#view-settings .tab-btn")[2].click() },
  // First run: the welcome tour a brand-new account meets before anything else, and its
  // last slide. Nothing had ever rendered either.
  { name: "47-welcome-slide1-phone", url: "/app.html", viewport: PHONE, seed: firstRunSeed(),
    act: () => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true })); };
      set("login-name", "Sam Reed"); set("login-email", "sam@example.com");
      set("login-password", "correct horse battery");
      document.getElementById("login-submit").click();
    } },
  { name: "48-welcome-slide3-phone", url: "/app.html", viewport: PHONE, seed: firstRunSeed(),
    act: () => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true })); };
      set("login-name", "Sam Reed"); set("login-email", "sam@example.com");
      set("login-password", "correct horse battery");
      document.getElementById("login-submit").click();
      setTimeout(() => { const n = document.getElementById("welcome-next"); n.click(); n.click(); }, 400);
    } },
];

if (!existsSync(OUT)) mkdirSync(OUT);

// Check the target is up first. Without this, goto() fails quietly and the first
// page.evaluate throws "Execution context was destroyed", which says nothing about the
// actual problem: the server is not running.
try {
  const probe = await fetch(BASE + "/", { method: "GET" });
  if (!probe.ok) throw new Error("HTTP " + probe.status);
} catch (e) {
  console.error(`Cannot reach ${BASE} (${e.message}).

Start the site first, then run this again:
  python -m http.server 8080
`);
  process.exit(2);
}

const failed = [];
const browser = await launch();
console.log("Rendering " + SHOTS.length + " screens from " + BASE + " into " + OUT + "/" + String.fromCharCode(10));

// One page for every shot. Opening a tab per shot -- each with its own request
// interception and its own evaluateOnNewDocument -- crashed the browser partway through
// once the list passed about 26 ("Session with given id not found"). The seed is written
// into localStorage and the page reloaded instead, which is what the app reads at boot.
const page = await browser.newPage();
// The service worker would serve a cached build and make a screenshot lie about the code
// under test.
await page.setBypassServiceWorker?.(true).catch?.(() => {});
let current = SHOTS[0];
await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url();
  const s = current.seed;
  // Public pages carry no seed and should reach the real static server.
  if (!s || !u.includes("/api/")) return req.continue();
  const j = (o) => req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  if (u.includes("/api/auth")) return j({ ok: true, token: s.auth.token, user: s.auth.user, verification: { available: true, sent: true } });
  // Only the signed-in account's own rows, which is all the real endpoint ever returns.
  // Returning another user's orders here duplicated them into the ops workspace and made
  // the screenshots lie.
  // A POST here is a customer placing an order. Answering it with {} made the client treat
  // the order as unsynced and queue it, so the success shot showed the offline path -- a
  // "Syncing…" pill and "we'll sync it once you're back online" -- rather than the normal
  // one. Echo back a stored order instead.
  if (u.includes("/api/my-orders")) {
    if (req.method() === "POST") {
      const body = (() => { try { return JSON.parse(req.postData() || "{}"); } catch (e) { return {}; } })();
      // A full package, not just an echo of the payload. showOrderSuccess() reads
      // order.customer.name, so a partial object throws inside the success handler and the
      // client's catch treats it as a network failure -- which is how this shot ended up
      // showing "we'll sync it once you're back online" instead of the confirmation.
      const now = Date.now();
      return j({ ok: true, order: {
        id: "GL-1044", status: "Won", source: "Customer Order", orderRef: "#10412",
        barcode: "GL1044", carrier: null, lane: null, batchId: null, tracking: null, photos: {},
        item: { description: body.item || "Item", value: parseInt(body.value, 10) || 0, weight: 24 },
        customer: { name: body.name || "-", address: body.address || "", city: body.city || "",
          state: body.state || "", zip: body.zip || "", phone: body.phone || "" },
        history: [{ stage: "Won", ts: now, note: "Order received." }],
        promisedTs: now + 3 * 86400000, exception: null, customerEmail: s.auth.user.email,
      } });
    }
    return j({ ok: true, orders: s.state.packages.filter((p) => p.customerEmail === s.auth.user.email) });
  }
  if (u.includes("/api/push")) return j({ ok: true, configured: false, publicKey: null });
  if (u.includes("/api/state")) return j(s.state);
  if (u.includes("/api/admin")) return j({ ok: true, you: s.auth.user.email, admins: 1,
    users: [
      { email: "ops@example.com", name: "Ken Filbert", role: "Admin", source: "env", grantedBy: null, grantedAt: null, createdAt: null },
      { email: "dana@example.com", name: "Dana Ruiz", role: "Runner", source: "granted", grantedBy: "ops@example.com", grantedAt: "2026-08-10T09:00:00Z", createdAt: null },
      { email: "jane@example.com", name: "Jane Doe", role: "Customer", source: "default", grantedBy: null, grantedAt: null, createdAt: null },
    ],
    audit: [{ email: "dana@example.com", from: "Customer", to: "Runner", by: "ops@example.com", at: "2026-08-10T09:00:00Z" }] });
  return j({});
});

// A shot used to fail sporadically and get silently skipped, leaving the PREVIOUS run's
// PNG on disk -- indistinguishable from a fresh one, which quietly invalidates whatever
// the screenshot was meant to prove. The cause was response.ok(), which is false for a
// 304: the static server returns Not Modified whenever the browser revalidates an
// unchanged file, so a perfectly good navigation read as a failure. Any status under 400
// is a successful load. The retry stays as cheap insurance.
const loaded = (r) => r && r.status() < 400;
const nav = async (url) => {
  let resp = null;
  for (let attempt = 1; attempt <= 3 && !loaded(resp); attempt++) {
    resp = await page.goto(BASE + url, { waitUntil: "load", timeout: 30000 }).catch(() => null);
    if (!loaded(resp) && attempt < 3) await new Promise((r) => setTimeout(r, 400));
  }
  return loaded(resp);
};

for (const shot of SHOTS) {
  current = shot;
  await page.setViewport(shot.viewport);

  // Load once to get an origin to write against, then set or clear the seed and reload.
  // Clearing matters: track.html falls back to localStorage when /api/track is
  // unavailable, so a previous shot's packages would otherwise leak into it.
  if (!await nav(shot.url)) {
    rmSync(OUT + "/" + shot.name + ".png", { force: true });
    console.error("  " + shot.name + ": FAILED after 3 attempts, " + shot.url + " did not load (stale PNG deleted)");
    failed.push(shot.name);
    continue;
  }
  await page.evaluate((seed) => {
    localStorage.clear();
    if (!seed) return;
    // A first-run shot has to arrive at the login screen and register for real: the welcome
    // tour is only shown on a successful registration, not on a fresh load. So it writes
    // neither the session nor gl-onboarded, and its `act` drives the form.
    if (seed.firstRun) { localStorage.setItem("granite-logistics-state-v1", JSON.stringify(seed.state)); return; }
    localStorage.setItem("gl-auth-v2", JSON.stringify(seed.auth));
    localStorage.setItem("gl-onboarded", "1");
    localStorage.setItem("granite-logistics-state-v1", JSON.stringify(seed.state));
  }, shot.seed || null);
  if (!await nav(shot.url)) {
    rmSync(OUT + "/" + shot.name + ".png", { force: true });
    console.error("  " + shot.name + ": FAILED, reload after seeding did not load (stale PNG deleted)");
    failed.push(shot.name);
    continue;
  }

  if (shot.view) {
    await page.evaluate((v) => {
      const el = document.querySelector('[data-bn="' + v + '"]') || document.querySelector('.nav-item[data-view="' + v + '"]');
      if (el) el.click();
    }, shot.view);
  }
  // Anything that only exists after an interaction -- a modal, the command palette, the
  // notification panel, the order-success panel. Without this every shot is a default
  // view state, and the states a user spends real time in are never looked at.
  if (shot.act) {
    await new Promise((r) => setTimeout(r, 450));
    await page.evaluate(shot.act);
  }
  // Let entrance animations settle so nothing is caught mid-fade.
  await new Promise((r) => setTimeout(r, 900));

  const path = OUT + "/" + shot.name + ".png";
  // Phone views scroll, so a viewport-only shot hides everything below the fold --
  // which is where a sign-out button or a form's last field tends to live.
  await page.screenshot({ path, fullPage: shot.full !== undefined ? shot.full : !shot.view });
  console.log("  " + path);
}

await browser.close();

// Exit non-zero on any failure. A run that reports success while a screen is missing
// invites reviewing a screenshot that was never taken.
if (failed.length) {
  console.error("\n" + failed.length + " of " + SHOTS.length + " screens FAILED: " + failed.join(", "));
  console.error("Re-run to retry. Do not trust shots/ until this is clean.\n");
  process.exit(1);
}
console.log("\nAll " + SHOTS.length + " screens rendered into " + OUT + "/\n");
