// Finding a browser Puppeteer can actually drive, shared by shots.mjs and contrast.mjs.
//
// Order matters. A Chrome for Testing in puppeteer's own cache is preferred over a system
// browser because a system browser can be replaced by an auto-update underneath a run --
// which is exactly what happened here: Edge updated mid-session and every launch after
// that failed with an empty stderr.
import puppeteer from "puppeteer";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The cache can hold a half-extracted directory from an interrupted download, so test for
// the executable rather than the version folder.
function cachedChromes() {
  const root = join(homedir(), ".cache", "puppeteer", "chrome");
  if (!existsSync(root)) return [];
  const rel = {
    win32: ["chrome-win64", "chrome.exe"],
    darwin: ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
  }[process.platform] || ["chrome-linux64", "chrome"];
  return readdirSync(root)
    .map((v) => join(root, v, ...rel))
    .filter((p) => existsSync(p))
    .sort().reverse();               // newest version first
}

const SYSTEM = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

export async function launch() {
  const tried = [];
  const order = [
    ...(process.env.GL_CHROME ? [[process.env.GL_CHROME, "GL_CHROME=" + process.env.GL_CHROME]] : []),
    [undefined, "puppeteer's bundled browser"],
    ...cachedChromes().map((p) => [p, p]),
    ...SYSTEM.filter(existsSync).map((p) => [p, p]),
  ];
  for (const [executablePath, label] of order) {
    try { return await puppeteer.launch({ headless: "new", executablePath, args: ["--no-sandbox"] }); }
    catch (e) { tried.push("  " + label + "\n    " + e.message.split("\n")[0]); }
  }
  // Report every failure: one generic line made a present-but-broken browser look
  // identical to no browser at all.
  throw new Error("No usable browser found. Tried:\n" + tried.join("\n") +
    "\n\nFix: npx puppeteer browsers install chrome  (or set GL_CHROME to an executable)");
}
