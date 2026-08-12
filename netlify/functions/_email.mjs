// Outbound email for Granite Logistics (password reset today, receipts later).
//
// Uses Brevo, which needs two Netlify environment variables:
//   GL_BREVO_KEY   your Brevo API key, starts "xkeysib-" (Brevo > SMTP & API > API keys)
//   GL_MAIL_FROM   a verified sender, e.g. "Granite Logistics <no-reply@usegl.com>"
//
// This calls Brevo's transactional HTTP endpoint (/v3/smtp/email) rather than talking
// SMTP on port 587. Same Brevo product and the same credentials, but SMTP from a
// serverless function would mean bundling an SMTP client and holding a socket open
// inside a short-lived request, and outbound SMTP ports are commonly blocked in these
// runtimes. HTTP keeps this dependency-free and works within a function invocation.
//
// With no key configured this is a deliberate no-op that reports "not-configured"
// rather than throwing, so the rest of the app keeps working and the UI can tell
// the user that password reset isn't switched on yet.
export function emailConfigured() {
  return !!(process.env.GL_BREVO_KEY && process.env.GL_MAIL_FROM);
}

// Brevo wants the sender split into name and email, so accept either
// "Name <a@b.com>" or a bare address.
export function parseSender(value) {
  const raw = String(value || "").trim();
  const m = /^\s*(.*?)\s*<\s*([^>]+?)\s*>\s*$/.exec(raw);
  if (m) return { name: m[1].replace(/^"|"$/g, "") || undefined, email: m[2] };
  return { email: raw };
}

export async function sendEmail({ to, subject, html, text }) {
  if (!emailConfigured()) return { ok: false, reason: "not-configured" };
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.GL_BREVO_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        sender: parseSender(process.env.GL_MAIL_FROM),
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return { ok: false, reason: "send-failed", status: r.status, detail: detail.slice(0, 300) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "send-failed", detail: String((e && e.message) || e) };
  }
}

// A parcel moved. Says only what the recipient already knows plus the new status, and
// links to the public tracking page rather than embedding shipment details in an email
// that may sit in an inbox for years.
export function statusEmail(pkg, stageLabel) {
  const id = (pkg && pkg.id) || "your order";
  const what = (pkg && pkg.item && pkg.item.description) || "Your shipment";
  const who = (pkg && pkg.customer && pkg.customer.name || "").split(" ")[0] || "there";
  const link = "https://usegl.com/track.html?n=" + encodeURIComponent(id);
  const headline = what + " is " + stageLabel;
  const eta = (pkg && pkg.promisedTs)
    ? new Date(pkg.promisedTs).toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : null;
  return {
    subject: id + ": " + stageLabel,
    text: "Hi " + who + ",\n\n" + headline + ".\n" +
      (eta ? "Estimated delivery: " + eta + "\n" : "") +
      "\nTrack it here:\n" + link + "\n\nGranite Logistics",
    html:
      '<div style="font-family:Segoe UI,system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;color:#101828">' +
      '<div style="font-weight:800;letter-spacing:.08em;color:#0f1b2c;font-size:15px;margin-bottom:22px">GRANITE LOGISTICS</div>' +
      '<h1 style="font-size:20px;margin:0 0 12px">' + headline + '</h1>' +
      '<p style="color:#697587;font-size:15px;line-height:1.55;margin:0 0 8px">Hi ' + who +
      ', your shipment <b style="color:#101828">' + id + '</b> is now <b style="color:#101828">' + stageLabel + '</b>.</p>' +
      (eta ? '<p style="color:#697587;font-size:15px;line-height:1.55;margin:0 0 22px">Estimated delivery: <b style="color:#101828">' + eta + '</b></p>' : '<div style="height:14px"></div>') +
      '<a href="' + link + '" style="display:inline-block;background:#2f9bd6;color:#fff;text-decoration:none;' +
      'font-weight:700;padding:13px 22px;border-radius:10px;font-size:15px">Track this shipment</a>' +
      '<p style="color:#9aa6b4;font-size:13px;line-height:1.55;margin:24px 0 0">' +
      "You're receiving this because you placed this order with Granite Logistics.</p></div>",
  };
}

// Confirm an address at signup. Deliberately not framed as a gate: the account already
// works, and this is how we know we can reach them when a parcel moves.
export function verifyEmail(name, link) {
  const who = name ? name.split(" ")[0] : "there";
  return {
    subject: "Confirm your email for Granite Logistics",
    text: "Hi " + who + ",\n\nConfirm this address so we can send you delivery updates:\n" +
      link + "\n\nYour account already works. This just makes sure we can reach you about a shipment.\n\n" +
      "If you didn't sign up, you can ignore this email.\n\nGranite Logistics",
    html:
      '<div style="font-family:Segoe UI,system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;color:#101828">' +
      '<div style="font-weight:800;letter-spacing:.08em;color:#0f1b2c;font-size:15px;margin-bottom:22px">GRANITE LOGISTICS</div>' +
      '<h1 style="font-size:20px;margin:0 0 12px">Confirm your email</h1>' +
      '<p style="color:#697587;font-size:15px;line-height:1.55;margin:0 0 22px">Hi ' + who +
      ', your account is already set up. Confirming this address lets us tell you when a ' +
      'parcel is picked up, out for delivery and delivered.</p>' +
      '<a href="' + link + '" style="display:inline-block;background:#2f9bd6;color:#fff;text-decoration:none;' +
      'font-weight:700;padding:13px 22px;border-radius:10px;font-size:15px">Confirm my email</a>' +
      '<p style="color:#9aa6b4;font-size:13px;line-height:1.55;margin:24px 0 0">' +
      "If you didn't sign up for Granite Logistics, you can safely ignore this email.</p></div>",
  };
}

// Plain, on-brand reset email. Kept inline (no template engine) to stay dependency-free.
export function resetEmail(name, link) {
  const who = name ? name.split(" ")[0] : "there";
  return {
    subject: "Reset your Granite Logistics password",
    text: "Hi " + who + ",\n\nUse this link to set a new password (valid for 30 minutes):\n" +
      link + "\n\nIf you didn't ask for this, you can ignore this email.\n\nGranite Logistics",
    html:
      '<div style="font-family:Segoe UI,system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 24px;color:#101828">' +
      '<div style="font-weight:800;letter-spacing:.08em;color:#0f1b2c;font-size:15px;margin-bottom:22px">GRANITE LOGISTICS</div>' +
      '<h1 style="font-size:20px;margin:0 0 12px">Reset your password</h1>' +
      '<p style="color:#697587;font-size:15px;line-height:1.55;margin:0 0 22px">Hi ' + who +
      ', use the button below to set a new password. The link is valid for 30 minutes.</p>' +
      '<a href="' + link + '" style="display:inline-block;background:#2f9bd6;color:#fff;text-decoration:none;' +
      'font-weight:700;padding:13px 22px;border-radius:10px;font-size:15px">Set a new password</a>' +
      '<p style="color:#9aa6b4;font-size:13px;line-height:1.55;margin:24px 0 0">' +
      "If you didn't ask for this, you can safely ignore this email.</p></div>",
  };
}
