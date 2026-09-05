import { fetchProductForIndexById } from "./product-sync.server";
import { indexProduct } from "./product-indexer.server";
import { deleteProductVectorForShop } from "../search/vector-store.server";
import { ensureProductCollection } from "../search/qdrant.server";
import { normalizeProductGid } from "./product-id.server";
import { removeIndexedProduct } from "../commerce/indexed-products.server";
import { getShopEntitlement } from "../commerce/entitlement.server";
import {
  recordProductDelete,
  recordUsageEvent,
} from "../commerce/usage.server";
import { recoverBlockedProducts } from "./quota-recovery.server";
import { enqueueCatalogRefresh } from "../catalog/catalog-sync-job.server";
import { kickCatalogSyncQueue } from "../catalog/catalog-sync-queue.server";

export { normalizeProductGid } from "./product-id.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

export type ProductWebhookSyncResult =
  | {
      action: "indexed" | "skipped" | "blocked";
      productId: string;
      handle: string;
      documentHash: string;
      blockedReason?: string;
    }
  | {
      action: "deleted";
      productId: string;
    };

async function recordProductSyncOutcome({
  shop,
  productId,
  action,
  blockedReason,
}: {
  shop: string;
  productId: string;
  action: "indexed" | "skipped" | "blocked";
  blockedReason?: string;
}) {
  try {
    const entitlement = await getShopEntitlement(shop);
    await recordUsageEvent({
      shop,
      periodId: entitlement.usage.id,
      type: "PRODUCT_SYNC",
      success: action !== "blocked",
      productId,
      metadata: { action, blockedReason: blockedReason ?? null },
    });
  } catch (error) {
    // Usage analytics must never turn a successful vector/hash decision into a
    // failed Shopify webhook job. AiSearchSyncJob remains the durable
    // operational log even if this analytics write is temporarily unavailable.
    console.error("[AI Search] Product sync usage logging failed:", {
      shop,
      productId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function deleteProductFromAiIndex({
  shop,
  productId,
}: {
  shop: string;
  productId: string;
}) {
  await deleteProductVectorForShop({ shop, productId });
  await removeIndexedProduct(shop, productId);

  const entitlement = await getShopEntitlement(shop);

  await recordProductDelete({
    shop,
    periodId: entitlement.usage.id,
    productId,
  });

  if (entitlement.active) {
    void recoverBlockedProducts(shop).catch((error) => {
      console.error(
        "[AI Search] Blocked-product recovery after delete failed:",
        error,
      );
    });

    if (
      entitlement.limits.productLimit !== null &&
      entitlement.productSlotAvailable
    ) {
      void enqueueCatalogRefresh(shop, "SLOT_REFILL")
        .then((jobId) => {
          if (jobId) kickCatalogSyncQueue();
        })
        .catch((error) => {
          console.error(
            "[AI Search] Catalog refill enqueue after delete failed:",
            error,
          );
        });
    }
  }
}

export async function syncProductFromWebhook({
  admin,
  shop,
  productId,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  productId: string | number;
}): Promise<ProductWebhookSyncResult> {
  const gid = normalizeProductGid(productId);

  console.log("[AI Search] Product webhook sync started:", {
    shop,
    productId: gid,
  });

  await ensureProductCollection();

  const product = await fetchProductForIndexById(admin, gid);

  if (!product) {
    await deleteProductFromAiIndex({
      shop,
      productId: gid,
    });

    console.log("[AI Search] Product vector removed:", gid);

    return {
      action: "deleted",
      productId: gid,
    };
  }

  const result = await indexProduct({
    shop,
    product,
    reason: "WEBHOOK",
  });

  if (result.action === "skipped") {
    console.log(
      "[AI Search] Product unchanged, webhook skipped embedding:",
      product.handle,
    );
  } else if (result.action === "blocked") {
    console.log("[AI Search] Product webhook blocked by entitlement:", {
      handle: product.handle,
      reason: result.blockedReason,
    });
  } else {
    console.log("[AI Search] Product webhook indexed:", product.handle);
  }

  await recordProductSyncOutcome({
    shop,
    productId: product.id,
    action: result.action,
    blockedReason: result.blockedReason,
  });

  return {
    action: result.action,
    productId: product.id,
    handle: product.handle,
    documentHash: result.documentHash,
    blockedReason: result.blockedReason,
  };
}

export async function deleteProductFromWebhook({
  shop,
  productId,
}: {
  shop: string;
  productId: string | number;
}): Promise<ProductWebhookSyncResult> {
  const gid = normalizeProductGid(productId);

  console.log("[AI Search] Product delete webhook:", {
    shop,
    productId: gid,
  });

  await ensureProductCollection();
  await deleteProductFromAiIndex({
    shop,
    productId: gid,
  });

  console.log("[AI Search] Product vector deleted:", gid);

  return {
    action: "deleted",
    productId: gid,
  };
}
