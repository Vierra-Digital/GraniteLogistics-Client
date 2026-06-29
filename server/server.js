/* Granite Logistics — zero-dependency backend.
 * Serves the static PWA AND a JSON API (state sync + read endpoints) with API-key auth.
 * No npm install required: uses only Node built-ins. Run: node server/server.js
 */
"use strict";
var http = require("http");
var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");           // project root (static files)
var DATA = path.join(__dirname, "data.json");      // persisted state
var PORT = process.env.PORT || 8080;
var API_KEY = process.env.GL_API_KEY || "granite-dev-key";

var MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain"
};

function readState() {
  try { return JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (e) { return { packages: [], manifests: [], loadUnits: [], events: [], settings: {} }; }
}
function writeState(obj) { fs.writeFileSync(DATA, JSON.stringify(obj, null, 2)); }

function nextId(state) {
  var max = 1040;
  (state.packages || []).forEach(function (p) { var m = /GL-(\d+)/.exec(p.id || ""); if (m) max = Math.max(max, +m[1]); });
  return "GL-" + (max + 1);
}
// Build a package from an inbound order payload (mirrors the client's intake shape).
function makeOrder(d, state) {
  var id = nextId(state);
  var now = Date.now();
  return {
    id: id,
    source: d.source || "API",
    orderRef: d.orderRef || ("#" + (10000 + Math.floor(Math.random() * 89999))),
    customer: {
      name: (d.name || "—").toString().trim(),
      address: (d.address || "").toString().trim(),
      city: (d.city || "").toString().trim(),
      state: (d.state || "").toString().trim().toUpperCase(),
      zip: (d.zip || "").toString().trim(),
      phone: (d.phone || "").toString().trim()
    },
    item: { description: (d.item || "Item").toString().trim(), value: Math.max(0, parseInt(d.value, 10) || 0), weight: Math.max(1, parseInt(d.weight, 10) || (2 + Math.floor(Math.random() * 38))) },
    barcode: id.replace(/-/g, ""),
    carrier: null, lane: null, batchId: null, tracking: null,
    photos: {},
    history: [{ stage: "Won", ts: now, note: "Order received via API webhook." }],
    promisedTs: now + (3 + Math.floor(Math.random() * 3)) * 86400000,
    exception: null,
    status: "Won"
  };
}

function sendJSON(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS"
  });
  res.end(body);
}
function authed(req) { return (req.headers["x-api-key"] || "") === API_KEY; }

function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") { sendJSON(res, 204, {}); return; }

  if (pathname === "/api/health") {
    var s = readState();
    return sendJSON(res, 200, { ok: true, service: "granite-logistics", packages: (s.packages || []).length, time: new Date().toISOString() });
  }

  // Everything below requires the API key
  if (!authed(req)) return sendJSON(res, 401, { error: "unauthorized", hint: "send header x-api-key" });

  if (pathname === "/api/state" && req.method === "GET") {
    return sendJSON(res, 200, readState());
  }
  if (pathname === "/api/state" && req.method === "PUT") {
    var body = "";
    req.on("data", function (c) { body += c; if (body.length > 8e6) req.destroy(); });
    req.on("end", function () {
      try {
        var obj = JSON.parse(body || "{}");
        if (!obj || !Array.isArray(obj.packages)) return sendJSON(res, 400, { error: "expected { packages: [...] }" });
        obj.updatedAt = new Date().toISOString();
        writeState(obj);
        sendJSON(res, 200, { ok: true, packages: obj.packages.length, updatedAt: obj.updatedAt });
      } catch (e) { sendJSON(res, 400, { error: "invalid JSON" }); }
    });
    return;
  }
  if (pathname === "/api/packages" && req.method === "GET") {
    return sendJSON(res, 200, { packages: readState().packages || [] });
  }
  // API-first ingest: a client store / carrier pushes orders here
  if (pathname === "/api/orders" && req.method === "POST") {
    var ob = "";
    req.on("data", function (c) { ob += c; if (ob.length > 4e6) req.destroy(); });
    req.on("end", function () {
      try {
        var parsed = JSON.parse(ob || "{}");
        var orders = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.orders) ? parsed.orders : [parsed]);
        var state = readState();
        if (!Array.isArray(state.packages)) state.packages = [];
        var created = orders.map(function (d) { var p = makeOrder(d, state); state.packages.push(p); return p; });
        state.updatedAt = new Date().toISOString();
        writeState(state);
        sendJSON(res, 201, { ok: true, created: created.length, packages: created });
      } catch (e) { sendJSON(res, 400, { error: "invalid JSON order payload" }); }
    });
    return;
  }
  sendJSON(res, 404, { error: "not found" });
}

function serveStatic(req, res, pathname) {
  var rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  var filePath = path.normalize(path.join(ROOT, rel));
  if (filePath.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

http.createServer(function (req, res) {
  var pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.indexOf("/api/") === 0) return handleApi(req, res, pathname);
  serveStatic(req, res, pathname);
}).listen(PORT, function () {
  console.log("Granite Logistics server on http://localhost:" + PORT + "  (API key: " + API_KEY + ")");
});
