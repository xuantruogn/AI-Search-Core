import db from "../../db.server";
import { getIndexedProductStats } from "./indexed-products.server";
import { PLAN_DEFINITIONS } from "./plans.server";
import {
  ensureShopRecord,
  getShopLifecycleStatus,
  getShopSettings,
  getSubscriptionSnapshot,
} from "./shop-registry.server";
import type { EntitlementSnapshot } from "./types.server";
import { ensureUsagePeriod } from "./usage.server";

function applyOverride(base: number | null, override: number | null) {
  if (override === null || override < 0) {
    return base;
  }

  return override;
}

export async function getShopEntitlement(
  shop: string,
): Promise<EntitlementSnapshot> {
  // Bootstrap at most once per entitlement read, then keep the hot storefront
  // path read-only. Older code called ensureShopRecord independently from
  // three getters, creating avoidable database write contention.
  await ensureShopRecord({ shop });

  const [subscription, shopLifecycleStatus, settings, productStats] =
    await Promise.all([
      getSubscriptionSnapshot(shop, { ensure: false }),
      getShopLifecycleStatus(shop, { ensure: false }),
      getShopSettings(shop, { ensure: false }),
      getIndexedProductStats(shop),
    ]);

  const {
    indexedProducts,
    productSlotsUsed,
    vectorQuotaBlockedProducts,
    productLimitBlockedProducts,
    subscriptionBlockedProducts,
  } = productStats;

  const usage = await ensureUsagePeriod({
    shop,
    subscription,
  });

  const catalogRows = await db.$queryRaw<Array<{ status: string }>>`
    SELECT \`status\`
    FROM \`AiSearchCatalogSyncJob\`
    WHERE \`shop\` = ${shop}
    ORDER BY \`id\` DESC
    LIMIT 1
  `;
  const catalogSyncStatus = catalogRows[0]?.status ?? null;

  const definition = PLAN_DEFINITIONS[subscription.plan];

  const limits = {
    productLimit: applyOverride(
      definition.limits.productLimit,
      settings.productLimitOverride,
    ),
    searchLimit: applyOverride(
      definition.limits.searchLimit,
      settings.searchLimitOverride,
    ),
    vectorUpdateLimit: applyOverride(
      definition.limits.vectorUpdateLimit,
      settings.vectorUpdateLimitOverride,
    ),
  };

  const subscriptionActive =
    shopLifecycleStatus === "ACTIVE" && subscription.status === "ACTIVE";
  const productSlotAvailable =
    limits.productLimit === null || productSlotsUsed < limits.productLimit;
  const productLimitExceeded =
    limits.productLimit !== null && indexedProducts > limits.productLimit;
  const searchQuotaAvailable =
    limits.searchLimit === null || usage.searchCount < limits.searchLimit;
  const vectorQuotaAvailable =
    limits.vectorUpdateLimit === null ||
    usage.vectorUpdateCount < limits.vectorUpdateLimit;

  let disabledReason: string | null = null;

  if (!subscriptionActive) {
    disabledReason = "SUBSCRIPTION_INACTIVE";
  } else if (!settings.aiSearchEnabled) {
    disabledReason = "AI_SEARCH_DISABLED_BY_MERCHANT";
  } else if (productLimitExceeded) {
    disabledReason = "PRODUCT_LIMIT_RECONCILIATION_REQUIRED";
  } else if (
    catalogSyncStatus === "PENDING" ||
    catalogSyncStatus === "PROCESSING"
  ) {
    disabledReason = "INITIAL_SYNC_IN_PROGRESS";
  } else if (catalogSyncStatus === "FAILED" && indexedProducts === 0) {
    disabledReason = "INITIAL_SYNC_FAILED";
  } else if (subscriptionBlockedProducts > 0) {
    disabledReason = "CATALOG_STALE_SUBSCRIPTION";
  } else if (vectorQuotaBlockedProducts > 0) {
    disabledReason = "CATALOG_STALE_QUOTA";
  } else if (!vectorQuotaAvailable) {
    disabledReason = "VECTOR_UPDATE_QUOTA_EXCEEDED";
  } else if (!searchQuotaAvailable) {
    disabledReason = "SEARCH_QUOTA_EXCEEDED";
  }

  const active = subscriptionActive && settings.aiSearchEnabled;

  return {
    shop,
    plan: subscription.plan,
    planLabel: definition.label,
    subscriptionStatus: subscription.status,
    active,
    aiSearchEnabled: settings.aiSearchEnabled,
    fallbackEnabled: settings.fallbackEnabled,
    limits,
    usage,
    indexedProducts,
    productSlotsUsed,
    vectorQuotaBlockedProducts,
    productLimitBlockedProducts,
    subscriptionBlockedProducts,
    resultLimit: settings.resultLimit,
    searchAllowed: disabledReason === null,
    vectorUpdateAllowed: active && vectorQuotaAvailable,
    productSlotAvailable,
    productLimitExceeded,
    catalogSyncStatus,
    disabledReason,
  };
}

export function remaining(limit: number | null, used: number) {
  if (limit === null) {
    return null;
  }

  return Math.max(0, limit - used);
}
