// Audit text contrast against WCAG 2.1 AA across every view, in both themes.
//
//   npm run contrast
//
// This exists because dark mode shipped with a theme toggle in the header and no screen had
// ever been rendered with it on. `.btn` hard-codes background:#fff and the dark block never
// overrode it, so every secondary button was #b7c2d0 text on white -- 1.75:1, against a
// 4.5:1 requirement. Eyeballing screenshots found that one; only measuring finds the rest.
//
// AA thresholds: 4.5:1 for body text, 3:1 for large text (>=24px, or >=18.66px bold).
// Disabled controls are exempt under 1.4.3 and are skipped.
import { launch } from "./_browser.mjs";
import { customerSeed, opsSeed, dark } from "./_seeds.mjs";

const BASE = process.env.GL_BASE || "http://localhost:8080";
const MIN = Number(process.env.GL_MIN_RATIO || 0);   // set to e.g. 3 to see only bad ones

const OPS_VIEWS = ["overview", "ingest", "runner", "presort", "batch", "driver", "returns",
                   "tracking", "reports", "activity", "settings", "admin"];
const CUST_VIEWS = ["custhome", "order", "account"];

const SCENARIOS = [
  ...OPS_VIEWS.map((v) => ({ label: "ops/" + v + "/light", seed: opsSeed(), view: v, mobile: false })),
  ...OPS_VIEWS.map((v) => ({ label: "ops/" + v + "/dark", seed: dark(opsSeed()), view: v, mobile: false })),
  ...CUST_VIEWS.map((v) => ({ label: "cust/" + v + "/light", seed: customerSeed(false), view: v, mobile: true })),
  ...CUST_VIEWS.map((v) => ({ label: "cust/" + v + "/dark", seed: dark(customerSeed(false)), view: v, mobile: true })),
];

try {
  const probe = await fetch(BASE + "/");
  if (!probe.ok) throw new Error("HTTP " + probe.status);
} catch (e) {
  console.error(`Cannot reach ${BASE} (${e.message}). Start the site first:\n  python -m http.server 8080\n`);
  process.exit(2);
}

// Runs in the page. Walks every element that renders its own text, resolves the effective
// background by climbing ancestors through transparent fills, and returns AA failures.
function audit() {
  const lum = (r, g, b) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  // Flatten a translucent colour over an opaque one.
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  // getComputedStyle reports a gradient or image background as backgroundColor
  // rgba(0,0,0,0), so climbing past one lands on whatever opaque colour sits behind it and
  // measures against the wrong ground. .scan-window paints a dark repeating-linear-gradient
  // inside a white card, which made its light-on-dark hint text look like a failure against
  // white. Flag those as unmeasurable rather than reporting a ratio we cannot compute.
  const bgOf = (el) => {
    let cur = el, acc = null, painted = false;
    while (cur) {
      const cs = getComputedStyle(cur);
      if (cs.backgroundImage && cs.backgroundImage !== "none") painted = true;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) {
        acc = acc ? over(acc, c) : c;
        if (acc.a >= 0.999) return { bg: acc, painted };
      }
      cur = cur.parentElement;
    }
    return { bg: acc && acc.a >= 0.999 ? acc : { r: 255, g: 255, b: 255, a: 1 }, painted };
  };
  const ratio = (a, b) => {
    const l1 = lum(a.r, a.g, a.b), l2 = lum(b.r, b.g, b.b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const out = [];
  document.querySelectorAll("*").forEach((el) => {
    // Only elements holding their own visible text.
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (el.disabled || el.closest("[disabled]")) return;   // 1.4.3 exempts disabled controls
    const fgRaw = parse(cs.color);
    if (!fgRaw) return;
    const { bg, painted } = bgOf(el);
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    const px = parseFloat(cs.fontSize);
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) {
      out.push({
        got: Math.round(got * 100) / 100, need, painted,
        text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 46),
        sel: el.tagName.toLowerCase() + (el.className && typeof el.className === "string"
          ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""),
        color: cs.color, background: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(",") + ")",
        px: Math.round(px),
      });
    }
  });
  return out;
}

const browser = await launch();
const findings = new Map();     // dedupe: same selector+colours reported once per theme

// One page for all 30 scenarios. Opening a tab each — with request interception on every
// one — crashed the browser partway through ("Session with given id not found"), and each
// evaluateOnNewDocument would have stacked up on the same page anyway. Instead the seed is
// written into localStorage and the page reloaded, which is what the app reads at boot.
const page = await browser.newPage();
// Once sw.js activates it serves the navigation itself, and page.goto() then resolves to
// null because no network response was produced -- which read as a load failure for every
// scenario after the first two. Bypassing the worker also means we audit the code on disk
// rather than whatever the worker had cached.
await page.setBypassServiceWorker(true).catch(() => {});
let current = SCENARIOS[0];
await page.setRequestInterception(true);
page.on("request", (req) => {
  const u = req.url();
  const seed = current.seed;
  const j = (o) => req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  if (u.includes("/api/auth")) return j({ ok: true, user: seed.auth.user, verification: { available: true, sent: false } });
  if (u.includes("/api/my-orders")) return j({ ok: true, orders: seed.state.packages.filter((p) => p.customerEmail === seed.auth.user.email) });
  if (u.includes("/api/push")) return j({ ok: true, configured: false, publicKey: null });
  if (u.includes("/api/admin")) return j({ ok: true, you: seed.auth.user.email, admins: 1,
    users: [{ email: "dana@example.com", name: "Dana Ruiz", role: "Runner", source: "granted", grantedBy: "ops@example.com", grantedAt: "2026-08-10T09:00:00Z", createdAt: null }], audit: [] });
  if (u.includes("/api/")) return j({});
  return req.continue();
});

// response.ok() is only true for 200-299, but a reload of an unchanged file gets a 304 from
// the static server, which is a successful navigation. Checking ok() made every scenario
// after the first look like a load failure.
const loaded = (r) => r && r.status() < 400;
const nav = async (opts) => {
  for (let i = 1; i <= 3; i++) {
    const r = await page.goto(BASE + "/app.html", { waitUntil: "load", timeout: 30000, ...opts }).catch(() => null);
    if (loaded(r)) return r;
  }
  return null;
};

let skipped = 0;
for (const sc of SCENARIOS) {
  current = sc;
  await page.setViewport(sc.mobile
    ? { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
    : { width: 1440, height: 900, deviceScaleFactor: 1 });

  // Load once to get an origin we can write localStorage against, seed it, then reload so
  // the app boots from the seeded state.
  if (!await nav()) { console.error("  " + sc.label + ": page did not load, skipped"); skipped++; continue; }
  await page.evaluate((auth, state) => {
    localStorage.setItem("gl-auth-v2", JSON.stringify(auth));
    localStorage.setItem("gl-onboarded", "1");
    localStorage.setItem("granite-logistics-state-v1", JSON.stringify(state));
  }, sc.seed.auth, sc.seed.state);
  if (!await nav()) { console.error("  " + sc.label + ": reload failed, skipped"); skipped++; continue; }

  await new Promise((r) => setTimeout(r, 500));
  const opened = await page.evaluate((v) => {
    const el = document.querySelector('[data-bn="' + v + '"]') || document.querySelector('.nav-item[data-view="' + v + '"]');
    if (el) { el.click(); return true; }
    return false;
  }, sc.view);
  if (!opened) { console.error("  " + sc.label + ": no nav control for this view, skipped"); skipped++; continue; }
  await new Promise((r) => setTimeout(r, 600));

  const rows = await page.evaluate(audit);
  const theme = sc.label.endsWith("/dark") ? "dark" : "light";
  for (const r of rows) {
    if (r.got < MIN) continue;
    const key = theme + "|" + r.sel + "|" + r.color + "|" + r.background;
    if (!findings.has(key)) findings.set(key, { ...r, theme, where: [sc.label] });
    else findings.get(key).where.push(sc.label);
  }
}
await browser.close();
if (skipped) console.error("\n" + skipped + " of " + SCENARIOS.length + " scenarios were skipped; coverage is incomplete.");

const every = [...findings.values()].sort((a, b) => a.got - b.got);
const all = every.filter((f) => !f.painted);
const unmeasured = every.filter((f) => f.painted);

// Reported, never hidden: an element on a gradient has a real contrast ratio, we just
// cannot compute it here. Staying quiet about it would be the same silent-pass trap as a
// screenshot that never rendered.
if (unmeasured.length) {
  console.log("\n" + unmeasured.length + " element(s) sit on a gradient or image background,"
    + " which getComputedStyle cannot read. Check by eye:\n");
  for (const f of unmeasured) {
    console.log(`  ${f.sel}  ${f.px}px  ${f.color}  "${f.text}"`);
    console.log(`      ${f.where.length} view(s): ${f.where.slice(0, 3).join(", ")}`);
  }
}
if (!all.length) {
  console.log("\nNo measurable AA contrast failures across " + SCENARIOS.length + " view/theme combinations.\n");
  process.exit(0);
}
console.log("\n" + all.length + " distinct AA contrast failure(s) across " + SCENARIOS.length + " view/theme combinations:\n");
for (const f of all) {
  console.log(`  ${f.got.toFixed(2)}:1  (needs ${f.need}:1)  [${f.theme}]  ${f.sel}  ${f.px}px`);
  console.log(`      ${f.color} on ${f.background}`);
  console.log(`      "${f.text}"`);
  console.log(`      ${f.where.length} view(s): ${f.where.slice(0, 4).join(", ")}${f.where.length > 4 ? ", …" : ""}`);
}
console.log("");
process.exit(1);
