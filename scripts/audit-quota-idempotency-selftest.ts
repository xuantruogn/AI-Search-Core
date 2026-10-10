import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { createQuotaGrant } from "../app/services/commerce/quota-grants.server";

if (!process.env.DATABASE_URL?.includes("/ai_search_ci")) {
  throw new Error("Refusing quota integration test outside the dedicated ai_search_ci database");
}
const shop = `audit-grant-${randomUUID()}.myshopify.com`;
const requestId = randomUUID();
await db.aiSearchShop.create({ data: { shop } });
try {
  const input = {
    actorShop: "dev:ci-test",
    targetShop: shop,
    kind: "SEARCH" as const,
    amount: 31,
    reason: "CI idempotency",
    expiresAt: null,
    requestId,
  };
  const [first, replay] = await Promise.all([
    createQuotaGrant(input),
    createQuotaGrant(input),
  ]);
  assert.equal(first, replay);
  assert.equal(await db.aiSearchQuotaGrant.count({ where: { shop } }), 1);
  assert.equal(await db.aiSearchAdminAuditLog.count({ where: { targetShop: shop, action: "QUOTA_GRANT_CREATED" } }), 1);
  console.log("PASS quota idempotency: two concurrent matching submissions create one grant and one audit");
} finally {
  await db.aiSearchShop.delete({ where: { shop } });
  await db.$disconnect();
}
