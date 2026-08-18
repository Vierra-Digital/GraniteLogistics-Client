// Audit layout geometry across every view at several viewport widths.
//
//   npm run layout
//
// The geometry counterpart to contrast.mjs. Past bugs of exactly this shape: an order form
// laying out 780px wide inside a 375px viewport, a driver row 792px wide in a 647px track,
// and a search input clipping its own placeholder to "Search id, customer, cit". Each was
// found by eye, one at a time, on one screen. This measures all of them at once.
//
// Three checks:
//   page-overflow   the document scrolls horizontally -- the page is wider than the screen
//   clipped-text    content is cut off with no ellipsis and no way to scroll to it
//   out-of-bounds   an element's box extends past its container's padding edge
//
// Deliberate truncation (text-overflow: ellipsis) and deliberate scrolling
// (overflow-x: auto/scroll) are not failures and are skipped.
import { launch } from "./_browser.mjs";
import { customerSeed, opsSeed, dark, stressSeed, stressCustomerSeed, roleSeed } from "./_seeds.mjs";

const BASE = process.env.GL_BASE || "http://localhost:8080";

// The app locks the customer experience to <=980px and the operator platform above it, so
// each is measured at the widths it actually ships at -- including just either side of the
// 980px boundary, where a layout swap is easy to get wrong.
const OPS_VIEWS = ["overview", "ingest", "runner", "presort", "batch", "driver", "returns",
                   "tracking", "reports", "activity", "settings", "admin"];
const CUST_VIEWS = ["custhome", "order", "account"];
const OPS_WIDTHS = [981, 1024, 1280, 1440, 1920];
const CUST_WIDTHS = [320, 360, 390, 414, 768, 980];

const SCENARIOS = [
  ...OPS_VIEWS.flatMap((v) => OPS_WIDTHS.map((w) => ({ view: v, w, h: 900, mobile: false, seed: opsSeed(), label: `ops/${v}@${w}` }))),
  ...CUST_VIEWS.flatMap((v) => CUST_WIDTHS.map((w) => ({ view: v, w, h: 844, mobile: w < 768, seed: customerSeed(), label: `cust/${v}@${w}` }))),
  // One dark pass: a theme should not change geometry, and if it does that is worth knowing.
  ...OPS_VIEWS.map((v) => ({ view: v, w: 1280, h: 900, mobile: false, seed: dark(opsSeed()), label: `ops/${v}@1280/dark` })),
  // Worst-case content at the tightest width each audience ships at, plus one roomy width
  // to separate "this layout cannot hold long content" from "this layout is just narrow".
  ...OPS_VIEWS.flatMap((v) => [981, 1440].map((w) =>
    ({ view: v, w, h: 900, mobile: false, seed: stressSeed(), label: `stress-ops/${v}@${w}` }))),
  ...CUST_VIEWS.flatMap((v) => [320, 390].map((w) =>
    ({ view: v, w, h: 844, mobile: true, seed: stressCustomerSeed(), label: `stress-cust/${v}@${w}` }))),
  // Driver and Runner on a phone: a supported configuration, so it is measured like one.
  ...["home", "driver", "tracking"].flatMap((v) => [320, 390].map((w) =>
    ({ view: v, w, h: 844, mobile: true, seed: roleSeed("Driver"), label: `driver/${v}@${w}` }))),
  ...["home", "runner", "presort", "tracking"].flatMap((v) => [320, 390].map((w) =>
    ({ view: v, w, h: 844, mobile: true, seed: roleSeed("Runner"), label: `runner/${v}@${w}` }))),
];

try {
  const probe = await fetch(BASE + "/");
  if (!probe.ok) throw new Error("HTTP " + probe.status);
} catch (e) {
  console.error(`Cannot reach ${BASE} (${e.message}). Start the site first:\n  python -m http.server 8080\n`);
  process.exit(2);
}

function audit() {
  const out = [];
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
    (el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "");
  const scroller = document.scrollingElement;

  if (scroller.scrollWidth > scroller.clientWidth + 1) {
    out.push({ kind: "page-overflow", sel: "document", detail:
      scroller.scrollWidth + "px of content in a " + scroller.clientWidth + "px viewport" });
  }

  document.querySelectorAll("body *").forEach((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;

    const scrollable = ["auto", "scroll"].includes(cs.overflowX);
    const ellipsis = cs.textOverflow === "ellipsis";
    // Content wider than the box, with no ellipsis to signal it and no way to scroll to it.
    if (!scrollable && !ellipsis && el.scrollWidth > el.clientWidth + 1 && cs.overflowX === "hidden") {
      out.push({ kind: "clipped-text", sel: sel(el), detail:
        el.scrollWidth + "px of content in a " + el.clientWidth + "px box",
        text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) });
    }

    // Escaping the container. Measured against the parent's padding box, and only when the
    // parent is not itself a scroll container.
    const p = el.parentElement;
    if (p && p !== document.body) {
      const pcs = getComputedStyle(p);
      if (!["auto", "scroll"].includes(pcs.overflowX) && pcs.position !== "absolute" && cs.position !== "fixed" && cs.position !== "absolute") {
        const pr = p.getBoundingClientRect();
        const padR = parseFloat(pcs.paddingRight) || 0;
        const over = Math.round(r.right - (pr.right - padR));
        if (over > 1) {
          out.push({ kind: "out-of-bounds", sel: sel(el), detail:
            "extends " + over + "px past " + sel(p),
            text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) });
        }
      }
    }
  });
  return out;
}

const browser = await launch();
const page = await browser.newPage();
await page.setBypassServiceWorker(true).catch(() => {});
let current = SCENARIOS[0];
await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url(), seed = current.seed;
  const j = (o) => req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  if (u.includes("/api/auth")) return j({ ok: true, user: seed.auth.user, verification: { available: true, sent: false } });
  if (u.includes("/api/my-orders")) return j({ ok: true, orders: seed.state.packages.filter((p) => p.customerEmail === seed.auth.user.email) });
  if (u.includes("/api/push")) return j({ ok: true, configured: false, publicKey: null });
  if (u.includes("/api/admin")) return j({ ok: true, you: seed.auth.user.email, admins: 1,
    users: [{ email: "dana@example.com", name: "Dana Ruiz", role: "Runner", source: "granted", grantedBy: "ops@example.com", grantedAt: "2026-08-10T09:00:00Z", createdAt: null }], audit: [] });
  if (u.includes("/api/")) return j({});
  return req.continue();
});

const loaded = (r) => r && r.status() < 400;
const nav = async () => {
  for (let i = 1; i <= 3; i++) {
    const r = await page.goto(BASE + "/app.html", { waitUntil: "load", timeout: 30000 }).catch(() => null);
    if (loaded(r)) return r;
  }
  return null;
};

const findings = new Map();
let skipped = 0;
for (const sc of SCENARIOS) {
  current = sc;
  await page.setViewport({ width: sc.w, height: sc.h, deviceScaleFactor: 1, isMobile: sc.mobile, hasTouch: sc.mobile });
  if (!await nav()) { console.error("  " + sc.label + ": did not load, skipped"); skipped++; continue; }
  await page.evaluate((auth, state) => {
    localStorage.setItem("gl-auth-v2", JSON.stringify(auth));
    localStorage.setItem("gl-onboarded", "1");
    localStorage.setItem("granite-logistics-state-v1", JSON.stringify(state));
  }, sc.seed.auth, sc.seed.state);
  if (!await nav()) { console.error("  " + sc.label + ": reload failed, skipped"); skipped++; continue; }
  await new Promise((r) => setTimeout(r, 400));
  const opened = await page.evaluate((v) => {
    const el = document.querySelector('[data-bn="' + v + '"]') || document.querySelector('.nav-item[data-view="' + v + '"]');
    if (el) { el.click(); return true; }
    return false;
  }, sc.view);
  if (!opened) { console.error("  " + sc.label + ": no nav control, skipped"); skipped++; continue; }
  await new Promise((r) => setTimeout(r, 500));

  for (const f of await page.evaluate(audit)) {
    const key = f.kind + "|" + f.sel + "|" + f.detail;
    if (!findings.has(key)) findings.set(key, { ...f, where: [sc.label] });
    else findings.get(key).where.push(sc.label);
  }
}
await browser.close();
if (skipped) console.error("\n" + skipped + " of " + SCENARIOS.length + " scenarios were skipped; coverage is incomplete.");

const all = [...findings.values()];
const order = { "page-overflow": 0, "clipped-text": 1, "out-of-bounds": 2 };
all.sort((a, b) => (order[a.kind] - order[b.kind]) || b.where.length - a.where.length);

if (!all.length) {
  console.log("\nNo layout problems across " + SCENARIOS.length + " view/width combinations.\n");
  process.exit(0);
}
console.log("\n" + all.length + " distinct layout problem(s) across " + SCENARIOS.length + " view/width combinations:\n");
for (const f of all) {
  console.log(`  [${f.kind}] ${f.sel}`);
  console.log(`      ${f.detail}`);
  if (f.text) console.log(`      "${f.text}"`);
  console.log(`      ${f.where.length} case(s): ${f.where.slice(0, 5).join(", ")}${f.where.length > 5 ? ", …" : ""}`);
}
console.log("");
process.exit(1);
