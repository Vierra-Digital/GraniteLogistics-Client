/* Granite Logistics — zero-dependency backend (multi-tenant).
 * Serves the static PWA AND a key-authed JSON API. Each API key maps to a tenant
 * with isolated state; inbound order webhooks support optional HMAC signatures.
 * No npm install required. Run: node server/server.js
 */
"use strict";
var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var ROOT = path.join(__dirname, "..");
var DATA_DIR = path.join(__dirname, "data");
var PORT = process.env.PORT || 8080;
var WEBHOOK_SECRET = process.env.GL_WEBHOOK_SECRET || "granite-webhook-secret";

// apiKey -> tenantId. Override with GL_TENANTS='{"key":"tenant",...}'.
var TENANTS;
try { TENANTS = process.env.GL_TENANTS ? JSON.parse(process.env.GL_TENANTS) : null; } catch (e) { TENANTS = null; }
if (!TENANTS) TENANTS = { "granite-dev-key": "default", "acme-key": "acme", "globex-key": "globex" };

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }

var MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain"
};

function tenantOf(req) { return TENANTS[req.headers["x-api-key"] || ""] || null; }
function fileFor(tenant) { return path.join(DATA_DIR, tenant.replace(/[^a-z0-9_-]/gi, "") + ".json"); }
function readState(tenant) {
  try { return JSON.parse(fs.readFileSync(fileFor(tenant), "utf8")); }
  catch (e) { return { packages: [], manifests: [], loadUnits: [], events: [], settings: {} }; }
}
function writeState(tenant, obj) { obj.updatedAt = new Date().toISOString(); fs.writeFileSync(fileFor(tenant), JSON.stringify(obj, null, 2)); }

function nextId(state) {
  var max = 1040;
  (state.packages || []).forEach(function (p) { var m = /GL-(\d+)/.exec(p.id || ""); if (m) max = Math.max(max, +m[1]); });
  return "GL-" + (max + 1);
}
function makeOrder(d, state) {
  var id = nextId(state), now = Date.now();
  return {
    id: id, source: d.source || "API", orderRef: d.orderRef || ("#" + (10000 + Math.floor(Math.random() * 89999))),
    customer: { name: (d.name || "—").toString().trim(), address: (d.address || "").toString().trim(), city: (d.city || "").toString().trim(), state: (d.state || "").toString().trim().toUpperCase(), zip: (d.zip || "").toString().trim(), phone: (d.phone || "").toString().trim() },
    item: { description: (d.item || "Item").toString().trim(), value: Math.max(0, parseInt(d.value, 10) || 0), weight: Math.max(1, parseInt(d.weight, 10) || (2 + Math.floor(Math.random() * 38))) },
    barcode: id.replace(/-/g, ""), carrier: null, lane: null, batchId: null, tracking: null, photos: {},
    history: [{ stage: "Won", ts: now, note: "Order received via API webhook." }],
    promisedTs: now + (3 + Math.floor(Math.random() * 3)) * 86400000, exception: null, status: "Won"
  };
}
function validSig(raw, sig) {
  if (!sig) return true; // signature optional; API key still required
  var h = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  var got = String(sig).replace(/^sha256=/, "");
  try { return got.length === h.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(h)); } catch (e) { return false; }
}

function sendJSON(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key, x-signature",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS"
  });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) { var b = ""; req.on("data", function (c) { b += c; if (b.length > 8e6) req.destroy(); }); req.on("end", function () { cb(b); }); }

function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") return sendJSON(res, 204, {});

  if (pathname === "/api/health") {
    var tenants = Object.keys(TENANTS).map(function (k) { return TENANTS[k]; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    return sendJSON(res, 200, { ok: true, service: "granite-logistics", tenants: tenants.length, time: new Date().toISOString() });
  }

  var tenant = tenantOf(req);
  if (!tenant) return sendJSON(res, 401, { error: "unauthorized", hint: "send a valid x-api-key" });

  if (pathname === "/api/state" && req.method === "GET") return sendJSON(res, 200, readState(tenant));
  if (pathname === "/api/state" && req.method === "PUT") {
    return readBody(req, function (body) {
      try { var obj = JSON.parse(body || "{}"); if (!Array.isArray(obj.packages)) return sendJSON(res, 400, { error: "expected { packages: [...] }" }); writeState(tenant, obj); sendJSON(res, 200, { ok: true, tenant: tenant, packages: obj.packages.length, updatedAt: obj.updatedAt }); }
      catch (e) { sendJSON(res, 400, { error: "invalid JSON" }); }
    });
  }
  if (pathname === "/api/packages" && req.method === "GET") return sendJSON(res, 200, { tenant: tenant, packages: readState(tenant).packages || [] });
  if (pathname === "/api/orders" && req.method === "POST") {
    return readBody(req, function (body) {
      if (!validSig(body, req.headers["x-signature"])) return sendJSON(res, 401, { error: "invalid signature" });
      try {
        var parsed = JSON.parse(body || "{}");
        var orders = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.orders) ? parsed.orders : [parsed]);
        var state = readState(tenant); if (!Array.isArray(state.packages)) state.packages = [];
        var created = orders.map(function (d) { var p = makeOrder(d, state); state.packages.push(p); return p; });
        writeState(tenant, state);
        sendJSON(res, 201, { ok: true, tenant: tenant, created: created.length, packages: created });
      } catch (e) { sendJSON(res, 400, { error: "invalid JSON order payload" }); }
    });
  }
  sendJSON(res, 404, { error: "not found" });
}

function serveStatic(req, res, pathname) {
  var rel = decodeURIComponent(pathname); if (rel === "/" || rel === "") rel = "/index.html";
  var filePath = path.normalize(path.join(ROOT, rel));
  if (filePath.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end("Forbidden"); }
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

http.createServer(function (req, res) {
  var pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.indexOf("/api/") === 0) return handleApi(req, res, pathname);
  serveStatic(req, res, pathname);
}).listen(PORT, function () {
  console.log("Granite Logistics server on http://localhost:" + PORT);
  console.log("Tenants:", JSON.stringify(TENANTS));
});
