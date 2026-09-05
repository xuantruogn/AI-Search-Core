import { getShopEntitlement, remaining } from "../commerce/entitlement.server";
import {
  listProductLimitBlockedProducts,
  listSubscriptionBlockedProducts,
  listVectorQuotaBlockedProducts,
  type IndexedProductRow,
} from "../commerce/indexed-products.server";
import { enqueueProductSyncJob } from "./product-sync-job.server";
import { kickProductSyncQueue } from "./product-sync-queue.server";

function updatedToken(row: IndexedProductRow) {
  const value =
    row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
  return Number.isNaN(value.getTime())
    ? String(row.id)
    : value.getTime().toString(36);
}

async function queueRows(
  shop: string,
  periodKey: string,
  kind: string,
  rows: IndexedProductRow[],
) {
  let queued = 0;

  for (const product of rows) {
    const result = await enqueueProductSyncJob({
      shop,
      webhookId: `${kind}:${periodKey}:${shop}:${product.productId}:${updatedToken(product)}`,
      topic: "PRODUCTS_UPDATE",
      productId: product.productId,
    });
    if (result.created) queued += 1;
  }

  return queued;
}

export async function recoverBlockedProducts(shop: string) {
  const entitlement = await getShopEntitlement(shop);

  if (!entitlement.active) {
    return { queued: 0, reason: "SUBSCRIPTION_INACTIVE" } as const;
  }

  let queued = 0;
  let vectorBudget = remaining(
    entitlement.limits.vectorUpdateLimit,
    entitlement.usage.vectorUpdateCount,
  );
  let slotBudget =
    entitlement.limits.productLimit === null
      ? null
      : Math.max(
          0,
          entitlement.limits.productLimit - entitlement.productSlotsUsed,
        );

  // Subscription-blocked products may be either existing vectors or new
  // products. Queue a bounded batch and let indexProduct enforce the current
  // slot/vector rules atomically.
  if (entitlement.subscriptionBlockedProducts > 0) {
    const batch = await listSubscriptionBlockedProducts(shop, 50);
    queued += await queueRows(
      shop,
      entitlement.usage.periodKey,
      "subscription-recovery",
      batch,
    );
  }

  if (
    entitlement.vectorQuotaBlockedProducts > 0 &&
    (vectorBudget === null || vectorBudget > 0)
  ) {
    const max = Math.min(vectorBudget ?? 50, 50);
    const batch = await listVectorQuotaBlockedProducts(shop, max);
    queued += await queueRows(
      shop,
      entitlement.usage.periodKey,
      "vector-quota-recovery",
      batch,
    );
    if (vectorBudget !== null)
      vectorBudget = Math.max(0, vectorBudget - batch.length);
  }

  if (
    entitlement.productLimitBlockedProducts > 0 &&
    (slotBudget === null || slotBudget > 0)
  ) {
    const max = Math.min(slotBudget ?? 50, 50);
    const batch = await listProductLimitBlockedProducts(shop, max);
    queued += await queueRows(
      shop,
      entitlement.usage.periodKey,
      "product-limit-recovery",
      batch,
    );
    if (slotBudget !== null)
      slotBudget = Math.max(0, slotBudget - batch.length);
  }

  if (queued > 0) kickProductSyncQueue();

  return {
    queued,
    reason: queued > 0 ? "RECOVERY_QUEUED" : "NOT_NEEDED_OR_ALREADY_QUEUED",
  } as const;
}

// Backwards-compatible Phase-1/V2 name used by older route imports.
export const recoverQuotaBlockedProducts = recoverBlockedProducts;
