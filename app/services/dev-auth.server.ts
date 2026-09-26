import argon2 from "argon2";
import { redirect } from "react-router";

import db from "../db.server";
import {
  DEV_MFA_CHALLENGE_MS,
  DEV_SESSION_ABSOLUTE_MS,
  DEV_SESSION_IDLE_MS,
  DEV_STRONG_AUTH_MS,
  clearMfaCookie,
  clearSessionCookie,
  decryptTotpSecret,
  devCsrfToken,
  hashOpaqueToken,
  hashRequestIp,
  mfaCookie,
  randomOpaqueToken,
  readDevMfaToken,
  readDevSessionToken,
  sessionCookie,
  verifyTotp,
} from "./dev-security.server";
import {
  hasDevPermission,
  isDevRole,
  type DevPermission,
  type DevRole,
} from "./dev-permissions.server";

type DevUserRow = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  isActive: boolean | number;
  totpSecretEncrypted: string | null;
  lastLoginAt: Date | null;
};

type DevSessionRow = {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  lastStrongAuthAt: Date;
  revokedAt: Date | null;
  email: string;
  role: string;
  isActive: boolean | number;
};

export type AuthenticatedDevUser = {
  id: string;
  email: string;
  role: DevRole;
  sessionId: string;
  csrfToken: string;
  lastStrongAuthAt: Date;
};

export function normalizeDevEmail(email: string) {
  return email.trim().toLocaleLowerCase("en-US");
}

export async function hashDevPassword(password: string) {
  if (password.length < 12 || password.length > 256) {
    throw new Error("Dev password must contain between 12 and 256 characters");
  }
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyDevPassword(hash: string, password: string) {
  try {
    return await argon2.verify(hash, password, { type: argon2.argon2id });
  } catch {
    return false;
  }
}

export async function findDevUserByEmail(email: string) {
  const rows = await db.$queryRaw<DevUserRow[]>`
    SELECT \`id\`, \`email\`, \`passwordHash\`, \`role\`, \`isActive\`,
      \`totpSecretEncrypted\`, \`lastLoginAt\`
    FROM \`DevUser\` WHERE \`email\` = ${normalizeDevEmail(email)} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createDevMfaChallenge(userId: string, request: Request) {
  const token = randomOpaqueToken();
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + DEV_MFA_CHALLENGE_MS);
  await db.$executeRaw`
    DELETE FROM \`DevLoginChallenge\` WHERE \`userId\` = ${userId} OR \`expiresAt\` <= UTC_TIMESTAMP(3)
  `;
  await db.$executeRaw`
    INSERT INTO \`DevLoginChallenge\` (
      \`id\`, \`tokenHash\`, \`userId\`, \`createdAt\`, \`expiresAt\`, \`attempts\`, \`ipHash\`
    ) VALUES (
      ${id}, ${hashOpaqueToken(token)}, ${userId}, UTC_TIMESTAMP(3), ${expiresAt}, 0, ${hashRequestIp(request)}
    )
  `;
  return { token, header: mfaCookie(token) };
}

export async function getDevMfaChallenge(request: Request) {
  const token = readDevMfaToken(request);
  if (!token) return null;
  const rows = await db.$queryRaw<Array<{
    id: string;
    userId: string;
    attempts: number;
    expiresAt: Date;
    email: string;
    role: string;
    isActive: boolean | number;
    totpSecretEncrypted: string | null;
  }>>`
    SELECT c.\`id\`, c.\`userId\`, c.\`attempts\`, c.\`expiresAt\`, u.\`email\`,
      u.\`role\`, u.\`isActive\`, u.\`totpSecretEncrypted\`
    FROM \`DevLoginChallenge\` c
    JOIN \`DevUser\` u ON u.\`id\` = c.\`userId\`
    WHERE c.\`tokenHash\` = ${hashOpaqueToken(token)} LIMIT 1
  `;
  const challenge = rows[0];
  if (!challenge || challenge.expiresAt.getTime() <= Date.now() || !Boolean(challenge.isActive)) return null;
  return challenge;
}

export async function failDevMfaChallenge(id: string) {
  await db.$executeRaw`
    UPDATE \`DevLoginChallenge\` SET \`attempts\` = \`attempts\` + 1 WHERE \`id\` = ${id}
  `;
}

export function verifyDevUserTotp(encrypted: string | null, code: string) {
  if (!encrypted) return false;
  return verifyTotp(decryptTotpSecret(encrypted), code);
}

export async function createDevSession(userId: string, request: Request) {
  const token = randomOpaqueToken();
  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + DEV_SESSION_ABSOLUTE_MS);
  const expiresAt = new Date(Math.min(now.getTime() + DEV_SESSION_IDLE_MS, absoluteExpiresAt.getTime()));
  await db.$executeRaw`
    DELETE FROM \`DevLoginChallenge\` WHERE \`userId\` = ${userId}
  `;
  await db.$executeRaw`
    INSERT INTO \`DevSession\` (
      \`id\`, \`tokenHash\`, \`userId\`, \`createdAt\`, \`lastSeenAt\`, \`expiresAt\`,
      \`absoluteExpiresAt\`, \`lastStrongAuthAt\`, \`revokedAt\`, \`ipHash\`, \`userAgent\`
    ) VALUES (
      ${crypto.randomUUID()}, ${hashOpaqueToken(token)}, ${userId}, ${now}, ${now}, ${expiresAt},
      ${absoluteExpiresAt}, ${now}, NULL, ${hashRequestIp(request)},
      ${request.headers.get("user-agent")?.slice(0, 512) ?? null}
    )
  `;
  await db.$executeRaw`UPDATE \`DevUser\` SET \`lastLoginAt\` = ${now} WHERE \`id\` = ${userId}`;
  return {
    token,
    headers: [sessionCookie(token), clearMfaCookie()],
  };
}

export async function getDevSession(request: Request): Promise<AuthenticatedDevUser | null> {
  const token = readDevSessionToken(request);
  if (!token) return null;
  const rows = await db.$queryRaw<DevSessionRow[]>`
    SELECT s.\`id\`, s.\`userId\`, s.\`createdAt\`, s.\`lastSeenAt\`, s.\`expiresAt\`,
      s.\`absoluteExpiresAt\`, s.\`lastStrongAuthAt\`, s.\`revokedAt\`,
      u.\`email\`, u.\`role\`, u.\`isActive\`
    FROM \`DevSession\` s JOIN \`DevUser\` u ON u.\`id\` = s.\`userId\`
    WHERE s.\`tokenHash\` = ${hashOpaqueToken(token)} LIMIT 1
  `;
  const session = rows[0];
  const expired = !session || session.expiresAt.getTime() <= Date.now() || session.absoluteExpiresAt.getTime() <= Date.now();
  if (!session || session.revokedAt || expired || !Boolean(session.isActive) || !isDevRole(session.role)) {
    if (session && !session.revokedAt) {
      await db.$executeRaw`UPDATE \`DevSession\` SET \`revokedAt\` = UTC_TIMESTAMP(3) WHERE \`id\` = ${session.id}`;
    }
    return null;
  }
  const nextExpiry = new Date(Math.min(Date.now() + DEV_SESSION_IDLE_MS, session.absoluteExpiresAt.getTime()));
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await db.$executeRaw`
      UPDATE \`DevSession\` SET \`lastSeenAt\` = UTC_TIMESTAMP(3), \`expiresAt\` = ${nextExpiry}
      WHERE \`id\` = ${session.id} AND \`revokedAt\` IS NULL
    `;
  }
  return {
    id: session.userId,
    email: session.email,
    role: session.role,
    sessionId: session.id,
    csrfToken: devCsrfToken(token),
    lastStrongAuthAt: session.lastStrongAuthAt,
  };
}

export async function requireDevUser(request: Request) {
  const user = await getDevSession(request);
  if (!user) throw redirect("/dev/login", { headers: { "Set-Cookie": clearSessionCookie() } });
  return user;
}

export async function requireDevPermission(request: Request, permission: DevPermission) {
  const user = await requireDevUser(request);
  if (!hasDevPermission(user.role, permission)) throw new Response("Forbidden", { status: 403 });
  return user;
}

export async function requireRecentDevAuthentication(request: Request) {
  const user = await requireDevUser(request);
  if (Date.now() - user.lastStrongAuthAt.getTime() > DEV_STRONG_AUTH_MS) {
    throw new Response("Recent authentication required", { status: 403 });
  }
  return user;
}

export async function destroyDevSession(request: Request) {
  const token = readDevSessionToken(request);
  if (token) {
    await db.$executeRaw`
      UPDATE \`DevSession\` SET \`revokedAt\` = UTC_TIMESTAMP(3)
      WHERE \`tokenHash\` = ${hashOpaqueToken(token)} AND \`revokedAt\` IS NULL
    `;
  }
  return clearSessionCookie();
}

export async function revokeDevUserSessions(userId: string) {
  return db.$executeRaw`
    UPDATE \`DevSession\` SET \`revokedAt\` = UTC_TIMESTAMP(3)
    WHERE \`userId\` = ${userId} AND \`revokedAt\` IS NULL
  `;
}
