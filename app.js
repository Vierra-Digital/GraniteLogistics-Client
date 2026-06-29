/* Granite Logistics — Enterprise Demo App
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
        name: (d.name || "—").trim(),
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
      // If the picker is dismissed (no file), the window regains focus — resolve null.
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
      company: { name: "Granite Logistics", address: "2200 Industrial Pkwy, Dayton, OH 45402", phone: "(937) 555-0118", email: "ops@granitelogistics.co" },
      defaultCarrier: "UPS", defaultLane: "Lane 1", role: "Admin", roleChosen: false
    };
  }
  var state = { packages: [], manifests: [], loadUnits: [], events: [], settings: defaultSettings() };
  function companyName() { return (state.settings && state.settings.company && state.settings.company.name) || "Granite Logistics"; }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ packages: state.packages, manifests: state.manifests, loadUnits: state.loadUnits, events: state.events, settings: state.settings, seq: seq })); } catch (e) { /* quota / private mode */ }
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
      inflight[0].exception = { type: "Address Issue", note: "Suite number missing — courier follow-up", ts: Date.now() - 3600000 };
      state.events.unshift({ ts: inflight[0].exception.ts, pkgId: inflight[0].id, who: inflight[0].customer.name, kind: "exception", note: "Exception: Address Issue — Suite number missing" });
    }
    if (inflight[1]) inflight[1].promisedTs = Date.now() - 7200000; // past due → SLA Late
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
  function toast(msg, kind) {
    var el = document.createElement("div");
    el.className = "toast " + (kind || "ok");
    el.innerHTML = '<span class="t-ico">' + (kind === "api" ? "⇄" : "✓") + '</span><span>' + msg + '</span>';
    $("#toasts").appendChild(el);
    setTimeout(function () { el.style.opacity = "0"; el.style.transform = "translateX(20px)"; el.style.transition = ".3s"; }, 3200);
    setTimeout(function () { el.remove(); }, 3600);
  }

  // ---- Navigation ----
  var VIEW_META = {
    overview: ["Executive Overview", "Real-time visibility from auction win to delivery confirmation."],
    ingest: ["Order Ingest", "Orders pulled directly from client commerce backends — zero manual entry."],
    runner: ["Runner Dashboard", "Daily pickups, condition photos, and label generation."],
    presort: ["Pre-Sort & Staging", "ZIP pre-sort and load-ready consolidation before carrier handoff."],
    batch: ["Batch & Lane Routing", "Group items into carrier manifests and assign dock lanes."],
    driver: ["Driver Scan", "Scan a label to retrieve destination details instantly."],
    tracking: ["Chain of Custody", "Tamper-evident, end-to-end package history."],
    reports: ["Reports & Analytics", "Operational metrics computed from your live data."],
    activity: ["Activity Log", "Tamper-evident audit trail of every event, newest first."],
    settings: ["Settings", "Company profile, defaults, and data management."]
  };

  // ---- Role-based access (maps to the platform's user roles) ----
  var ROLE_VIEWS = {
    Admin: ["overview", "ingest", "runner", "presort", "batch", "driver", "tracking", "reports", "activity", "settings"],
    Runner: ["ingest", "runner", "presort", "batch", "tracking", "activity"],
    Driver: ["driver", "tracking"],
    Viewer: ["overview", "tracking", "reports", "activity"]
  };
  var ROLE_META = {
    Admin: { label: "Administrator", ico: "▦", tag: "Full access" },
    Runner: { label: "Store Runner", ico: "▣", tag: "Operations" },
    Driver: { label: "Carrier Driver", ico: "◎", tag: "Field" },
    Viewer: { label: "Viewer", ico: "⊶", tag: "Read-only" }
  };
  function currentRole() { return (state.settings && state.settings.role) || "Admin"; }
  function allowedViews() { return ROLE_VIEWS[currentRole()] || ROLE_VIEWS.Admin; }
  function updateRoleUI() {
    var m = ROLE_META[currentRole()] || ROLE_META.Admin;
    var chip = $("#role-chip");
    if (chip) chip.innerHTML = '<span class="rc-ico">' + m.ico + '</span><div class="rc-text"><b>' + m.label + '</b><span>' + m.tag + '</span></div>';
    var bt = $("#role-badge-text"); if (bt) bt.textContent = m.label;
  }
  function applyRole() {
    var allowed = allowedViews();
    $$(".nav-item").forEach(function (b) { b.style.display = allowed.indexOf(b.dataset.view) >= 0 ? "" : "none"; });
    $$(".nav-group").forEach(function (g) {
      var any = Array.prototype.some.call(g.querySelectorAll(".nav-item"), function (b) { return b.style.display !== "none"; });
      g.style.display = any ? "" : "none";
    });
    updateRoleUI();
    var active = $(".nav-item.active") ? $(".nav-item.active").dataset.view : null;
    if (allowed.indexOf(active) < 0) go(allowed[0]);
  }
  function openGate() { var g = $("#role-gate"); if (g) g.classList.add("open"); }
  function closeGate() { var g = $("#role-gate"); if (g) g.classList.remove("open"); }
  function setRole(role) {
    if (!ROLE_VIEWS[role]) return;
    state.settings.role = role; state.settings.roleChosen = true; save();
    closeGate(); applyRole(); go(allowedViews()[0]);
    toast("Workspace: " + ROLE_META[role].label, "ok");
  }
  function toggleSidebar(open) {
    var sb = $("#sidebar"), bd = $("#sidebar-backdrop");
    var willOpen = (open === undefined) ? !(sb && sb.classList.contains("open")) : open;
    if (sb) sb.classList.toggle("open", willOpen);
    if (bd) bd.classList.toggle("open", willOpen);
  }
  function go(view) {
    if (typeof stopScan === "function") stopScan(); // release camera when navigating
    if (typeof toggleSidebar === "function") toggleSidebar(false); // close mobile drawer
    $$(".nav-item").forEach(function (b) { b.classList.toggle("active", b.dataset.view === view); });
    $$(".view").forEach(function (v) { v.classList.remove("active"); });
    $("#view-" + view).classList.add("active");
    $("#view-title").textContent = VIEW_META[view][0];
    $("#view-sub").textContent = VIEW_META[view][1];
    render(view);
  }
  $$(".nav-item").forEach(function (b) { b.addEventListener("click", function () { go(b.dataset.view); }); });

  // ---- Renderers ----
  function render(view) {
    if (view === "overview") renderOverview();
    else if (view === "ingest") renderIngest();
    else if (view === "runner") renderRunner();
    else if (view === "batch") renderBatch();
    else if (view === "driver") renderDriver();
    else if (view === "tracking") renderTracking();
    else if (view === "reports") renderReports();
    else if (view === "activity") renderActivity();
    else if (view === "settings") renderSettings();
    else if (view === "presort") renderPresort();
  }
  function renderAll() { var active = $(".nav-item.active").dataset.view; render(active); }

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
        '<div class="alert-main"><b class="mono">' + p.id + '</b> · ' + p.customer.name + ' — ' + p.customer.city + ', ' + p.customer.state +
        '<div class="alert-reason">' + reason + '</div></div>' +
        '<span class="' + pillClass(p.status) + '">' + STAGE_LABEL[p.status] + '</span></div>';
    }).join("") : '<p class="muted">No open exceptions or SLA breaches. All clear.</p>';
    $$("#overview-alerts .alert-row").forEach(function (r) { r.addEventListener("click", function () { openPackage(r.dataset.id); }); });

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

    var rows = state.packages.slice().sort(function (a, b) { return stageIdx(b.status) - stageIdx(a.status); }).slice(0, 9);
    $("#overview-table").innerHTML =
      '<thead><tr><th>Package</th><th>Customer</th><th>Destination</th><th>Carrier</th><th>Status</th></tr></thead><tbody>' +
      rows.map(function (p) {
        return '<tr data-id="' + p.id + '"><td class="mono">' + p.id + '</td><td>' + p.customer.name +
          '</td><td>' + p.customer.city + ", " + p.customer.state + '</td><td>' + (p.carrier || "—") +
          '</td><td><span class="' + pillClass(p.status) + '">' + STAGE_LABEL[p.status] + '</span></td></tr>';
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
    }).join("") : '<p class="muted">All caught up — no items awaiting pickup.</p>';

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
      '<div style="margin-top:16px;text-align:center"><button class="btn primary" id="print-label">🖨 Print Label</button></div>'
    );
    var pb = $("#print-label");
    if (pb) pb.addEventListener("click", function () { printLabel(p); });
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
      el.addEventListener("click", function () {
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
        '<div class="head-actions"><button class="btn sm" data-mprint="' + m.id + '">🖨 Print</button>' +
        '<button class="btn sm" data-mcsv="' + m.id + '">↓ CSV</button>' +
        '<button class="btn sm" data-mxmit="' + m.id + '">⇈ Transmit</button></div></div>';
    }).join("");
    $$("#manifest-list [data-mprint]").forEach(function (b) { b.addEventListener("click", function () { printManifest(b.dataset.mprint); }); });
    $$("#manifest-list [data-mcsv]").forEach(function (b) { b.addEventListener("click", function () { exportManifest(b.dataset.mcsv); }); });
    $$("#manifest-list [data-mxmit]").forEach(function (b) { b.addEventListener("click", function () { transmitManifest(b.dataset.mxmit); }); });
  }
  function printManifest(id) {
    var m = state.manifests.find(function (x) { return x.id === id; }); if (!m) return;
    var ps = manifestPkgs(m);
    $("#print-root").innerHTML =
      '<div class="pmanifest"><div class="pl-h">' + companyName().toUpperCase() + ' — OUTBOUND MANIFEST</div>' +
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
        events.push({ ts: h.ts, pkgId: p.id, kind: "stage", label: STAGE_LABEL[h.stage], pill: pillClass(h.stage), note: h.note, who: p.customer.name });
      });
    });
    (state.events || []).forEach(function (e) {
      events.push({ ts: e.ts, pkgId: e.pkgId, kind: e.kind, who: e.who, note: e.note,
        label: e.kind === "resolved" ? "Resolved" : "Exception", pill: e.kind === "resolved" ? "pill sla-ok" : "pill sla-late" });
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
  }

  // ---- Operational logistics: ZIP pre-sort, palletization, transmission ----
  function zoneOf(p) { return (p.customer.zip || "").replace(/[^0-9]/g, "").slice(0, 3) || "—"; }
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
    toast("Pre-sorted " + loose.length + " parcels into " + Object.keys(zones).length + " ZIP zones — hub bypass enabled.", "ok");
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
      return '<option value="' + p.id + '">' + p.id + " — " + p.item.description + " (" + STAGE_LABEL[p.status] + ")</option>";
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
    var actionLabel = next === "InTransit" ? "Picked up — In Transit" : next === "OutforDelivery" ? "Out for Delivery" : "Delivered (photo captured)";
    toast(p.id + " → " + actionLabel, "ok");
    $("#scan-result").innerHTML =
      field("Package", p.id, true) + field("Item", p.item.description) +
      field("Deliver To", p.customer.name) +
      field("Address", p.customer.address + ", " + p.customer.city + ", " + p.customer.state + " " + p.customer.zip) +
      field("Carrier", (p.carrier || "—") + (p.lane ? " · " + p.lane : "")) +
      field("Tracking", p.tracking || "—", true) +
      field("New Status", STAGE_LABEL[p.status]) +
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
    }).catch(function () { toast("Couldn't access the camera.", "ok"); scanActive = false; });
  }

  // ---- Tracking / chain of custody ----
  var cocSelected = null;
  var trackQuery = "";
  function renderTracking() {
    var pkgs = state.packages.slice().sort(function (a, b) { return stageIdx(b.status) - stageIdx(a.status); });
    if (trackQuery) {
      pkgs = pkgs.filter(function (p) {
        return (p.id + " " + p.customer.name + " " + p.customer.city + " " + p.customer.state + " " +
          p.item.description + " " + STAGE_LABEL[p.status] + " " + (p.tracking || "") + " " + (p.carrier || ""))
          .toLowerCase().indexOf(trackQuery) >= 0;
      });
    }
    $("#tracking-list").innerHTML = pkgs.length ? pkgs.map(function (p) {
      return '<div class="row-item selectable" data-id="' + p.id + '"><div class="ri-main">' +
        '<div class="ri-title">' + p.id + " · " + p.item.description + (p.exception ? ' <span class="pill sla-late">exception</span>' : '') + '</div>' +
        '<div class="ri-sub">' + p.customer.name + " — " + p.customer.city + ", " + p.customer.state + '</div></div>' +
        '<span class="' + pillClass(p.status) + '">' + STAGE_LABEL[p.status] + '</span>' + slaPillHtml(p) + '</div>';
    }).join("") : '<p class="muted">No packages match “' + trackQuery + '”.</p>';
    $$("#tracking-list .row-item").forEach(function (el) {
      el.addEventListener("click", function () {
        cocSelected = el.dataset.id;
        $$("#tracking-list .row-item").forEach(function (r) { r.classList.remove("selected"); });
        el.classList.add("selected");
        renderCoc(el.dataset.id);
      });
    });
    if (cocSelected && getPkg(cocSelected)) renderCoc(cocSelected);
  }
  function renderCoc(id) {
    var p = getPkg(id);
    var cur = stageIdx(p.status);
    $("#coc-title").textContent = "Chain of Custody — " + p.id;
    var meta = '<div class="coc-meta">' +
      '<span class="chip">Source: ' + p.source + '</span>' +
      (p.carrier ? '<span class="chip">Carrier: ' + p.carrier + '</span>' : "") +
      (p.lane ? '<span class="chip">' + p.lane + '</span>' : "") +
      (p.tracking ? '<span class="chip">Tracking: ' + p.tracking + '</span>' : "") +
      '<span class="chip">Value: ' + money(p.item.value) + '</span></div>';
    var tl = '<div class="timeline">' + STAGES.map(function (s, i) {
      var h = p.history.find(function (x) { return x.stage === s; });
      var cls = i < cur ? "done" : i === cur ? "current" : "";
      return '<div class="tl-node ' + cls + '"><div class="tl-stage">' + STAGE_LABEL[s] + '</div>' +
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
    modal('<button class="close-x" data-close>×</button><h2>Flag Exception — ' + p.id + '</h2>' +
      '<form id="exc-form" class="order-form" style="margin-top:12px">' +
      '<div class="ff"><label>Type</label><select name="type"><option>Address Issue</option><option>Damaged in Transit</option><option>Weather Delay</option><option>Failed Delivery Attempt</option><option>Customs / Compliance Hold</option><option>Lost / Mis-sort</option></select></div>' +
      '<div class="ff"><label>Note</label><input name="note" placeholder="Optional details" /></div>' +
      '<button class="btn danger" type="submit">Flag Exception</button></form>');
    $("#exc-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var type = this.elements.namedItem("type").value, note = this.elements.namedItem("note").value.trim();
      p.exception = { type: type, note: note, ts: Date.now() };
      logEvent(p, "exception", "Exception: " + type + (note ? " — " + note : ""));
      save(); toast("Exception flagged on " + p.id + ": " + type, "ok"); closeModal(); renderAll();
    });
  }
  function resolveException(id) {
    var p = getPkg(id); if (!p || !p.exception) return;
    logEvent(p, "resolved", "Exception resolved: " + p.exception.type);
    p.exception = null; save(); toast("Exception resolved on " + p.id, "ok"); closeModal(); renderAll();
  }

  // ---- Package modal ----
  function openPackage(id) {
    var p = getPkg(id);
    var cur = stageIdx(p.status);
    var tl = '<div class="timeline">' + STAGES.slice(0, cur + 1).map(function (s, i) {
      var h = p.history.find(function (x) { return x.stage === s; });
      return '<div class="tl-node ' + (i === cur ? "current" : "done") + '"><div class="tl-stage">' + STAGE_LABEL[s] +
        '</div><div class="tl-time">' + (h ? fmtTime(h.ts) : "") + '</div></div>';
    }).join("") + '</div>';
    var photos = (p.photos.pickup || p.photos.delivery)
      ? '<div class="photos">' + (p.photos.pickup ? '<img src="' + p.photos.pickup + '">' : "") +
        (p.photos.delivery ? '<img src="' + p.photos.delivery + '">' : "") + '</div>'
      : '<p class="muted small">No condition photos yet.</p>';
    modal(
      '<button class="close-x" data-close>×</button>' +
      '<span class="' + pillClass(p.status) + '">' + STAGE_LABEL[p.status] + '</span>' + slaPillHtml(p) +
      (p.exception ? '<div class="exc-banner">⚠ ' + p.exception.type + (p.exception.note ? ' — ' + p.exception.note : '') + '</div>' : '') +
      '<h2 style="margin-top:8px">' + p.id + " — " + p.item.description + '</h2>' +
      '<p class="muted">' + p.source + " · order " + p.orderRef + " · " + money(p.item.value) + '</p>' +
      '<div class="modal-grid"><div>' +
      field("Customer", p.customer.name) +
      field("Address", p.customer.address + ", " + p.customer.city + ", " + p.customer.state + " " + p.customer.zip) +
      field("Phone", p.customer.phone) +
      field("Carrier", (p.carrier || "—") + (p.lane ? " · " + p.lane : "")) +
      field("Tracking", p.tracking || "—", true) +
      '<div style="margin-top:14px">' + Code128.toSVG(p.barcode, { height: 60, moduleWidth: 1.6 }) +
      '<div class="mono small" style="text-align:center">' + p.barcode + '</div></div>' +
      '</div><div><h2 style="font-size:.95rem;margin-bottom:10px">Chain of Custody</h2>' + tl + photos + '</div></div>' +
      '<div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end">' +
      (p.exception
        ? '<button class="btn sm ok" id="resolve-exc">✓ Resolve Exception</button>'
        : '<button class="btn sm" id="flag-exc">⚠ Flag Exception</button>') +
      '<button class="btn sm" id="edit-pkg">✎ Edit</button>' +
      '<button class="btn sm danger" id="del-pkg">🗑 Delete</button></div>'
    );
    var ed = $("#edit-pkg"); if (ed) ed.addEventListener("click", function () { editPackage(p.id); });
    var dl = $("#del-pkg"); if (dl) dl.addEventListener("click", function () { deletePackage(p.id); });
    var fx = $("#flag-exc"); if (fx) fx.addEventListener("click", function () { flagException(p.id); });
    var rx = $("#resolve-exc"); if (rx) rx.addEventListener("click", function () { resolveException(p.id); });
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
    if (!window.confirm("Delete " + id + "? This cannot be undone.")) return;
    state.packages = state.packages.filter(function (p) { return p.id !== id; });
    rebuildManifests(); save(); closeModal();
    if (cocSelected === id) cocSelected = null;
    toast(id + " deleted", "ok"); renderAll();
  }

  function modal(html) {
    $("#modal").innerHTML = html;
    $("#modal-backdrop").classList.add("open");
    var x = $("#modal [data-close]");
    if (x) x.addEventListener("click", closeModal);
  }
  function closeModal() { $("#modal-backdrop").classList.remove("open"); }
  $("#modal-backdrop").addEventListener("click", function (e) { if (e.target === $("#modal-backdrop")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

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
    toast("Live demo — " + p.customer.name + " just won an auction. Watch it reach the doorstep.", "api");

    var steps = [
      { v: "ingest", t: "Auction won — order pulled via API from " + p.source, k: "api", act: function () { } },
      { v: "runner", t: "Code 128 label generated & printed", k: "ok", act: function () { advance(p, "Intake"); } },
      { v: "runner", t: "Condition photo captured · item binned", k: "ok", act: function () { p.photos.pickup = placeholderPhoto(p.item.description, "PICKUP", "#1d4ed8"); advance(p, "PickedUp"); } },
      { v: "batch", t: "Batched to " + (p.carrier = "UPS") + " manifest · Lane 2", k: "ok", act: function () { p.lane = "Lane 2"; p.batchId = "BATCH-" + (700 + rng(299)); advance(p, "Staged"); } },
      { v: "driver", t: "UPS API: shipment created · tracking issued", k: "api", act: function () { p.tracking = trackingFor("UPS"); advance(p, "InTransit"); } },
      { v: "tracking", t: "Carrier scan: Out for Delivery", k: "ok", act: function () { advance(p, "OutforDelivery"); } },
      { v: "tracking", t: "Delivered — confirmed with condition photo ✓", k: "ok", act: function () { p.photos.delivery = placeholderPhoto(p.item.description, "DELIVERED", "#15803d"); advance(p, "Delivered"); } }
    ];

    var i = 0;
    (function tick() {
      if (i >= steps.length) {
        demoRunning = false;
        $("#run-demo").disabled = false;
        $("#run-demo").textContent = "▶ Run Live Demo";
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

  var resetBtn = $("#reset-data");
  if (resetBtn) resetBtn.addEventListener("click", function () {
    if (!window.confirm("Reset all data back to the demo seed? This clears any orders you've added.")) return;
    var keepRole = currentRole(), keepChosen = state.settings.roleChosen;
    seed(); state.settings.role = keepRole; state.settings.roleChosen = keepChosen; save();
    cocSelected = null; trackQuery = ""; toast("Demo data reset to seed.", "ok");
    applyRole(); go(allowedViews()[0]);
  });

  // Activity search
  var actSearch = $("#activity-search");
  if (actSearch) actSearch.addEventListener("input", function () { activityQuery = this.value.trim().toLowerCase(); renderActivity(); });

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
      try {
        var data = JSON.parse(e.target.result);
        if (!data || !Array.isArray(data.packages)) throw new Error("bad");
        state.packages = data.packages;
        state.manifests = Array.isArray(data.manifests) ? data.manifests : [];
        state.loadUnits = Array.isArray(data.loadUnits) ? data.loadUnits : [];
        state.events = Array.isArray(data.events) ? data.events : [];
        state.settings = Object.assign(defaultSettings(), data.settings || {});
        if (data.settings && data.settings.company) state.settings.company = Object.assign(defaultSettings().company, data.settings.company);
        if (typeof data.seq === "number") seq = data.seq;
        rebuildManifests(); save();
        syncRoleSelect(); applyRole(); toast(state.packages.length + " packages restored from backup", "ok"); go("overview");
      } catch (err) { toast("That file isn't a valid Granite backup.", "ok"); }
    };
    reader.readAsText(f);
  });

  // Workspace picker + role badge
  $$("#role-gate .rg-card").forEach(function (c) { c.addEventListener("click", function () { setRole(c.dataset.role); }); });
  var roleBadge = $("#role-badge"); if (roleBadge) roleBadge.addEventListener("click", openGate);

  // Mobile drawer
  var menuBtn = $("#menu-btn"); if (menuBtn) menuBtn.addEventListener("click", function () { toggleSidebar(); });
  var sbBackdrop = $("#sidebar-backdrop"); if (sbBackdrop) sbBackdrop.addEventListener("click", function () { toggleSidebar(false); });

  // Global package search
  var gsearch = $("#global-search");
  if (gsearch) gsearch.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var q = this.value.trim(); if (!q) return;
    var norm = function (s) { return String(s).toUpperCase().replace(/[^A-Z0-9]/g, ""); };
    var m = state.packages.find(function (p) { return norm(p.id) === norm(q) || norm(p.barcode) === norm(q); });
    if (m) { openPackage(m.id); this.value = ""; return; }
    if (allowedViews().indexOf("tracking") >= 0) {
      trackQuery = q.toLowerCase(); go("tracking");
      var si = $("#track-search"); if (si) si.value = q;
      toast('Showing matches for "' + q + '"', "ok");
    } else { toast('No package matches "' + q + '"', "ok"); }
    this.value = "";
  });

  // ---- Deep-linking: index.html sends e.g. #tracking or #tracking=GL-1042 ----

  // ---- Deep-linking: index.html sends e.g. #tracking or #tracking=GL-1042 ----
  function applyHash() {
    var raw = (location.hash || "").replace(/^#/, "");
    if (!raw) return false;
    var parts = raw.split("=");
    var view = parts[0];
    var query = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (!VIEW_META[view]) return false;
    go(view);
    if (view === "tracking" && query) {
      var norm = function (s) { return String(s).toUpperCase().replace(/[^A-Z0-9]/g, ""); };
      var match = state.packages.find(function (p) { return norm(p.id) === norm(query) || norm(p.barcode) === norm(query); });
      if (match) {
        cocSelected = match.id; renderTracking(); renderCoc(match.id);
        var rowEl = document.querySelector('#tracking-list .row-item[data-id="' + match.id + '"]');
        if (rowEl) rowEl.classList.add("selected");
      }
      else toast("No shipment found for “" + query + "”. Showing all packages.", "ok");
    }
    return true;
  }

  // ---- Boot ----
  updateRoleUI();
  if (!applyHash()) go(allowedViews()[0]);
  applyRole();
  if (!state.settings.roleChosen) openGate(); // first entry → pick a workspace
  window.addEventListener("hashchange", applyHash);

  // QA / debugging hook (harmless in a demo)
  window.GL = state;

  // Register service worker for installable / offline PWA
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () { }); });
  }
})();
