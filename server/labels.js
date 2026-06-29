/* Puppeteer label rendering — turns a package into a printable 4x6 PDF label.
 * Uses a system Chromium (Chrome/Edge) since the bundled download may be blocked.
 * Lazy/graceful: throws a clear error if no browser is available. */
"use strict";
var fs = require("fs");
var code128 = require("./code128");

function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]; }); }

function findBrowser() {
  if (process.env.GL_CHROME && fs.existsSync(process.env.GL_CHROME)) return process.env.GL_CHROME;
  try { var pp = require("puppeteer").executablePath(); if (pp && fs.existsSync(pp)) return pp; } catch (e) { }
  var cands = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
  for (var i = 0; i < cands.length; i++) { try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) { } }
  return null;
}

function labelInner(pkg, company) {
  var c = pkg.customer || {};
  var bc = code128.toSVG(pkg.barcode || (pkg.id || "").replace(/-/g, ""), { height: 120, moduleWidth: 3 });
  return '<div class="lbl">' +
    '<div class="h">' + esc(company || "GRANITE LOGISTICS") + '</div>' +
    '<div class="sub">PRIORITY' + (pkg.carrier ? " &middot; " + esc(pkg.carrier) : "") + (pkg.lane ? " &middot; " + esc(pkg.lane) : "") + '</div>' +
    '<div class="lab">SHIP TO</div>' +
    '<div class="to">' + esc(c.name || "") + '<br>' + esc(c.address || "") + '<br>' + esc(c.city || "") + ', ' + esc(c.state || "") + ' ' + esc(c.zip || "") + '</div>' +
    '<div class="bc">' + bc + '</div>' +
    '<div class="key">' + esc(pkg.barcode || pkg.id || "") + '</div>' +
    '<div class="meta"><span>' + esc(pkg.id || "") + '</span><span>WT ' + ((pkg.item && pkg.item.weight) || "—") + ' LB</span></div>' +
    '</div>';
}
var STYLE = '<style>*{margin:0;box-sizing:border-box}@page{size:4in 6in;margin:0}' +
  'body{font-family:Arial,Helvetica,sans-serif;color:#000}' +
  '.lbl{width:4in;height:6in;padding:.22in;page-break-after:always;display:flex;flex-direction:column}' +
  '.h{font-size:26px;font-weight:800;letter-spacing:.5px}' +
  '.sub{font-size:13px;font-weight:700;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:10px}' +
  '.lab{font-size:11px;color:#444;font-weight:700;margin-top:4px}.to{font-size:18px;line-height:1.35}' +
  '.bc{margin-top:auto;text-align:center}.bc svg{max-width:100%}' +
  '.key{text-align:center;font-family:"Courier New",monospace;font-weight:700;letter-spacing:3px;font-size:18px;margin-top:6px}' +
  '.meta{display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-top:8px;border-top:1px dashed #777;padding-top:8px}</style>';

function htmlDoc(inner) { return '<!doctype html><html><head><meta charset="utf-8">' + STYLE + '</head><body>' + inner + '</body></html>'; }

var _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) return _browser;
  var exe = findBrowser();
  if (!exe) throw new Error("No Chrome/Edge found — set GL_CHROME to a Chromium executable path.");
  var puppeteer = require("puppeteer");
  _browser = await puppeteer.launch({ headless: "new", executablePath: exe, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  return _browser;
}
async function renderPDF(inner) {
  var browser = await getBrowser();
  var page = await browser.newPage();
  try {
    await page.setContent(htmlDoc(inner), { waitUntil: "load" });
    return await page.pdf({ width: "4in", height: "6in", printBackground: true });
  } finally { await page.close(); }
}
function renderLabelPDF(pkg, company) { return renderPDF(labelInner(pkg, company)); }
function renderManifestPDF(pkgs, company) { return renderPDF(pkgs.map(function (p) { return labelInner(p, company); }).join("")); }

module.exports = { renderLabelPDF: renderLabelPDF, renderManifestPDF: renderManifestPDF, findBrowser: findBrowser };
