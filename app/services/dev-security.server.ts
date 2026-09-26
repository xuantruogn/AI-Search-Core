import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import db from "../db.server";

export const DEV_SESSION_IDLE_MS = 30 * 60_000;
export const DEV_SESSION_ABSOLUTE_MS = 8 * 60 * 60_000;
export const DEV_STRONG_AUTH_MS = 10 * 60_000;
export const DEV_MFA_CHALLENGE_MS = 5 * 60_000;

const SESSION_COOKIE = process.env.NODE_ENV === "production"
  ? "__Host-ai_buyense_dev"
  : "ai_buyense_dev";
const MFA_COOKIE = process.env.NODE_ENV === "production"
  ? "__Host-ai_buyense_dev_mfa"
  : "ai_buyense_dev_mfa";
const LOGIN_CSRF_COOKIE = process.env.NODE_ENV === "production"
  ? "__Host-ai_buyense_dev_login_csrf"
  : "ai_buyense_dev_login_csrf";

function requiredSecret(name: "DEV_SESSION_SECRET" | "DEV_TOTP_ENCRYPTION_KEY") {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) {
    throw new Error(`${name} must be configured with at least 32 characters`);
  }
  return value;
}

export function devRequestId(request: Request) {
  const incoming = request.headers.get("x-request-id")?.trim();
  return incoming && /^[A-Za-z0-9._:-]{8,64}$/.test(incoming)
    ? incoming
    : randomUUID();
}

function parseCookies(request: Request) {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return result;
}

function cookie(name: string, value: string, maxAge: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.trunc(maxAge))}${secure}`;
}

export function readDevSessionToken(request: Request) {
  return parseCookies(request).get(SESSION_COOKIE) ?? null;
}

export function readDevMfaToken(request: Request) {
  return parseCookies(request).get(MFA_COOKIE) ?? null;
}

export function sessionCookie(token: string) {
  return cookie(SESSION_COOKIE, token, DEV_SESSION_ABSOLUTE_MS / 1000);
}

export function clearSessionCookie() {
  return cookie(SESSION_COOKIE, "", 0);
}

export function mfaCookie(token: string) {
  return cookie(MFA_COOKIE, token, DEV_MFA_CHALLENGE_MS / 1000);
}

export function clearMfaCookie() {
  return cookie(MFA_COOKIE, "", 0);
}

export function hashOpaqueToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function randomOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function requestIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0] ??
    "unknown"
  ).trim().slice(0, 128);
}

export function hashRequestIp(request: Request) {
  return createHmac("sha256", requiredSecret("DEV_SESSION_SECRET"))
    .update(requestIp(request))
    .digest("hex");
}

export function devCsrfToken(sessionToken: string) {
  return createHmac("sha256", requiredSecret("DEV_SESSION_SECRET"))
    .update(`csrf:${sessionToken}`)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertDevCsrf(sessionToken: string, supplied: FormDataEntryValue | null) {
  if (typeof supplied !== "string" || !safeEqual(devCsrfToken(sessionToken), supplied)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

function allowedOrigins(request: Request) {
  const configured = (process.env.DEV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV === "production") {
    return new Set(configured.length ? configured : [
      "https://app.aibuyense.com",
      "https://dev.aibuyense.com",
    ]);
  }
  const current = new URL(request.url);
  const local = ["localhost", "127.0.0.1", "::1"].includes(current.hostname)
    ? [current.origin]
    : [];
  return new Set([...configured, ...local]);
}

export function assertDevOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(request).has(origin)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

export function createLoginCsrf(request: Request) {
  const nonce = randomOpaqueToken();
  const signature = createHmac("sha256", requiredSecret("DEV_SESSION_SECRET"))
    .update(`login-csrf:${nonce}`)
    .digest("base64url");
  return {
    token: nonce,
    header: cookie(LOGIN_CSRF_COOKIE, `${nonce}.${signature}`, 10 * 60),
  };
}

export function assertLoginCsrf(request: Request, supplied: FormDataEntryValue | null) {
  const stored = parseCookies(request).get(LOGIN_CSRF_COOKIE) ?? "";
  const split = stored.lastIndexOf(".");
  if (split < 1 || typeof supplied !== "string") throw new Response("Forbidden", { status: 403 });
  const nonce = stored.slice(0, split);
  const signature = stored.slice(split + 1);
  const expected = createHmac("sha256", requiredSecret("DEV_SESSION_SECRET"))
    .update(`login-csrf:${nonce}`)
    .digest("base64url");
  if (!safeEqual(nonce, supplied) || !safeEqual(signature, expected)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

export function clearLoginCsrfCookie() {
  return cookie(LOGIN_CSRF_COOKIE, "", 0);
}

export function encryptTotpSecret(secret: string) {
  const key = createHash("sha256").update(requiredSecret("DEV_TOTP_ENCRYPTION_KEY")).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptTotpSecret(value: string) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted TOTP secret");
  const key = createHash("sha256").update(requiredSecret("DEV_TOTP_ENCRYPTION_KEY")).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function decodeBase32(value: string) {
  const cleaned = value.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of cleaned) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Invalid TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpAt(secret: string, counter: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return number.toString().padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(now / 30_000);
  return [-1, 0, 1].some((offset) => safeEqual(totpAt(secret, counter + offset), code));
}

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForLog(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = /password|authorization|access[_-]?token|api[_-]?key|secret|session|cookie|database_url|csrf/i.test(key)
      ? "[REDACTED]"
      : sanitizeForLog(item, depth + 1);
  }
  return output;
}

export function devSecurityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    ...(process.env.NODE_ENV === "production"
      ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
      : {}),
  };
}

export async function assertThrottleAllowed(kind: "LOGIN_IP" | "LOGIN_ACCOUNT" | "MFA", key: string) {
  const bucketKey = createHash("sha256").update(`${kind}:${key}`).digest("hex");
  const rows = await db.$queryRaw<Array<{ blockedUntil: Date | null }>>`
    SELECT \`blockedUntil\` FROM \`DevAuthThrottle\` WHERE \`bucketKey\` = ${bucketKey} LIMIT 1
  `;
  if (rows[0]?.blockedUntil && rows[0].blockedUntil.getTime() > Date.now()) {
    throw new Response("Too many attempts", { status: 429 });
  }
}

export async function recordThrottleFailure(kind: "LOGIN_IP" | "LOGIN_ACCOUNT" | "MFA", key: string) {
  const bucketKey = createHash("sha256").update(`${kind}:${key}`).digest("hex");
  const limit = kind === "LOGIN_IP" ? 5 : kind === "LOGIN_ACCOUNT" ? 10 : 6;
  const windowMs = kind === "LOGIN_ACCOUNT" ? 15 * 60_000 : 60_000;
  const blockedMs = kind === "LOGIN_ACCOUNT" ? 15 * 60_000 : 5 * 60_000;
  const now = new Date();
  const windowStart = new Date(Date.now() - windowMs);
  await db.$executeRaw`
    INSERT INTO \`DevAuthThrottle\` (\`bucketKey\`, \`kind\`, \`attemptCount\`, \`windowStart\`, \`blockedUntil\`, \`updatedAt\`)
    VALUES (${bucketKey}, ${kind}, 1, ${now}, NULL, ${now})
    ON DUPLICATE KEY UPDATE
      \`attemptCount\` = IF(\`windowStart\` < ${windowStart}, 1, \`attemptCount\` + 1),
      \`windowStart\` = IF(\`windowStart\` < ${windowStart}, ${now}, \`windowStart\`),
      \`blockedUntil\` = IF(IF(\`windowStart\` < ${windowStart}, 1, \`attemptCount\` + 1) >= ${limit}, ${new Date(Date.now() + blockedMs)}, \`blockedUntil\`),
      \`updatedAt\` = ${now}
  `;
}

export async function clearThrottle(kind: "LOGIN_IP" | "LOGIN_ACCOUNT" | "MFA", key: string) {
  const bucketKey = createHash("sha256").update(`${kind}:${key}`).digest("hex");
  await db.$executeRaw`DELETE FROM \`DevAuthThrottle\` WHERE \`bucketKey\` = ${bucketKey}`;
}
