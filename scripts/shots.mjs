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
import { customerSeed, opsSeed, emptyCustomerSeed, emptyOpsSeed, dark, stressSeed, stressCustomerSeed } from "./_seeds.mjs";

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
  { name: "07-customer-account-phone", full: true, url: "/app.html", viewport: PHONE, seed: customerSeed(false), view: "account" },
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

  // A shot used to fail sporadically and get silently skipped, leaving the PREVIOUS run's
  // PNG on disk -- indistinguishable from a fresh one, which quietly invalidates whatever
  // the screenshot was meant to prove. The cause was response.ok(), which is false for a
  // 304: the static server returns Not Modified whenever the browser revalidates an
  // unchanged file, so a perfectly good navigation read as a failure. Any status under 400
  // is a successful load. The retry stays as cheap insurance.
  const loaded = (r) => r && r.status() < 400;
  let resp = null;
  for (let attempt = 1; attempt <= 3 && !loaded(resp); attempt++) {
    resp = await page.goto(BASE + shot.url, { waitUntil: "load", timeout: 30000 }).catch(() => null);
    if (!loaded(resp) && attempt < 3) await new Promise((r) => setTimeout(r, 400));
  }
  if (!loaded(resp)) {
    // Remove the stale file so a failure can never be mistaken for a current render.
    rmSync(OUT + "/" + shot.name + ".png", { force: true });
    console.error("  " + shot.name + ": FAILED after 3 attempts, " + shot.url + " did not load (stale PNG deleted)");
    failed.push(shot.name);
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
  // Phone views scroll, so a viewport-only shot hides everything below the fold --
  // which is where a sign-out button or a form's last field tends to live.
  await page.screenshot({ path, fullPage: shot.full !== undefined ? shot.full : !shot.view });
  console.log("  " + path);
  await page.close();
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
