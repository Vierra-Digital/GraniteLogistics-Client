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
      item: { description: item[0], value: item[1] },
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

  // ---- App state ----
  var state = { packages: [] };
  // Seed a realistic spread across the pipeline
  [6, 6, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0].forEach(function (s) { state.packages.push(makePackage(s)); });

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
    batch: ["Batch & Lane Routing", "Group items into carrier manifests and assign dock lanes."],
    driver: ["Driver Scan", "Scan a label to retrieve destination details instantly."],
    tracking: ["Chain of Custody", "Tamper-evident, end-to-end package history."]
  };
  function go(view) {
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
    var inFlight = total - delivered - c.Won;
    var value = state.packages.reduce(function (a, p) { return a + p.item.value; }, 0);
    var kpis = [
      ["Active Packages", total, "+3 today"],
      ["In Transit Now", c.InTransit + c.OutforDelivery, "across 4 carriers"],
      ["Delivered", delivered, "100% photo-verified"],
      ["Goods In Custody", money(value), "fully insured*"]
    ];
    $("#kpi-row").innerHTML = kpis.map(function (k) {
      return '<div class="kpi"><div class="k-label">' + k[0] + '</div><div class="k-val">' + k[1] +
        '</div><div class="k-sub">' + k[2] + '</div></div>';
    }).join("");

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
    state.packages.push(p);
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
    p.photos.pickup = placeholderPhoto(p.item.description, "PICKUP", "#1d4ed8");
    advance(p, "PickedUp");
    toast("Condition photo captured · " + p.id + " binned", "ok");
    renderRunner();
  }

  function openLabel(p) {
    modal(
      '<button class="close-x" data-close>×</button><h2>Tracking Label</h2>' +
      '<p class="muted">' + p.item.description + ' → ' + p.customer.name + '</p>' +
      '<div class="label-card" style="margin-top:14px">' +
      '<div style="font-weight:800;font-size:1.1rem">GRANITE LOGISTICS</div>' +
      '<div class="muted small">' + p.customer.address + ', ' + p.customer.city + ', ' + p.customer.state + ' ' + p.customer.zip + '</div>' +
      '<div style="margin:12px 0">' + Code128.toSVG(p.barcode, { height: 80, moduleWidth: 2 }) + '</div>' +
      '<div class="lbl-key">' + p.barcode + '</div></div>'
    );
  }

  // ---- Batch ----
  var batchSel = {};
  function renderBatch() {
    batchSel = {};
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
    var batchId = "BATCH-" + (700 + rng(299));
    Object.keys(batchSel).forEach(function (id) {
      var p = getPkg(id);
      p.carrier = carrier; p.lane = lane; p.batchId = batchId;
      advance(p, "Staged");
    });
    toast(Object.keys(batchSel).length + " items → " + carrier + " manifest at " + lane, "ok");
    renderBatch();
  });

  // ---- Driver scan ----
  function renderDriver() {
    var scannable = state.packages.filter(function (p) { return p.status === "Staged" || p.status === "InTransit" || p.status === "OutforDelivery"; });
    $("#scan-select").innerHTML = scannable.map(function (p) {
      return '<option value="' + p.id + '">' + p.id + " — " + p.item.description + " (" + STAGE_LABEL[p.status] + ")</option>";
    }).join("") || '<option value="">No packages staged</option>';
    $("#scan-result").innerHTML = '<p class="muted">Scan a label to retrieve package details.</p>';
  }
  $("#do-scan").addEventListener("click", function () {
    var id = $("#scan-select").value;
    if (!id) return;
    var p = getPkg(id);
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
      field("Carrier", p.carrier + " · " + p.lane) +
      field("Tracking", p.tracking || "—", true) +
      field("New Status", STAGE_LABEL[p.status]) +
      '<div style="margin-top:12px"><button class="btn sm" data-open="' + p.id + '">View Chain of Custody</button></div>';
    var btn = $("#scan-result [data-open]");
    if (btn) btn.addEventListener("click", function () { openPackage(p.id); });
    renderDriver();
  });
  function field(k, v, mono) { return '<div class="field"><b>' + k + '</b><span' + (mono ? ' class="mono"' : "") + ">" + v + "</span></div>"; }

  // ---- Tracking / chain of custody ----
  var cocSelected = null;
  function renderTracking() {
    var pkgs = state.packages.slice().sort(function (a, b) { return stageIdx(b.status) - stageIdx(a.status); });
    $("#tracking-list").innerHTML = pkgs.map(function (p) {
      return '<div class="row-item selectable" data-id="' + p.id + '"><div class="ri-main">' +
        '<div class="ri-title">' + p.id + " · " + p.item.description + '</div>' +
        '<div class="ri-sub">' + p.customer.name + " — " + p.customer.city + ", " + p.customer.state + '</div></div>' +
        '<span class="' + pillClass(p.status) + '">' + STAGE_LABEL[p.status] + '</span></div>';
    }).join("");
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
      '<span class="' + pillClass(p.status) + '">' + STAGE_LABEL[p.status] + '</span>' +
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
      '</div><div><h2 style="font-size:.95rem;margin-bottom:10px">Chain of Custody</h2>' + tl + photos + '</div></div>'
    );
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
    state.packages.push(p);
    go("tracking"); cocSelected = p.id;

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
  if (!applyHash()) go("overview");
  window.addEventListener("hashchange", applyHash);

  // QA / debugging hook (harmless in a demo)
  window.GL = state;

  // Register service worker for installable / offline PWA
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () { }); });
  }
})();
