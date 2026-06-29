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
