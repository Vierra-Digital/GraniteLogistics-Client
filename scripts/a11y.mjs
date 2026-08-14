// Audit semantics and keyboard reachability across every view and public page.
//
//   npm run a11y
//
// The third audit, after contrast (colour) and layout (geometry). Those two measure what a
// sighted mouse user sees. This one covers what a screen reader announces and what a
// keyboard can reach -- neither of which shows up in a screenshot, which is how the app
// once shipped 39 unlabelled form controls without anybody noticing.
//
// Checks, all of them things that are unambiguously wrong rather than matters of taste:
//   no-accessible-name   a control a screen reader can only announce as "button"
//   img-no-alt           an <img> with no alt attribute at all (alt="" is correct for decor)
//   heading-skip         h1 -> h3, which breaks heading navigation
//   duplicate-id         two elements sharing an id; aria references then resolve to one
//   dangling-aria        aria-labelledby/describedby/controls pointing at a missing id
//   positive-tabindex    tabindex > 0, which overrides document order for the whole page
//   label-not-associated a form control with no label, aria-label or aria-labelledby
//   unreachable-control  a visible control that cannot be tabbed to
//   mouse-only-control   cursor:pointer on something neither focusable nor interactive
//   dialog-not-modal     role=dialog without aria-modal, so the page behind stays live
//   dialog-unnamed       a dialog with no accessible name
import { launch } from "./_browser.mjs";
import { customerSeed, opsSeed, roleSeed } from "./_seeds.mjs";

const BASE = process.env.GL_BASE || "http://localhost:8080";

const OPS_VIEWS = ["overview", "ingest", "runner", "presort", "batch", "driver", "returns",
                   "tracking", "reports", "activity", "settings", "admin"];
const CUST_VIEWS = ["custhome", "order", "account"];
const STATIC = ["/index.html", "/track.html?n=GL-1041", "/privacy.html", "/terms.html"];

const SCENARIOS = [
  ...OPS_VIEWS.map((v) => ({ label: "ops/" + v, seed: opsSeed(), view: v, mobile: false })),
  ...CUST_VIEWS.map((v) => ({ label: "cust/" + v, seed: customerSeed(false), view: v, mobile: true })),
  ...["home", "driver", "tracking"].map((v) => ({ label: "driver-phone/" + v, seed: roleSeed("Driver"), view: v, mobile: true })),
  ...["home", "runner", "presort", "tracking"].map((v) => ({ label: "runner-phone/" + v, seed: roleSeed("Runner"), view: v, mobile: true })),
  ...STATIC.map((u) => ({ label: "public" + u.split("?")[0], staticUrl: u, mobile: false })),
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
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const add = (kind, el, detail) => out.push({ kind, sel: sel(el), detail });

  // An accessible name from any of the usual sources.
  const nameOf = (el) => {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id))
        .filter(Boolean).map((n) => n.textContent.trim()).join(" ").trim();
      if (t) return t;
    }
    // Text content, but ignore anything marked decorative.
    const clone = el.cloneNode(true);
    clone.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
    const txt = (clone.textContent || "").trim();
    if (txt) return txt;
    const title = (el.getAttribute("title") || "").trim();
    if (title) return title;
    if (el.tagName === "INPUT" && el.value && ["submit", "button", "reset"].includes(el.type)) return el.value;
    const img = el.querySelector("img[alt]");
    if (img && img.alt.trim()) return img.alt.trim();
    return "";
  };

  document.querySelectorAll("button, a[href], [role='button']").forEach((el) => {
    if (!visible(el)) return;
    if (!nameOf(el)) add("no-accessible-name", el, "announced only as its role");
  });

  document.querySelectorAll("img").forEach((el) => {
    if (!el.hasAttribute("alt")) add("img-no-alt", el, "src=" + (el.getAttribute("src") || "").slice(-40));
  });

  // Heading order, over visible headings only.
  let prev = 0;
  document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    if (!visible(h)) return;
    const lvl = +h.tagName[1];
    if (prev && lvl > prev + 1) {
      add("heading-skip", h, "h" + prev + " -> h" + lvl + ': "' + h.textContent.trim().slice(0, 34) + '"');
    }
    prev = lvl;
  });

  const seen = new Map();
  document.querySelectorAll("[id]").forEach((el) => {
    const id = el.id;
    if (seen.has(id)) add("duplicate-id", el, "id=" + id + " also on " + sel(seen.get(id)));
    else seen.set(id, el);
  });

  ["aria-labelledby", "aria-describedby", "aria-controls"].forEach((attr) => {
    document.querySelectorAll("[" + attr + "]").forEach((el) => {
      const missing = el.getAttribute(attr).split(/\s+/).filter((id) => id && !document.getElementById(id));
      if (missing.length) add("dangling-aria", el, attr + ' -> missing id "' + missing.join(", ") + '"');
    });
  });

  // Dialogs are hidden when a view is at rest, so this one check deliberately ignores
  // visibility. aria-modal is what tells a screen reader the rest of the page is inert;
  // the command palette shipped without it while every other dialog had it, and it turned
  // out not to trap focus either -- 11 of 12 Tab presses walked out into the page behind.
  // The trap itself needs interaction to test, but the missing attribute is the tell.
  document.querySelectorAll('[role="dialog"], [role="alertdialog"]').forEach((el) => {
    if (el.getAttribute("aria-modal") !== "true") {
      add("dialog-not-modal", el, 'role="' + el.getAttribute("role") + '" without aria-modal="true"');
    }
    const named = (el.getAttribute("aria-label") || "").trim() || el.getAttribute("aria-labelledby");
    if (!named) add("dialog-unnamed", el, "a dialog announced only as its role");
  });

  document.querySelectorAll("[tabindex]").forEach((el) => {
    const t = parseInt(el.getAttribute("tabindex"), 10);
    if (t > 0) add("positive-tabindex", el, "tabindex=" + t + " overrides document order");
  });

  document.querySelectorAll("input, select, textarea").forEach((el) => {
    if (!visible(el)) return;
    if (el.type === "hidden") return;
    const labelled = (el.getAttribute("aria-label") || "").trim() ||
      el.getAttribute("aria-labelledby") ||
      (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) ||
      el.closest("label");
    if (!labelled) add("label-not-associated", el, "type=" + (el.type || el.tagName.toLowerCase()));
  });

  // A visible control that cannot receive focus at all.
  document.querySelectorAll("button, a[href], input, select, textarea, [role='button']").forEach((el) => {
    if (!visible(el)) return;
    if (el.disabled) return;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && parseInt(ti, 10) < 0) add("unreachable-control", el, "tabindex=" + ti + " on a visible control");
  });

  // Mouse-only controls. A click listener cannot be read back from the DOM, but cursor:pointer
  // on an element that is neither natively interactive nor made focusable is a reliable
  // signal for one -- it is how the Executive Overview shipped a table whose rows opened a
  // modal on click and could not be reached by Tab at all.
  const NATIVE = "a[href],button,input,select,textarea,summary,label,[contenteditable='true']";
  document.querySelectorAll("body *").forEach((el) => {
    if (!visible(el)) return;
    if (getComputedStyle(el).cursor !== "pointer") return;
    if (el.matches(NATIVE) || el.closest(NATIVE)) return;
    if (el.tabIndex >= 0) return;                       // made focusable already
    const role = el.getAttribute("role");
    if (role && ["button", "link", "tab", "menuitem", "option", "checkbox", "radio"].includes(role)) return;
    // A pointer cursor inherited from an interactive ancestor is that ancestor's business.
    const p = el.parentElement;
    if (p && getComputedStyle(p).cursor === "pointer") return;
    add("mouse-only-control", el, "cursor:pointer but not focusable and no interactive role");
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
  if (!seed) return req.continue();
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
const nav = async (path = "/app.html") => {
  for (let i = 1; i <= 3; i++) {
    const r = await page.goto(BASE + path, { waitUntil: "load", timeout: 30000 }).catch(() => null);
    if (loaded(r)) return r;
  }
  return null;
};

const findings = new Map();
let skipped = 0;
for (const sc of SCENARIOS) {
  current = sc;
  await page.setViewport(sc.mobile
    ? { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
    : { width: 1440, height: 900, deviceScaleFactor: 1 });

  if (sc.staticUrl) {
    if (!await nav(sc.staticUrl)) { console.error("  " + sc.label + ": did not load, skipped"); skipped++; continue; }
    await new Promise((r) => setTimeout(r, 350));
  } else {
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
  }

  for (const f of await page.evaluate(audit)) {
    const key = f.kind + "|" + f.sel + "|" + f.detail;
    if (!findings.has(key)) findings.set(key, { ...f, where: [sc.label] });
    else findings.get(key).where.push(sc.label);
  }
}
await browser.close();
if (skipped) console.error("\n" + skipped + " of " + SCENARIOS.length + " scenarios were skipped; coverage is incomplete.");

const all = [...findings.values()].sort((a, b) => b.where.length - a.where.length);
if (!all.length) {
  console.log("\nNo semantic or keyboard problems across " + SCENARIOS.length + " views.\n");
  process.exit(0);
}
console.log("\n" + all.length + " distinct problem(s) across " + SCENARIOS.length + " views:\n");
for (const f of all) {
  console.log(`  [${f.kind}] ${f.sel}`);
  console.log(`      ${f.detail}`);
  console.log(`      ${f.where.length} view(s): ${f.where.slice(0, 5).join(", ")}${f.where.length > 5 ? ", …" : ""}`);
}
console.log("");
process.exit(1);
