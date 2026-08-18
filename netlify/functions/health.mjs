// Open health check, plus a deployment-readiness report.
//
// The readiness block exists because the failure modes here are silent. If GL_ADMIN_EMAILS is
// unset, every account is a Customer and the whole ops platform answers 403 with no other
// symptom; if the VAPID keys are unset, a delivery status changes and nobody is told. This
// endpoint makes both visible before a real user finds them.
//
// It reports booleans and counts only, never a value: this route is public, so it must
// say whether a secret is configured without disclosing it or who holds it.
import { json, tenants, storageProvider } from "./_lib.mjs";
import { adminEmails, roleMap, readGrants, grantedRole, OPS_ROLES } from "./_auth.mjs";
import { pushConfigured } from "./_push.mjs";
import { configuredCarriers } from "./_carriers.mjs";

// An address already counted via env config must not be counted twice.
const envRoleForCount = (email, admins, named) =>
  (admins.includes(email) || OPS_ROLES.includes(named[email])) ? 1 : 0;

// Every variable this app reads. Used to tell "you have not set it" apart from "you set
// something close to it", which is otherwise indistinguishable from the outside and is the
// single most likely reason a correctly-set variable appears missing.
const KNOWN_VARS = [
  "GL_AUTH_SECRET", "GL_ADMIN_EMAILS", "GL_ROLES", "GL_TENANTS",
  "GL_VAPID_PUBLIC", "GL_VAPID_PRIVATE",
  "GL_UPS_CLIENT_ID", "GL_UPS_CLIENT_SECRET", "GL_FEDEX_CLIENT_ID", "GL_FEDEX_CLIENT_SECRET",
  // Storage. Both set switches workspaces from Netlify Blobs to Supabase; neither is required.
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
];

// Read only outside the deployment -- GL_WEBHOOK_SECRET by server/server.js, GL_CHROME by the
// verification scripts. Recognised, so setting one is not reported as a typo, but never
// reported as missing: no function here reads them, so "unset" is the correct state.
const LOCAL_ONLY_VARS = ["GL_WEBHOOK_SECRET", "GL_CHROME"];

// Names only, never values. A name is not a secret, and without this a misspelled or
// wrongly-scoped variable looks exactly like an unset one.
function envDiagnostic() {
  const present = KNOWN_VARS.concat(LOCAL_ONLY_VARS).filter((k) => !!process.env[k]);
  const unrecognised = Object.keys(process.env)
    .filter((k) => /^(GL_|SUPABASE_)/.test(k) && KNOWN_VARS.indexOf(k) < 0 && LOCAL_ONLY_VARS.indexOf(k) < 0)
    .sort();
  return {
    present,
    missing: KNOWN_VARS.filter((k) => !process.env[k]),
    // Anything here is set on the deployment but read by nothing: almost always a typo.
    unrecognised,
    hint: unrecognised.length
      ? "These variables are set but this app reads none of them. Check the spelling against `present` and `missing`."
      : "No unrecognised GL_ / SUPABASE_ variables. A variable in `missing` is genuinely not visible to the deployed functions: confirm it is set for the Production context and that a deploy has happened since.",
  };
}

async function readiness() {
  const admins = adminEmails();
  const named = roleMap();
  const namedOps = Object.values(named).filter((r) => OPS_ROLES.includes(r)).length;
  // Grants made on the Team & Roles screen count too, so a deployment bootstrapped from
  // config and then managed in-app does not keep reporting itself as unconfigured.
  let inApp = 0;
  try {
    const grants = await readGrants();
    inApp = Object.keys(grants).filter((e) => grantedRole(grants, e) && envRoleForCount(e, admins, named) === 0).length;
  } catch (e) { inApp = 0; }
  const opsUsers = admins.length + namedOps + inApp;
  const authSecret = !!process.env.GL_AUTH_SECRET;

  const checks = {
    // Without this every session token is forgeable by anyone who can read the repo.
    authSecret: { ok: authSecret, detail: authSecret ? "set" : "GL_AUTH_SECRET is not set; sessions are signed with a public fallback" },
    // Without this nobody can reach the ops workspace at all.
    opsAccess: { ok: opsUsers > 0, detail: opsUsers > 0 ? opsUsers + " account(s) hold an ops role" : "no ops roles granted; set GL_ADMIN_EMAILS to bootstrap, then use Team & Roles" },
    // Optional: customers simply do not see the opt-in without it.
    pushNotifications: { ok: pushConfigured(), detail: pushConfigured() ? "configured" : "GL_VAPID_PUBLIC / GL_VAPID_PRIVATE not set; run `npm run vapid` to generate a keypair" },
    // Push is the only delivery channel: there is no email feature, so without VAPID keys a
    // status change is recorded and nobody is told.
    statusUpdates: { ok: pushConfigured(), detail: pushConfigured() ? "browser push configured" : "no push configured, and there is no email channel; transitions are recorded but nothing is delivered" },
    // Optional, but the difference between a demo and a shipment somebody is waiting on.
    carrierTracking: (() => {
      const live = configuredCarriers();
      return { ok: live.length > 0, detail: live.length ? live.join(", ") + " configured" : "no carrier credentials; tracking numbers and scans are generated locally" };
    })(),
    // Which store a workspace lives in. Not a pass/fail -- both providers work -- but it is
    // the one thing you cannot tell from outside during a migration, and getting it wrong
    // means writing orders into a store nobody is reading.
    workspaceStorage: (() => {
      const p = storageProvider();
      return { ok: true, detail: p === "supabase"
        ? "Supabase (a row per parcel); condition photos in Storage behind expiring signed URLs"
        : "Netlify Blobs (one JSON record per workspace); set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to switch" };
    })(),
    // Optional: only needed for machine callers that read a workspace.
    machineApiKeys: { ok: true, detail: tenants() ? "GL_TENANTS configured; the public demo keys are disabled" : "using the public demo keys, which are valid for /api/orders ingest only" },
  };

  // Only the things that break the product count as blocking.
  const blocking = ["authSecret", "opsAccess"].filter((k) => !checks[k].ok);
  return { ready: blocking.length === 0, blocking, checks };
}

export default async () =>
  json({
    ok: true,
    service: "granite-logistics",
    runtime: "netlify-functions",
    storage: storageProvider(),
    time: new Date().toISOString(),
    readiness: await readiness(),
    env: envDiagnostic(),
  });

export const config = { path: "/api/health" };
