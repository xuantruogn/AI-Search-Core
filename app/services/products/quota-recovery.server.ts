import db from "../../db.server";
import { getShopEntitlement, remaining } from "../commerce/entitlement.server";
import { reconcileIndexedProductEligibility } from "../commerce/indexed-products.server";
import { withDistributedLease } from "../commerce/lease-lock.server";
import { enqueueProductSyncJob } from "./product-sync-job.server";
import { kickProductSyncQueue } from "./product-sync-queue.server";

async function queueReindexRows(
  shop: string,
  policyVersion: number,
  productIds: string[],
  productCapacityIds: Set<string>,
  subscriptionRecoveryIds: Set<string>,
) {
  let queued = 0;

  // Queue every newly eligible catalog product, but use bounded concurrency so
  // a large limit increase does not serialize hundreds of database round trips.
  for (let offset = 0; offset < productIds.length; offset += 10) {
    const batch = productIds.slice(offset, offset + 10);
    const results = await Promise.all(
      batch.map((productId) => {
        const capacityRecovery = productCapacityIds.has(productId);
        const subscriptionRecovery = subscriptionRecoveryIds.has(productId);
        const recoveryKind = capacityRecovery
          ? "capacity-reindex"
          : subscriptionRecovery
            ? "subscription-reindex"
            : "reindex";
        return enqueueProductSyncJob({
          shop,
          webhookId: `${recoveryKind}:${shop}:${productId}:policy:${policyVersion}`,
          topic: capacityRecovery
            ? "REINDEX_PRODUCT_CAPACITY"
            : subscriptionRecovery
              ? "REINDEX_PRODUCT_SUBSCRIPTION"
            : "REINDEX_PRODUCT",
          productId,
          policyVersion,
        });
      }),
    );
    queued += results.filter((result) => result.created).length;
  }

  return queued;
}

export async function recoverBlockedProducts(
  shop: string,
  options?: { productCapacityExpanded?: boolean },
) {
  return withDistributedLease({
    shop,
    resource: "product-policy:reconcile",
    task: async () => {
      const entitlement = await getShopEntitlement(shop);
      const policyRows = await db.$queryRaw<Array<{ productPolicyVersion: number }>>`
        SELECT \`productPolicyVersion\` FROM \`AiSearchShopSettings\`
        WHERE \`shop\` = ${shop} LIMIT 1
      `;
      console.log("[PRODUCT POLICY RECONCILE START]", {
        policyVersion: policyRows[0]?.productPolicyVersion ?? 0,
        shop, effectiveProductLimit: entitlement.limits.productLimit,
        catalogCount: entitlement.catalogProductCount,
        cachedVectorCount: entitlement.cachedVectorCount,
        activeCount: entitlement.activeProductSlotsUsed,
        blockedCount: entitlement.blockedProductCount,
      });
      const plan = await reconcileIndexedProductEligibility({
        shop,
        policyActive: entitlement.active,
        productLimit: entitlement.limits.productLimit,
        recoverMissingAsProductCapacity:
          options?.productCapacityExpanded === true,
      });
      const vectorBudget = remaining(
        entitlement.limits.vectorUpdateLimit,
        entitlement.usage.vectorUpdateCount,
      );
      const productCapacityIds = new Set([
        ...plan.productCapacityReindex,
        ...(options?.productCapacityExpanded ? plan.missingVectorReindex : []),
      ]);
      const subscriptionRecoveryIds = new Set(
        plan.subscriptionRecoveryReindex,
      );
      const quotaControlledReindex = plan.requiresReindex.filter(
        (productId) =>
          !productCapacityIds.has(productId) &&
          !subscriptionRecoveryIds.has(productId),
      );
      const billableBatchLimit = Math.min(vectorBudget ?? 50, 50);
      const toQueue = entitlement.active
        ? [...new Set([
            ...productCapacityIds,
            ...subscriptionRecoveryIds,
            ...quotaControlledReindex.slice(0, billableBatchLimit),
          ])]
        : [];
      console.log("[PRODUCT POLICY RECONCILE PLAN]", {
        shop, policyVersion: plan.policyVersion,
        keepActive: plan.activeAfter - plan.reactivateReady.length,
        deactivate: plan.deactivate.length,
        reactivateReady: plan.reactivateReady.length,
        requiresReindex: plan.requiresReindex.length,
        productCapacityReindex: productCapacityIds.size,
        subscriptionRecoveryReindex: subscriptionRecoveryIds.size,
        quotaControlledReindex: quotaControlledReindex.length,
      });
      const queued = await queueReindexRows(
        shop,
        plan.policyVersion,
        toQueue,
        productCapacityIds,
        subscriptionRecoveryIds,
      );
      if (queued > 0) kickProductSyncQueue();
      console.log("[PRODUCT POLICY RECONCILE DONE]", {
        shop, policyVersion: plan.policyVersion,
        activeBefore: plan.activeBefore, activeAfter: plan.activeAfter,
        cachedBefore: plan.cachedVectorCount, cachedAfter: plan.cachedVectorCount,
        blockedAfter: plan.catalogCount - plan.activeAfter,
        targetLimit: entitlement.limits.productLimit,
      });
      return { queued, reason: entitlement.active ? "RECONCILED" : "SUBSCRIPTION_INACTIVE", ...plan } as const;
    },
  });
}

// Backwards-compatible Phase-1/V2 name used by older route imports.
export const recoverQuotaBlockedProducts = recoverBlockedProducts;
