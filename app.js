/* Granite Logistics: Enterprise Demo App
 * Single-page, dependency-free. Drives the full Auction Win -> Delivery Confirmed journey
 * with simulated e-commerce + UPS/FedEx integrations and a real Code 128 chain of custody. */
(function () {
  "use strict";

  // ---- Lifecycle stages (the chain of custody) ----
  var STAGES = ["Won", "Intake", "PickedUp", "Staged", "InTransit", "OutforDelivery", "Delivered"];
  var STAGE_LABEL = {
    Won: "Auction Win", Intake: "Intake & Label", PickedUp: "Picked Up",
    Staged: "Staged at Dock", InTransit: "In Transit", OutforDelivery: "Out for Delivery", Delivered: "Delivered"
  };
  // The first stage is an auction win for auction-sourced intake, but customer orders
  // now flow into the same pipeline, where "Auction Win" would read as wrong. Use the
  // package to pick the right wording; falls back to the generic stage label.
  function stageLabelFor(p, stage) {
    var s = stage || (p && p.status);
    if (s === "Won" && p && p.customerEmail) return "Order Placed";
    return STAGE_LABEL[s] || s;
  }
  var STAGE_NOTE = {
    Won: "Order pulled automatically from client commerce backend via API.",
    Intake: "Code 128 tracking label generated and printed.",
    PickedUp: "Runner captured condition photo and binned item.",
    Staged: "Batched to carrier manifest and assigned to dock lane.",
    InTransit: "Carrier label created via API; tracking number issued.",
    OutforDelivery: "Carrier scan: on vehicle for delivery.",
    Delivered: "Delivery confirmed with final condition photo."
  };

  var CARRIER_COLOR = { UPS: "#7a5c2e", FedEx: "#4d148c", "Dayton Freight": "#0f766e", "Pitt Ohio": "#b91c1c" };

  // ---- Seed data ----
  var SOURCES = ["MacBid Auction", "Shopify", "WooCommerce"];
  var FIRST = ["Marcus", "Elena", "Priya", "Devon", "Sofia", "Aaron", "Nina", "Wesley", "Grace", "Tariq", "Lena", "Hugo"];
  var LAST = ["Whitfield", "Brennan", "Okafor", "Castellano", "Reyes", "Mbeki", "Donovan", "Aslan", "Park", "Mercer"];
  var STREETS = ["Maple Ave", "Cedar Ridge Rd", "Lakeshore Dr", "Birchwood Ln", "Summit St", "Harbor Way", "Vine St"];
  var CITIES = [["Dayton","OH","45402"],["Columbus","OH","43004"],["Cincinnati","OH","45202"],["Toledo","OH","43604"],["Akron","OH","44303"]];
  var ITEMS = [
    ["Dyson V11 Cordless Vacuum", 420], ["LG 55\" OLED TV", 1100], ["KitchenAid Stand Mixer", 380],
    ["Herman Miller Aeron Chair", 950], ["Bose QC Headphones", 240], ["DeWalt 20V Drill Kit", 199],
    ["Nespresso Vertuo Machine", 160], ["iRobot Roomba j7", 560], ["Weber Genesis Grill", 720],
    ["Sony A7 IV Camera Body", 2300]
  ];

  var seq = 1041;
  var rng = function (n) { return Math.floor(Math.random() * n); };
  var pick = function (a) { return a[rng(a.length)]; };

  function makePackage(stageIndex) {
    var item = pick(ITEMS);
    var city = pick(CITIES);
    var fn = pick(FIRST), ln = pick(LAST);
    var id = "GL-" + (seq++);
    var carrier = stageIndex >= 3 ? pick(["UPS", "FedEx", "Dayton Freight", "Pitt Ohio"]) : null;
    var p = {
      id: id,
      source: pick(SOURCES),
      orderRef: "#" + (10000 + rng(89999)),
      customer: {
        name: fn + " " + ln,
        address: (100 + rng(8900)) + " " + pick(STREETS),
        city: city[0], state: city[1], zip: city[2],
        phone: "(937) 555-" + (1000 + rng(8999))
      },
      item: { description: item[0], value: item[1], weight: 2 + rng(38) },
      barcode: id.replace(/-/g, ""),
      carrier: carrier,
      lane: stageIndex >= 3 ? "Lane " + (1 + rng(4)) : null,
      batchId: stageIndex >= 3 ? "BATCH-" + (700 + rng(299)) : null,
      tracking: stageIndex >= 4 ? trackingFor(carrier) : null,
      photos: {},
      history: [],
      status: STAGES[stageIndex]
    };
    // Build history up to current stage
    var base = Date.now() - (stageIndex + 1) * 5400000;
    for (var i = 0; i <= stageIndex; i++) {
      p.history.push({ stage: STAGES[i], ts: base + i * 4800000, note: STAGE_NOTE[STAGES[i]] });
    }
    p.promisedTs = base + (2 + rng(4)) * 86400000; // SLA: promised delivery window
    p.exception = null;
    if (stageIndex >= 2) p.photos.pickup = placeholderPhoto(item[0], "PICKUP", "#1d4ed8");
    if (stageIndex >= 6) p.photos.delivery = placeholderPhoto(item[0], "DELIVERED", "#15803d");
    return p;
  }

  function trackingFor(carrier) {
    if (carrier === "UPS") return "1Z" + Math.random().toString(36).slice(2, 8).toUpperCase() + rng(99) + "0394" + rng(9999);
    if (carrier === "FedEx") return "" + (7700 + rng(299)) + " " + (1000 + rng(8999)) + " " + (1000 + rng(8999));
    return "PRO-" + (4000000 + rng(999999));
  }

  // Canvas placeholder image so condition photos look real without assets.
  function placeholderPhoto(label, tag, color) {
    var c = document.createElement("canvas");
    c.width = 240; c.height = 240;
    var x = c.getContext("2d");
    x.fillStyle = "#0f172a"; x.fillRect(0, 0, 240, 240);
    x.fillStyle = color; x.fillRect(0, 0, 240, 46);
    x.fillStyle = "#fff"; x.font = "bold 16px Segoe UI"; x.fillText(tag + " PHOTO", 14, 29);
    // faux item silhouette
    x.fillStyle = "#1e293b"; x.fillRect(40, 80, 160, 110);
    x.strokeStyle = "#334155"; x.lineWidth = 2; x.strokeRect(40, 80, 160, 110);
    x.fillStyle = "#64748b"; x.font = "12px Segoe UI";
    wrap(x, label, 48, 140, 150, 16);
    x.fillStyle = "#94a3b8"; x.font = "11px Consolas";
    x.fillText(new Date().toLocaleString(), 14, 222);
    return c.toDataURL("image/jpeg", 0.7);
  }
  function wrap(ctx, text, x, y, max, lh) {
    var words = text.split(" "), line = "";
    for (var i = 0; i < words.length; i++) {
      var test = line + words[i] + " ";
      if (ctx.measureText(test).width > max && i > 0) { ctx.fillText(line, x, y); line = words[i] + " "; y += lh; }
      else line = test;
    }
    ctx.fillText(line, x, y);
  }

  // Create a package from real user/CSV-provided data (enters at "Won").
  function makeOrderFrom(d) {
    var id = "GL-" + (seq++);
    var fromApi = d.source && d.source !== "Manual Entry" && d.source !== "CSV Import";
    return {
      id: id,
      source: d.source || "Manual Entry",
      orderRef: "#" + (10000 + rng(89999)),
      customer: {
        name: (d.name || "–").trim(),
        address: (d.address || "").trim(),
        city: (d.city || "").trim(),
        state: (d.state || "").trim().toUpperCase(),
        zip: (d.zip || "").trim(),
        phone: (d.phone || "").trim()
      },
      item: { description: (d.item || "Item").trim(), value: Math.max(0, parseInt(d.value, 10) || 0), weight: Math.max(1, parseInt(d.weight, 10) || (2 + rng(38))) },
      barcode: id.replace(/-/g, ""),
      carrier: null, lane: null, batchId: null, tracking: null,
      photos: {},
      history: [{ stage: "Won", ts: Date.now(), note: fromApi ? STAGE_NOTE.Won : "Order entered manually at intake." }],
      promisedTs: Date.now() + (3 + rng(3)) * 86400000,
      exception: null,
      status: "Won"
    };
  }

  // ---- Real photo capture (device camera / file picker) ----
  var photoInput = document.createElement("input");
  photoInput.type = "file"; photoInput.accept = "image/*"; photoInput.capture = "environment";
  photoInput.style.display = "none";
  document.body.appendChild(photoInput);
  // Resolves a downscaled+stamped data URL on capture, or null if cancelled / no camera.
  function capturePhoto(tag, color) {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (v) { if (!settled) { settled = true; resolve(v); } };
      photoInput.value = "";
      photoInput.onchange = function () {
        var f = photoInput.files && photoInput.files[0];
        if (!f) { finish(null); return; }
        var reader = new FileReader();
        reader.onload = function (e) {
          var img = new Image();
          img.onload = function () { finish(downscalePhoto(img, tag, color)); };
          img.onerror = function () { finish(null); };
          img.src = e.target.result;
        };
        reader.onerror = function () { finish(null); };
        reader.readAsDataURL(f);
      };
      // If the picker is dismissed (no file), the window regains focus. Resolve null.
      var onFocus = function () {
        setTimeout(function () { if (!settled && (!photoInput.files || !photoInput.files.length)) finish(null); }, 700);
      };
      window.addEventListener("focus", onFocus, { once: true });
      photoInput.click();
    });
  }
  function downscalePhoto(img, tag, color) {
    var max = 900, w = img.width, h = img.height;
    if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
    else if (h >= w && h > max) { w = Math.round(w * max / h); h = max; }
    var c = document.createElement("canvas"); c.width = w; c.height = h || 1;
    var x = c.getContext("2d");
    x.drawImage(img, 0, 0, w, h);
    x.fillStyle = color; x.fillRect(0, 0, w, 30);
    x.fillStyle = "#fff"; x.font = "bold 15px Segoe UI";
    x.fillText(tag + " · " + new Date().toLocaleString(), 10, 21);
    return c.toDataURL("image/jpeg", 0.7);
  }

  // ---- CSV + file helpers ----
  function parseCSV(text) {
    var rows = [], field = "", row = [], inQ = false, i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
      else field += ch;
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ""; }); });
  }
  function csvCell(v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function downloadFile(name, content, type) {
    var blob = new Blob([content], { type: type || "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 120);
  }
  function exportCSV() {
    var cols = ["id", "status", "source", "name", "item", "value", "address", "city", "state", "zip", "phone", "carrier", "lane", "batch", "tracking", "barcode"];
    var lines = [cols.join(",")];
    state.packages.forEach(function (p) {
      lines.push([p.id, p.status, p.source, p.customer.name, p.item.description, p.item.value, p.customer.address,
        p.customer.city, p.customer.state, p.customer.zip, p.customer.phone, p.carrier || "", p.lane || "",
        p.batchId || "", p.tracking || "", p.barcode].map(csvCell).join(","));
    });
    downloadFile("granite-shipments.csv", lines.join("\n"), "text/csv");
    toast(state.packages.length + " shipments exported to CSV", "ok");
  }

  // ---- App state + persistence ----
  var STORE_KEY = "granite-logistics-state-v1";
  function defaultSettings() {
    return {
      company: { name: "Granite Logistics", address: "", phone: "", email: "" },
      defaultCarrier: "UPS", defaultLane: "Lane 1", role: "Customer", roleChosen: false, theme: "light",
      // Auto-sync on by default so ops sees customer orders (which now land in the
      // same shared workspace) without anyone having to flip a switch in Settings.
      cloud: { url: "", key: "granite-dev-key", autoSync: true }
    };
  }
  var state = { packages: [], manifests: [], loadUnits: [], events: [], settings: defaultSettings() };
  function companyName() { return (state.settings && state.settings.company && state.settings.company.name) || "Granite Logistics"; }
  function save() {
    // tombstones must persist: a deletion made while offline has to survive a reload,
    // or the server-side merge would resurrect the order on the next successful push.
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ packages: state.packages, manifests: state.manifests, loadUnits: state.loadUnits, events: state.events, settings: state.settings, seq: seq, tombstones: state.tombstones || [] })); } catch (e) { /* quota / private mode */ }
    if (typeof scheduleAutoPush === "function") scheduleAutoPush();
  }
  // Derive manifest records by grouping packages that share a batchId.
  function rebuildManifests() {
    var by = {};
    state.packages.forEach(function (p) {
      if (!p.batchId) return;
      if (!by[p.batchId]) by[p.batchId] = {
        id: p.batchId, carrier: p.carrier, lane: p.lane,
        ts: (p.history.find(function (h) { return h.stage === "Staged"; }) || {}).ts || Date.now(),
        packageIds: []
      };
      by[p.batchId].packageIds.push(p.id);
    });
    state.manifests = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.ts - a.ts; });
  }
  function seed() {
    seq = 1041; state.packages = []; state.loadUnits = []; state.events = []; state.settings = defaultSettings();
    [6, 6, 5, 4, 4, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1, 0].forEach(function (s) { state.packages.push(makePackage(s)); });
    // Group advanced (staged+) packages into a few realistic shared manifests
    var advanced = state.packages.filter(function (p) { return STAGES.indexOf(p.status) >= 3; });
    var carriers = ["UPS", "FedEx", "Dayton Freight"], defs = [];
    advanced.forEach(function (p, i) {
      var gi = Math.floor(i / 3);
      if (!defs[gi]) defs[gi] = { carrier: carriers[gi % carriers.length], lane: "Lane " + (1 + (gi % 4)), batchId: "BATCH-" + (810 + gi) };
      p.carrier = defs[gi].carrier; p.lane = defs[gi].lane; p.batchId = defs[gi].batchId;
      if (STAGES.indexOf(p.status) >= 4) p.tracking = trackingFor(p.carrier);
    });
    // Seed a realistic exception + an SLA breach so the Alerts panel demos well
    var inflight = state.packages.filter(function (p) { return p.status === "InTransit" || p.status === "OutforDelivery"; });
    if (inflight[0]) {
      inflight[0].exception = { type: "Address Issue", note: "Suite number missing, courier follow-up requested", ts: Date.now() - 3600000 };
      state.events.unshift({ ts: inflight[0].exception.ts, pkgId: inflight[0].id, who: inflight[0].customer.name, kind: "exception", note: "Exception: Address Issue (Suite number missing)" });
    }
    if (inflight[1]) inflight[1].promisedTs = Date.now() - 7200000; // past due → SLA Late
    var dlv = state.packages.filter(function (p) { return p.status === "Delivered"; });
    if (dlv[0]) {
      dlv[0].return = { status: "In Transit", reason: "Damaged / Defective", note: "Screen cracked on arrival", ts: Date.now() - 5400000 };
      state.events.unshift({ ts: dlv[0].return.ts, pkgId: dlv[0].id, who: dlv[0].customer.name, kind: "return", note: "Return requested: Damaged / Defective" });
    }
    rebuildManifests(); save();
  }
  function load() {
    try {
      var data = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!data || !Array.isArray(data.packages) || !data.packages.length) return false;
      state.packages = data.packages;
      state.manifests = Array.isArray(data.manifests) ? data.manifests : [];
      state.loadUnits = Array.isArray(data.loadUnits) ? data.loadUnits : [];
      state.events = Array.isArray(data.events) ? data.events : [];
      state.settings = Object.assign(defaultSettings(), data.settings || {});
      if (data.settings && data.settings.company) state.settings.company = Object.assign(defaultSettings().company, data.settings.company);
      if (typeof data.seq === "number") seq = data.seq;
      state.tombstones = Array.isArray(data.tombstones) ? data.tombstones : [];
      syncSeqFromPackages(); // guard against a stale seq vs. server-numbered orders
      if (!state.manifests.length) rebuildManifests();
      return true;
    } catch (e) { return false; }
  }
  if (!load()) seed();

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var stageIdx = function (st) { return STAGES.indexOf(st); };
  var fmtTime = function (ts) { return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };
  var pillClass = function (st) { return "pill st-" + st.replace(/\s/g, ""); };
  var money = function (n) { return "$" + n.toLocaleString(); };

  // ---- Toasts ----
  // ---- Label association ----
  //
  // The form markup is `<div class="ff"><label>Item</label><input ...></div>` throughout.
  // That looks labelled and reads as labelled to a sighted user, but a <label> with no
  // `for` and no wrapped control names nothing: a screen reader falls back to the
  // placeholder, or announces the field with no name at all. 39 of 46 controls were in
  // that state.
  //
  // Done at runtime rather than by editing the markup because a dozen of these blocks are
  // built by modal() and the various render functions, so static `for=` attributes would
  // miss exactly the fields that are hardest to fill in blind.
  // Make a non-button element activate from the keyboard.
  //
  // Several lists render rows as <div> with a click handler: the tracking list, the staging
  // list, the overview alerts, the notification feed. A mouse reaches them, a keyboard
  // never does, which is most of the ops platform unreachable without a pointer. These
  // stay divs rather than becoming <button> because a row can contain its own checkbox in
  // select mode, and a button containing a control is invalid.
  function makeActivatable(el, fn) {
    if (!el || el.dataset.kbd === "1") return;
    el.dataset.kbd = "1";
    // A real button or link already does all of this, and adding role/tabindex would only
    // misdescribe it. Some of these selectors match either shape depending on the view.
    if (/^(BUTTON|A)$/.test(el.tagName)) { el.addEventListener("click", fn); return; }
    el.tabIndex = 0;
    // role=button only when the row holds no control of its own; claiming to be a button
    // while wrapping a checkbox misdescribes it to a screen reader.
    if (!el.querySelector("input, button, select, textarea, a")) el.setAttribute("role", "button");
    el.addEventListener("click", fn);
    el.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      // Space scrolls the page by default, and Enter would submit an enclosing form.
      e.preventDefault();
      fn(e);
    });
  }

  var labelSeq = 0;
  function associateLabels(root) {
    var scope = root || document;
    var labels = scope.querySelectorAll ? scope.querySelectorAll("label:not([for])") : [];
    Array.prototype.forEach.call(labels, function (label) {
      // A label that already wraps its control is correct as it stands.
      if (label.querySelector("input, select, textarea")) return;
      var el = label.nextElementSibling;
      while (el && !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
        // Only look past wrappers that hold the control, never into the next field.
        el = el.querySelector ? el.querySelector("input, select, textarea") : null;
        break;
      }
      if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
      if (el.type === "hidden") return;
      if (!el.id) el.id = "f" + (++labelSeq) + "-" + (el.name || "field");
      label.htmlFor = el.id;
    });
  }

  var TOAST_ICONS = { api: "⇄", warn: "⚠", ok: "✓" };
  // ms overrides how long it stays up; a warning worth interrupting for needs longer than
  // a routine confirmation.
  function toast(msg, kind, ms) {
    var el = document.createElement("div");
    el.className = "toast " + (kind || "ok");
    // Built as nodes, not interpolated HTML: toast text now includes server-supplied
    // messages, and textContent can't be coerced into markup.
    var ico = document.createElement("span");
    ico.className = "t-ico";
    ico.textContent = TOAST_ICONS[kind] || TOAST_ICONS.ok;
    var body = document.createElement("span");
    body.textContent = String(msg);
    el.appendChild(ico); el.appendChild(body);
    $("#toasts").appendChild(el);
    var hold = Math.max(1200, ms || 3200);
    // Exit is a class so the curve and duration come from the motion tokens rather than
    // being hard-coded here.
    setTimeout(function () { el.classList.add("leaving"); }, hold);
    setTimeout(function () { el.remove(); }, hold + 400);
  }

  // ---- Navigation ----
  var VIEW_META = {
    custhome: ["Home", "A quick look at your orders."],
    account: ["Account", "Your profile and sign-out."],
    order: ["Place an Order", "Create a new shipment and track it from pickup to delivery."],
    overview: ["Executive Overview", "Real-time visibility from auction win to delivery confirmation."],
    ingest: ["Order Ingest", "Orders pulled directly from client commerce backends. Zero manual entry."],
    runner: ["Runner Dashboard", "Daily pickups, condition photos, and label generation."],
    presort: ["Pre-Sort & Staging", "ZIP pre-sort and load-ready consolidation before carrier handoff."],
    batch: ["Batch & Lane Routing", "Group items into carrier manifests and assign dock lanes."],
    driver: ["Driver Scan", "Scan a label to retrieve destination details instantly."],
    home: ["Home", "Your tasks at a glance."],
    tracking: ["Chain of Custody", "Tamper-evident, end-to-end package history."],
    returns: ["Returns", "Reverse logistics: manage return requests through to receipt."],
    reports: ["Reports & Analytics", "Operational metrics computed from your live data."],
    activity: ["Activity Log", "Tamper-evident audit trail of every event, newest first."],
    settings: ["Settings", "Company profile, defaults, and data management."],
    admin: ["Team & Roles", "Grant and revoke operations access."]
  };

  // ---- Role-based access (maps to the platform's user roles) ----
  var ROLE_VIEWS = {
    Customer: ["custhome", "order", "account"],
    Admin: ["order", "overview", "ingest", "runner", "presort", "batch", "driver", "tracking", "returns", "reports", "activity", "settings", "admin"],
    Runner: ["home", "ingest", "runner", "presort", "batch", "tracking", "returns", "activity"],
    Driver: ["home", "driver", "tracking"],
    Viewer: ["overview", "tracking", "reports", "activity"]
  };
  var ROLE_META = {
    Customer: { label: "Customer", ico: "🛒", tag: "Place orders" },
    Admin: { label: "Administrator", ico: "▦", tag: "Full access" },
    Runner: { label: "Store Runner", ico: "▣", tag: "Operations" },
    Driver: { label: "Carrier Driver", ico: "◎", tag: "Field" },
    Viewer: { label: "Viewer", ico: "⊶", tag: "Read-only" }
  };
  // Mobile is the customer app. The ops roles (Admin/Runner/Driver/Viewer) are
  // desktop-only for now, so a narrow viewport always renders the Customer
  // experience regardless of the saved role. savedRole() is the stored value;
  // currentRole() is what the UI should actually show.
  function isMobileViewport() { var w = window.innerWidth; return w > 0 && w <= 980; }
  function savedRole() { return (state.settings && state.settings.role) || "Customer"; }
  function currentRole() { return isMobileViewport() ? "Customer" : savedRole(); }
  function allowedViews() {
    var views = ROLE_VIEWS[currentRole()] || ROLE_VIEWS.Customer;
    // "admin" talks to /api/admin, which only exists on a real deployment and only
    // answers a signed-in Admin. In local/demo mode it is removed rather than shown
    // broken, so the guided demo still explores every ops role freely.
    if (views.indexOf("admin") >= 0 && !canManageRoles()) {
      views = views.filter(function (v) { return v !== "admin"; });
    }
    return views;
  }
  // A real server session whose account is an Admin. Checked again on the server for
  // every request; this only decides what to render.
  function canManageRoles() {
    if (!hasServerAuth()) return false;
    var u = (typeof currentUser === "function") ? currentUser() : null;
    return !!(u && u.role === "Admin");
  }
  function updateRoleUI() {
    var m = ROLE_META[currentRole()] || ROLE_META.Admin;
    document.body.setAttribute("data-role", currentRole());
    var chip = $("#role-chip");
    if (chip) chip.innerHTML = '<span class="rc-ico">' + m.ico + '</span><div class="rc-text"><b>' + m.label + '</b><span>' + m.tag + '</span></div>';
    var bt = $("#role-badge-text"); if (bt) bt.textContent = m.label;
    var uc = $("#user-chip");
    if (uc) {
      var u = (typeof currentUser === "function") ? currentUser() : null;
      uc.innerHTML = u
        ? '<span class="uc-avatar">' + ((u.name || u.email || "U").charAt(0).toUpperCase()) + '</span><div class="uc-text"><b>' + (u.name || u.email) + '</b><span>' + m.label + '</span></div>'
        : "";
    }
    var au = (typeof currentUser === "function") ? currentUser() : null;
    var av = $("#am-avatar"); if (av) av.textContent = (au && (au.name || au.email) || "U").charAt(0).toUpperCase();
    var an = $("#am-name"); if (an) an.textContent = au ? (au.name || au.email) : "Guest";
    var ae = $("#am-email"); if (ae) ae.textContent = au ? au.email : "";
  }
  // The sidebar nav scrolls when the role has more destinations than the viewport fits.
  // At 1440x900 with the Admin role, 115px of it sits below the fold — including the whole
  // Administration group, which is where Settings and Team & Roles live. Nothing indicated
  // that, so those two were effectively invisible on a normal laptop. This adds the missing
  // affordance: a fade at the bottom edge whenever there is more nav below.
  function updateNavScrollHint() {
    var nav = $(".nav"); if (!nav) return;
    var more = nav.scrollHeight - nav.clientHeight - nav.scrollTop > 4;
    nav.classList.toggle("nav-has-more", more);
  }

  function applyRole() {
    var allowed = allowedViews();
    $$(".nav-item").forEach(function (b) {
      var ok = allowed.indexOf(b.dataset.view) >= 0;
      // Both, because the admin entry ships with `hidden` set so it cannot flash up
      // before this runs, and style.display alone would not clear that.
      b.hidden = !ok;
      b.style.display = ok ? "" : "none";
    });
    $$(".nav-group").forEach(function (g) {
      var any = Array.prototype.some.call(g.querySelectorAll(".nav-item"), function (b) { return b.style.display !== "none"; });
      g.style.display = any ? "" : "none";
    });
    updateRoleUI();
    updateNavScrollHint();
    var active = $(".nav-item.active") ? $(".nav-item.active").dataset.view : null;
    if (allowed.indexOf(active) < 0) go(allowed[0]);
  }
  // Whether this session may actually use an ops workspace.
  //
  // With no server session the app runs entirely on local storage (static host, offline,
  // or a demo), and every role is explorable — that is the point of the demo. With a real
  // session the server decides: it authorizes /api/state by the account's role, so
  // offering an ops role the account does not have would just produce a 403 later.
  function opsAccessGranted() {
    if (!hasServerAuth()) return true;
    var u = (typeof currentUser === "function") ? currentUser() : null;
    return !!(u && u.role && u.role !== "Customer");
  }
  function openGate() {
    var g = $("#role-gate"); if (!g) return;
    var locked = !opsAccessGranted();
    $$("#role-gate .rg-card").forEach(function (c) {
      var isOps = c.dataset.role && c.dataset.role !== "Customer";
      var lock = isOps && locked;
      c.classList.toggle("rg-locked", lock);
      c.disabled = lock;
      if (lock) c.setAttribute("aria-disabled", "true"); else c.removeAttribute("aria-disabled");
      var note = c.querySelector(".rg-lock-note");
      if (lock && !note) {
        note = document.createElement("span");
        note.className = "rg-lock-note";
        note.textContent = "Needs an operations account";
        c.appendChild(note);
      } else if (!lock && note) { note.remove(); }
    });
    g.classList.add("open");
    trapFocus(g);
  }
  function closeGate() {
    var g = $("#role-gate");
    if (!g || !g.classList.contains("open")) return;
    g.classList.remove("open");
    releaseFocus(g);
  }
  function setRole(role) {
    if (!ROLE_VIEWS[role]) return;
    // Defence in depth: the picker disables these cards, but a stale saved role or a
    // keyboard activation should not leave someone stranded in a workspace that 403s.
    if (role !== "Customer" && !opsAccessGranted()) {
      toast("This account doesn't have operations access. Ask an administrator to grant it, then sign in again.", "warn", 9000);
      return;
    }
    state.settings.role = role; state.settings.roleChosen = true; save();
    resetSyncBlock(); // a different role may well be allowed to sync
    closeGate(); applyRole(); go(allowedViews()[0]);
    toast("Workspace: " + ROLE_META[role].label, "ok");
  }
  function toggleSidebar(open) {
    var sb = $("#sidebar"), bd = $("#sidebar-backdrop");
    var willOpen = (open === undefined) ? !(sb && sb.classList.contains("open")) : open;
    if (sb) sb.classList.toggle("open", willOpen);
    if (bd) bd.classList.toggle("open", willOpen);
  }
  // Crossing the nav-mode breakpoint (window resize, or browser/OS zoom changing
  // the effective layout width) has two consequences:
  //  1. A mobile drawer left open would linger fixed over the desktop layout.
  //  2. The effective role changes for ops users, since mobile is customer-only,
  //     so the nav and active view have to be rebuilt for the new role.
  (function () {
    var lastWide = window.innerWidth > 980;
    window.addEventListener("resize", function () {
      var wide = window.innerWidth > 980;
      if (wide === lastWide) return;
      lastWide = wide;
      toggleSidebar(false);
      if (savedRole() !== "Customer" && currentUser()) { applyRole(); renderBottomNav(); }
      updateNavScrollHint();
    });
  })();
  function applyTheme() {
    var t = (state.settings && state.settings.theme === "dark") ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
    var b = $("#theme-btn"); if (b) b.textContent = t === "dark" ? "☀" : "☾";
  }

  // ---- Auth ----
  // Server-backed accounts via /api/auth (hashed passwords + signed session token),
  // with a local-account fallback so the app still works offline or without the backend.
  var AUTH_KEY = "gl-auth-v2";
  var LOCAL_USERS_KEY = "gl-users-local";
  var loginMode = "signin";
  function authData() { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "null") || { token: null, user: null }; } catch (e) { return { token: null, user: null }; } }
  function authSave(a) { try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); localStorage.setItem("gl-onboarded", "1"); } catch (e) { } }
  function currentUser() { var a = authData(); return a.user ? Object.assign({}, a.user) : null; }
  function authToken() { return authData().token; }
  function logoutUser() {
    // Don't leave one customer's order details sitting in local storage for whoever
    // uses this browser next. The public tracker falls back to local state when the
    // API is unreachable, so a stale order here is reachable by tracking number.
    //
    // Only purge when the server holds a copy (a real session). Local-only accounts,
    // used offline or with no backend, keep theirs; losing someone's orders outright
    // would be worse than the risk. Ops roles keep their cached workspace, which is
    // their own working data, and the server-side merge restores anything a push drops.
    if (currentRole() === "Customer" && hasServerAuth()) {
      state.packages = state.packages.filter(function (p) { return !p.customerEmail; });
      save();
    }
    try { localStorage.removeItem(AUTH_KEY); } catch (e) { }
  }

  function postAuth(action, body) {
    return fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ action: action }, body)) })
      .then(function (r) { return r.json().then(function (j) { return j; }); });
  }
  // Local fallback (used only when the auth API is unreachable)
  function localUsers() { try { return JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || "{}"); } catch (e) { return {}; } }
  function localUsersSave(u) { try { localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(u)); } catch (e) { } }
  function localRegister(name, email, pw, role) {
    var u = localUsers(); email = (email || "").toLowerCase();
    if (u[email]) return { ok: false, error: "That account already exists. Sign in instead." };
    u[email] = { pw: pw, name: name || email.split("@")[0], role: role }; localUsersSave(u);
    authSave({ token: "local", user: { email: email, name: u[email].name, role: role } });
    return { ok: true, offline: true };
  }
  function localLogin(email, pw) {
    var u = localUsers()[(email || "").toLowerCase()];
    if (!u || u.pw !== pw) return { ok: false, error: "Incorrect email or password." };
    authSave({ token: "local", user: { email: email.toLowerCase(), name: u.name, role: u.role } });
    return { ok: true, offline: true };
  }
  function registerUser(name, email, pw, role) {
    return postAuth("register", { name: name, email: email, pw: pw, role: role }).then(function (j) {
      if (j && j.verification) mailAvailable = !!j.verification.available;
      if (j && j.ok) { authSave({ token: j.token, user: j.user }); return { ok: true }; }
      return { ok: false, error: (j && j.error) || "Could not create account." };
    }).catch(function () { return localRegister(name, email, pw, role); });
  }
  function loginUser(email, pw) {
    return postAuth("login", { email: email, pw: pw }).then(function (j) {
      if (j && j.verification) mailAvailable = !!j.verification.available;
      if (j && j.ok) { authSave({ token: j.token, user: j.user }); return { ok: true }; }
      return { ok: false, error: (j && j.error) || "Incorrect email or password." };
    }).catch(function () { return localLogin(email, pw); });
  }

  function renderLoginMode() {
    var reg = loginMode === "register";
    $("#login-title").textContent = reg ? "Create your account" : "Sign in";
    $("#login-sub").textContent = reg ? "Set up your account to place and track orders." : "Welcome back. Sign in to see your orders.";
    $("#login-name-field").style.display = reg ? "" : "none";
    $("#login-role-field").style.display = "none";
    $("#login-submit").textContent = reg ? "Create account" : "Sign in";
    $("#login-password").setAttribute("autocomplete", reg ? "new-password" : "current-password");
    $("#login-alt").innerHTML = reg
      ? 'Already have an account? <button type="button" id="login-toggle" class="linkbtn">Sign in</button>'
      : 'New here? <button type="button" id="login-toggle" class="linkbtn">Create an account</button>';
    var fg = $("#login-forgot"); if (fg) fg.style.display = reg ? "none" : "";
    var tg = $("#login-toggle");
    if (tg) tg.addEventListener("click", function () { loginMode = reg ? "signin" : "register"; $("#login-err").textContent = ""; renderLoginMode(); });
  }
  function showLogin() {
    loginMode = localStorage.getItem("gl-onboarded") ? "signin" : "register";
    renderLoginMode();
    var ls = $("#login-screen"); if (ls) ls.classList.add("open");
  }
  function hideLogin() { var ls = $("#login-screen"); if (ls) ls.classList.remove("open"); }

  // ---- Password reset ----
  // Step 1: email a reset link. Step 2 (below) redeems the token from that link.
  function requestPasswordReset() {
    var emailEl = $("#login-email");
    var email = (emailEl.value || "").trim();
    var err = $("#login-err");
    if (!email) { err.textContent = "Enter your email address first, then tap “Forgot your password?”"; emailEl.focus(); return; }
    var btn = $("#forgot-btn"); if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    postAuth("reset-request", { email: email })
      .then(function (j) {
        if (btn) { btn.disabled = false; btn.textContent = "Forgot your password?"; }
        if (j && j.ok) { err.textContent = ""; toast("If that email has an account, a reset link is on its way.", "ok"); }
        else { err.textContent = (j && j.error) || "Could not start a password reset."; }
      })
      .catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Forgot your password?"; }
        err.textContent = "Could not reach the server. Check your connection and try again.";
      });
  }
  // Shows the "set a new password" form instead of the sign-in form.
  var resetToken = null;
  function showResetForm(token) {
    resetToken = token;
    var lb = $(".login-body"); if (lb) lb.style.display = "none";
    var rb = $("#reset-body"); if (rb) rb.style.display = "";
    var ls = $("#login-screen"); if (ls) ls.classList.add("open");
  }
  function hideResetForm() {
    resetToken = null;
    var rb = $("#reset-body"); if (rb) rb.style.display = "none";
    var lb = $(".login-body"); if (lb) lb.style.display = "";
    // Drop the token from the URL so a refresh doesn't reopen this form.
    try { history.replaceState(null, "", location.pathname); } catch (e) { }
    showLogin();
  }

  // ---- Welcome tour: a short, skippable walkthrough shown once, right after
  // a brand-new account is created (never on sign-in, never again after dismissed). ----
  var WELCOME_SLIDES = 3;
  var welcomeStep = 1;
  function renderWelcomeStep() {
    $$("#welcome-slides .w-slide").forEach(function (s) { s.classList.toggle("active", +s.dataset.slide === welcomeStep); });
    $$("#welcome-dots .w-dot").forEach(function (d) { d.classList.toggle("active", +d.dataset.dot === welcomeStep); });
    var nextBtn = $("#welcome-next"); if (nextBtn) nextBtn.textContent = welcomeStep === WELCOME_SLIDES ? "Get started →" : "Next →";
  }
  function showWelcomeTour() {
    welcomeStep = 1;
    renderWelcomeStep();
    var b = $("#welcome-backdrop"); if (b) b.classList.add("open");
    trapFocus($(".welcome-card"));
  }
  function closeWelcomeTour() {
    var b = $("#welcome-backdrop");
    if (!b || !b.classList.contains("open")) return;
    b.classList.remove("open");
    releaseFocus($(".welcome-card"));
  }
  // Validate the session token against the server so a login on one device is honored
  // (and expired/tampered tokens rejected) on any other. Local/offline accounts skip this.
  function verifySession() {
    var a = authData();
    if (!a.token || a.token === "local") return;
    fetch("/api/auth", { headers: { "Authorization": "Bearer " + a.token } })
      .then(function (r) {
        if (r.status === 401) {
          logoutUser();
          if (typeof toast === "function") toast("Your session expired. Please sign in again.", "warn");
          showLogin();
          return null;
        }
        return r.json().catch(function () { return null; });
      })
      .then(function (j) {
        if (!(j && j.ok && j.user)) return;
        authSave({ token: a.token, user: j.user });
        // The server is authoritative on privileges. Boot starts from the cached role,
        // which can be a stale ops role from before the account was demoted; without this
        // the user would sit in an ops workspace that 403s until their next sign-in.
        var serverRole = j.user.role || "Customer";
        if (serverRole === "Customer" && savedRole() !== "Customer") {
          state.settings.role = "Customer";
          save();
          applyRole();
          go(allowedViews()[0]);
          toast("This account no longer has operations access.", "warn", 8000);
        }
        updateRoleUI();
      })
      .catch(function () { /* offline / backend unreachable: keep the cached session */ });
  }
  function enterApp() {
    var u = currentUser();
    // A fresh sign-in carries a fresh role, so a previous "no ops access" latch no longer
    // applies to this session.
    resetSyncBlock();
    if (u) { state.settings.role = u.role || state.settings.role; state.settings.roleChosen = true; save(); }
    hideLogin();
    updateRoleUI(); applyRole(); go(allowedViews()[0]); renderBottomNav(); renderNotifs(); bootSync();
  }

  // ---- Bottom tab bar: the customer's ONLY navigation, at every screen size.
  // Ops roles also get it on narrow screens, alongside the sidebar drawer via "Menu". ----
  var BN_LABEL = { custhome: "Home", order: "Orders", account: "Account", overview: "Home", home: "Home", ingest: "Orders", runner: "Pickups", presort: "Pre-Sort", batch: "Manifests", driver: "Scan", tracking: "Tracking", returns: "Returns", reports: "Reports", activity: "Activity", settings: "Settings" };
  var BN_ICON = { custhome: "🏠", order: "🛒", account: "👤" };
  function renderBottomNav() {
    var el = $("#bottom-nav"); if (!el) return;
    var allowed = allowedViews();
    var isCustomer = currentRole() === "Customer";
    var primary = allowed.length > 4 ? allowed.slice(0, 4) : allowed.slice();
    // Tracked directly, not inferred from the sidebar: custhome and account have no
    // sidebar item, so reading it back from the DOM highlighted the wrong tab.
    var active = currentView || allowed[0];
    var html = primary.map(function (v) {
      var ico = BN_ICON[v] || (document.querySelector('.nav-item[data-view="' + v + '"] .ico') || {}).textContent || "•";
      var on = v === active;
      return '<button class="bn-item' + (on ? " active" : "") + '" data-bn="' + v + '"' + (on ? ' aria-current="page"' : '') +
        '><span class="bn-ico" aria-hidden="true">' + ico + '</span><span>' + (BN_LABEL[v] || v) + '</span></button>';
    }).join("");
    // Customers have no sidebar drawer to open, so there's nothing for a "Menu" tab to do.
    if (!isCustomer) html += '<button class="bn-item" data-bnmore="1"><span class="bn-ico">☰</span><span>Menu</span></button>';
    el.innerHTML = html;
    $$("#bottom-nav [data-bn]").forEach(function (b) { b.addEventListener("click", function () { go(b.dataset.bn); }); });
    var more = $("#bottom-nav [data-bnmore]"); if (more) more.addEventListener("click", function () { toggleSidebar(true); });
  }

  // ---- Notifications (alerts bell) ----
  function buildNotifs() {
    var list = [];
    state.packages.forEach(function (p) {
      if (p.exception) list.push({ kind: "exc", ts: p.exception.ts, pkgId: p.id, title: p.exception.type, sub: p.id + " · " + p.customer.name });
      else if (p.status !== "Delivered" && slaStatus(p) === "Late") list.push({ kind: "sla", ts: p.promisedTs, pkgId: p.id, title: "SLA breach: past promised delivery", sub: p.id + " · " + p.customer.name });
    });
    list.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return list;
  }
  // Customers get their own bell: updates on their own orders, not ops-wide alerts.
  // "Seen" state is tracked per-account in localStorage so the badge clears once opened.
  function custNotifSeenKey(email) { return "gl-notifs-seen:" + email; }
  function getNotifSeenTs(email) { try { return parseInt(localStorage.getItem(custNotifSeenKey(email)) || "0", 10) || 0; } catch (e) { return 0; } }
  function setNotifSeenTs(email, ts) { try { localStorage.setItem(custNotifSeenKey(email), String(ts)); } catch (e) { } }
  function buildCustomerNotifs(email) {
    var list = [];
    state.packages.forEach(function (p) {
      if (p.customerEmail !== email) return;
      (p.history || []).forEach(function (h, i) {
        if (i === 0) return; // the first entry ("order placed") is covered by the confirmation screen, not a notification
        var label = (CUST_STATUS[h.stage] || STAGE_LABEL[h.stage] || h.stage).toLowerCase();
        list.push({ ts: h.ts, pkgId: p.id, exc: false, title: "Your " + p.item.description + " is " + label });
      });
      if (p.exception) list.push({ ts: p.exception.ts, pkgId: p.id, exc: true, title: "An update is needed on your " + p.item.description });
    });
    list.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return list;
  }
  function renderCustomerNotifs() {
    var u = (typeof currentUser === "function") ? currentUser() : null;
    var email = u ? u.email : null;
    var badge = $("#notif-badge");
    var panel = $("#notif-panel");
    if (!email) { if (badge) badge.classList.remove("show"); if (panel) panel.innerHTML = ""; return; }
    var list = buildCustomerNotifs(email);
    var seenTs = getNotifSeenTs(email);
    var unread = list.filter(function (n) { return n.ts > seenTs; }).length;
    if (badge) { badge.textContent = unread; badge.classList.toggle("show", unread > 0); }
    if (!panel) return;
    panel.innerHTML = '<div class="notif-head"><span>Order updates</span><span class="muted small">' + list.length + '</span></div>' +
      (list.length ? list.slice(0, 15).map(function (n) {
        return '<div class="notif-item' + (n.ts > seenTs ? " unread" : "") + '" data-open="' + n.pkgId + '"><span class="notif-ico ' + (n.exc ? "exc" : "ok") + '">' + (n.exc ? "⚠" : "📦") + '</span>' +
          '<div class="notif-main"><b>' + n.title + '</b><div class="notif-time">' + fmtTime(n.ts) + '</div></div></div>';
      }).join("") : '<div class="notif-empty">No updates yet. Place an order to start tracking it here.</div>');
    $$("#notif-panel [data-open]").forEach(function (b) { makeActivatable(b, function () { closeNotif(); openCustomerOrder(b.dataset.open); }); });
  }
  function renderNotifs() {
    if ((typeof currentRole === "function" ? currentRole() : "") === "Customer") { renderCustomerNotifs(); return; }
    var list = buildNotifs();
    var badge = $("#notif-badge");
    if (badge) { badge.textContent = list.length; badge.classList.toggle("show", list.length > 0); }
    var panel = $("#notif-panel"); if (!panel) return;
    panel.innerHTML = '<div class="notif-head"><span>Alerts</span><span class="muted small">' + list.length + ' open</span></div>' +
      (list.length ? list.map(function (n) {
        return '<div class="notif-item" data-open="' + n.pkgId + '"><span class="notif-ico ' + n.kind + '">' + (n.kind === "exc" ? "⚠" : "⏱") + '</span>' +
          '<div class="notif-main"><b>' + n.title + '</b><div class="notif-time">' + n.sub + '</div></div></div>';
      }).join("") : '<div class="notif-empty">✓ All clear. No open exceptions or SLA breaches.</div>');
    $$("#notif-panel [data-open]").forEach(function (b) { makeActivatable(b, function () { closeNotif(); openPackage(b.dataset.open); }); });
  }
  function toggleNotif() { var p = $("#notif-panel"); if (p) p.classList.toggle("open"); }
  function closeNotif() { var p = $("#notif-panel"); if (p) p.classList.remove("open"); }
  function markCustomerNotifsSeen() {
    if ((typeof currentRole === "function" ? currentRole() : "") !== "Customer") return;
    var u = (typeof currentUser === "function") ? currentUser() : null; if (!u) return;
    setNotifSeenTs(u.email, Date.now());
    var badge = $("#notif-badge"); if (badge) badge.classList.remove("show");
    $$("#notif-panel .notif-item.unread").forEach(function (el) { el.classList.remove("unread"); });
  }

  // ---- Command palette (Ctrl/Cmd-K) ----
  var cmdItems = [], cmdSel = 0;
  function openCmd() { var b = $("#cmd-backdrop"); if (!b) return; b.classList.add("open"); var i = $("#cmd-input"); i.value = ""; renderCmd(""); setTimeout(function () { i.focus(); }, 20); }
  function closeCmd() { var b = $("#cmd-backdrop"); if (b) b.classList.remove("open"); }
  function renderCmd(q) {
    q = (q || "").trim().toLowerCase();
    cmdItems = [];
    allowedViews().forEach(function (v) {
      var label = VIEW_META[v][0];
      if (!q || label.toLowerCase().indexOf(q) >= 0) cmdItems.push({ type: "view", view: v, label: label, sub: "Go to view" });
    });
    if (q) {
      state.packages.filter(function (p) {
        return (p.id + " " + p.customer.name + " " + p.customer.city + " " + p.item.description).toLowerCase().indexOf(q) >= 0;
      }).slice(0, 6).forEach(function (p) {
        cmdItems.push({ type: "pkg", id: p.id, label: p.id + " · " + p.item.description, sub: p.customer.name + " · " + stageLabelFor(p) });
      });
    }
    cmdItems = cmdItems.slice(0, 12); cmdSel = 0; drawCmd();
  }
  function drawCmd() {
    var el = $("#cmd-results"); if (!el) return;
    el.innerHTML = cmdItems.length ? cmdItems.map(function (it, i) {
      return '<div class="cmd-item' + (i === cmdSel ? " sel" : "") + '" data-i="' + i + '">' +
        '<span class="cmd-ico">' + (it.type === "view" ? "↪" : "▢") + '</span>' +
        '<div class="cmd-main">' + it.label + '<div class="cm-sub">' + it.sub + '</div></div></div>';
    }).join("") : '<div class="cmd-empty">No matches.</div>';
    $$("#cmd-results .cmd-item").forEach(function (el2) { el2.addEventListener("click", function () { activateCmd(cmdItems[+el2.dataset.i]); }); });
  }
  function activateCmd(it) { if (!it) return; closeCmd(); if (it.type === "view") go(it.view); else openPackage(it.id); }
  // Adds the entrance class for exactly one play. The timeout is the animation budget
  // (slow duration + the longest row stagger) plus a little slack; leaving the class on
  // would make the next re-render animate again.
  var currentView = null; // the view go() last switched to, for the bottom nav
  var viewEnterTimer = null;
  function animateViewEntrance(el) {
    if (!el) return;
    clearTimeout(viewEnterTimer);
    el.classList.remove("view-enter");
    // Reading offsetWidth forces a reflow so re-adding the class restarts the animation
    // rather than being coalesced into a no-op.
    void el.offsetWidth;
    el.classList.add("view-enter");
    viewEnterTimer = setTimeout(function () { el.classList.remove("view-enter"); }, 700);
  }

  function go(view) {
    if (typeof stopScan === "function") stopScan(); // release camera when navigating
    if (typeof toggleSidebar === "function") toggleSidebar(false); // close mobile drawer
    $$(".nav-item").forEach(function (b) { b.classList.toggle("active", b.dataset.view === view); });
    currentView = view;
    $$(".view").forEach(function (v) { v.classList.remove("active", "view-enter"); });
    var target = $("#view-" + view);
    target.classList.add("active");
    $("#view-title").textContent = VIEW_META[view][0];
    $("#view-sub").textContent = VIEW_META[view][1];
    render(view);
    associateLabels(target);
    // Entrance animation belongs to navigation, not to rendering. The ops workspace
    // re-renders on every sync (~1.5s), and animating that would make the queue flicker
    // constantly, so the class is added here and dropped once it has played.
    animateViewEntrance(target);
    if (typeof renderBottomNav === "function") renderBottomNav();
  }
  $$(".nav-item").forEach(function (b) { b.addEventListener("click", function () { go(b.dataset.view); }); });

  // ---- Renderers ----
  function render(view) {
    if (view === "custhome") renderCustHome();
    else if (view === "account") renderAccountView();
    else if (view === "order") renderOrder();
    else if (view === "home") renderHome();
    else if (view === "overview") renderOverview();
    else if (view === "ingest") renderIngest();
    else if (view === "runner") renderRunner();
    else if (view === "batch") renderBatch();
    else if (view === "driver") renderDriver();
    else if (view === "tracking") renderTracking();
    else if (view === "reports") renderReports();
    else if (view === "activity") renderActivity();
    else if (view === "settings") renderSettings();
    else if (view === "presort") renderPresort();
    else if (view === "returns") renderReturns();
    else if (view === "admin") renderAdmin();
  }
  function renderAll() { var active = $(".nav-item.active").dataset.view; render(active); if (typeof renderNotifs === "function") renderNotifs(); }

  // ---- Customer ordering flow (default experience) ----
  var CUST_STATUS = {
    Won: "Order received", Intake: "Preparing", PickedUp: "Picked up",
    Staged: "Ready to ship", InTransit: "In transit", OutforDelivery: "Out for delivery", Delivered: "Delivered"
  };
  // The status pill for one of a customer's own orders. A queued order says so; one the
  // server refused says that instead, because leaving it on "Syncing" would promise a
  // delivery that is never going to happen.
  // The date line beside an order. Never repeats the status pill: for a delivered parcel
  // the useful fact is when it arrived, not the word "Delivered" a second time.
  function custWhen(p) {
    var d = new Date(p.status === "Delivered" ? deliveredAt(p) : p.promisedTs);
    if (isNaN(d.getTime())) return "";
    var when = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return p.status === "Delivered" ? ("Arrived " + when) : ("Est. " + when);
  }
  function deliveredAt(p) {
    var h = (p.history || []).filter(function (x) { return x && x.stage === "Delivered"; }).pop();
    return (h && h.ts) || p.promisedTs;
  }
  function custStatusPill(p) {
    if (p.syncRejected) return '<span class="pill sla-late" title="' + String(p.syncRejected).replace(/"/g, "&quot;") + '">⚠ Needs attention</span>';
    if (p.pendingSync) return '<span class="pill sla-risk">⟲ Syncing…</span>';
    return '<span class="' + pillClass(p.status) + '">' + (CUST_STATUS[p.status] || stageLabelFor(p)) + '</span>';
  }
  // A customer scans this list for "where is my stuff": the parcel furthest along and
  // arriving soonest belongs at the top, and anything already delivered belongs at the
  // bottom. Insertion order put a delivered parcel above one out for delivery today.
  function custOrderSort(a, b) {
    var doneA = a.status === "Delivered" ? 1 : 0, doneB = b.status === "Delivered" ? 1 : 0;
    if (doneA !== doneB) return doneA - doneB;              // active first
    if (doneA) return (b.promisedTs || 0) - (a.promisedTs || 0); // delivered: newest first
    var sa = stageIdx(a.status), sb = stageIdx(b.status);
    if (sa !== sb) return sb - sa;                          // furthest along first
    return (a.promisedTs || 0) - (b.promisedTs || 0);        // then soonest due
  }
  var custQuery = ""; // current filter on the customer's own order list
  // Server-scoped orders: when signed in with a real (non-local) session, a customer's
  // orders live under their account in Netlify Blobs and follow them across devices.
  function hasServerAuth() { var t = (typeof authToken === "function") ? authToken() : null; return !!t && t !== "local"; }
  function myOrdersGet() {
    return fetch("/api/my-orders", { headers: { "Authorization": "Bearer " + authToken() } }).then(function (r) { return r.json(); });
  }
  // Resolves with the parsed body plus _status. The caller needs the status to tell a
  // definite rejection (rate limited, validation) apart from an unreachable server: the
  // first must be shown to the customer, only the second should be queued for retry.
  function myOrdersPost(payload) {
    return fetch("/api/my-orders", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + authToken() }, body: JSON.stringify(payload) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          j._status = r.status;
          return j;
        });
      });
  }
  // Replace this customer's orders in local state with the authoritative server list,
  // but keep any orders still waiting to sync (placed while offline) so a server pull
  // never silently erases them before they've had a chance to reach the server.
  function mergeCustomerOrders(serverOrders, email) {
    if (!email || !Array.isArray(serverOrders)) return;
    var pending = state.packages.filter(function (p) { return p.customerEmail === email && p.pendingSync; });
    state.packages = state.packages.filter(function (p) { return p.customerEmail !== email; }).concat(serverOrders).concat(pending);
    syncSeqFromPackages(); // server-numbered orders must not collide with local ids
    save();
  }
  // Retry any orders that were placed while offline (or the API was unreachable).
  // Once one lands on the server, drop the local placeholder and re-merge.
  // Send orders that were placed offline, one at a time.
  //
  // Sequential rather than parallel on purpose: order creation is rate limited per
  // account, so firing a queue of them at once would guarantee that most get refused.
  // The batch also stops at the first refusal instead of retrying every order on every
  // view load, which otherwise turns a full queue into a hot loop against a limited
  // endpoint. Anything still queued is picked up on the next visit.
  var pendingSyncRunning = false;
  function syncPendingOrders(email) {
    if (!email || !hasServerAuth() || pendingSyncRunning) return;
    var queue = state.packages.filter(function (p) {
      return p.customerEmail === email && p.pendingSync && !p.syncRejected;
    });
    if (!queue.length) return;
    pendingSyncRunning = true;

    var synced = 0;
    var step = function (i) {
      if (i >= queue.length) return finish();
      var p = queue[i];
      var payload = {
        name: p.customer.name, item: p.item.description, value: p.item.value,
        address: p.customer.address, city: p.customer.city, state: p.customer.state, zip: p.customer.zip, phone: p.customer.phone
      };
      return myOrdersPost(payload).then(function (j) {
        if (j && j.ok && j.order) {
          state.packages = state.packages.filter(function (x) { return x.id !== p.id; });
          mergeCustomerOrders(j.orders, email);
          synced++;
          return step(i + 1);
        }
        var status = j && j._status;
        // Rate limited, or the session is gone: stop and try again later. Both resolve
        // on their own (the window moves; the user signs back in).
        if (status === 429 || status === 401) return finish(status === 429 ? j.error : null);
        // Any other definite rejection will never succeed on retry, so stop asking.
        // The order is kept and flagged so the customer can see it needs attention.
        if (status >= 400 && status < 500) {
          p.syncRejected = (j && j.error) || "This order was refused by the server.";
          return finish();
        }
        return finish(); // 5xx or unparseable: leave queued, stay quiet
      }).catch(function () { finish(); }); // offline: leave queued, stay quiet
    };
    var finish = function (message) {
      pendingSyncRunning = false;
      save();
      if (synced) {
        renderCustomerOrderList(email);
        renderCustHomeList(email);
        if (typeof renderNotifs === "function") renderNotifs();
        toast(synced === 1 ? "Synced an offline order." : "Synced " + synced + " offline orders.", "ok");
      }
      if (message) toast(message, "warn", 8000);
      else if (!synced && queue.some(function (p) { return p.syncRejected; })) {
        renderCustomerOrderList(email);
        renderCustHomeList(email);
      }
    };
    step(0);
  }
  // Customer's Home tab: a real landing screen, separate from the ordering flow.
  // Pulls the authoritative list on open so status changes made by ops show up here,
  // not only on the Orders tab.
  function renderCustHome() {
    var u = (typeof currentUser === "function") ? currentUser() : null;
    var email = u ? u.email : null;
    var fetching = email && hasServerAuth();
    // Show placeholders only when there is nothing local to show. If we already have this
    // customer's orders cached, real data beats a shimmer, and swapping it out for
    // skeletons on every visit would make a working app look like a loading one.
    var showSkeleton = fetching && !state.packages.some(function (p) { return p.customerEmail === email; });
    if (showSkeleton) renderCustHomeSkeleton();
    else renderCustHomeList(email);
    if (typeof renderNotifs === "function") renderNotifs();
    if (fetching) {
      myOrdersGet().then(function (j) {
        if (j && j.ok) { mergeCustomerOrders(j.orders, email); renderCustHomeList(email); renderNotifs(); syncPendingOrders(email); }
        else if (showSkeleton) renderCustHomeList(email); // replace placeholders with the real empty state
      }).catch(function () {
        // Offline: keep the local view, but never leave skeletons shimmering forever.
        if (showSkeleton) renderCustHomeList(email);
      });
    }
  }
  // Placeholder rows shaped like the real ones, so the layout doesn't jump when the
  // orders arrive. aria-hidden and aria-busy keep a screen reader from announcing them.
  function renderCustHomeSkeleton() {
    var box = $("#chome-recent");
    if (!box) return;
    box.setAttribute("aria-busy", "true");
    var row = '<div class="cust-order skel-row" aria-hidden="true">' +
      '<div class="co-main"><span class="skeleton skel-title"></span>' +
      '<span class="skeleton skel-meta"></span></div>' +
      '<span class="skeleton skel-pill"></span></div>';
    box.innerHTML = row + row;
  }
  function renderCustHomeList(email) {
    var sbox = $("#chome-recent"); if (sbox) sbox.removeAttribute("aria-busy");
    var u = (typeof currentUser === "function") ? currentUser() : null;
    var greet = $("#chome-greeting");
    if (greet) greet.textContent = "Welcome back" + (u && u.name ? ", " + u.name.split(" ")[0] : "");
    var mine = state.packages.filter(function (p) { return email && p.customerEmail === email; });
    var cc = $("#chome-count"); if (cc) cc.textContent = mine.length ? (mine.length + (mine.length === 1 ? " order" : " orders")) : "";
    var box = $("#chome-recent");
    var viewAll = $("#chome-viewall");
    if (viewAll) viewAll.style.display = mine.length ? "" : "none";
    if (!box) return;
    if (!mine.length) {
      box.innerHTML = '<div class="empty-state"><div class="es-ico">📦</div><b>No orders yet</b>' +
        '<span>Place your first order and it\'ll show up here so you can follow it the whole way.</span></div>';
      return;
    }
    box.innerHTML = mine.slice().sort(custOrderSort).slice(0, 3).map(function (p) {
      var eta = custWhen(p);
      var pill = custStatusPill(p);
      return '<button class="cust-order" data-id="' + p.id + '">' +
        '<div class="co-main"><b>' + p.item.description + '</b>' +
        '<span class="co-meta">' + p.id + ' · ' + eta + '</span></div>' +
        pill + '</button>';
    }).join("");
    $$("#chome-recent [data-id]").forEach(function (b) { b.addEventListener("click", function () { openCustomerOrder(b.dataset.id); }); });
  }
  // ---- Team & roles (Admin only) ----
  //
  // Every rule shown here is also enforced server-side; this only explains them. The
  // server is the authority, so a stale page can't grant anything by being out of date.
  var admUsers = [];
  var admAudit = [];
  var admTruncated = null; // {total} when the server returned only part of the list
  var admQuery = "";
  var admBusy = false;

  function admStatus(msg, kind) {
    var el = $("#adm-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "muted small" + (kind ? " adm-" + kind : "");
  }
  function admFetch(init) {
    return fetch("/api/admin", Object.assign({
      headers: Object.assign({ "Authorization": "Bearer " + authToken() },
        init && init.body ? { "Content-Type": "application/json" } : {})
    }, init || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; });
    });
  }
  function renderAdmin() {
    if (!canManageRoles()) { go(allowedViews()[0]); return; }
    admStatus("Loading accounts…");
    admFetch().then(function (j) {
      if (!j.ok) {
        // 404 here means the server does not consider this session an admin, which can
        // happen if access was revoked in another tab or by a config change.
        admStatus(j._status === 404
          ? "This account no longer has administrator access."
          : (j.error || "Couldn't load accounts."), "err");
        admUsers = [];
      } else {
        admUsers = j.users || [];
        admAudit = j.audit || [];
        admTruncated = j.truncated ? { total: j.total } : null;
        admStatus("");
      }
      renderAdminList();
    }).catch(function () {
      admStatus("Couldn't reach the server. Check your connection and refresh.", "err");
    });
  }
  function renderAdminList() {
    var box = $("#adm-list"); if (!box) return;
    var me = (currentUser() || {}).email;
    var admins = admUsers.filter(function (u) { return u.role === "Admin"; }).length;
    var count = $("#adm-count");
    if (count) count.textContent = admUsers.length
      ? (admTruncated
          // Never let a partial list read as the whole list.
          ? "showing " + admUsers.length + " of " + admTruncated.total + " accounts · " + admins + " admin" + (admins === 1 ? "" : "s") + " here"
          : admUsers.length + (admUsers.length === 1 ? " account" : " accounts") + " · " + admins + " admin" + (admins === 1 ? "" : "s"))
      : "";

    var q = admQuery;
    var rows = admUsers.filter(function (u) {
      return !q || (u.email + " " + (u.name || "")).toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) {
      box.innerHTML = '<div class="empty-state"><div class="es-ico">⚿</div><b>' +
        (admUsers.length ? "No accounts match that search" : "No accounts yet") + '</b>' +
        '<span>' + (admUsers.length ? "Try a different name or address." : "Accounts appear here once people sign up.") + '</span></div>';
      return;
    }
    box.innerHTML = rows.map(function (u) {
      var isMe = u.email === me;
      // An env-granted role is read-only here, and so is your own: both are enforced by
      // the server, and disabling them explains why instead of failing on submit.
      var locked = u.source === "env" || isMe;
      var why = u.source === "env" ? "Set in this site's environment configuration"
        : (isMe ? "You can't change your own role" : "");
      var opts = ROLE_ORDER.map(function (r) {
        return '<option value="' + r + '"' + (r === u.role ? " selected" : "") + '>' +
          (r === "Customer" ? "Customer (no ops access)" : ROLE_META[r].label) + '</option>';
      }).join("");
      return '<div class="adm-row' + (locked ? " adm-locked" : "") + '">' +
        '<div class="adm-who">' +
        '<b>' + attr(u.name || u.email.split("@")[0]) + (isMe ? ' <span class="adm-you">you</span>' : '') + '</b>' +
        '<span class="adm-email">' + attr(u.email) + '</span>' +
        (u.grantedBy ? '<span class="adm-meta">granted by ' + attr(u.grantedBy) + '</span>' : '') +
        '</div>' +
        '<div class="adm-set">' +
        '<select class="adm-role" data-email="' + attr(u.email) + '"' + (locked ? " disabled" : "") +
        ' aria-label="Role for ' + attr(u.email) + '">' + opts + '</select>' +
        (why ? '<span class="adm-why">' + why + '</span>' : '') +
        '</div></div>';
    }).join("");

    $$("#adm-list .adm-role").forEach(function (sel) {
      sel.addEventListener("change", function () { setUserRole(sel.dataset.email, sel.value, sel); });
    });
    renderAdminAudit();
  }
  // The grants record only holds what is true now, so this is the only place a revoked
  // role leaves a trace. Hidden entirely until there is something to show.
  function renderAdminAudit() {
    var card = $("#adm-audit-card"), box = $("#adm-audit");
    if (!card || !box) return;
    card.hidden = !admAudit.length;
    if (!admAudit.length) return;
    box.innerHTML = admAudit.map(function (a) {
      var granted = a.to && a.to !== "Customer";
      var what = granted
        ? "granted " + ((ROLE_META[a.to] || {}).label || a.to)
        : "revoked access";
      return '<div class="adm-audit-row">' +
        '<span class="adm-audit-dot' + (granted ? " up" : " down") + '"></span>' +
        '<div><b>' + attr(a.email) + '</b> <span class="muted">' + what + '</span>' +
        '<span class="adm-audit-meta">by ' + attr(a.by || "unknown") + ' · ' + (a.at ? fmtTime(a.at) : 'unknown time') + '</span></div>' +
        '</div>';
    }).join("");
  }
  // Order shown in the picker: no ops access first, then increasing reach.
  var ROLE_ORDER = ["Customer", "Viewer", "Driver", "Runner", "Admin"];

  function setUserRole(email, role, sel) {
    if (admBusy) return;
    var previous = (admUsers.find(function (u) { return u.email === email; }) || {}).role || "Customer";
    if (role === previous) return;
    var label = role === "Customer" ? "remove operations access for" : ("make " + ROLE_META[role].label.toLowerCase() + ":");
    confirmDialog({
      title: role === "Customer" ? "Revoke access?" : "Change role?",
      message: role === "Customer"
        ? "This removes " + email + "'s access to the operations workspace straight away."
        : "This gives " + email + " the " + ROLE_META[role].label + " role straight away.",
      confirmLabel: role === "Customer" ? "Revoke access" : "Change role",
      danger: role === "Customer"
    }).then(function (ok) {
      if (!ok) { if (sel) sel.value = previous; return; }
      admBusy = true;
      if (sel) sel.disabled = true;
      admStatus("Saving…");
      admFetch({ method: "POST", body: JSON.stringify({ email: email, role: role }) })
        .then(function (j) {
          admBusy = false;
          if (!j.ok) {
            if (sel) { sel.value = previous; sel.disabled = false; }
            admStatus(j.error || "Couldn't change that role.", "err");
            toast(j.error || "Couldn't change that role.", "warn", 8000);
            return;
          }
          admUsers = j.users || admUsers;
          admAudit = j.audit || admAudit;
          admStatus(j.note || "Saved.", "ok");
          toast(email + " is now " + (role === "Customer" ? "a customer" : ROLE_META[role].label), "ok");
          renderAdminList();
        })
        .catch(function () {
          admBusy = false;
          if (sel) { sel.value = previous; sel.disabled = false; }
          admStatus("Couldn't reach the server. Nothing was changed.", "err");
        });
    });
  }

  // ---- Delivery alerts (Web Push) ----
  //
  // Offered only when all three are true: the browser supports push, the deployment has
  // VAPID keys, and there is a real server session to attach the subscription to. Asking
  // for notification permission the app cannot honour is the fastest way to get denied
  // permanently, so the card stays hidden rather than failing on tap.
  var pushInfo = null; // {configured, publicKey} once /api/push has answered
  // Set from the register/login response. null means we have not been told yet.
  var mailAvailable = null;

  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }
  // The VAPID public key travels as base64url and has to reach PushManager as bytes.
  function urlBase64ToUint8Array(base64) {
    var padding = "=".repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function pushApi(init) {
    return fetch("/api/push", Object.assign({
      headers: Object.assign({ "Authorization": "Bearer " + authToken() },
        init && init.body ? { "Content-Type": "application/json" } : {})
    }, init || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; });
    });
  }
  function renderPushCard() {
    var card = $("#acct-push-card"), on = $("#acct-push-on"), off = $("#acct-push-off"), note = $("#acct-push-note");
    if (!card) return;
    if (!pushSupported() || !hasServerAuth() || !(pushInfo && pushInfo.configured)) { card.hidden = true; return; }
    card.hidden = false;

    if (Notification.permission === "denied") {
      // Only the browser can undo this, so say so instead of offering a button that
      // silently does nothing.
      on.hidden = true; off.hidden = true;
      note.textContent = "Notifications are blocked for this site. You can re-enable them in your browser's site settings.";
      return;
    }
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      var active = !!sub && Notification.permission === "granted";
      on.hidden = active; off.hidden = !active;
      note.textContent = active
        ? "On for this device. You'll hear when your parcel is picked up, out for delivery, and delivered."
        : "Get a notification on this device when your parcel is picked up, out for delivery, and delivered.";
    }).catch(function () { on.hidden = false; off.hidden = true; });
  }
  function enablePush() {
    var on = $("#acct-push-on");
    if (on) { on.disabled = true; on.textContent = "Turning on…"; }
    var reset = function () { if (on) { on.disabled = false; on.textContent = "🔔 Turn on notifications"; } };

    Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") { reset(); renderPushCard(); toast("Notifications weren't allowed.", "warn"); return null; }
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,  // required by browsers; every push shows a notification
          applicationServerKey: urlBase64ToUint8Array(pushInfo.publicKey)
        });
      });
    }).then(function (sub) {
      if (!sub) return;
      return pushApi({ method: "POST", body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub }) })
        .then(function (j) {
          reset();
          if (!j.ok) { toast(j.error || "Couldn't turn on notifications.", "warn", 7000); return; }
          toast("Delivery alerts are on for this device.", "ok");
          renderPushCard();
        });
    }).catch(function (e) {
      reset();
      toast("Couldn't turn on notifications on this device.", "warn", 7000);
    });
  }
  function disablePush() {
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) {
        if (!sub) return null;
        var endpoint = sub.endpoint;
        // Unsubscribe locally first: if the server call fails, the device is already quiet,
        // and the stale record is pruned the next time a send to it is refused.
        return sub.unsubscribe().then(function () {
          return pushApi({ method: "DELETE", body: JSON.stringify({ endpoint: endpoint }) });
        });
      })
      .then(function () { toast("Delivery alerts are off for this device.", "ok"); renderPushCard(); })
      .catch(function () { toast("Couldn't turn notifications off.", "warn"); });
  }
  // Asked once per load, not per render: the answer is a property of the deployment.
  function loadPushInfo() {
    if (pushInfo || !pushSupported()) { renderPushCard(); return; }
    fetch("/api/push").then(function (r) { return r.json(); })
      .then(function (j) { pushInfo = { configured: !!j.configured, publicKey: j.publicKey }; renderPushCard(); })
      .catch(function () { pushInfo = { configured: false, publicKey: null }; renderPushCard(); });
  }

  function resendVerification() {
    var btn = $("#acct-verify-resend");
    if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
    var done = function () { if (btn) { btn.disabled = false; btn.textContent = "Send the link again"; } };
    fetch("/api/auth", { method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + authToken() },
      body: JSON.stringify({ action: "verify-request" }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); })
      .then(function (j) {
        done();
        if (j.alreadyVerified) {
          // Confirmed in another tab or on another device; reflect it rather than resend.
          var a = authData(); if (a.user) { a.user.emailVerified = true; authSave(a); }
          renderAccountView();
          toast("Your email is already confirmed.", "ok");
          return;
        }
        if (!j.ok) { toast(j.error || "Couldn't send the link.", "warn", 8000); return; }
        toast("Confirmation link sent. Check your inbox.", "ok");
      })
      .catch(function () { done(); toast("Couldn't reach the server.", "warn"); });
  }

  // Customer's Account tab: profile + sign out, replacing the header account dropdown.
  function renderAccountView() {
    var u = (typeof currentUser === "function") ? currentUser() : null;
    var av = $("#acct-avatar"); if (av) av.textContent = ((u && (u.name || u.email)) || "U").charAt(0).toUpperCase();
    var nm = $("#acct-name"); if (nm) nm.textContent = u ? (u.name || u.email) : "Guest";
    var em = $("#acct-email"); if (em) em.textContent = u ? u.email : "";
    // The nudge to confirm an address, shown only when it is both needed and possible.
    var vc = $("#acct-verify-card");
    if (vc) vc.hidden = !(hasServerAuth() && u && u.emailVerified === false && mailAvailable !== false);
    // Export and closure need the server. In local demo mode there is nothing to act on.
    var dc = $("#acct-data-card"); if (dc) dc.hidden = !hasServerAuth();
    loadPushInfo();
  }

  // ---- Data rights ----
  function exportMyData() {
    var btn = $("#acct-export");
    if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
    var done = function () { if (btn) { btn.disabled = false; btn.innerHTML = '<span aria-hidden="true">⇩</span> Download my data'; } };
    fetch("/api/account", { headers: { "Authorization": "Bearer " + authToken() } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); })
      .then(function (j) {
        done();
        if (!j.ok) { toast(j.error || "Couldn't prepare your data.", "warn", 7000); return; }
        // Downloaded rather than displayed: it contains every address they have shipped to.
        var blob = new Blob([JSON.stringify(j, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "granite-logistics-my-data.json";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast("Your data has been downloaded.", "ok");
      })
      .catch(function () { done(); toast("Couldn't reach the server.", "warn"); });
  }

  function closeMyAccount() {
    confirmDialog({
      title: "Close your account?",
      message: "This deletes your sign-in details and any order we haven't collected yet. " +
        "Shipments already delivered are kept as records with your name and address removed. This can't be undone.",
      confirmLabel: "Close my account", danger: true
    }).then(function (ok) {
      if (!ok) return;
      var btn = $("#acct-close");
      if (btn) { btn.disabled = true; btn.textContent = "Closing…"; }
      fetch("/api/account", { method: "DELETE", headers: { "Authorization": "Bearer " + authToken() } })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); })
        .then(function (j) {
          if (!j.ok) {
            if (btn) { btn.disabled = false; btn.textContent = "Close my account"; }
            // The in-flight case is the one people will hit, so give the reason, not a code.
            toast(j.error || "Couldn't close your account.", "warn", 10000);
            return;
          }
          toast("Your account is closed. Thanks for using Granite Logistics.", "ok", 6000);
          // Sign out locally so nothing of theirs is left on this device.
          setTimeout(function () { logoutUser(); showLogin(); }, 1200);
        })
        .catch(function () {
          if (btn) { btn.disabled = false; btn.textContent = "Close my account"; }
          toast("Couldn't reach the server. Nothing was changed.", "warn");
        });
    });
  }
  function renderOrder() {
    if (typeof resetOrderForm === "function") resetOrderForm();
    var u = (typeof currentUser === "function") ? currentUser() : null;
    var email = u ? u.email : null;
    renderCustomerOrderList(email);
    if (typeof renderNotifs === "function") renderNotifs();
    // Pull the authoritative list from the server (if signed in), then re-render.
    if (email && hasServerAuth()) {
      myOrdersGet().then(function (j) {
        if (j && j.ok) { mergeCustomerOrders(j.orders, email); renderCustomerOrderList(email); renderNotifs(); syncPendingOrders(email); }
      }).catch(function () { /* offline. Keep local view. */ });
    }
  }
  function renderCustomerOrderList(email) {
    var all = state.packages.filter(function (p) { return email && p.customerEmail === email; });
    var cc = $("#cust-count"); if (cc) cc.textContent = all.length ? (all.length + (all.length === 1 ? " order" : " orders")) : "";
    var box = $("#cust-orders"); if (!box) return;
    var search = $("#cust-search"); if (search) search.style.display = all.length > 1 ? "" : "none";
    // Filter by tracking number, carrier tracking, item, or status.
    var mine = !custQuery ? all : all.filter(function (p) {
      return (p.id + " " + (p.tracking || "") + " " + p.item.description + " " +
        (CUST_STATUS[p.status] || stageLabelFor(p) || "")).toLowerCase().indexOf(custQuery) >= 0;
    });
    if (all.length && !mine.length) {
      box.innerHTML = '<div class="empty-state"><div class="es-ico">🔍</div><b>No matches</b>' +
        '<span>Nothing matches “' + custQuery + '”. Try a tracking number or item name.</span></div>';
      return;
    }
    if (!all.length) {
      box.innerHTML = '<div class="empty-state"><div class="es-ico">📦</div><b>No orders yet</b>' +
        '<span>Create your first shipment in three quick steps. We\'ll move it from pickup to your door and keep you posted along the way.</span>' +
        '<div class="es-steps">' +
        '<div class="es-step"><span class="es-step-ico">📝</span><span>Place your order</span></div>' +
        '<span class="es-step-arrow">→</span>' +
        '<div class="es-step"><span class="es-step-ico">🚚</span><span>We pick up &amp; ship</span></div>' +
        '<span class="es-step-arrow">→</span>' +
        '<div class="es-step"><span class="es-step-ico">✅</span><span>Delivered &amp; tracked</span></div>' +
        '</div>' +
        '<button class="btn primary" id="try-sample" type="button"><span aria-hidden="true">✨</span> Try a sample order</button></div>';
      var ts = $("#try-sample"); if (ts) ts.addEventListener("click", fillSampleOrder);
      return;
    }
    box.innerHTML = mine.slice().sort(custOrderSort).map(function (p) {
      var eta = custWhen(p);
      var pill = custStatusPill(p);
      return '<button class="cust-order" data-id="' + p.id + '">' +
        '<div class="co-main"><b>' + p.item.description + '</b>' +
        '<span class="co-meta">' + p.id + ' · ' + eta + '</span></div>' +
        pill + '</button>';
    }).join("");
    $$("#cust-orders [data-id]").forEach(function (b) { b.addEventListener("click", function () { openCustomerOrder(b.dataset.id); }); });
  }
  // Guided multi-step order flow (Item → Delivery → Review)
  var ORDER_STEP = 1;
  function gotoStep(n) {
    ORDER_STEP = n;
    $$("#cust-order-form .order-step").forEach(function (s) { s.classList.toggle("active", +s.dataset.step === n); });
    $$("#order-steps .ostep").forEach(function (s) {
      var d = +s.dataset.step;
      s.classList.toggle("active", d === n);
      s.classList.toggle("done", d < n);
      var dot = s.querySelector(".os-dot"); if (dot) dot.textContent = d < n ? "✓" : String(d);
    });
    var err = $("#step-err"); if (err) err.textContent = "";
  }
  function stepVal(n) { var f = $("#cust-order-form"); var el = f && f.elements.namedItem(n); return el ? el.value.trim() : ""; }
  function validateStep(n) {
    var f = $("#cust-order-form"); if (!f) return true;
    var need = n === 1 ? [["item", "Please describe the item you're shipping."]]
      : n === 2 ? [["name", "Please enter the recipient's name."]] : [];
    for (var i = 0; i < need.length; i++) {
      var el = f.elements.namedItem(need[i][0]);
      if (el && !el.value.trim()) {
        el.classList.add("invalid"); el.focus();
        var err = $("#step-err"); if (err) err.textContent = need[i][1];
        return false;
      }
      if (el) el.classList.remove("invalid");
    }
    return true;
  }
  function buildReview() {
    var addr = [stepVal("address"), stepVal("city"), stepVal("state").toUpperCase(), stepVal("zip")].filter(Boolean).join(", ") || "–";
    var rows = [
      ["Item", stepVal("item") || "–"],
      ["Declared value", stepVal("value") ? "$" + stepVal("value") : "–"],
      ["Recipient", stepVal("name") || "–"],
      ["Address", addr],
      ["Phone", stepVal("phone") || "–"]
    ];
    var rs = $("#review-summary");
    if (rs) rs.innerHTML = rows.map(function (r) { return '<div><dt>' + r[0] + '</dt><dd>' + r[1] + '</dd></div>'; }).join("");
  }
  function fillSampleOrder() {
    var f = $("#cust-order-form"); if (!f) return;
    var u = (typeof currentUser === "function") ? currentUser() : null;
    var set = function (n, val) { var el = f.elements.namedItem(n); if (el) { el.value = val; el.classList.remove("invalid"); } };
    set("item", 'Samsung 65" QLED TV'); set("value", "1400");
    set("name", (u && u.name) || "Jane Doe"); set("address", "742 Birchwood Ln");
    set("city", "Columbus"); set("state", "OH"); set("zip", "43004"); set("phone", "(614) 555-0142");
    gotoStep(1);
    var card = $("#order-form-card"); if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Sample order filled in. Review the steps and place it, or edit any field.", "ok");
  }
  var custForm = $("#cust-order-form");
  if (custForm) {
    custForm.addEventListener("click", function (e) {
      var t = e.target;
      var nx = t.closest ? t.closest("[data-next]") : null;
      var bk = t.closest ? t.closest("[data-back]") : null;
      if (nx) { if (!validateStep(ORDER_STEP)) return; var to = +nx.getAttribute("data-next"); if (to === 3) buildReview(); gotoStep(to); }
      else if (bk) { gotoStep(+bk.getAttribute("data-back")); }
    });
    custForm.addEventListener("input", function (e) { if (e.target.classList) e.target.classList.remove("invalid"); var err = $("#step-err"); if (err) err.textContent = ""; });
    custForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!stepVal("item")) { gotoStep(1); validateStep(1); return; }
      if (!stepVal("name")) { gotoStep(2); validateStep(2); return; }
      var form = this;
      var v = function (n) { var el = form.elements.namedItem(n); return el ? el.value : ""; };
      var u = (typeof currentUser === "function") ? currentUser() : null;
      var email = u ? u.email : null;
      var payload = {
        name: v("name") || (u && u.name) || "–", item: v("item"), value: v("value"),
        address: v("address"), city: v("city"), state: v("state"), zip: v("zip"), phone: v("phone")
      };
      var finish = function (p, queuedNote) {
        form.reset(); renderCustomerOrderList(email); showOrderSuccess(p);
        toast(p.pendingSync ? (queuedNote || "Order saved. We'll sync it once you're back online.")
                            : "Order placed. Tracking " + p.id, "ok");
      };
      // pendingSync=true means we intended to save this server-side but couldn't confirm
      // it. Kept and retried (see syncPendingOrders) instead of being lost. queuedNote
      // exists because "once you're back online" is wrong when the server answered and
      // simply could not confirm the write.
      var placeLocal = function (pendingSync, queuedNote) {
        var p = makeOrderFrom(Object.assign({ source: "Customer Order" }, payload));
        p.customerEmail = email;
        if (pendingSync) p.pendingSync = true;
        state.packages.push(p); save();
        finish(p, queuedNote);
      };
      if (hasServerAuth()) {
        var btn = $("#cust-order-form [type=submit]"); if (btn) { btn.disabled = true; btn.textContent = "Placing…"; }
        myOrdersPost(payload).then(function (j) {
          if (btn) { btn.disabled = false; btn.textContent = "Place order →"; }
          if (j && j.ok && j.order) { mergeCustomerOrders(j.orders, email); finish(j.order); }
          else if (j && j._status >= 400 && j._status < 500) {
            // The server reached a decision and said no. Queueing this for retry would
            // both lie to the customer and defeat the rate limit.
            toast(j.error || "We couldn't place that order.", "warn", 8000);
          }
          else if (j && j._status >= 500) {
            placeLocal(true, "Saved. The server is busy, so we'll confirm this order shortly.");
          }
          else { placeLocal(true); }
        }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = "Place order →"; } placeLocal(true); });
      } else {
        placeLocal(false);
      }
    });
  }
  var lastOrderId = null;
  function showOrderSuccess(p) {
    lastOrderId = p.id;
    var idEl = $("#os-id"); if (idEl) idEl.textContent = p.id;
    var dest = p.customer.name + (p.customer.city ? " · " + p.customer.city + ", " + p.customer.state : "");
    var eta = new Date(p.promisedTs).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    var sum = $("#os-summary");
    if (sum) sum.innerHTML =
      '<div><dt>Item</dt><dd>' + p.item.description + '</dd></div>' +
      '<div><dt>Deliver to</dt><dd>' + dest + '</dd></div>' +
      '<div><dt>Estimated delivery</dt><dd>' + eta + '</dd></div>';
    var card = $("#order-form-card"); if (card) card.classList.add("is-success");
  }
  function resetOrderForm() { var card = $("#order-form-card"); if (card) card.classList.remove("is-success"); if (typeof gotoStep === "function") gotoStep(1); }
  var osAnother = $("#os-another");
  if (osAnother) osAnother.addEventListener("click", function () { resetOrderForm(); var f = $("#cust-order-form"); var first = f && f.elements.namedItem("item"); if (first) first.focus(); });
  var osTrack = $("#os-track");
  if (osTrack) osTrack.addEventListener("click", function () { if (lastOrderId) openCustomerOrder(lastOrderId); });

  function counts() {
    var c = {}; STAGES.forEach(function (s) { c[s] = 0; });
    state.packages.forEach(function (p) { c[p.status]++; });
    return c;
  }

  function renderOverview() {
    var c = counts(), total = state.packages.length;
    var delivered = c.Delivered;
    var inTransit = c.InTransit + c.OutforDelivery;
    var nonDelivered = total - delivered;
    var custodyValue = state.packages.filter(function (p) { return p.status !== "Delivered"; }).reduce(function (a, p) { return a + p.item.value; }, 0);
    var activeCarrierSet = {};
    state.packages.forEach(function (p) { if (p.carrier && p.status !== "Delivered" && stageIdx(p.status) >= 3) activeCarrierSet[p.carrier] = 1; });
    var activeCarriers = Object.keys(activeCarrierSet).length;
    var dwp = state.packages.filter(function (p) { return p.status === "Delivered" && p.photos && p.photos.delivery; }).length;
    var photoPct = delivered ? Math.round(dwp / delivered * 100) : 100;
    var kpis = [
      ["Active Packages", total, nonDelivered + " in motion"],
      ["In Transit Now", inTransit, activeCarriers + " carrier" + (activeCarriers === 1 ? "" : "s") + " active"],
      ["Delivered", delivered, photoPct + "% photo-verified"],
      ["Goods In Custody", money(custodyValue), nonDelivered + " shipments"]
    ];
    $("#kpi-row").innerHTML = kpis.map(function (k) {
      return '<div class="kpi"><div class="k-label">' + k[0] + '</div><div class="k-val">' + k[1] +
        '</div><div class="k-sub">' + k[2] + '</div></div>';
    }).join("");

    // Alerts: open exceptions + SLA breaches on undelivered packages
    var alerts = state.packages.filter(function (p) { return p.exception || (p.status !== "Delivered" && slaStatus(p) === "Late"); });
    $("#alerts-count").textContent = alerts.length ? alerts.length + " needs attention" : "all clear";
    $("#alerts-card").style.borderColor = alerts.length ? "#fca5a5" : "";
    $("#overview-alerts").innerHTML = alerts.length ? alerts.map(function (p) {
      var reason = p.exception ? ("Exception · " + p.exception.type) : "SLA breach · past promised delivery";
      return '<div class="alert-row" data-id="' + p.id + '"><span class="alert-dot"></span>' +
        '<div class="alert-main"><b class="mono">' + p.id + '</b> · ' + p.customer.name + ' · ' + p.customer.city + ', ' + p.customer.state +
        '<div class="alert-reason">' + reason + '</div></div>' +
        '<span class="' + pillClass(p.status) + '">' + stageLabelFor(p) + '</span></div>';
    }).join("") : '<p class="muted">No open exceptions or SLA breaches. All clear.</p>';
    $$("#overview-alerts .alert-row").forEach(function (r) { makeActivatable(r, function () { openPackage(r.dataset.id); }); });

    var max = Math.max.apply(null, STAGES.map(function (s) { return c[s]; })) || 1;
    $("#funnel").innerHTML = STAGES.map(function (s) {
      return '<div class="funnel-row"><span class="fn">' + STAGE_LABEL[s] + '</span>' +
        '<div class="funnel-bar" style="width:' + Math.max(6, (c[s] / max) * 100) + '%"></div>' +
        '<span class="muted">' + c[s] + '</span></div>';
    }).join("");

    var carriers = {};
    state.packages.filter(function (p) { return p.carrier && stageIdx(p.status) >= 3 && p.status !== "Delivered"; })
      .forEach(function (p) { carriers[p.carrier] = (carriers[p.carrier] || 0) + 1; });
    var cmax = Math.max.apply(null, Object.keys(carriers).map(function (k) { return carriers[k]; }).concat([1]));
    $("#carrier-mix").innerHTML = Object.keys(carriers).length ? Object.keys(carriers).map(function (k) {
      return '<div class="cm-row"><span class="cm-badge" style="background:' + (CARRIER_COLOR[k] || "#334155") + '">' + k +
        '</span><div class="cm-bar"><i style="width:' + (carriers[k] / cmax * 100) + '%;background:' + (CARRIER_COLOR[k] || "#334155") + '"></i></div>' +
        '<span class="muted">' + carriers[k] + '</span></div>';
    }).join("") : '<p class="muted">No active outbound right now.</p>';

    // Tiebroken by id so the table is deterministic. Sorting by stage alone leaves
    // same-stage rows in an unspecified order, which makes the list appear to shuffle
    // between renders during the 1.5s sync loop.
    var rows = state.packages.slice().sort(function (a, b) {
      return (stageIdx(b.status) - stageIdx(a.status)) || String(a.id).localeCompare(String(b.id));
    }).slice(0, 9);
    $("#overview-table").innerHTML =
      '<thead><tr><th>Package</th><th>Customer</th><th>Destination</th><th>Carrier</th><th>Status</th></tr></thead><tbody>' +
      (rows.length ? "" : '<tr><td colspan="5" class="muted" style="padding:20px;text-align:center">No shipments yet. Pull or add orders in Order Ingest.</td></tr>') +
      rows.map(function (p) {
        return '<tr data-id="' + p.id + '"><td class="mono">' + p.id + '</td><td>' + p.customer.name +
          '</td><td>' + p.customer.city + ", " + p.customer.state + '</td><td>' + (p.carrier || "–") +
          '</td><td><span class="' + pillClass(p.status) + '">' + stageLabelFor(p) + '</span></td></tr>';
      }).join("") + '</tbody>';
    $$("#overview-table tr[data-id]").forEach(function (tr) {
      tr.addEventListener("click", function () { openPackage(tr.dataset.id); });
    });
  }

  function renderIngest() {
    var bySource = {};
    state.packages.forEach(function (p) { bySource[p.source] = (bySource[p.source] || 0) + 1; });
    $("#connectors").innerHTML = SOURCES.map(function (s) {
      return '<div class="connector"><div class="c-top"><span class="c-name">' + s +
        '</span><span class="c-status"><span class="dot ok"></span> Connected</span></div>' +
        '<div class="c-meta">OAuth 2.0 · webhook: orders/create</div>' +
        '<div class="c-meta"><b>' + (bySource[s] || 0) + '</b> orders ingested</div></div>';
    }).join("");
    renderFeed();
    var wc = $("#webhook-curl");
    if (wc) {
      var c = cloudCfg(), base = c.url || location.origin;
      wc.textContent = 'curl -X POST ' + base + '/api/orders \\\n' +
        '  -H "x-api-key: ' + c.key + '" -H "Content-Type: application/json" \\\n' +
        '  -d \'{"name":"Jane Doe","item":"LG OLED TV","value":1100,"city":"Dayton","state":"OH","zip":"45402","source":"Shopify"}\'';
    }
  }
  // API-first demo: push current state, POST an order to the webhook, pull it back.
  function simulateWebhook() {
    var c = cloudCfg(), base = c.url || "";
    if (c.provider === "supabase") { toast("Webhook ingest needs the Node/Edge backend. On Supabase, orders sync via Cloud Sync.", "ok"); return; }
    var st = $("#webhook-status");
    var item = pick(ITEMS), city = pick(CITIES);
    var order = { name: pick(FIRST) + " " + pick(LAST), item: item[0], value: item[1], address: (100 + rng(8900)) + " " + pick(STREETS), city: city[0], state: city[1], zip: city[2], source: "Shopify (webhook)" };
    var hdr = cloudHeaders(c, true);
    if (st) st.textContent = "Pushing current state…";
    fetch(base + "/api/state", { method: "PUT", headers: hdr, body: JSON.stringify({ packages: state.packages, manifests: state.manifests, loadUnits: state.loadUnits, events: state.events, settings: state.settings }) })
      // Surface an auth failure here rather than continuing and failing confusingly later.
      .then(function (r) { return r.ok ? null : r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.hint || j.error || r.status); }); })
      .then(function () { if (st) st.textContent = "POSTing order to /api/orders…"; return fetch(base + "/api/orders", { method: "POST", headers: hdr, body: JSON.stringify(order) }); })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || "failed"); if (st) st.textContent = "Pulling updated state…"; return fetch(base + "/api/state", { headers: cloudHeaders(c, false) }); })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!Array.isArray(s.packages)) throw new Error("bad state");
        state.packages = s.packages; state.manifests = s.manifests || []; state.loadUnits = s.loadUnits || []; state.events = s.events || [];
        save();
        if (st) st.textContent = "✓ Inbound order received via API: " + order.item + " → " + order.name;
        toast("Inbound order ingested via webhook", "api"); renderIngest();
      })
      .catch(function () { if (st) st.textContent = "✕ Backend unreachable. Run server/server.js, or set a Cloud Sync URL in Settings."; toast("Webhook backend unreachable", "ok"); });
  }
  function renderFeed() {
    var recent = state.packages.slice().reverse().slice(0, 8);
    $("#ingest-feed").innerHTML = recent.map(function (p) {
      return '<div class="ingest-item"><div><span class="src">' + p.source + '</span><div><b>' +
        p.item.description + '</b> → ' + p.customer.name + '</div><code>order ' + p.orderRef +
        ' · ' + p.customer.city + ", " + p.customer.state + " " + p.customer.zip + '</code></div>' +
        '<button class="btn sm" data-id="' + p.id + '">View</button></div>';
    }).join("");
    $$("#ingest-feed button[data-id]").forEach(function (b) { b.addEventListener("click", function () { openPackage(b.dataset.id); }); });
  }
  $("#pull-orders").addEventListener("click", function () {
    var p = makePackage(0);
    state.packages.push(p); save();
    toast("API: pulled order " + p.orderRef + " from " + p.source, "api");
    renderFeed(); renderIngest();
  });

  function renderRunner() {
    var list = state.packages.filter(function (p) { return p.status === "Won" || p.status === "Intake"; });
    $("#runner-count").textContent = list.length + " awaiting pickup";
    $("#runner-list").innerHTML = list.length ? list.map(function (p) {
      var labeled = p.status === "Intake";
      return '<div class="row-item"><div class="ri-main"><div class="ri-title">' + p.item.description +
        '</div><div class="ri-sub">' + p.id + " · " + p.customer.name + " · " + p.source + '</div></div>' +
        (labeled
          ? '<span class="pill st-Intake">Labeled</span> <button class="btn ok sm" data-pickup="' + p.id + '">Photo &amp; Bin</button>'
          : '<button class="btn primary sm" data-label="' + p.id + '">Generate Label</button>') +
        '</div>';
    }).join("") : '<p class="muted">All caught up. No items awaiting pickup.</p>';

    $$("#runner-list button[data-label]").forEach(function (b) {
      b.addEventListener("click", function () { generateLabel(b.dataset.label); });
    });
    $$("#runner-list button[data-pickup]").forEach(function (b) {
      b.addEventListener("click", function () { doPickup(b.dataset.pickup); });
    });
  }

  function generateLabel(id) {
    var p = getPkg(id);
    advance(p, "Intake");
    toast("Code 128 label printed for " + p.id, "ok");
    openLabel(p);
    renderRunner();
  }
  function doPickup(id) {
    var p = getPkg(id);
    p.photos.pickup = placeholderPhoto(p.item.description, "PICKUP", "#2280b5"); // immediate fallback
    advance(p, "PickedUp"); // saves
    toast("Condition photo captured · " + p.id + " binned", "ok");
    renderRunner();
    // Offer to replace with a real device-camera photo (non-blocking).
    capturePhoto("PICKUP", "#2280b5").then(function (url) {
      if (url) { p.photos.pickup = url; save(); toast("Live condition photo saved for " + p.id, "ok"); renderAll(); }
    });
  }

  function openLabel(p) {
    modal(
      '<button class="close-x" data-close>×</button><h2>Tracking Label</h2>' +
      '<p class="muted">' + p.item.description + ' → ' + p.customer.name + '</p>' +
      '<div class="label-card" style="margin-top:14px">' +
      '<div style="font-weight:800;font-size:1.1rem">' + companyName().toUpperCase() + '</div>' +
      '<div class="muted small">' + p.customer.address + ', ' + p.customer.city + ', ' + p.customer.state + ' ' + p.customer.zip + '</div>' +
      '<div style="margin:12px 0">' + Code128.toSVG(p.barcode, { height: 80, moduleWidth: 2 }) + '</div>' +
      '<div class="lbl-key">' + p.barcode + '</div></div>' +
      '<div style="margin-top:16px;text-align:center;display:flex;gap:8px;justify-content:center">' +
      '<button class="btn primary" id="print-label"><span aria-hidden="true">🖨</span> Print</button>' +
      '<button class="btn" id="pdf-label"><span aria-hidden="true">📄</span> PDF (server)</button></div>'
    );
    var pb = $("#print-label");
    if (pb) pb.addEventListener("click", function () { printLabel(p); });
    var pdfb = $("#pdf-label");
    if (pdfb) pdfb.addEventListener("click", function () {
      var c = cloudCfg(), base = c.url || location.origin;
      window.open(base + "/api/label/" + encodeURIComponent(p.id) + "?key=" + encodeURIComponent(c.key), "_blank");
    });
  }
  // Real printing: render a clean label into #print-root and invoke the browser print dialog.
  function printLabel(p) {
    $("#print-root").innerHTML =
      '<div class="plabel"><div class="pl-h">' + companyName().toUpperCase() + '</div>' +
      '<div class="pl-sub">PRIORITY &middot; ' + (p.carrier || "GROUND") + (p.lane ? " &middot; " + p.lane : "") + '</div>' +
      '<div class="pl-to"><span class="pl-lbl">SHIP TO</span><br>' + p.customer.name + '<br>' +
      p.customer.address + '<br>' + p.customer.city + ', ' + p.customer.state + ' ' + p.customer.zip + '</div>' +
      '<div class="pl-bc">' + Code128.toSVG(p.barcode, { height: 95, moduleWidth: 2.6 }) + '</div>' +
      '<div class="pl-key">' + p.barcode + '</div></div>';
    window.print();
  }

  // ---- Batch ----
  var batchSel = {};
  function renderBatch() {
    batchSel = {};
    if ($("#batch-carrier") && state.settings.defaultCarrier) $("#batch-carrier").value = state.settings.defaultCarrier;
    if ($("#batch-lane") && state.settings.defaultLane) $("#batch-lane").value = state.settings.defaultLane;
    var staged = state.packages.filter(function (p) { return p.status === "PickedUp"; });
    $("#stage-list").innerHTML = staged.length ? staged.map(function (p) {
      return '<div class="row-item selectable" data-id="' + p.id + '">' +
        (p.photos.pickup ? '<img class="thumb" src="' + p.photos.pickup + '">' : '') +
        '<div class="ri-main"><div class="ri-title">' + p.item.description + '</div>' +
        '<div class="ri-sub">' + p.id + " · " + p.customer.city + ", " + p.customer.state + " " + p.customer.zip + '</div></div></div>';
    }).join("") : '<p class="muted">No items staged for batching. Pick up items in the Runner Dashboard first.</p>';
    $$("#stage-list .row-item").forEach(function (el) {
      makeActivatable(el, function () {
        var id = el.dataset.id;
        if (batchSel[id]) { delete batchSel[id]; el.classList.remove("selected"); }
        else { batchSel[id] = true; el.classList.add("selected"); }
        updateManifest();
      });
    });
    updateManifest();
    renderManifests();
  }
  function updateManifest() {
    var ids = Object.keys(batchSel);
    $("#commit-batch").disabled = ids.length === 0;
    $("#manifest-selected").innerHTML = ids.length
      ? ids.map(function (id) { return '<span class="chip">' + id + "</span>"; }).join("")
      : "No items selected.";
  }
  $("#commit-batch").addEventListener("click", function () {
    var carrier = $("#batch-carrier").value, lane = $("#batch-lane").value;
    var ids = Object.keys(batchSel);
    if (!ids.length) return;
    var batchId = "BATCH-" + (700 + rng(299));
    ids.forEach(function (id) {
      var p = getPkg(id);
      p.carrier = carrier; p.lane = lane; p.batchId = batchId;
      advance(p, "Staged");
    });
    state.manifests.unshift({ id: batchId, carrier: carrier, lane: lane, ts: Date.now(), packageIds: ids.slice() });
    save();
    toast(ids.length + " items → " + carrier + " manifest " + batchId + " at " + lane, "ok");
    renderBatch();
  });

  // ---- Manifests: list, print, export ----
  function manifestPkgs(m) { return m.packageIds.map(getPkg).filter(Boolean); }
  function renderManifests() {
    var el = $("#manifest-list"); if (!el) return;
    if (!state.manifests.length) { el.innerHTML = '<p class="muted">No manifests yet. Build one above.</p>'; return; }
    el.innerHTML = state.manifests.slice(0, 12).map(function (m) {
      return '<div class="row-item"><div class="ri-main"><div class="ri-title">' + m.id +
        ' <span class="cm-badge" style="background:' + (CARRIER_COLOR[m.carrier] || "#334155") + '">' + m.carrier + '</span>' +
        (m.transmitted ? ' <span class="pill st-Delivered">transmitted</span>' : '') + '</div>' +
        '<div class="ri-sub">' + manifestPkgs(m).length + ' packages · ' + m.lane + ' · ' + fmtTime(m.ts) + '</div></div>' +
        '<div class="head-actions"><button class="btn sm" data-mprint="' + m.id + '"><span aria-hidden="true">🖨</span> Print</button>' +
        '<button class="btn sm" data-mcsv="' + m.id + '"><span aria-hidden="true">↓</span> CSV</button>' +
        '<button class="btn sm" data-mlabels="' + m.id + '"><span aria-hidden="true">🏷</span> Labels PDF</button>' +
        '<button class="btn sm" data-mxmit="' + m.id + '"><span aria-hidden="true">⇈</span> Transmit</button></div></div>';
    }).join("");
    $$("#manifest-list [data-mprint]").forEach(function (b) { b.addEventListener("click", function () { printManifest(b.dataset.mprint); }); });
    $$("#manifest-list [data-mcsv]").forEach(function (b) { b.addEventListener("click", function () { exportManifest(b.dataset.mcsv); }); });
    $$("#manifest-list [data-mxmit]").forEach(function (b) { b.addEventListener("click", function () { transmitManifest(b.dataset.mxmit); }); });
    $$("#manifest-list [data-mlabels]").forEach(function (b) { b.addEventListener("click", function () { var c = cloudCfg(), base = c.url || location.origin; window.open(base + "/api/manifest/" + encodeURIComponent(b.dataset.mlabels) + "/labels?key=" + encodeURIComponent(c.key), "_blank"); }); });
  }
  function printManifest(id) {
    var m = state.manifests.find(function (x) { return x.id === id; }); if (!m) return;
    var ps = manifestPkgs(m);
    $("#print-root").innerHTML =
      '<div class="pmanifest"><div class="pl-h">' + companyName().toUpperCase() + ' &middot; OUTBOUND MANIFEST</div>' +
      '<div class="pl-sub">' + m.id + ' &middot; ' + m.carrier + ' &middot; ' + m.lane + ' &middot; ' + fmtTime(m.ts) + '</div>' +
      '<table class="pm-tbl"><thead><tr><th>#</th><th>Package</th><th>Destination</th><th>Item</th></tr></thead><tbody>' +
      ps.map(function (p, i) {
        return '<tr><td>' + (i + 1) + '</td><td>' + p.id + '</td><td>' + p.customer.city + ', ' + p.customer.state + ' ' + p.customer.zip + '</td><td>' + p.item.description + '</td></tr>';
      }).join("") +
      '</tbody></table><div class="pm-foot">Total packages: ' + ps.length + '</div></div>';
    window.print();
  }
  function exportManifest(id) {
    var m = state.manifests.find(function (x) { return x.id === id; }); if (!m) return;
    var lines = ["manifest,carrier,lane,package,name,destination,item,barcode"];
    manifestPkgs(m).forEach(function (p) {
      lines.push([m.id, m.carrier, m.lane, p.id, p.customer.name,
        p.customer.city + " " + p.customer.state + " " + p.customer.zip, p.item.description, p.barcode].map(csvCell).join(","));
    });
    downloadFile(m.id + ".csv", lines.join("\n"), "text/csv");
    toast("Manifest " + m.id + " exported", "ok");
  }

  // ---- Reports / analytics ----
  function renderReports() {
    var pkgs = state.packages, total = pkgs.length || 1;
    var delivered = pkgs.filter(function (p) { return p.status === "Delivered"; });
    var stamp = function (p, st) { return (p.history.find(function (h) { return h.stage === st; }) || {}).ts; };
    var transit = delivered.map(function (p) { var a = stamp(p, "Won"), b = stamp(p, "Delivered"); return (a && b) ? (b - a) / 3600000 : null; }).filter(function (v) { return v != null; });
    var avgTransit = transit.length ? transit.reduce(function (a, b) { return a + b; }, 0) / transit.length : 0;
    var valueDelivered = delivered.reduce(function (a, p) { return a + p.item.value; }, 0);
    var onTime = delivered.filter(function (p) { return slaStatus(p) === "On-time"; }).length;
    var onTimePct = delivered.length ? Math.round(onTime / delivered.length * 100) : 100;
    var openExc = pkgs.filter(function (p) { return p.exception; }).length;
    var kpis = [
      ["Avg Transit Time", avgTransit.toFixed(1) + " h", delivered.length + " delivered"],
      ["On-Time Rate", onTimePct + "%", onTime + "/" + delivered.length + " on time"],
      ["Value Delivered", money(valueDelivered), "lifetime"],
      ["Open Exceptions", openExc, openExc === 0 ? "all clear" : "needs attention"]
    ];
    $("#rep-kpi").innerHTML = kpis.map(function (k) { return '<div class="kpi"><div class="k-label">' + k[0] + '</div><div class="k-val">' + k[1] + '</div><div class="k-sub">' + k[2] + '</div></div>'; }).join("");

    var bySource = {}; pkgs.forEach(function (p) { bySource[p.source] = (bySource[p.source] || 0) + 1; });
    $("#rep-source").innerHTML = barRows(Object.keys(bySource).map(function (k) { return { label: k, val: bySource[k] }; }));

    var byCarrier = {}; pkgs.forEach(function (p) { if (p.carrier) byCarrier[p.carrier] = (byCarrier[p.carrier] || 0) + p.item.value; });
    $("#rep-carrier").innerHTML = barRows(Object.keys(byCarrier).map(function (k) { return { label: k, val: byCarrier[k], fmt: money }; }));

    var trans = [];
    for (var i = 0; i < STAGES.length - 1; i++) {
      var diffs = [];
      pkgs.forEach(function (p) {
        var a = stamp(p, STAGES[i]), b = stamp(p, STAGES[i + 1]);
        if (a && b && b >= a) diffs.push((b - a) / 3600000);
      });
      trans.push({ label: STAGE_LABEL[STAGES[i]] + " → " + STAGE_LABEL[STAGES[i + 1]], val: diffs.length ? +(diffs.reduce(function (x, y) { return x + y; }, 0) / diffs.length).toFixed(1) : 0, suffix: " h" });
    }
    $("#rep-stage").innerHTML = barRows(trans);
  }
  function barRows(items) {
    if (!items.length) return '<p class="muted">No data yet.</p>';
    var max = Math.max.apply(null, items.map(function (i) { return i.val; }).concat([1]));
    return items.map(function (i) {
      var disp = i.fmt ? i.fmt(i.val) : (i.val + (i.suffix || ""));
      return '<div class="funnel-row" style="grid-template-columns:180px 1fr 70px"><span class="fn">' + i.label + '</span>' +
        '<div class="funnel-bar" style="width:' + Math.max(4, (i.val / max) * 100) + '%"></div>' +
        '<span class="muted">' + disp + '</span></div>';
    }).join("");
  }

  // ---- Activity log (audit trail) ----
  var activityQuery = "";
  function renderActivity() {
    var events = [];
    state.packages.forEach(function (p) {
      (p.history || []).forEach(function (h) {
        events.push({ ts: h.ts, pkgId: p.id, kind: "stage", label: stageLabelFor(p, h.stage), pill: pillClass(h.stage), note: h.note, who: p.customer.name });
      });
    });
    (state.events || []).forEach(function (e) {
      var label = e.kind === "resolved" ? "Resolved" : e.kind === "return" ? "Return" : "Exception";
      var pill = e.kind === "resolved" ? "pill sla-ok" : e.kind === "return" ? "pill st-InTransit" : "pill sla-late";
      events.push({ ts: e.ts, pkgId: e.pkgId, kind: e.kind, who: e.who, note: e.note, label: label, pill: pill });
    });
    events.sort(function (a, b) { return b.ts - a.ts; });
    if (activityQuery) {
      events = events.filter(function (e) {
        return (e.pkgId + " " + e.label + " " + e.note + " " + e.who).toLowerCase().indexOf(activityQuery) >= 0;
      });
    }
    var el = $("#activity-feed");
    el.innerHTML = events.length ? events.slice(0, 200).map(function (e) {
      return '<div class="act-row"><span class="' + e.pill + '">' + e.label + '</span>' +
        '<div class="act-main"><div class="act-top"><b class="mono">' + e.pkgId + '</b> · ' + e.who + '</div>' +
        '<div class="act-note">' + e.note + '</div></div>' +
        '<div class="act-time">' + fmtTime(e.ts) + '</div></div>';
    }).join("") : '<p class="muted">No activity matches “' + activityQuery + '”.</p>';
    var count = $("#activity-count"); if (count) count.textContent = events.length + " events";
  }

  // ---- Settings ----
  function renderSettings() {
    var s = state.settings, c = s.company;
    var set = function (n, v) { var el = $('#set-' + n); if (el) el.value = v; };
    set("name", c.name); set("address", c.address); set("phone", c.phone); set("email", c.email);
    set("carrier", s.defaultCarrier); set("lane", s.defaultLane);
    var cl = s.cloud || {};
    var setv = function (id, v) { var el = $(id); if (el) el.value = v; };
    var cp = $("#cloud-provider"); if (cp) cp.value = cl.provider || "granite";
    setv("#cloud-url", cl.url || ""); setv("#cloud-key", cl.key || "granite-dev-key");
    setv("#cloud-sburl", cl.sbUrl || ""); setv("#cloud-sbanon", cl.sbAnon || ""); setv("#cloud-tenant", cl.tenant || "default");
    var ca = $("#cloud-auto"); if (ca) ca.checked = !!cl.autoSync;
    syncProviderUI();
  }

  // ---- Cloud sync (provider: Granite API server OR Supabase REST) ----
  function cloudCfg() {
    var c = state.settings.cloud || {};
    return {
      provider: c.provider || "granite",
      url: (c.url || "").trim().replace(/\/$/, ""),
      key: (c.key || "granite-dev-key").trim(),
      sbUrl: (c.sbUrl || "").trim().replace(/\/$/, ""),
      sbAnon: (c.sbAnon || "").trim(),
      tenant: (c.tenant || "default").trim() || "default",
      autoSync: !!c.autoSync
    };
  }
  function saveCloudInputs() {
    var v = function (id, d) { var el = $(id); return (el ? (el.value || "") : "").trim() || d; };
    state.settings.cloud = {
      provider: (($("#cloud-provider") || {}).value) || "granite",
      url: v("#cloud-url", ""), key: v("#cloud-key", "granite-dev-key"),
      sbUrl: v("#cloud-sburl", ""), sbAnon: v("#cloud-sbanon", ""), tenant: v("#cloud-tenant", "default"),
      autoSync: !!(($("#cloud-auto") || {}).checked)
    };
    resetSyncBlock(); // new url/key/provider deserves a fresh attempt
    save();
  }
  // `deleted` carries ids this client removed on purpose. The server preserves any
  // customer order missing from `packages` (it was probably created after our last
  // pull), so without these tombstones an ops deletion would resurrect on next push.
  function fullState() {
    return {
      packages: state.packages, manifests: state.manifests, loadUnits: state.loadUnits,
      events: state.events, settings: state.settings, deleted: state.tombstones || []
    };
  }
  // Record an intentional deletion so it survives the server-side merge. Kept for a
  // week, which is far longer than any client stays out of sync.
  function addTombstone(id) {
    if (!Array.isArray(state.tombstones)) state.tombstones = [];
    var weekAgo = Date.now() - 7 * 86400000;
    state.tombstones = state.tombstones.filter(function (t) { return t && t.ts > weekAgo && t.id !== id; });
    state.tombstones.push({ id: id, ts: Date.now() });
  }
  // Local ids come from `seq`, but customer orders are numbered on the server and
  // arrive via a pull, so `seq` has to catch up or the next locally-created package
  // would reuse an id that already exists in the workspace.
  function syncSeqFromPackages() {
    var max = 1040;
    state.packages.forEach(function (p) {
      var m = /GL-(\d+)/.exec((p && p.id) || "");
      if (m) max = Math.max(max, +m[1]);
    });
    if (seq <= max) seq = max + 1;
  }
  function applyPulled(s) {
    if (!s || !Array.isArray(s.packages)) return false;
    state.packages = s.packages; state.manifests = s.manifests || []; state.loadUnits = s.loadUnits || []; state.events = s.events || [];
    syncSeqFromPackages();
    save(); return true;
  }
  // Headers for the Granite workspace API.
  //
  // The session token is what actually authorizes /api/state now: the server checks the
  // signed-in user's role, because the tenant key ships in this bundle and so is public.
  // x-api-key is still sent for the self-hosted Node server, which authorizes by key.
  function cloudHeaders(c, withBody) {
    var h = withBody ? { "Content-Type": "application/json" } : {};
    if (c.key) h["x-api-key"] = c.key;
    if (hasServerAuth()) h["Authorization"] = "Bearer " + authToken();
    return h;
  }

  // Turn a failed workspace response into an Error that carries the status and the
  // server's hint, so callers can tell "you are offline" (retry) apart from "this account
  // has no ops access" (stop and say so).
  function workspaceError(r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      var e = new Error(j.hint || j.error || ("HTTP " + r.status));
      e.status = r.status;
      return Promise.reject(e);
    });
  }

  // Returns a Promise resolving to {count}; rejects on error.
  function pushState() {
    var c = cloudCfg();
    if (c.provider === "supabase") {
      return fetch(c.sbUrl + "/rest/v1/workspaces", {
        method: "POST",
        headers: { apikey: c.sbAnon, Authorization: "Bearer " + c.sbAnon, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ tenant: c.tenant, data: fullState(), updated_at: new Date().toISOString() })
      }).then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.status); }); return { count: state.packages.length }; });
    }
    return fetch(c.url + "/api/state", { method: "PUT", headers: cloudHeaders(c, true), body: JSON.stringify(fullState()) })
      .then(function (r) {
        if (!r.ok) return workspaceError(r);
        return r.json().then(function (j) { return { count: j.packages }; });
      });
  }
  // Returns a Promise resolving to a state object (or null if none).
  function pullState() {
    var c = cloudCfg();
    if (c.provider === "supabase") {
      return fetch(c.sbUrl + "/rest/v1/workspaces?select=data&tenant=eq." + encodeURIComponent(c.tenant), { headers: { apikey: c.sbAnon, Authorization: "Bearer " + c.sbAnon } })
        .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.status); }); return r.json(); })
        .then(function (rows) { return (rows && rows[0]) ? rows[0].data : null; });
    }
    return fetch(c.url + "/api/state", { headers: cloudHeaders(c, false) })
      .then(function (r) { return r.ok ? r.json() : workspaceError(r); });
  }

  // Auto-sync: debounced push on change, pull-or-seed on load.
  // Ops roles only. A customer's orders travel through /api/my-orders (which reads and
  // writes just their own rows of the shared workspace); letting a customer push their
  // whole local state with the tenant key would clobber everyone else's packages.
  var autoPushTimer = null, syncing = false;
  // The server authorizes /api/state by the signed-in user's role. If it says this
  // account has no ops access, retrying every 1.5s will never help, so latch it off and
  // tell the user once. Silence here used to mean working all day in a local-only
  // workspace while believing it was syncing.
  var syncBlocked = null;
  function workspaceSyncAllowed() {
    var cl = state.settings && state.settings.cloud;
    return !!(cl && cl.autoSync) && currentRole() !== "Customer" && !syncBlocked;
  }
  // Auth failures are permanent until something changes; anything else (offline, 500,
  // DNS) is transient and stays quiet so a flaky connection isn't noisy.
  function syncFailed(e) {
    var permanent = e && (e.status === 401 || e.status === 403);
    if (!permanent) { cloudStatus("Offline · will retry"); return; }
    if (syncBlocked) return;
    syncBlocked = e.message || "Not authorized";
    cloudStatus("⚠ Cloud sync off: " + syncBlocked);
    toast("Cloud sync stopped: " + syncBlocked, "warn", 9000);
  }
  // Called after sign-in or a settings change, so a fixed permission is picked up
  // without making the user reload.
  function resetSyncBlock() { syncBlocked = null; }
  // A button press deserves a specific message, unlike a background attempt. Still runs
  // syncFailed so an auth failure latches auto-sync off rather than retrying forever.
  function manualSyncFailed(e, what) {
    var reason = (e && e.message) || "unreachable";
    var permanent = e && (e.status === 401 || e.status === 403);
    syncFailed(e);
    cloudStatus("✕ " + what + " failed: " + reason);
    if (!permanent) toast(what + " failed: " + reason, "warn");
  }
  function scheduleAutoPush() {
    if (!workspaceSyncAllowed() || syncing) return;
    clearTimeout(autoPushTimer);
    autoPushTimer = setTimeout(autoPush, 1500);
  }
  function autoPush() {
    pushState()
      .then(function () { cloudStatus("✓ Auto-synced · " + new Date().toLocaleTimeString()); })
      .catch(syncFailed);
  }
  function bootSync() {
    if (!workspaceSyncAllowed()) return;
    syncing = true;
    pullState().then(function (s) {
      if (s && Array.isArray(s.packages) && s.packages.length) { applyPulled(s); applyRole(); go(allowedViews()[0]); toast("Synced from cloud", "api"); }
      else { autoPush(); }
      syncing = false;
    }).catch(function (e) { syncing = false; syncFailed(e); });
  }
  function cloudStatus(msg) { var el = $("#cloud-status"); if (el) el.textContent = msg; }
  function cloudBusy(on) { ["#cloud-push", "#cloud-pull"].forEach(function (id) { var b = $(id); if (b) b.disabled = on; }); }
  // The manual buttons are an explicit retry, so they clear the auth latch first and
  // restore auto-sync if the permission has since been granted.
  function cloudPush() {
    saveCloudInputs(); resetSyncBlock(); cloudStatus("Pushing…"); cloudBusy(true);
    pushState().then(function (o) { cloudStatus("✓ Pushed " + o.count + " packages · " + new Date().toLocaleTimeString()); toast("Pushed to cloud", "api"); })
      .catch(function (e) { manualSyncFailed(e, "Push"); })
      .finally(function () { cloudBusy(false); });
  }
  function cloudPull() {
    saveCloudInputs(); resetSyncBlock(); cloudStatus("Pulling…"); cloudBusy(true);
    pullState().then(function (s) {
      if (applyPulled(s)) { cocSelected = null; trackQuery = ""; cloudStatus("✓ Pulled " + state.packages.length + " packages · " + new Date().toLocaleTimeString()); toast("Pulled from cloud", "api"); applyRole(); go(allowedViews()[0]); }
      else { cloudStatus("No data found for this workspace yet. Push first."); }
    }).catch(function (e) { manualSyncFailed(e, "Pull"); })
      .finally(function () { cloudBusy(false); });
  }
  function syncProviderUI() {
    var p = (($("#cloud-provider") || {}).value) || "granite";
    var g = $("#grp-granite"), s = $("#grp-supabase");
    if (g) g.style.display = p === "supabase" ? "none" : "";
    if (s) s.style.display = p === "supabase" ? "" : "none";
  }

  // ---- Operational logistics: ZIP pre-sort, palletization, transmission ----
  function zoneOf(p) { return (p.customer.zip || "").replace(/[^0-9]/g, "").slice(0, 3) || "–"; }
  function recommendedLane(zone) {
    var n = 0; for (var i = 0; i < zone.length; i++) n += zone.charCodeAt(i);
    return "Lane " + (1 + (n % 4));
  }
  function scacFor(carrier) { return { UPS: "UPSN", FedEx: "FDEG", "Dayton Freight": "DAFG", "Pitt Ohio": "PITD" }[carrier] || "GLOG"; }

  function renderPresort() {
    var loose = state.packages.filter(function (p) { return p.status === "PickedUp" && !p.loadUnit; });
    var zones = {};
    loose.forEach(function (p) { (zones[zoneOf(p)] = zones[zoneOf(p)] || []).push(p); });
    var keys = Object.keys(zones).sort();
    $("#presort-zones").innerHTML = keys.length ? keys.map(function (z) {
      var arr = zones[z], ex = arr[0];
      var sorted = arr.every(function (p) { return p.sortZone === z; });
      return '<div class="row-item"><div class="ri-main"><div class="ri-title">ZIP ' + z + 'xx · ' + ex.customer.city + ', ' + ex.customer.state +
        (sorted ? ' <span class="pill st-Staged">pre-sorted</span>' : '') + '</div>' +
        '<div class="ri-sub">' + arr.length + ' parcel' + (arr.length === 1 ? '' : 's') + ' · bypass hub → ' + recommendedLane(z) + '</div></div>' +
        '<button class="btn primary sm" data-pallet="' + z + '">Build Load Unit</button></div>';
    }).join("") : '<p class="muted">No loose parcels awaiting pre-sort. Pick up items in the Runner Dashboard first.</p>';
    $$("#presort-zones [data-pallet]").forEach(function (b) { b.addEventListener("click", function () { buildLoadUnit(b.dataset.pallet); }); });
    renderLoadUnits();
  }
  $("#run-presort") && $("#run-presort").addEventListener("click", function () {
    var loose = state.packages.filter(function (p) { return p.status === "PickedUp" && !p.loadUnit; });
    if (!loose.length) { toast("Nothing to pre-sort right now.", "ok"); return; }
    var zones = {};
    loose.forEach(function (p) { p.sortZone = zoneOf(p); p.presortLane = recommendedLane(p.sortZone); zones[p.sortZone] = 1; });
    save();
    toast("Pre-sorted " + loose.length + " parcels into " + Object.keys(zones).length + " ZIP zones. Hub bypass enabled.", "ok");
    renderPresort();
  });

  function buildLoadUnit(zone) {
    var loose = state.packages.filter(function (p) { return p.status === "PickedUp" && !p.loadUnit && zoneOf(p) === zone; });
    if (!loose.length) return;
    var id = "LD-" + (5000 + rng(4999));
    var lane = recommendedLane(zone);
    var weight = loose.reduce(function (a, p) { return a + (p.item.weight || 10); }, 0);
    loose.forEach(function (p) { p.loadUnit = id; p.sortZone = zone; p.presortLane = lane; });
    state.loadUnits.unshift({ id: id, zone: zone, lane: lane, parcels: loose.map(function (p) { return p.id; }), weightLb: weight, ts: Date.now() });
    save();
    toast(loose.length + " parcels consolidated into load unit " + id + " (" + weight + " lb)", "ok");
    renderPresort();
  }

  function renderLoadUnits() {
    var el = $("#loadunit-list"); if (!el) return;
    if (!state.loadUnits.length) { el.innerHTML = '<p class="muted">No load units yet. Build one from a ZIP zone above.</p>'; return; }
    el.innerHTML = state.loadUnits.map(function (u) {
      var pkgs = u.parcels.map(getPkg).filter(Boolean);
      var staged = pkgs.length && pkgs.every(function (p) { return stageIdx(p.status) >= 3; });
      var density = (u.weightLb / Math.max(1, u.parcels.length)).toFixed(0);
      return '<div class="row-item"><div class="ri-main"><div class="ri-title">' + u.id + ' · ZIP ' + u.zone + 'xx ' +
        '<span class="cm-badge" style="background:#334155">' + u.parcels.length + ' parcels</span></div>' +
        '<div class="ri-sub">' + u.weightLb + ' lb total · ~' + density + ' lb/parcel · ' + u.lane + (staged ? ' · staged ✓' : '') + '</div></div>' +
        (staged ? '<span class="pill st-Staged">Staged</span>' : '<button class="btn ok sm" data-stage="' + u.id + '">Stage to Manifest</button>') + '</div>';
    }).join("");
    $$("#loadunit-list [data-stage]").forEach(function (b) { b.addEventListener("click", function () { stageLoadUnit(b.dataset.stage); }); });
  }

  function stageLoadUnit(id) {
    var u = state.loadUnits.find(function (x) { return x.id === id; }); if (!u) return;
    var pkgs = u.parcels.map(getPkg).filter(Boolean).filter(function (p) { return p.status === "PickedUp"; });
    if (!pkgs.length) { toast("Load unit already staged.", "ok"); return; }
    var carrier = state.settings.defaultCarrier || "UPS";
    var batchId = "BATCH-" + (700 + rng(299));
    pkgs.forEach(function (p) { p.carrier = carrier; p.lane = u.lane; p.batchId = batchId; advance(p, "Staged"); });
    state.manifests.unshift({ id: batchId, carrier: carrier, lane: u.lane, ts: Date.now(), packageIds: pkgs.map(function (p) { return p.id; }), loadUnits: [u.id] });
    save();
    toast(u.id + " staged → " + carrier + " manifest " + batchId + " at " + u.lane, "ok");
    renderPresort();
  }
  function transmitManifest(id) {
    var m = state.manifests.find(function (x) { return x.id === id; }); if (!m) return;
    var ps = manifestPkgs(m);
    var payload = {
      asnId: m.id, transmittedAt: new Date().toISOString(), carrier: m.carrier, scac: scacFor(m.carrier),
      dockLane: m.lane, shipper: companyName(), loadUnits: m.loadUnits || [],
      totalParcels: ps.length, totalWeightLb: ps.reduce(function (a, p) { return a + (p.item.weight || 10); }, 0),
      shipments: ps.map(function (p) {
        return { tracking: p.tracking || p.barcode, sortZone: zoneOf(p), weightLb: p.item.weight || 10, item: p.item.description,
          shipTo: { name: p.customer.name, city: p.customer.city, state: p.customer.state, zip: p.customer.zip } };
      })
    };
    downloadFile(m.id + "-ASN.json", JSON.stringify(payload, null, 2), "application/json");
    m.transmitted = true; m.transmittedTs = Date.now(); save();
    toast("Manifest " + m.id + " transmitted to " + m.carrier + " network (ASN / EDI-214)", "api");
    renderManifests();
  }

  // ---- Driver scan ----
  function renderDriver() {
    var scannable = state.packages.filter(function (p) { return p.status === "Staged" || p.status === "InTransit" || p.status === "OutforDelivery"; });
    $("#scan-select").innerHTML = scannable.map(function (p) {
      return '<option value="' + p.id + '">' + p.id + " · " + p.item.description + " (" + stageLabelFor(p) + ")</option>";
    }).join("") || '<option value="">No packages staged</option>';
    $("#scan-result").innerHTML = '<p class="muted">Scan a label to retrieve package details.</p>';
  }
  function processScan(id) {
    if (!id) return;
    var p = getPkg(id);
    if (!p) { toast("No staged package matches that label.", "ok"); return; }
    if (p.status === "Delivered") { toast(p.id + " is already delivered.", "ok"); return; }
    var next = p.status === "Staged" ? "InTransit" : p.status === "InTransit" ? "OutforDelivery" : "Delivered";
    if (p.status === "Staged" && !p.tracking) {
      p.tracking = trackingFor(p.carrier);
      toast(p.carrier + " API: shipment created · tracking " + p.tracking, "api");
    }
    if (next === "Delivered") p.photos.delivery = placeholderPhoto(p.item.description, "DELIVERED", "#15803d");
    advance(p, next);
    var actionLabel = next === "InTransit" ? "Picked Up (In Transit)" : next === "OutforDelivery" ? "Out for Delivery" : "Delivered (photo captured)";
    toast(p.id + " → " + actionLabel, "ok");
    $("#scan-result").innerHTML =
      field("Package", p.id, true) + field("Item", p.item.description) +
      field("Deliver To", p.customer.name) +
      field("Address", p.customer.address + ", " + p.customer.city + ", " + p.customer.state + " " + p.customer.zip) +
      field("Carrier", (p.carrier || "–") + (p.lane ? " · " + p.lane : "")) +
      field("Tracking", p.tracking || "–", true) +
      field("New Status", stageLabelFor(p)) +
      '<div style="margin-top:12px"><button class="btn sm" data-open="' + p.id + '">View Chain of Custody</button></div>';
    var btn = $("#scan-result [data-open]");
    if (btn) btn.addEventListener("click", function () { openPackage(p.id); });
    renderDriver();
    // On delivery, offer a real device-camera proof-of-delivery photo (non-blocking).
    if (next === "Delivered") {
      capturePhoto("DELIVERED", "#15803d").then(function (url) {
        if (url) { p.photos.delivery = url; save(); toast("Proof-of-delivery photo saved for " + p.id, "ok"); renderAll(); }
      });
    }
  }
  $("#do-scan").addEventListener("click", function () { processScan($("#scan-select").value); });
  function field(k, v, mono) { return '<div class="field"><b>' + k + '</b><span' + (mono ? ' class="mono"' : "") + ">" + v + "</span></div>"; }

  // ---- Live camera barcode scanning (BarcodeDetector where supported) ----
  var scanStream = null, scanActive = false;
  function stopScan() {
    scanActive = false;
    if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; }
    var v = $("#scan-video"); if (v) { try { v.pause(); } catch (e) { } v.srcObject = null; v.classList.remove("on"); }
    var h = $("#scan-hint"); if (h) h.style.display = "";
    var b = $("#scan-live"); if (b) b.textContent = "📷 Live Camera Scan";
  }
  function scanLive() {
    if (scanActive) { stopScan(); return; }
    if (!("BarcodeDetector" in window) || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      toast("Live scanning needs a camera + Chromium browser. Use the selector below.", "ok"); return;
    }
    var detector = new window.BarcodeDetector({ formats: ["code_128", "qr_code", "code_39"] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(function (stream) {
      scanStream = stream; scanActive = true;
      var v = $("#scan-video"); v.srcObject = stream; v.classList.add("on");
      var h = $("#scan-hint"); if (h) h.style.display = "none";
      $("#scan-live").textContent = "■ Stop Camera";
      v.play();
      var norm = function (s) { return String(s).toUpperCase().replace(/[^A-Z0-9]/g, ""); };
      (function loop() {
        if (!scanActive) return;
        detector.detect(v).then(function (codes) {
          var hit = (codes || []).map(function (c) { return norm(c.rawValue); })
            .map(function (r) { return state.packages.find(function (p) { return norm(p.barcode) === r || norm(p.id) === r; }); })
            .filter(Boolean)[0];
          if (hit && /Staged|InTransit|OutforDelivery/.test(hit.status)) {
            stopScan(); $("#scan-select").value = hit.id; toast("Scanned " + hit.id, "ok"); processScan(hit.id); return;
          }
          setTimeout(loop, 400);
        }).catch(function () { setTimeout(loop, 600); });
      })();
    }).catch(function () { toast("Couldn't access the camera.", "warn"); scanActive = false; });
  }

  // ---- Tracking / chain of custody ----
  var cocSelected = null;
  var trackQuery = "";
  var trackSelectMode = false, trackSelect = {};
  function updateBulkBar() {
    var bar = $("#track-bulk"); if (!bar) return;
    if (!trackSelectMode) { bar.style.display = "none"; return; }
    var ids = Object.keys(trackSelect);
    bar.style.display = "flex";
    bar.innerHTML = '<span class="bulk-count">' + ids.length + ' selected</span>' +
      '<button class="btn sm" data-bulk="export"' + (ids.length ? '' : ' disabled') + '><span aria-hidden="true">↓</span> Export selected</button>' +
      '<button class="btn sm" data-bulk="clear">Clear</button>';
    var ex = bar.querySelector('[data-bulk="export"]'); if (ex) ex.addEventListener("click", exportSelected);
    var cl = bar.querySelector('[data-bulk="clear"]'); if (cl) cl.addEventListener("click", function () { trackSelect = {}; renderTracking(); });
  }
  function exportSelected() {
    var ids = Object.keys(trackSelect); if (!ids.length) return;
    var cols = ["id", "status", "source", "name", "item", "value", "city", "state", "zip", "carrier", "tracking", "barcode"];
    var lines = [cols.join(",")];
    state.packages.filter(function (p) { return trackSelect[p.id]; }).forEach(function (p) {
      lines.push([p.id, p.status, p.source, p.customer.name, p.item.description, p.item.value, p.customer.city, p.customer.state, p.customer.zip, p.carrier || "", p.tracking || "", p.barcode].map(csvCell).join(","));
    });
    downloadFile("granite-selected.csv", lines.join("\n"), "text/csv");
    toast(ids.length + " packages exported", "ok");
  }
  function renderTracking() {
    var tvReset = $("#view-tracking"); if (tvReset) tvReset.classList.remove("detail-open"); // open to the list on mobile
    var pkgs = state.packages.slice().sort(function (a, b) { return stageIdx(b.status) - stageIdx(a.status); });
    if (trackQuery) {
      pkgs = pkgs.filter(function (p) {
        // The account email is searchable so a support request from an address can be
        // traced straight to the package.
        return (p.id + " " + p.customer.name + " " + p.customer.city + " " + p.customer.state + " " +
          p.item.description + " " + stageLabelFor(p) + " " + (p.tracking || "") + " " + (p.carrier || "") +
          " " + (p.customerEmail || ""))
          .toLowerCase().indexOf(trackQuery) >= 0;
      });
    }
    $("#tracking-list").innerHTML = pkgs.length ? pkgs.map(function (p) {
      return '<div class="row-item selectable' + (trackSelectMode && trackSelect[p.id] ? ' selected' : '') + '" data-id="' + p.id + '">' +
        (trackSelectMode ? '<input type="checkbox" class="tk-check"' + (trackSelect[p.id] ? ' checked' : '') + ' />' : '') +
        '<div class="ri-main">' +
        '<div class="ri-title">' + p.id + " · " + p.item.description + (p.exception ? ' <span class="pill sla-late">exception</span>' : '') + '</div>' +
        '<div class="ri-sub">' + p.customer.name + " · " + p.customer.city + ", " + p.customer.state +
        (p.customerEmail ? ' · <span class="ri-acct">' + p.customerEmail + '</span>' : '') + '</div></div>' +
        '<span class="' + pillClass(p.status) + '">' + stageLabelFor(p) + '</span>' + slaPillHtml(p) + '</div>';
    }).join("") : '<p class="muted">No packages match “' + trackQuery + '”.</p>';
    $$("#tracking-list .row-item").forEach(function (el) {
      makeActivatable(el, function () {
        var id = el.dataset.id;
        if (trackSelectMode) {
          if (trackSelect[id]) delete trackSelect[id]; else trackSelect[id] = true;
          renderTracking(); return;
        }
        cocSelected = id;
        $$("#tracking-list .row-item").forEach(function (r) { r.classList.remove("selected"); });
        el.classList.add("selected");
        renderCoc(id);
        var tv = $("#view-tracking"); if (tv) tv.classList.add("detail-open"); // mobile master→detail
      });
    });
    updateBulkBar();
    if (!trackSelectMode && cocSelected && getPkg(cocSelected)) renderCoc(cocSelected);
  }
  function renderCoc(id) {
    var p = getPkg(id);
    var cur = stageIdx(p.status);
    $("#coc-title").textContent = "Chain of Custody: " + p.id;
    var meta = '<div class="coc-meta">' +
      '<span class="chip">Source: ' + p.source + '</span>' +
      (p.carrier ? '<span class="chip">Carrier: ' + p.carrier + '</span>' : "") +
      (p.lane ? '<span class="chip">' + p.lane + '</span>' : "") +
      (p.tracking ? '<span class="chip">Tracking: ' + p.tracking + '</span>' : "") +
      '<span class="chip">Value: ' + money(p.item.value) + '</span></div>';
    var tl = '<div class="timeline">' + STAGES.map(function (s, i) {
      var h = p.history.find(function (x) { return x.stage === s; });
      var cls = i < cur ? "done" : i === cur ? "current" : "";
      return '<div class="tl-node ' + cls + '"><div class="tl-stage">' + stageLabelFor(p, s) + '</div>' +
        (h ? '<div class="tl-time">' + fmtTime(h.ts) + '</div><div class="tl-note">' + h.note + '</div>'
           : '<div class="tl-note muted">Pending</div>') + '</div>';
    }).join("") + '</div>';
    var photos = "";
    if (p.photos.pickup || p.photos.delivery) {
      photos = '<div class="card-head" style="margin-top:8px"><h2 style="font-size:.95rem">Condition Photos</h2></div><div class="photos" style="display:flex;gap:10px">' +
        (p.photos.pickup ? '<img style="width:120px;height:120px;border-radius:11px;border:1px solid var(--line)" src="' + p.photos.pickup + '">' : "") +
        (p.photos.delivery ? '<img style="width:120px;height:120px;border-radius:11px;border:1px solid var(--line)" src="' + p.photos.delivery + '">' : "") + '</div>';
    }
    $("#coc-detail").innerHTML = meta + tl + photos;
  }

  // ---- Role home (field mode for Runner / Driver) ----
  function homeTiles(arr) {
    return '<div class="home-tiles">' + arr.map(function (t) {
      return '<div class="home-tile' + (t[2] ? ' attn' : '') + '"><div class="ht-val">' + t[1] + '</div><div class="ht-label">' + t[0] + '</div></div>';
    }).join("") + '</div>';
  }
  function homeAction(view, ico, title, sub) {
    return '<button class="home-action" data-go="' + view + '"><span class="ha-ico">' + ico + '</span><span class="ha-title">' + title + '</span><span class="ha-sub">' + sub + '</span></button>';
  }
  function renderHome() {
    var el = $("#home-content"); if (!el) return;
    var c = counts(), role = currentRole();
    if (role === "Driver") {
      $("#view-title").textContent = "Driver Home";
      $("#view-sub").textContent = "Your stops and scans for today.";
      var stops = state.packages.filter(function (p) { return p.status === "InTransit" || p.status === "OutforDelivery"; });
      el.innerHTML =
        homeTiles([["On Vehicle", c.OutforDelivery, false], ["In Transit", c.InTransit, false], ["Awaiting Pickup", c.Staged, false]]) +
        '<button class="home-cta" data-go="driver">📷 &nbsp;Scan a Label</button>' +
        '<div class="card"><div class="card-head"><h2>Your Stops</h2><span class="muted">' + stops.length + ' active</span></div>' +
        '<div class="pickup-list">' + (stops.length ? stops.map(function (p) {
          var act = p.status === "InTransit" ? "Out for Delivery →" : "Mark Delivered ✓";
          return '<div class="row-item" data-open="' + p.id + '"><div class="ri-main"><div class="ri-title">' + p.id + ' · ' + p.item.description +
            (p.exception ? ' <span class="pill sla-late">exception</span>' : '') + '</div><div class="ri-sub">' + p.customer.name + ' · ' + p.customer.address + ', ' + p.customer.city + '</div></div>' +
            '<span class="' + pillClass(p.status) + '">' + stageLabelFor(p) + '</span> <button class="btn ok sm" data-scan="' + p.id + '">' + act + '</button></div>';
        }).join("") : '<p class="muted">No active stops. Scan a staged label to begin.</p>') + '</div></div>';
    } else {
      $("#view-title").textContent = "Runner Home";
      $("#view-sub").textContent = "Your pickups and staging at a glance.";
      var awaiting = c.Won + c.Intake;
      var loose = state.packages.filter(function (p) { return p.status === "PickedUp" && !p.loadUnit; }).length;
      var openUnits = state.loadUnits.filter(function (u) { return u.parcels.map(getPkg).filter(Boolean).some(function (p) { return p.status === "PickedUp"; }); }).length;
      var exc = state.packages.filter(function (p) { return p.exception; }).length;
      el.innerHTML =
        homeTiles([["Pickups Awaiting", awaiting, awaiting > 0], ["To Pre-Sort", loose, false], ["Open Exceptions", exc, exc > 0]]) +
        '<div class="home-actions">' +
        homeAction("runner", "▣", "Today's Pickups", "Photograph & label items") +
        homeAction("presort", "⤧", "Pre-Sort & Stage", "ZIP-sort and palletize") +
        homeAction("batch", "⊞", "Manifests", "Build & hand off to carrier") +
        '</div>';
    }
    $$("#home-content [data-go]").forEach(function (b) { b.addEventListener("click", function () { go(b.dataset.go); }); });
    // These are row divs on the role-home view, so they need keyboard activation. The
    // action button inside each row is native and focusable already, and stops propagation.
    $$("#home-content [data-open]").forEach(function (b) { makeActivatable(b, function () { openPackage(b.dataset.open); }); });
    $$("#home-content [data-scan]").forEach(function (b) { b.addEventListener("click", function (ev) { ev.stopPropagation(); processScan(b.dataset.scan); renderHome(); }); });
  }

  // ---- SLA + exceptions ----
  function slaStatus(p) {
    if (!p.promisedTs) return null;
    if (p.status === "Delivered") {
      var d = (p.history.find(function (h) { return h.stage === "Delivered"; }) || {}).ts;
      return (d && d <= p.promisedTs) ? "On-time" : "Late";
    }
    var now = Date.now();
    if (now > p.promisedTs) return "Late";
    if (p.promisedTs - now < 86400000) return "At-risk";
    return "On-track";
  }
  function slaPillHtml(p) {
    var s = slaStatus(p); if (!s) return "";
    var cls = { "On-time": "sla-ok", "On-track": "sla-ok", "At-risk": "sla-risk", "Late": "sla-late" }[s] || "";
    return ' <span class="pill ' + cls + '">' + (p.status === "Delivered" ? s : "SLA: " + s) + '</span>';
  }
  function logEvent(p, kind, note) {
    if (!state.events) state.events = [];
    state.events.unshift({ ts: Date.now(), pkgId: p.id, who: p.customer.name, kind: kind, note: note });
  }
  function flagException(id) {
    var p = getPkg(id); if (!p) return;
    modal('<button class="close-x" data-close>×</button><h2>Flag Exception: ' + p.id + '</h2>' +
      '<form id="exc-form" class="order-form" style="margin-top:12px">' +
      '<div class="ff"><label>Type</label><select name="type"><option>Address Issue</option><option>Damaged in Transit</option><option>Weather Delay</option><option>Failed Delivery Attempt</option><option>Customs / Compliance Hold</option><option>Lost / Mis-sort</option></select></div>' +
      '<div class="ff"><label>Note</label><input name="note" placeholder="Optional details" /></div>' +
      '<button class="btn danger" type="submit">Flag Exception</button></form>');
    $("#exc-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var type = this.elements.namedItem("type").value, note = this.elements.namedItem("note").value.trim();
      p.exception = { type: type, note: note, ts: Date.now() };
      logEvent(p, "exception", "Exception: " + type + (note ? " (" + note + ")" : ""));
      save(); toast("Exception flagged on " + p.id + ": " + type, "ok"); closeModal(); renderAll();
    });
  }
  function resolveException(id) {
    var p = getPkg(id); if (!p || !p.exception) return;
    logEvent(p, "resolved", "Exception resolved: " + p.exception.type);
    p.exception = null; save(); toast("Exception resolved on " + p.id, "ok"); closeModal(); renderAll();
  }

  // ---- Returns / reverse logistics ----
  var RETURN_FLOW = ["Requested", "In Transit", "Received"];
  function returnPillClass(st) { return st === "Received" ? "pill sla-ok" : st === "In Transit" ? "pill st-InTransit" : "pill sla-risk"; }
  function initiateReturn(id) {
    var p = getPkg(id); if (!p) return;
    modal('<button class="close-x" data-close>×</button><h2>Initiate Return: ' + p.id + '</h2>' +
      '<p class="muted">' + p.item.description + ' → ' + p.customer.name + '</p>' +
      '<form id="ret-form" class="order-form" style="margin-top:12px">' +
      '<div class="ff"><label>Reason</label><select name="reason"><option>Damaged / Defective</option><option>Wrong Item</option><option>No Longer Wanted</option><option>Did Not Arrive</option><option>Other</option></select></div>' +
      '<div class="ff"><label>Note</label><input name="note" placeholder="Optional details" /></div>' +
      '<button class="btn primary" type="submit">Create Return</button></form>');
    $("#ret-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var reason = this.elements.namedItem("reason").value, note = this.elements.namedItem("note").value.trim();
      p.return = { status: "Requested", reason: reason, note: note, ts: Date.now() };
      logEvent(p, "return", "Return requested: " + reason + (note ? " (" + note + ")" : ""));
      save(); toast("Return created for " + p.id, "ok"); closeModal(); renderAll();
    });
  }
  function advanceReturn(id) {
    var p = getPkg(id); if (!p || !p.return) return;
    var i = RETURN_FLOW.indexOf(p.return.status);
    if (i < 0 || i >= RETURN_FLOW.length - 1) return;
    p.return.status = RETURN_FLOW[i + 1]; p.return.ts = Date.now();
    logEvent(p, "return", "Return " + p.return.status.toLowerCase());
    save(); toast(p.id + " return → " + p.return.status, "ok"); renderAll();
  }
  function renderReturns() {
    var rets = state.packages.filter(function (p) { return p.return; }).sort(function (a, b) { return (b.return.ts || 0) - (a.return.ts || 0); });
    var cnt = $("#returns-count"); if (cnt) cnt.textContent = rets.length + (rets.length === 1 ? " return" : " returns");
    var el = $("#returns-list"); if (!el) return;
    el.innerHTML = rets.length ? rets.map(function (p) {
      var st = p.return.status;
      return '<div class="row-item"><div class="ri-main"><div class="ri-title">' + p.id + ' · ' + p.item.description + '</div>' +
        '<div class="ri-sub">' + p.customer.name + ' · ' + p.return.reason + (p.return.note ? ' (' + p.return.note + ')' : '') + '</div></div>' +
        '<span class="' + returnPillClass(st) + '">' + st + '</span>' +
        (st !== "Received" ? ' <button class="btn ok sm" data-radv="' + p.id + '">Advance →</button>' : '') +
        ' <button class="btn sm" data-ropen="' + p.id + '">Open</button></div>';
    }).join("") : '<p class="muted">No returns yet. Initiate one from any delivered package’s detail.</p>';
    $$("#returns-list [data-radv]").forEach(function (b) { b.addEventListener("click", function () { advanceReturn(b.dataset.radv); }); });
    $$("#returns-list [data-ropen]").forEach(function (b) { b.addEventListener("click", function () { openPackage(b.dataset.ropen); }); });
  }

  // ---- Package modal ----
  function openPackage(id) {
    var p = getPkg(id);
    var cur = stageIdx(p.status);
    var tl = '<div class="timeline">' + STAGES.slice(0, cur + 1).map(function (s, i) {
      var h = p.history.find(function (x) { return x.stage === s; });
      return '<div class="tl-node ' + (i === cur ? "current" : "done") + '"><div class="tl-stage">' + stageLabelFor(p, s) +
        '</div><div class="tl-time">' + (h ? fmtTime(h.ts) : "") + '</div></div>';
    }).join("") + '</div>';
    var photos = (p.photos.pickup || p.photos.delivery)
      ? '<div class="photos">' + (p.photos.pickup ? '<img src="' + p.photos.pickup + '">' : "") +
        (p.photos.delivery ? '<img src="' + p.photos.delivery + '">' : "") + '</div>'
      : '<p class="muted small">No condition photos yet.</p>';
    modal(
      '<button class="close-x" data-close>×</button>' +
      '<span class="' + pillClass(p.status) + '">' + stageLabelFor(p) + '</span>' + slaPillHtml(p) +
      (p.return ? ' <span class="' + returnPillClass(p.return.status) + '">↩ Return: ' + p.return.status + '</span>' : '') +
      (p.exception ? '<div class="exc-banner">⚠ ' + p.exception.type + (p.exception.note ? ' (' + p.exception.note + ')' : '') + '</div>' : '') +
      '<h2 style="margin-top:8px">' + p.id + ": " + p.item.description + '</h2>' +
      '<p class="muted">' + p.source + " · order " + p.orderRef + " · " + money(p.item.value) + '</p>' +
      '<div class="modal-grid"><div>' +
      field("Customer", p.customer.name) +
      // Self-serve orders carry the account that placed them. Ops needs this to answer
      // "who is asking about GL-1043?" and to reach the right person on an exception.
      (p.customerEmail ? field("Account", p.customerEmail) : "") +
      field("Address", p.customer.address + ", " + p.customer.city + ", " + p.customer.state + " " + p.customer.zip) +
      field("Phone", p.customer.phone) +
      field("Carrier", (p.carrier || "–") + (p.lane ? " · " + p.lane : "")) +
      field("Tracking", p.tracking || "–", true) +
      '<div style="margin-top:14px">' + Code128.toSVG(p.barcode, { height: 60, moduleWidth: 1.6 }) +
      '<div class="mono small" style="text-align:center">' + p.barcode + '</div></div>' +
      '</div><div><h2 style="font-size:.95rem;margin-bottom:10px">Chain of Custody</h2>' + tl + photos + '</div></div>' +
      '<div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="btn sm" id="copy-track"><span aria-hidden="true">🔗</span> Copy tracking link</button>' +
      (p.status === "Delivered" && !p.return ? '<button class="btn sm" id="init-return"><span aria-hidden="true">↩</span> Initiate Return</button>' : '') +
      (p.return && p.return.status !== "Received" ? '<button class="btn sm ok" id="adv-return"><span aria-hidden="true">↩</span> Advance Return</button>' : '') +
      (p.exception
        ? '<button class="btn sm ok" id="resolve-exc"><span aria-hidden="true">✓</span> Resolve Exception</button>'
        : '<button class="btn sm" id="flag-exc"><span aria-hidden="true">⚠</span> Flag Exception</button>') +
      '<button class="btn sm" id="edit-pkg"><span aria-hidden="true">✎</span> Edit</button>' +
      '<button class="btn sm danger" id="del-pkg"><span aria-hidden="true">🗑</span> Delete</button></div>'
    );
    var ed = $("#edit-pkg"); if (ed) ed.addEventListener("click", function () { editPackage(p.id); });
    var dl = $("#del-pkg"); if (dl) dl.addEventListener("click", function () { deletePackage(p.id); });
    var fx = $("#flag-exc"); if (fx) fx.addEventListener("click", function () { flagException(p.id); });
    var rx = $("#resolve-exc"); if (rx) rx.addEventListener("click", function () { resolveException(p.id); });
    var ir = $("#init-return"); if (ir) ir.addEventListener("click", function () { initiateReturn(p.id); });
    var ar = $("#adv-return"); if (ar) ar.addEventListener("click", function () { advanceReturn(p.id); });
    var ct = $("#copy-track");
    if (ct) ct.addEventListener("click", function () {
      var url = location.href.replace(/[^\/]*$/, "track.html?n=" + encodeURIComponent(p.id)).replace(/#.*$/, "");
      var done = function () { toast("Customer tracking link copied", "ok"); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { toast(url, "ok"); });
      else toast(url, "ok");
    });
  }

  // Customer-facing order tracker: a clean status timeline, none of the ops controls.
  function custEta(p) {
    if (p.status === "Delivered") {
      var d = p.history.find(function (h) { return h.stage === "Delivered"; });
      return d ? "Delivered " + new Date(d.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Delivered";
    }
    return "Est. delivery " + new Date(p.promisedTs).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }
  function openCustomerOrder(id) {
    var p = getPkg(id); if (!p) return;
    var cur = stageIdx(p.status);
    var tl = '<div class="timeline cust-timeline">' + STAGES.map(function (s, i) {
      var h = p.history.find(function (x) { return x.stage === s; });
      var cls = i < cur ? "done" : (i === cur ? "current" : "upcoming");
      var time = h ? fmtTime(h.ts) : (i === cur ? "In progress" : "");
      return '<div class="tl-node ' + cls + '"><div class="tl-stage">' + (CUST_STATUS[s] || STAGE_LABEL[s]) + '</div>' +
        '<div class="tl-time">' + time + '</div></div>';
    }).join("") + '</div>';
    var addr = [p.customer.address, p.customer.city, p.customer.state, p.customer.zip].filter(Boolean).join(", ");
    modal(
      '<button class="close-x" data-close>×</button>' +
      '<div class="cust-detail-head">' +
      '<span class="' + pillClass(p.status) + '">' + (CUST_STATUS[p.status] || stageLabelFor(p)) + '</span>' +
      '<h2>' + p.item.description + '</h2>' +
      '<p class="muted">Tracking ' + p.id + ' · ' + custEta(p) + '</p>' +
      '</div>' +
      '<h3 class="cust-detail-sub">Progress</h3>' + tl +
      '<h3 class="cust-detail-sub">Delivery details</h3>' +
      '<dl class="os-summary">' +
      '<div><dt>Recipient</dt><dd>' + p.customer.name + '</dd></div>' +
      (addr ? '<div><dt>Address</dt><dd>' + addr + '</dd></div>' : '') +
      '<div><dt>Declared value</dt><dd>' + money(p.item.value) + '</dd></div>' +
      (p.tracking ? '<div><dt>Carrier tracking</dt><dd>' + p.tracking + '</dd></div>' : '') +
      '</dl>' +
      '<div class="cust-detail-actions">' +
      '<button class="btn block" id="cust-copy-link" type="button"><span aria-hidden="true">🔗</span> Copy tracking link</button>' +
      // Cancelling is only offered before anything physical has happened to the parcel.
      (stageIdx(p.status) === 0 && !p.pendingSync
        ? '<button class="btn danger block" id="cust-cancel" type="button">Cancel this order</button>'
        : '') +
      '</div>'
    );
    var cl = $("#cust-copy-link");
    if (cl) cl.addEventListener("click", function () {
      var url = location.href.replace(/[^\/]*$/, "track.html?n=" + encodeURIComponent(p.id)).replace(/#.*$/, "");
      var done = function () { toast("Tracking link copied", "ok"); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { toast(url, "ok"); });
      else toast(url, "ok");
    });
    var cx = $("#cust-cancel");
    if (cx) cx.addEventListener("click", function () { cancelCustomerOrder(p.id); });
  }
  // Customers can cancel their own order while it's still just "Order received".
  function cancelCustomerOrder(id) {
    var p = getPkg(id); if (!p) return;
    confirmDialog({
      title: "Cancel this order?",
      message: "We'll stop " + p.item.description + " (" + p.id + ") from being picked up. This can't be undone.",
      confirmLabel: "Cancel order", danger: true
    }).then(function (ok) {
      if (!ok) return;
      var u = (typeof currentUser === "function") ? currentUser() : null;
      var email = u ? u.email : null;
      var applyLocal = function () {
        state.packages = state.packages.filter(function (x) { return x.id !== id; });
        save(); closeModal();
        renderCustomerOrderList(email); renderCustHomeList(email); renderNotifs();
        toast(id + " cancelled", "ok");
      };
      if (hasServerAuth()) {
        fetch("/api/my-orders?id=" + encodeURIComponent(id), { method: "DELETE", headers: { "Authorization": "Bearer " + authToken() } })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (j) {
            if (j && j.ok) { mergeCustomerOrders(j.orders, email); closeModal(); renderCustomerOrderList(email); renderCustHomeList(email); renderNotifs(); toast(id + " cancelled", "ok"); }
            else { toast((j && j.error) || "Could not cancel that order.", "warn", 7000); }
          })
          // A cancellation cannot be completed offline. Deleting the row locally used to
          // look like success, but the server still had the order: it came back on the
          // next sync and the parcel was still collected. Better to leave it visible and
          // say plainly that nothing has changed yet.
          .catch(function () {
            toast("We couldn't reach the server, so " + id + " has NOT been cancelled. Try again when you're back online.", "warn", 9000);
          });
      } else {
        applyLocal();
      }
    });
  }

  function attr(s) { return String(s == null ? "" : s).replace(/"/g, "&quot;"); }
  function editPackage(id) {
    var p = getPkg(id); if (!p) return;
    modal('<button class="close-x" data-close>×</button><h2>Edit ' + p.id + '</h2>' +
      '<form id="edit-form" class="order-form" style="margin-top:12px">' +
      '<div class="ff"><label>Customer name</label><input name="name" value="' + attr(p.customer.name) + '"></div>' +
      '<div class="ff"><label>Item description</label><input name="item" value="' + attr(p.item.description) + '"></div>' +
      '<div class="ff-row"><div class="ff"><label>Declared value ($)</label><input name="value" type="number" min="0" value="' + p.item.value + '"></div>' +
      '<div class="ff"><label>Phone</label><input name="phone" value="' + attr(p.customer.phone) + '"></div></div>' +
      '<div class="ff"><label>Address</label><input name="address" value="' + attr(p.customer.address) + '"></div>' +
      '<div class="ff-row"><div class="ff"><label>City</label><input name="city" value="' + attr(p.customer.city) + '"></div>' +
      '<div class="ff" style="max-width:80px"><label>State</label><input name="state" maxlength="2" value="' + attr(p.customer.state) + '"></div>' +
      '<div class="ff" style="max-width:110px"><label>ZIP</label><input name="zip" value="' + attr(p.customer.zip) + '"></div></div>' +
      '<button class="btn primary" type="submit">Save changes</button></form>');
    $("#edit-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = function (n) { var el = this.elements.namedItem(n); return el ? el.value : ""; }.bind(this);
      p.customer.name = v("name").trim();
      p.item.description = v("item").trim();
      p.item.value = Math.max(0, parseInt(v("value"), 10) || 0);
      p.customer.phone = v("phone").trim();
      p.customer.address = v("address").trim();
      p.customer.city = v("city").trim();
      p.customer.state = v("state").trim().toUpperCase();
      p.customer.zip = v("zip").trim();
      save(); toast("Saved changes to " + p.id, "ok"); closeModal(); renderAll();
    });
  }
  function deletePackage(id) {
    confirmDialog({ title: "Delete " + id + "?", message: "This cannot be undone.", confirmLabel: "Delete", danger: true }).then(function (ok) {
      if (!ok) return;
      addTombstone(id); // so the server merge doesn't bring it back on the next push
      state.packages = state.packages.filter(function (p) { return p.id !== id; });
      rebuildManifests(); save(); closeModal();
      if (cocSelected === id) cocSelected = null;
      toast(id + " deleted", "ok"); renderAll();
    });
  }

  // ---- Dialog focus handling ----
  // Without this, opening a dialog leaves the keyboard behind it: Tab walks the page
  // underneath and the dialog is unreachable. Move focus in, keep Tab inside, and put
  // focus back where it started on close. Stacked so a dialog opened from a dialog
  // (a confirm on top of the package modal) unwinds in the right order.
  var focusTraps = [];
  function focusableIn(el) {
    if (!el) return [];
    return $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', el)
      .filter(function (n) { return n.offsetWidth > 0 || n.offsetHeight > 0; });
  }
  function trapFocus(container) {
    if (!container) return;
    var entry = { container: container, prev: document.activeElement };
    entry.onKey = function (e) {
      if (e.key !== "Tab") return;
      var f = focusableIn(container);
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", entry.onKey, true);
    focusTraps.push(entry);
    setTimeout(function () { var f = focusableIn(container); (f[0] || container).focus(); }, 0);
  }
  function releaseFocus(container) {
    for (var i = focusTraps.length - 1; i >= 0; i--) {
      if (focusTraps[i].container === container) {
        var entry = focusTraps.splice(i, 1)[0];
        document.removeEventListener("keydown", entry.onKey, true);
        if (entry.prev && entry.prev.focus) { try { entry.prev.focus(); } catch (e) { } }
        return;
      }
    }
  }

  function modal(html) {
    $("#modal").innerHTML = html;
    associateLabels($("#modal"));
    // Cancel any in-flight close, otherwise .closing would still be set and its exit
    // animation would win the cascade over .open, hiding the modal we just opened.
    clearTimeout(modalCloseTimer);
    $("#modal-backdrop").classList.remove("closing");
    $("#modal-backdrop").classList.add("open");
    var x = $("#modal [data-close]");
    if (x) x.addEventListener("click", closeModal);
    trapFocus($("#modal"));
  }
  var modalCloseTimer = null;
  function closeModal() {
    var bd = $("#modal-backdrop");
    if (!bd.classList.contains("open")) return; // avoid stealing focus when already shut
    bd.classList.remove("open");
    // Focus goes back immediately: the animation is decoration, and waiting for it would
    // leave a keyboard user stranded on a panel that is on its way out.
    releaseFocus($("#modal"));
    // .closing keeps the backdrop displayed just long enough to animate out. The timeout
    // matches --dur (240ms); if another modal opens first, .open wins and this is a no-op.
    bd.classList.add("closing");
    clearTimeout(modalCloseTimer);
    modalCloseTimer = setTimeout(function () { bd.classList.remove("closing"); }, 240);
  }
  $("#modal-backdrop").addEventListener("click", function (e) { if (e.target === $("#modal-backdrop")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key !== "Escape") return; closeModal(); closeConfirmDialog(); closeGate(); closeAccountMenu(); closeNotif(); closeWelcomeTour(); });

  // Lightweight, app-styled confirmation prompt. Replaces native window.confirm()
  // so destructive actions (delete, reset, sign out) look consistent everywhere.
  var confirmActive = null;
  function confirmDialog(opts) {
    var bd = $("#confirm-backdrop");
    $("#confirm-title").textContent = opts.title || "Are you sure?";
    $("#confirm-message").textContent = opts.message || "";
    var okBtn = $("#confirm-ok"), cancelBtn = $("#confirm-cancel");
    okBtn.textContent = opts.confirmLabel || "Confirm";
    okBtn.className = "btn block " + (opts.danger ? "danger" : "primary");
    cancelBtn.textContent = opts.cancelLabel || "Cancel";
    bd.classList.add("open");
    trapFocus($(".confirm-card"));
    return new Promise(function (resolve) {
      function cleanup(result) {
        bd.classList.remove("open");
        releaseFocus($(".confirm-card"));
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        confirmActive = null;
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      confirmActive = onCancel;
    });
  }
  function closeConfirmDialog() { if (confirmActive) confirmActive(); }
  $("#confirm-backdrop").addEventListener("click", function (e) { if (e.target === this) closeConfirmDialog(); });

  // ---- Core: advance a package one stage ----
  function getPkg(id) { return state.packages.find(function (p) { return p.id === id; }); }
  function advance(p, toStage) {
    if (stageIdx(toStage) <= stageIdx(p.status) && p.history.some(function (h) { return h.stage === toStage; })) return;
    p.status = toStage;
    p.history.push({ stage: toStage, ts: Date.now(), note: STAGE_NOTE[toStage] });
    save();
  }

  // ---- Live demo autoplay (the executive pitch) ----
  var demoRunning = false;
  $("#run-demo").addEventListener("click", runDemo);
  function runDemo() {
    if (demoRunning) return;
    demoRunning = true;
    $("#run-demo").disabled = true;
    $("#run-demo").textContent = "▶ Running…";

    var p = makePackage(0);
    state.packages.push(p); save();
    go("tracking"); cocSelected = p.id;
    toast("Live demo: " + p.customer.name + " just won an auction. Watch it reach the doorstep.", "api");

    var steps = [
      { v: "ingest", t: "Auction won. Order pulled via API from " + p.source, k: "api", act: function () { } },
      { v: "runner", t: "Code 128 label generated & printed", k: "ok", act: function () { advance(p, "Intake"); } },
      { v: "runner", t: "Condition photo captured · item binned", k: "ok", act: function () { p.photos.pickup = placeholderPhoto(p.item.description, "PICKUP", "#1d4ed8"); advance(p, "PickedUp"); } },
      { v: "batch", t: "Batched to " + (p.carrier = "UPS") + " manifest · Lane 2", k: "ok", act: function () { p.lane = "Lane 2"; p.batchId = "BATCH-" + (700 + rng(299)); advance(p, "Staged"); } },
      { v: "driver", t: "UPS API: shipment created · tracking issued", k: "api", act: function () { p.tracking = trackingFor("UPS"); advance(p, "InTransit"); } },
      { v: "tracking", t: "Carrier scan: Out for Delivery", k: "ok", act: function () { advance(p, "OutforDelivery"); } },
      { v: "tracking", t: "Delivered, confirmed with condition photo ✓", k: "ok", act: function () { p.photos.delivery = placeholderPhoto(p.item.description, "DELIVERED", "#15803d"); advance(p, "Delivered"); } }
    ];

    var i = 0;
    (function tick() {
      if (i >= steps.length) {
        demoRunning = false;
        $("#run-demo").disabled = false;
        $("#run-demo").textContent = "▶ Guided tour";
        toast("Journey complete: Auction Win → Delivery Confirmed", "ok");
        cocSelected = p.id; go("tracking");
        return;
      }
      var s = steps[i++];
      s.act();
      go(s.v);
      if (s.v === "tracking") { cocSelected = p.id; renderTracking(); }
      toast(s.t, s.k);
      setTimeout(tick, 1650);
    })();
  }

  // ---- Order intake: manual form + CSV import/export ----
  var orderForm = $("#order-form");
  if (orderForm) orderForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = function (n) { var el = this.elements.namedItem(n); return el ? el.value : ""; }.bind(this);
    var p = makeOrderFrom({
      name: v("name"), item: v("item"), value: v("value"), source: v("source"),
      address: v("address"), city: v("city"), state: v("state"), zip: v("zip"), phone: v("phone")
    });
    state.packages.push(p); save();
    toast("Order created: " + p.id + " · " + p.item.description, "ok");
    this.reset(); renderIngest();
  });

  var csvInput = $("#csv-input");
  if (csvInput) csvInput.addEventListener("change", function () {
    var f = this.files && this.files[0];
    this.value = "";
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var rows = parseCSV(e.target.result);
      if (rows.length < 2) { $("#import-result").textContent = "No data rows found in that file."; return; }
      var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
      var map = {}; ["name", "item", "value", "address", "city", "state", "zip", "phone", "source"].forEach(function (c) { map[c] = head.indexOf(c); });
      var n = 0;
      rows.slice(1).forEach(function (r) {
        var g = function (c) { return map[c] >= 0 ? (r[map[c]] || "").trim() : ""; };
        if (!g("name") && !g("item")) return;
        state.packages.push(makeOrderFrom({
          name: g("name"), item: g("item"), value: g("value"), address: g("address"),
          city: g("city"), state: g("state"), zip: g("zip"), phone: g("phone"), source: g("source") || "CSV Import"
        }));
        n++;
      });
      save();
      $("#import-result").textContent = n + " order" + (n === 1 ? "" : "s") + " imported.";
      toast(n + " orders imported from CSV", "api");
      renderIngest();
    };
    reader.readAsText(f);
  });

  var exportBtn = $("#export-csv"); if (exportBtn) exportBtn.addEventListener("click", exportCSV);
  var tplBtn = $("#csv-template");
  if (tplBtn) tplBtn.addEventListener("click", function () {
    downloadFile("granite-orders-template.csv",
      "name,item,value,address,city,state,zip,phone,source\n" +
      "Jane Doe,Sample Item,199,123 Main St,Dayton,OH,45402,(937) 555-0100,Shopify\n", "text/csv");
  });

  var scanLiveBtn = $("#scan-live"); if (scanLiveBtn) scanLiveBtn.addEventListener("click", scanLive);

  var searchInput = $("#track-search");
  if (searchInput) searchInput.addEventListener("input", function () { trackQuery = this.value.trim().toLowerCase(); renderTracking(); });
  var acctResend = $("#acct-verify-resend");
  if (acctResend) acctResend.addEventListener("click", resendVerification);
  var acctExport = $("#acct-export");
  if (acctExport) acctExport.addEventListener("click", exportMyData);
  var acctClose = $("#acct-close");
  if (acctClose) acctClose.addEventListener("click", closeMyAccount);
  var pushOn = $("#acct-push-on");
  if (pushOn) pushOn.addEventListener("click", enablePush);
  var pushOff = $("#acct-push-off");
  if (pushOff) pushOff.addEventListener("click", disablePush);
  var navEl = $(".nav");
  if (navEl) {
    navEl.addEventListener("scroll", updateNavScrollHint, { passive: true });
    // Calling this from applyRole() alone was not enough: at boot the measurement ran
    // before layout settled, so the hint never appeared on the one screen size where it
    // was needed. A ResizeObserver fires whenever the nav's box or contents change, which
    // is exactly the condition being tested.
    if (typeof ResizeObserver === "function") {
      try { new ResizeObserver(updateNavScrollHint).observe(navEl); } catch (e) { }
    }
    requestAnimationFrame(updateNavScrollHint);
  }
  var admSearch = $("#adm-search");
  if (admSearch) admSearch.addEventListener("input", function () { admQuery = this.value.trim().toLowerCase(); renderAdminList(); });
  var admRefresh = $("#adm-refresh");
  if (admRefresh) admRefresh.addEventListener("click", function () { renderAdmin(); });

  // Login + sign out
  var forgotBtn = $("#forgot-btn"); if (forgotBtn) forgotBtn.addEventListener("click", requestPasswordReset);
  var resetCancel = $("#reset-cancel"); if (resetCancel) resetCancel.addEventListener("click", hideResetForm);
  var resetForm = $("#reset-form");
  if (resetForm) resetForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = $("#reset-pw").value || "";
    var err = $("#reset-err"); err.textContent = "";
    if (pw.length < 4) { err.textContent = "Password must be at least 4 characters."; return; }
    var btn = $("#reset-submit"); btn.disabled = true; btn.textContent = "Saving…";
    postAuth("reset-confirm", { token: resetToken, pw: pw })
      .then(function (j) {
        btn.disabled = false; btn.textContent = "Save new password";
        if (!(j && j.ok)) { err.textContent = (j && j.error) || "Could not set that password."; return; }
        authSave({ token: j.token, user: j.user });
        try { history.replaceState(null, "", location.pathname); } catch (e2) { }
        var rb = $("#reset-body"); if (rb) rb.style.display = "none";
        var lb = $(".login-body"); if (lb) lb.style.display = "";
        enterApp();
        toast("Password updated. You're signed in.", "ok");
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = "Save new password";
        err.textContent = "Could not reach the server. Check your connection and try again.";
      });
  });

  var loginForm = $("#login-form");
  if (loginForm) loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = ($("#login-email").value || "").trim(), pw = $("#login-password").value || "";
    var name = ($("#login-name").value || "").trim();
    var err = $("#login-err"); err.textContent = "";
    if (!email || !pw) { err.textContent = "Enter your email and password."; return; }
    if (pw.length < 4) { err.textContent = "Password must be at least 4 characters."; return; }
    var mode = loginMode;
    var btn = $("#login-submit"); var orig = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = mode === "register" ? "Creating account…" : "Signing in…"; }
    var work = (mode === "register") ? registerUser(name, email, pw, "Customer") : loginUser(email, pw);
    work.then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
      if (!res || !res.ok) { err.textContent = (res && res.error) || "Something went wrong. Please try again."; return; }
      enterApp();
      if (mode === "register") showWelcomeTour();
      else toast("Signed in", "ok");
      if (res.offline) toast("Backend unreachable. Using a local account on this device.", "ok");
    });
  });
  function confirmSignOut() {
    confirmDialog({ title: "Sign out?", message: "You'll need to sign in again to place or track orders.", confirmLabel: "Sign out", danger: true })
      .then(function (ok) { if (ok) { logoutUser(); location.reload(); } });
  }
  var welcomeNext = $("#welcome-next");
  if (welcomeNext) welcomeNext.addEventListener("click", function () {
    if (welcomeStep < WELCOME_SLIDES) { welcomeStep++; renderWelcomeStep(); } else closeWelcomeTour();
  });
  var welcomeSkip = $("#welcome-skip"); if (welcomeSkip) welcomeSkip.addEventListener("click", closeWelcomeTour);
  var welcomeBackdropEl = $("#welcome-backdrop");
  if (welcomeBackdropEl) welcomeBackdropEl.addEventListener("click", function (e) { if (e.target === this) closeWelcomeTour(); });
  var signOutBtn = $("#sign-out");
  if (signOutBtn) signOutBtn.addEventListener("click", confirmSignOut);

  var cocBack = $("#coc-back");
  if (cocBack) cocBack.addEventListener("click", function () { var v = $("#view-tracking"); if (v) v.classList.remove("detail-open"); });

  var trackSelectBtn = $("#track-select-btn");
  if (trackSelectBtn) trackSelectBtn.addEventListener("click", function () {
    trackSelectMode = !trackSelectMode;
    if (!trackSelectMode) trackSelect = {};
    this.classList.toggle("primary", trackSelectMode);
    this.textContent = trackSelectMode ? "✕ Done" : "☑ Select";
    renderTracking();
  });

  var resetBtn = $("#reset-data");
  if (resetBtn) resetBtn.addEventListener("click", function () {
    confirmDialog({ title: "Reset all data?", message: "This resets to the demo seed and clears any orders you've added.", confirmLabel: "Reset", danger: true }).then(function (ok) {
      if (!ok) return;
      var keepRole = currentRole(), keepChosen = state.settings.roleChosen;
      seed(); state.settings.role = keepRole; state.settings.roleChosen = keepChosen; save();
      cocSelected = null; trackQuery = ""; toast("Demo data reset to seed.", "ok");
      applyRole(); go(allowedViews()[0]);
    });
  });

  // Activity search
  var actSearch = $("#activity-search");
  if (actSearch) actSearch.addEventListener("input", function () { activityQuery = this.value.trim().toLowerCase(); renderActivity(); });

  // Reusable tabbed layout (Settings, Order Ingest, and more). Each .tabbed-layout
  // group wires its own .tab-btn clicks to show the matching .tab-panel.
  $$(".tabbed-layout").forEach(function (group) {
    $$(".tab-btn", group).forEach(function (t) {
      t.addEventListener("click", function () {
        $$(".tab-btn", group).forEach(function (x) { x.classList.remove("active"); });
        this.classList.add("active");
        var tab = this.dataset.tab;
        $$(".tab-panel", group).forEach(function (p) { p.classList.toggle("active", p.dataset.panel === tab); });
      });
    });
  });

  // Settings form
  var settingsForm = $("#settings-form");
  if (settingsForm) settingsForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var g = function (n) { var el = this.elements.namedItem(n); return el ? el.value.trim() : ""; }.bind(this);
    state.settings.company = { name: g("name") || "Granite Logistics", address: g("address"), phone: g("phone"), email: g("email") };
    state.settings.defaultCarrier = g("carrier");
    state.settings.defaultLane = g("lane");
    save(); toast("Settings saved. Labels & manifests now use “" + companyName() + "”.", "ok");
  });

  // Data backup / restore
  var simBtn = $("#sim-webhook"); if (simBtn) simBtn.addEventListener("click", simulateWebhook);
  var copyCurlBtn = $("#copy-curl");
  if (copyCurlBtn) copyCurlBtn.addEventListener("click", function () {
    var t = (($("#webhook-curl") || {}).textContent) || "";
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { toast("curl command copied", "ok"); }, function () { toast(t, "ok"); });
    else toast("Copy unavailable", "ok");
  });

  var cloudPushBtn = $("#cloud-push"); if (cloudPushBtn) cloudPushBtn.addEventListener("click", cloudPush);
  var cloudPullBtn = $("#cloud-pull"); if (cloudPullBtn) cloudPullBtn.addEventListener("click", cloudPull);
  var cloudAuto = $("#cloud-auto"); if (cloudAuto) cloudAuto.addEventListener("change", function () { saveCloudInputs(); toast(this.checked ? "Auto-sync on" : "Auto-sync off", "ok"); });
  var cloudProvider = $("#cloud-provider"); if (cloudProvider) cloudProvider.addEventListener("change", function () { syncProviderUI(); saveCloudInputs(); });

  var backupBtn = $("#backup-json");
  if (backupBtn) backupBtn.addEventListener("click", function () {
    downloadFile("granite-backup.json", JSON.stringify({ packages: state.packages, manifests: state.manifests, settings: state.settings, seq: seq }, null, 2), "application/json");
    toast("Full backup exported (" + state.packages.length + " packages)", "ok");
  });
  var restoreInput = $("#restore-json");
  if (restoreInput) restoreInput.addEventListener("change", function () {
    var f = this.files && this.files[0]; this.value = "";
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var data;
      try {
        data = JSON.parse(e.target.result);
        if (!data || !Array.isArray(data.packages)) throw new Error("bad");
      } catch (err) { toast("That file isn't a valid Granite backup.", "ok"); return; }
      var n = data.packages.length;
      confirmDialog({
        title: "Restore this backup?",
        message: "This replaces your current data with " + n + " package" + (n === 1 ? "" : "s") + " from the file. This cannot be undone.",
        confirmLabel: "Restore", danger: true
      }).then(function (ok) {
        if (!ok) return;
        state.packages = data.packages;
        state.manifests = Array.isArray(data.manifests) ? data.manifests : [];
        state.loadUnits = Array.isArray(data.loadUnits) ? data.loadUnits : [];
        state.events = Array.isArray(data.events) ? data.events : [];
        state.settings = Object.assign(defaultSettings(), data.settings || {});
        if (data.settings && data.settings.company) state.settings.company = Object.assign(defaultSettings().company, data.settings.company);
        if (typeof data.seq === "number") seq = data.seq;
        rebuildManifests(); save();
        syncRoleSelect(); applyRole(); toast(state.packages.length + " packages restored from backup", "ok"); go("overview");
      });
    };
    reader.readAsText(f);
  });

  // Workspace picker + account menu
  $$("#role-gate .rg-card").forEach(function (c) { c.addEventListener("click", function () { setRole(c.dataset.role); }); });
  var rgClose = $("#rg-close"); if (rgClose) rgClose.addEventListener("click", closeGate);
  var roleGateEl = $("#role-gate");
  if (roleGateEl) roleGateEl.addEventListener("click", function (e) { if (e.target === this) closeGate(); });
  function closeAccountMenu() { var m = $("#account-menu"); if (m) m.classList.remove("open"); }
  var roleBadge = $("#role-badge");
  if (roleBadge) roleBadge.addEventListener("click", function (e) {
    e.stopPropagation();
    var m = $("#account-menu"); if (m) m.classList.toggle("open");
  });
  var amSwitch = $("#am-switch"); if (amSwitch) amSwitch.addEventListener("click", function () { closeAccountMenu(); openGate(); });
  var amTheme = $("#am-theme"); if (amTheme) amTheme.addEventListener("click", function () { closeAccountMenu(); state.settings.theme = (state.settings.theme === "dark") ? "light" : "dark"; save(); applyTheme(); });
  var amSignout = $("#am-signout"); if (amSignout) amSignout.addEventListener("click", function () { closeAccountMenu(); confirmSignOut(); });
  document.addEventListener("click", function (e) { var w = $(".account-wrap"); if (w && !w.contains(e.target)) closeAccountMenu(); });

  // Customer Home + Account tabs
  var chomePlace = $("#chome-place"); if (chomePlace) chomePlace.addEventListener("click", function () { go("order"); });
  var chomeViewAll = $("#chome-viewall"); if (chomeViewAll) chomeViewAll.addEventListener("click", function () { go("order"); });
  var acctSignout = $("#acct-signout"); if (acctSignout) acctSignout.addEventListener("click", confirmSignOut);
  var acctSwitch = $("#acct-switch"); if (acctSwitch) acctSwitch.addEventListener("click", openGate);
  var acctTour = $("#acct-tour"); if (acctTour) acctTour.addEventListener("click", showWelcomeTour);
  var acctSupport = $("#acct-support");
  if (acctSupport) acctSupport.addEventListener("click", function () {
    window.location.href = "mailto:ken@usegl.com?subject=" + encodeURIComponent("Granite Logistics support");
  });
  var custSearch = $("#cust-search");
  if (custSearch) custSearch.addEventListener("input", function () {
    custQuery = this.value.trim().toLowerCase();
    var u = (typeof currentUser === "function") ? currentUser() : null;
    renderCustomerOrderList(u ? u.email : null);
  });

  // Mobile drawer
  var menuBtn = $("#menu-btn"); if (menuBtn) menuBtn.addEventListener("click", function () { toggleSidebar(); });
  var sbBackdrop = $("#sidebar-backdrop"); if (sbBackdrop) sbBackdrop.addEventListener("click", function () { toggleSidebar(false); });

  // Theme toggle
  var themeBtn = $("#theme-btn");
  if (themeBtn) themeBtn.addEventListener("click", function () {
    state.settings.theme = (state.settings.theme === "dark") ? "light" : "dark";
    save(); applyTheme();
  });

  // Notifications bell
  var notifBtn = $("#notif-btn");
  if (notifBtn) notifBtn.addEventListener("click", function (e) {
    e.stopPropagation(); renderNotifs(); toggleNotif();
    var panel = $("#notif-panel");
    if (panel && panel.classList.contains("open")) setTimeout(markCustomerNotifsSeen, 400);
  });
  document.addEventListener("click", function (e) {
    var w = $(".notif-wrap"), panel = $("#notif-panel");
    if (panel && panel.classList.contains("open") && w && !w.contains(e.target)) closeNotif();
  });

  // Command palette
  var cmdInput = $("#cmd-input");
  if (cmdInput) {
    cmdInput.addEventListener("input", function () { renderCmd(this.value); });
    cmdInput.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); cmdSel = Math.min(cmdSel + 1, cmdItems.length - 1); drawCmd(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cmdSel = Math.max(cmdSel - 1, 0); drawCmd(); }
      else if (e.key === "Enter") { e.preventDefault(); activateCmd(cmdItems[cmdSel]); }
      else if (e.key === "Escape") { closeCmd(); }
    });
  }
  var cmdBackdrop = $("#cmd-backdrop");
  if (cmdBackdrop) cmdBackdrop.addEventListener("click", function (e) { if (e.target === cmdBackdrop) closeCmd(); });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); openCmd(); }
  });

  // Search trigger → command palette
  var searchTrigger = $("#search-trigger");
  if (searchTrigger) searchTrigger.addEventListener("click", openCmd);

  // ---- Deep-linking: index.html sends e.g. #tracking or #tracking=GL-1042 ----

  // ---- Deep-linking: index.html sends e.g. #tracking or #tracking=GL-1042 ----
  function applyHash() {
    var raw = (location.hash || "").replace(/^#/, "");
    if (!raw) return false;
    var parts = raw.split("=");
    var view = parts[0];
    var query = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (!VIEW_META[view]) return false;
    // A deep link must not reach a view this role has no business in: #admin was
    // otherwise navigable by anyone who typed it.
    if (allowedViews().indexOf(view) < 0) return false;
    go(view);
    if (view === "tracking" && query) {
      var norm = function (s) { return String(s).toUpperCase().replace(/[^A-Z0-9]/g, ""); };
      var match = state.packages.find(function (p) { return norm(p.id) === norm(query) || norm(p.barcode) === norm(query); });
      if (match) {
        cocSelected = match.id; renderTracking(); renderCoc(match.id);
        var rowEl = document.querySelector('#tracking-list .row-item[data-id="' + match.id + '"]');
        if (rowEl) rowEl.classList.add("selected");
      }
      else toast("No shipment found for “" + query + "”. Showing all packages.", "warn");
    }
    return true;
  }

  // ---- Boot ----
  applyTheme();
  updateRoleUI();
  renderBottomNav();
  // Arriving from a password-reset email takes priority over any cached session.
  var bootReset = null, bootVerify = null;
  try {
    var qs = new URLSearchParams(location.search);
    bootReset = qs.get("reset");
    bootVerify = qs.get("verify");
  } catch (e) { }

  // Redeemed before anything renders, so the account screen never shows a stale nudge to
  // confirm an address that was just confirmed.
  if (bootVerify) {
    fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify-confirm", token: bootVerify }) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok) {
          var a = authData();
          if (a.user) { a.user.emailVerified = true; authSave(a); }
          toast("Thanks, your email is confirmed.", "ok", 6000);
        } else {
          toast((j && j.error) || "That confirmation link didn't work.", "warn", 9000);
        }
        renderAccountView();
        // Drop the token from the URL so it is not left in history or a shared link.
        try { history.replaceState(null, "", location.pathname); } catch (e) { }
      })
      .catch(function () { toast("Couldn't reach the server to confirm your email.", "warn"); });
  }
  associateLabels(document);
  if (bootReset) {
    showResetForm(bootReset);
  } else if (currentUser()) {
    state.settings.role = currentUser().role || state.settings.role;
    state.settings.roleChosen = true;
    if (!applyHash()) go(allowedViews()[0]);
    applyRole();
    renderNotifs();
    bootSync();
    verifySession();
  } else {
    showLogin(); // not signed in → login screen is the entry
  }
  window.addEventListener("hashchange", applyHash);

  // Hide the boot preloader once the shell is ready
  setTimeout(function () {
    var p = $("#preloader"); if (!p) return;
    p.classList.add("hide");
    setTimeout(function () { p.style.display = "none"; }, 420);
  }, 550);

  // QA / debugging hook
  window.GL = state;

  // Register service worker for installable / offline PWA.
  // Detect new deploys and activate them immediately, then reload once so the user
  // always lands on the latest version (no more "stuck on old PWA" on the phone).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").then(function (reg) {
        reg.update();
        if (reg.waiting) reg.waiting.postMessage("skip-waiting");
        reg.addEventListener("updatefound", function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", function () {
            if (nw.state === "installed" && navigator.serviceWorker.controller) nw.postMessage("skip-waiting");
          });
        });
      }).catch(function () { });
      var reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (reloaded) return; reloaded = true; window.location.reload();
      });
    });
  }
})();
