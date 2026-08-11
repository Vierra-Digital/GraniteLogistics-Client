// Generate a VAPID keypair for Web Push:  npm run vapid
//
// Run this yourself and paste the values straight into Netlify. The private key is a
// secret that signs every push this server sends, so it should not travel through chat,
// a ticket, or a commit. It is printed here and nowhere else; nothing writes it to disk.
import webpushDefault from "web-push";

const webpush = webpushDefault && webpushDefault.generateVAPIDKeys
  ? webpushDefault
  : (webpushDefault.default || webpushDefault);

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`
VAPID keypair generated. Set both in Netlify:
  Site configuration > Environment variables

  GL_VAPID_PUBLIC   ${publicKey}
  GL_VAPID_PRIVATE  ${privateKey}

GL_VAPID_PUBLIC is handed to browsers when they subscribe, so it is not a secret.
GL_VAPID_PRIVATE is. Keep it out of the repo and out of any message thread.

GL_MAIL_FROM is reused as the VAPID contact address, so set that too if it isn't already.

Rotating these keys invalidates every existing subscription: each device has to opt in
again, and the old ones are pruned automatically the first time a send is refused.
`);
