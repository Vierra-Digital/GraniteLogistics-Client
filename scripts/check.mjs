// Run every browser audit in one pass, against one server, in one browser.
//
//   npm run check
//
// The three audits each cost a browser launch and 20-90 page loads, which is why they are
// separate commands during development. This runs all of them so a pre-deploy sweep is a
// single command, reports a summary, and exits non-zero if anything failed -- including
// when an audit could not run at all, so a crashed audit can never read as a pass.
//
// `npm test` is not included: it needs no server and runs in two seconds on its own.
import { spawn } from "node:child_process";

const BASE = process.env.GL_BASE || "http://localhost:8080";
const AUDITS = [
  ["contrast", "WCAG AA text contrast, both themes"],
  ["layout", "overflow and clipping across viewport widths"],
  ["a11y", "semantics and keyboard reachability"],
];

try {
  const probe = await fetch(BASE + "/");
  if (!probe.ok) throw new Error("HTTP " + probe.status);
} catch (e) {
  console.error(`Cannot reach ${BASE} (${e.message}). Start the site first:\n  python -m http.server 8080\n`);
  process.exit(2);
}

const run = (script) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["scripts/" + script + ".mjs"], { stdio: "inherit" });
  p.on("close", (code) => resolve(code));
  p.on("error", () => resolve(1));
});

const results = [];
for (const [name, what] of AUDITS) {
  console.log("\n" + "=".repeat(72) + "\n  " + name + " -- " + what + "\n" + "=".repeat(72));
  results.push([name, await run(name)]);
}

console.log("\n" + "=".repeat(72));
for (const [name, code] of results) {
  console.log("  " + (code === 0 ? "PASS" : "FAIL") + "  " + name + (code === 0 ? "" : "  (exit " + code + ")"));
}
console.log("=".repeat(72) + "\n");
process.exit(results.some(([, c]) => c !== 0) ? 1 : 0);
