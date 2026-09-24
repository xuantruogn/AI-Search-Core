import { randomUUID } from "node:crypto";

import db from "../../db.server";
import type { PlanLimits } from "./plans.server";

export const QUOTA_GRANT_KIND = {
  search: "SEARCH",
  product: "PRODUCT",
  vectorUpdate: "VECTOR_UPDATE",
} as const;

export type QuotaGrantKind =
  (typeof QUOTA_GRANT_KIND)[keyof typeof QUOTA_GRANT_KIND];

export type QuotaGrantTotals = {
  search: number;
  product: number;
  vectorUpdate: number;
};

type GrantAggregateRow = {
  kind: string;
  total: number | bigint | string | null;
  nearestExpiry: Date | string | null;
};

const CACHE_MAX_MS = 5_000;
const cacheGlobal = globalThis as typeof globalThis & {
  aiSearchQuotaGrantCache?: Map<
    string,
    { until: number; value: QuotaGrantTotals }
  >;
};
const grantCache =
  cacheGlobal.aiSearchQuotaGrantCache ??
  (cacheGlobal.aiSearchQuotaGrantCache = new Map());

function boundedPositiveInteger(value: number) {
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer) || integer <= 0) {
    throw new Error("Grant amount must be a positive integer");
  }
  return Math.min(integer, 1_000_000_000);
}

async function reconcileProductPolicyAfterQuotaChange(shop: string) {
  // Dynamic import avoids a static quota-grants -> reconciliation ->
  // entitlement -> quota-grants cycle while keeping the invariant at the
  // mutation boundary: whenever product capacity changes, eligibility is
  // reconciled before the mutation is considered complete.
  const { reconcileShopCommercialState } = await import("./reconciliation.server");
  await reconcileShopCommercialState({ shop });
}

function emptyTotals(): QuotaGrantTotals {
  return { search: 0, product: 0, vectorUpdate: 0 };
}

function invalidate(shop: string) {
  grantCache.delete(shop);
}

export async function getActiveQuotaGrantTotals(
  shop: string,
  now = new Date(),
): Promise<QuotaGrantTotals> {
  const cached = grantCache.get(shop);
  if (cached && cached.until > Date.now()) return cached.value;

  const rows = await db.$queryRaw<GrantAggregateRow[]>`
    SELECT
      \`kind\`,
      COALESCE(SUM(\`amount\`), 0) AS \`total\`,
      MIN(\`expiresAt\`) AS \`nearestExpiry\`
    FROM \`AiSearchQuotaGrant\`
    WHERE
      \`shop\` = ${shop}
      AND \`revokedAt\` IS NULL
      AND \`startsAt\` <= ${now}
      AND (\`expiresAt\` IS NULL OR \`expiresAt\` > ${now})
    GROUP BY \`kind\`
  `;

  const totals = emptyTotals();
  let cacheUntil = Date.now() + CACHE_MAX_MS;

  for (const row of rows) {
    const total = Math.max(0, Number(row.total ?? 0));
    if (row.kind === QUOTA_GRANT_KIND.search) totals.search = total;
    if (row.kind === QUOTA_GRANT_KIND.product) totals.product = total;
    if (row.kind === QUOTA_GRANT_KIND.vectorUpdate) totals.vectorUpdate = total;

    if (row.nearestExpiry) {
      const expiry = new Date(row.nearestExpiry).getTime();
      if (Number.isFinite(expiry)) cacheUntil = Math.min(cacheUntil, expiry);
    }
  }

  grantCache.set(shop, { until: Math.max(Date.now() + 250, cacheUntil), value: totals });
  return totals;
}

function addGrant(limit: number | null, grant: number) {
  if (limit === null) return null;
  return Math.min(1_000_000_000, Math.max(0, limit) + Math.max(0, grant));
}

export async function applyActiveQuotaGrants(
  shop: string,
  base: PlanLimits,
): Promise<PlanLimits> {
  // Unlimited plans stay unlimited; grants are still retained for audit/history.
  if (
    base.productLimit === null &&
    base.searchLimit === null &&
    base.vectorUpdateLimit === null
  ) {
    return base;
  }

  const grants = await getActiveQuotaGrantTotals(shop);
  return {
    productLimit: addGrant(base.productLimit, grants.product),
    searchLimit: addGrant(base.searchLimit, grants.search),
    vectorUpdateLimit: addGrant(base.vectorUpdateLimit, grants.vectorUpdate),
  };
}

async function audit(
  tx: {
    aiSearchAdminAuditLog: {
      create: (args: unknown) => Promise<unknown>;
    };
  },
  input: {
    actorShop: string;
    targetShop: string;
    action: string;
    reason?: string | null;
    before?: unknown;
    after?: unknown;
  },
) {
  await tx.aiSearchAdminAuditLog.create({
    data: {
      id: randomUUID(),
      actorShop: input.actorShop,
      targetShop: input.targetShop,
      action: input.action,
      reason: input.reason?.trim() || null,
      beforeJson:
        input.before === undefined ? null : JSON.stringify(input.before),
      afterJson:
        input.after === undefined ? null : JSON.stringify(input.after),
    },
  } as never);
}

export async function createQuotaGrant({
  actorShop,
  targetShop,
  kind,
  amount,
  reason,
  expiresAt,
}: {
  actorShop: string;
  targetShop: string;
  kind: QuotaGrantKind;
  amount: number;
  reason: string;
  expiresAt: Date | null;
}) {
  const safeAmount = boundedPositiveInteger(amount);
  const cleanReason = reason.trim();
  if (cleanReason.length < 3) {
    throw new Error("Reason is required for quota changes");
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new Error("Grant expiry must be in the future");
  }

  const id = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.aiSearchQuotaGrant.create({
      data: {
        id,
        shop: targetShop,
        kind,
        amount: safeAmount,
        reason: cleanReason,
        expiresAt,
        createdBy: actorShop,
      },
    });

    await audit(tx as never, {
      actorShop,
      targetShop,
      action: "QUOTA_GRANT_CREATED",
      reason: cleanReason,
      after: { id, kind, amount: safeAmount, expiresAt },
    });
  });
  invalidate(targetShop);
  if (kind === QUOTA_GRANT_KIND.product) {
    await reconcileProductPolicyAfterQuotaChange(targetShop);
  }
  return id;
}

export async function revokeQuotaGrant({
  actorShop,
  grantId,
  reason,
}: {
  actorShop: string;
  grantId: string;
  reason: string;
}) {
  const cleanReason = reason.trim();
  if (cleanReason.length < 3) {
    throw new Error("Reason is required to revoke a grant");
  }

  const grant = await db.aiSearchQuotaGrant.findUnique({
    where: { id: grantId },
  });
  if (!grant) throw new Error("Grant not found");
  if (grant.revokedAt) {
    return { shop: grant.shop, kind: grant.kind as QuotaGrantKind, alreadyRevoked: true };
  }

  await db.$transaction(async (tx) => {
    await tx.aiSearchQuotaGrant.update({
      where: { id: grantId },
      data: { revokedAt: new Date() },
    });
    await audit(tx as never, {
      actorShop,
      targetShop: grant.shop,
      action: "QUOTA_GRANT_REVOKED",
      reason: cleanReason,
      before: {
        id: grant.id,
        kind: grant.kind,
        amount: grant.amount,
        expiresAt: grant.expiresAt,
      },
      after: { revoked: true },
    });
  });
  invalidate(grant.shop);
  if (grant.kind === QUOTA_GRANT_KIND.product) {
    await reconcileProductPolicyAfterQuotaChange(grant.shop);
  }
  return { shop: grant.shop, kind: grant.kind as QuotaGrantKind, alreadyRevoked: false };
}

function normalizeAbsoluteOverride(value: number | null) {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Absolute limits must be blank or >= 0");
  }
  return Math.min(1_000_000_000, Math.trunc(value));
}

export async function setAbsoluteQuotaOverridesWithAudit({
  actorShop,
  targetShop,
  productLimitOverride,
  searchLimitOverride,
  vectorUpdateLimitOverride,
  reason,
}: {
  actorShop: string;
  targetShop: string;
  productLimitOverride: number | null;
  searchLimitOverride: number | null;
  vectorUpdateLimitOverride: number | null;
  reason: string;
}) {
  const cleanReason = reason.trim();
  if (cleanReason.length < 3) {
    throw new Error("Reason is required for quota changes");
  }

  const before = await db.aiSearchShopSettings.findUnique({
    where: { shop: targetShop },
    select: {
      productLimitOverride: true,
      searchLimitOverride: true,
      vectorUpdateLimitOverride: true,
    },
  });
  if (!before) throw new Error("Target shop settings not found");

  const after = {
    productLimitOverride: normalizeAbsoluteOverride(productLimitOverride),
    searchLimitOverride: normalizeAbsoluteOverride(searchLimitOverride),
    vectorUpdateLimitOverride: normalizeAbsoluteOverride(vectorUpdateLimitOverride),
  };

  await db.$transaction(async (tx) => {
    await tx.aiSearchShopSettings.update({
      where: { shop: targetShop },
      data: after,
    });
    await audit(tx as never, {
      actorShop,
      targetShop,
      action: "ABSOLUTE_QUOTA_OVERRIDE_CHANGED",
      reason: cleanReason,
      before,
      after,
    });
  });
  invalidate(targetShop);
  if (before.productLimitOverride !== after.productLimitOverride) {
    await reconcileProductPolicyAfterQuotaChange(targetShop);
  }
}

export async function setShopAiEnabledWithAudit({
  actorShop,
  targetShop,
  enabled,
  reason,
}: {
  actorShop: string;
  targetShop: string;
  enabled: boolean;
  reason: string;
}) {
  const cleanReason = reason.trim();
  if (cleanReason.length < 3) {
    throw new Error("Reason is required");
  }
  const before = await db.aiSearchShopSettings.findUnique({
    where: { shop: targetShop },
    select: { aiSearchEnabled: true },
  });
  if (!before) throw new Error("Target shop settings not found");

  await db.$transaction(async (tx) => {
    await tx.aiSearchShopSettings.update({
      where: { shop: targetShop },
      data: { aiSearchEnabled: enabled },
    });
    await audit(tx as never, {
      actorShop,
      targetShop,
      action: enabled ? "AI_SEARCH_ENABLED_BY_ADMIN" : "AI_SEARCH_DISABLED_BY_ADMIN",
      reason: cleanReason,
      before,
      after: { aiSearchEnabled: enabled },
    });
  });
}
