// Open health check, plus a deployment-readiness report.
//
// The readiness block exists because the failure modes here are silent. If
// GL_ADMIN_EMAILS is unset, every account is a Customer and the whole ops platform
// answers 403 with no other symptom; if the mail vars are unset, password reset fails
// only at the moment a locked-out user needs it. This endpoint makes both visible before
// a real user finds them.
//
// It reports booleans and counts only, never a value: this route is public, so it must
// say whether a secret is configured without disclosing it or who holds it.
import { json, tenants } from "./_lib.mjs";
import { adminEmails, roleMap, OPS_ROLES } from "./_auth.mjs";
import { emailConfigured } from "./_email.mjs";

function readiness() {
  const admins = adminEmails();
  const named = roleMap();
  const namedOps = Object.values(named).filter((r) => OPS_ROLES.includes(r)).length;
  const opsUsers = admins.length + namedOps;
  const authSecret = !!process.env.GL_AUTH_SECRET;

  const checks = {
    // Without this every session token is forgeable by anyone who can read the repo.
    authSecret: { ok: authSecret, detail: authSecret ? "set" : "GL_AUTH_SECRET is not set; sessions are signed with a public fallback" },
    // Without this nobody can reach the ops workspace at all.
    opsAccess: { ok: opsUsers > 0, detail: opsUsers > 0 ? opsUsers + " account(s) granted an ops role" : "no ops roles granted; set GL_ADMIN_EMAILS or the ops platform is locked out" },
    // Optional: reset links simply report "not set up" without it.
    passwordReset: { ok: emailConfigured(), detail: emailConfigured() ? "configured" : "GL_RESEND_KEY / GL_MAIL_FROM not set; password reset returns a clear error instead of sending" },
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
    storage: "netlify-blobs",
    time: new Date().toISOString(),
    readiness: readiness(),
  });

export const config = { path: "/api/health" };
