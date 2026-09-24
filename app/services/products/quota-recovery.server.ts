import db from "../../db.server";
import { getShopEntitlement, remaining } from "../commerce/entitlement.server";
import { reconcileIndexedProductEligibility } from "../commerce/indexed-products.server";
import { withDistributedLease } from "../commerce/lease-lock.server";
import { enqueueProductSyncJob } from "./product-sync-job.server";
import { kickProductSyncQueue } from "./product-sync-queue.server";

async function queueReindexRows(shop: string, policyVersion: number, productIds: string[]) {
  let queued = 0;
  for (const productId of productIds) {
    const result = await enqueueProductSyncJob({
      shop,
      webhookId: `reindex:${shop}:${productId}:policy:${policyVersion}`,
      topic: "REINDEX_PRODUCT",
      productId,
      policyVersion,
    });
    if (result.created) queued += 1;
  }

  return queued;
}

export async function recoverBlockedProducts(shop: string) {
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
      });
      const vectorBudget = remaining(
        entitlement.limits.vectorUpdateLimit,
        entitlement.usage.vectorUpdateCount,
      );
      const batchLimit = Math.min(vectorBudget ?? 50, 50);
      const toQueue = entitlement.active ? plan.requiresReindex.slice(0, batchLimit) : [];
      console.log("[PRODUCT POLICY RECONCILE PLAN]", {
        shop, policyVersion: plan.policyVersion,
        keepActive: plan.activeAfter - plan.reactivateReady.length,
        deactivate: plan.deactivate.length,
        reactivateReady: plan.reactivateReady.length,
        requiresReindex: plan.requiresReindex.length,
      });
      const queued = await queueReindexRows(shop, plan.policyVersion, toQueue);
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
