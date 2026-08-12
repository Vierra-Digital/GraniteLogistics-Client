// Generate a VAPID keypair for Web Push:  npm run vapid
//
// The private key is written to vapid-keys.local.txt (gitignored) and never printed. The
// first version of this script printed both keys to stdout, which put a private key into a
// terminal buffer, a scrollback and — the time I ran it — a chat transcript. A file you can
// delete is a better home for it than anything's history.
//
// Only the public key is printed, because it is handed to browsers anyway.
import webpushDefault from "web-push";
import { writeFileSync, existsSync } from "node:fs";

const webpush = webpushDefault && webpushDefault.generateVAPIDKeys
  ? webpushDefault
  : (webpushDefault.default || webpushDefault);

const OUT = "vapid-keys.local.txt";

// Rotating keys invalidates every existing subscription, so overwriting an existing file
// by accident would be a bad way to find that out.
if (existsSync(OUT) && !process.argv.includes("--force")) {
  console.error(
`${OUT} already exists.

Rotating VAPID keys invalidates every existing push subscription: every device has to opt
in again. If that is what you want, run:  npm run vapid -- --force`);
  process.exit(1);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

writeFileSync(OUT, `# Granite Logistics VAPID keypair — generated ${new Date().toISOString()}
# Set both in Netlify: Site configuration > Environment variables.
# Delete this file once they are set. It is gitignored, but it is still a secret on disk.

GL_VAPID_PUBLIC=${publicKey}
GL_VAPID_PRIVATE=${privateKey}
`, { mode: 0o600 });

console.log(`
VAPID keypair written to ${OUT}  (gitignored, not printed here)

  GL_VAPID_PUBLIC   ${publicKey}
  GL_VAPID_PRIVATE  → see ${OUT}

Next:
  1. Copy both values into Netlify > Site configuration > Environment variables.
  2. Netlify bakes env values at build time, so trigger a deploy afterwards or the
     functions will not see them.
  3. Delete ${OUT}.
  4. Check it took effect:  curl -s https://usegl.com/api/health

GL_MAIL_FROM is reused as the VAPID contact address, so set that too if it is not already.
`);
