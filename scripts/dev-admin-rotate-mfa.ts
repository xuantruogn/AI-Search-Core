import { randomBytes } from "node:crypto";

import db from "../app/db.server";
import { normalizeDevEmail, revokeDevUserSessions } from "../app/services/dev-auth.server";
import { encryptTotpSecret } from "../app/services/dev-security.server";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Buffer) {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    out += BASE32[Number.parseInt(chunk, 2)];
  }
  return out;
}

const emailArg = process.argv.find((value) => value.startsWith("--email="));
const email = normalizeDevEmail(emailArg?.slice("--email=".length) ?? "");

if (!email || !email.includes("@")) {
  throw new Error("Usage: npm run dev-admin:rotate-mfa -- --email=you@example.com");
}

const user = await db.devUser.findUnique({ where: { email } });
if (!user) throw new Error("DevUser not found.");
if (!user.isActive) throw new Error("DevUser is inactive.");

const secret = base32(randomBytes(20));
await db.devUser.update({
  where: { id: user.id },
  data: { totpSecretEncrypted: encryptTotpSecret(secret) },
});
await revokeDevUserSessions(user.id);

const issuer = encodeURIComponent("AI-Buyense Dev Center");
const label = encodeURIComponent(`AI-Buyense Dev Center:${email}`);
const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

console.log(`Rotated MFA for ${email} and revoked existing Dev sessions.`);
console.log("Add this NEW TOTP URI to your authenticator. It is shown only now:");
console.log(uri);

await db.$disconnect();
