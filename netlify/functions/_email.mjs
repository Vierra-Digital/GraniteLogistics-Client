// Outbound email for Granite Logistics (password reset today, receipts later).
//
// Uses Resend, which needs two Netlify environment variables:
//   GL_RESEND_KEY  your Resend API key       (https://resend.com, free tier is fine)
//   GL_MAIL_FROM   a verified sender address e.g. "Granite Logistics <no-reply@usegl.com>"
//
// With no key configured this is a deliberate no-op that reports "not-configured"
// rather than throwing, so the rest of the app keeps working and the UI can tell
// the user that password reset isn't switched on yet.
export function emailConfigured() {
  return !!(process.env.GL_RESEND_KEY && process.env.GL_MAIL_FROM);
}

export async function sendEmail({ to, subject, html, text }) {
  if (!emailConfigured()) return { ok: false, reason: "not-configured" };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.GL_RESEND_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: process.env.GL_MAIL_FROM, to: [to], subject, html, text }),
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
