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
import puppeteer from "puppeteer";
import { mkdirSync, existsSync } from "node:fs";

const BASE = process.env.GL_BASE || "http://localhost:8080";
const OUT = "shots";

// Puppeteer's bundled Chromium is often absent on a dev machine; fall back to whatever
// browser is installed, which is what server/server.js does for label rendering too.
const CANDIDATES = [
  process.env.GL_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

async function launch() {
  try { return await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] }); }
  catch (e) { /* fall through to a system browser */ }
  for (const executablePath of CANDIDATES) {
    try { return await puppeteer.launch({ headless: "new", executablePath, args: ["--no-sandbox"] }); }
    catch (e) { /* try the next one */ }
  }
  throw new Error("No usable browser found. Set GL_CHROME to a Chrome or Edge executable.");
}

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { width: 1440, height: 900, deviceScaleFactor: 1 };

// A signed-in customer with a few orders in varied states, so lists are not empty and the
// status pills are all exercised.
const customerSeed = (verified = true) => ({
  auth: { token: "shot-token", user: { email: "jane@example.com", name: "Jane Doe", role: "Customer", emailVerified: verified } },
  state: {
    settings: { role: "Customer", roleChosen: true },
    packages: [
      pkg(1, "OutforDelivery", "UPS", "LG 55\" OLED TV", 1299),
      pkg(2, "InTransit", "FedEx", "Herman Miller Aeron chair", 890),
      pkg(3, "Delivered", "UPS", "Sonos Arc soundbar", 799),
    ],
    manifests: [], loadUnits: [], events: [],
  },
});

const opsSeed = () => ({
  auth: { token: "shot-token", user: { email: "ops@example.com", name: "Ken Filbert", role: "Admin", emailVerified: true } },
  state: {
    settings: { role: "Admin", roleChosen: true, cloud: { url: "", key: "granite-dev-key", autoSync: false } },
    packages: [
      pkg(1, "OutforDelivery", "UPS", "LG 55\" OLED TV", 1299),
      pkg(2, "InTransit", "FedEx", "Herman Miller Aeron chair", 890),
      pkg(3, "Delivered", "UPS", "Sonos Arc soundbar", 799),
      pkg(4, "Staged", "UPS", "Dyson V15 vacuum", 649),
      pkg(5, "PickedUp", null, "Weber Genesis grill", 1099),
      pkg(6, "Won", null, "Samsung 980 Pro 2TB SSD", 199),
    ],
    manifests: [], loadUnits: [], events: [],
  },
});

function pkg(n, status, carrier, description, value) {
  const now = Date.now();
  const cities = [["Dayton", "OH", "45402"], ["Columbus", "OH", "43004"], ["Cincinnati", "OH", "45202"]];
  const c = cities[n % cities.length];
  const names = ["Jane Doe", "Marcus Webb", "Priya Raman", "Tom Ellery", "Sara Nolan", "Devin Cross"];
  return {
    id: "GL-10" + (40 + n), status, source: n <= 3 ? "Customer Order" : "API",
    orderRef: "#" + (10000 + n * 137), barcode: "GL10" + (40 + n),
    carrier, lane: carrier ? "Lane 2" : null, batchId: carrier ? "BATCH-70" + n : null,
    tracking: carrier === "UPS" ? "1Z999AA1012345678" + n : carrier === "FedEx" ? "7712 3456 789" + n : null,
    item: { description, value, weight: 12 + n * 4 }, photos: {},
    customer: { name: names[n - 1] || "Jane Doe", address: (100 + n * 7) + " Birchwood Lane",
      city: c[0], state: c[1], zip: c[2], phone: "937-555-01" + (10 + n) },
    history: [{ stage: "Won", ts: now - 86400000 * 3, note: "Order received." }],
    promisedTs: now + 86400000 * 2, exception: null,
    customerEmail: n <= 3 ? "jane@example.com" : null,
  };
}

const SHOTS = [
  { name: "01-landing-desktop", url: "/", viewport: DESK },
  { name: "02-landing-phone", url: "/", viewport: PHONE },
  { name: "03-privacy-desktop", url: "/privacy.html", viewport: DESK },
  { name: "04-track-desktop", url: "/track.html?n=GL-1041", viewport: DESK },
  { name: "05-customer-home-phone", url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "custhome" },
  { name: "06-customer-order-phone", url: "/app.html", viewport: PHONE, seed: customerSeed(), view: "order" },
  { name: "07-customer-account-phone", url: "/app.html", viewport: PHONE, seed: customerSeed(false), view: "account" },
  { name: "08-ops-overview-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "overview" },
  { name: "09-ops-tracking-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "tracking" },
  { name: "10-ops-roles-desktop", url: "/app.html", viewport: DESK, seed: opsSeed(), view: "admin" },
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

const browser = await launch();
console.log("Rendering " + SHOTS.length + " screens from " + BASE + " into " + OUT + "/\n");

for (const shot of SHOTS) {
  const page = await browser.newPage();
  await page.setViewport(shot.viewport);
  // The service worker would serve a cached build and make a screenshot lie about the
  // code under test.
  await page.setBypassServiceWorker?.(true).catch?.(() => {});

  if (shot.seed) {
    const s = shot.seed;
    await page.evaluateOnNewDocument((auth, state) => {
      localStorage.setItem("gl-auth-v2", JSON.stringify(auth));
      localStorage.setItem("gl-onboarded", "1");
      localStorage.setItem("granite-logistics-state-v1", JSON.stringify(state));
    }, s.auth, s.state);
    // Answer the app's API calls so nothing renders an error state.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/api/auth")) return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, user: s.auth.user, verification: { available: true, sent: false } }) });
      if (u.includes("/api/my-orders")) return req.respond({ status: 200, contentType: "application/json",
        // Only the signed-in account's own rows, which is all the real endpoint ever
        // returns. Returning another user's orders here duplicated them into the ops
        // workspace and made the screenshots lie.
        body: JSON.stringify({ ok: true, orders: s.state.packages.filter((p) => p.customerEmail === s.auth.user.email) }) });
      if (u.includes("/api/push")) return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, configured: false, publicKey: null }) });
      if (u.includes("/api/state")) return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(s.state) });
      if (u.includes("/api/admin")) return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, you: s.auth.user.email, admins: 1,
        users: [
          { email: "ops@example.com", name: "Ken Filbert", role: "Admin", source: "env", grantedBy: null, grantedAt: null, createdAt: null },
          { email: "dana@example.com", name: "Dana Ruiz", role: "Runner", source: "granted", grantedBy: "ops@example.com", grantedAt: "2026-08-10T09:00:00Z", createdAt: null },
          { email: "jane@example.com", name: "Jane Doe", role: "Customer", source: "default", grantedBy: null, grantedAt: null, createdAt: null },
        ],
        audit: [{ email: "dana@example.com", from: "Customer", to: "Runner", by: "ops@example.com", at: "2026-08-10T09:00:00Z" }] }) });
      if (u.includes("/api/")) return req.respond({ status: 200, contentType: "application/json", body: "{}" });
      return req.continue();
    });
  }

  const resp = await page.goto(BASE + shot.url, { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => {
    console.error("  " + shot.name + ": navigation failed - " + e.message);
    return null;
  });
  if (!resp || !resp.ok()) {
    console.error("  " + shot.name + ": skipped, " + shot.url + " did not load");
    await page.close();
    continue;
  }
  if (shot.view) {
    await page.evaluate((v) => {
      const el = document.querySelector('[data-bn="' + v + '"]') || document.querySelector('.nav-item[data-view="' + v + '"]');
      if (el) el.click();
    }, shot.view);
  }
  // Let entrance animations settle so nothing is caught mid-fade.
  await new Promise((r) => setTimeout(r, 900));

  const path = OUT + "/" + shot.name + ".png";
  await page.screenshot({ path, fullPage: !shot.view });
  console.log("  " + path);
  await page.close();
}

await browser.close();
console.log("\nDone. Open the files in " + OUT + "/\n");
