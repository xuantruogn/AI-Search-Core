import { randomBytes } from "node:crypto";

import db from "../app/db.server";
import { hashDevPassword, normalizeDevEmail } from "../app/services/dev-auth.server";
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
const password = process.env.DEV_ADMIN_BOOTSTRAP_PASSWORD ?? "";

if (!email || !email.includes("@")) {
  throw new Error("Usage: npm run dev-admin:create -- --email=you@example.com");
}
if (password.length < 12) {
  throw new Error("Set DEV_ADMIN_BOOTSTRAP_PASSWORD to a password with at least 12 characters for this command.");
}

const existingOwner = await db.devUser.findFirst({ where: { role: "OWNER", isActive: true } });
if (existingOwner) {
  throw new Error("An active OWNER already exists. Refusing bootstrap creation.");
}

const existingEmail = await db.devUser.findUnique({ where: { email } });
if (existingEmail) {
  throw new Error("A DevUser with this email already exists.");
}

const secret = base32(randomBytes(20));
const user = await db.devUser.create({
  data: {
    email,
    passwordHash: await hashDevPassword(password),
    role: "OWNER",
    isActive: true,
    totpSecretEncrypted: encryptTotpSecret(secret),
  },
});

const issuer = encodeURIComponent("AI-Buyense Dev Center");
const label = encodeURIComponent(`AI-Buyense Dev Center:${email}`);
const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

console.log(`Created OWNER ${user.email}.`);
console.log("Add this TOTP URI to your authenticator now. It is shown only during bootstrap:");
console.log(uri);
console.log("Remove DEV_ADMIN_BOOTSTRAP_PASSWORD from your environment after bootstrap.");

await db.$disconnect();
