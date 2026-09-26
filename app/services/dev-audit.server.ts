import db from "../db.server";
import {
  devRequestId,
  hashRequestIp,
  sanitizeForLog,
} from "./dev-security.server";

export type DevAuditInput = {
  request: Request;
  devUserId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  result: "SUCCESS" | "DENIED" | "FAILED";
  metadata?: Record<string, unknown> | null;
  requestId?: string;
};

export async function writeDevAudit(input: DevAuditInput) {
  const id = crypto.randomUUID();
  const requestId = input.requestId ?? devRequestId(input.request);
  const userAgent = input.request.headers.get("user-agent")?.slice(0, 512) ?? null;
  const metadata = input.metadata
    ? JSON.stringify(sanitizeForLog(input.metadata))
    : null;

  await db.$executeRaw`
    INSERT INTO \`DevAuditLog\` (
      \`id\`, \`devUserId\`, \`action\`, \`resourceType\`, \`resourceId\`,
      \`result\`, \`requestId\`, \`ipHash\`, \`userAgent\`, \`metadata\`, \`createdAt\`
    ) VALUES (
      ${id}, ${input.devUserId ?? null}, ${input.action}, ${input.resourceType ?? null},
      ${input.resourceId ?? null}, ${input.result}, ${requestId}, ${hashRequestIp(input.request)},
      ${userAgent}, ${metadata}, UTC_TIMESTAMP(3)
    )
  `;
}

export async function listDevAuditLogs(limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  return db.$queryRaw<Array<{
    id: string;
    devUserId: string | null;
    email: string | null;
    action: string;
    resourceType: string | null;
    resourceId: string | null;
    result: string;
    requestId: string | null;
    metadata: string | null;
    createdAt: Date;
  }>>`
    SELECT l.\`id\`, l.\`devUserId\`, u.\`email\`, l.\`action\`, l.\`resourceType\`,
      l.\`resourceId\`, l.\`result\`, l.\`requestId\`, l.\`metadata\`, l.\`createdAt\`
    FROM \`DevAuditLog\` l
    LEFT JOIN \`DevUser\` u ON u.\`id\` = l.\`devUserId\`
    ORDER BY l.\`createdAt\` DESC
    LIMIT ${safeLimit}
  `;
}
