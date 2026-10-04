import { fetchProductForIndexById } from "./product-sync.server";
import {
  indexProduct,
  type ProductIndexReason,
} from "./product-indexer.server";

import {
  deleteProductVectorForShop,
  updateProductVectorSearchabilityForShop,
} from "../search/vector-store.server";
import { ensureProductCollection } from "../search/qdrant.server";

import { normalizeProductGid } from "./product-id.server";

import { markIndexedProductUnpublished, removeIndexedProduct } from "../commerce/indexed-products.server";
import { getShopEntitlement } from "../commerce/entitlement.server";

import {
  recordProductDelete,
  recordUsageEvent,
} from "../commerce/usage.server";

import { recoverBlockedProducts } from "./quota-recovery.server";

import { enqueueCatalogRefresh } from "../catalog/catalog-sync-job.server";
import { kickCatalogSyncQueue } from "../catalog/catalog-sync-queue.server";

import {
  invalidateDerivedProductSearchCaches,
} from "../theme/theme-search-transport-key.server";
import { bumpSearchSemanticRevision } from "../search/search-catalog-revision.server";

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
      action:
        | "indexed"
        | "skipped"
        | "blocked";

      productId: string;
      handle: string;
      documentHash: string;
      blockedReason?: string;
    }
  | {
      action: "deleted";
      productId: string;
    }
  | {
      action: "unpublished";
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

  action:
    | "indexed"
    | "skipped"
    | "blocked";

  blockedReason?: string;
}) {
  try {
    const entitlement =
      await getShopEntitlement(
        shop,
      );

    await recordUsageEvent({
      shop,

      periodId:
        entitlement.usage.id,

      type:
        "PRODUCT_SYNC",

      success:
        action !== "blocked",

      productId,

      metadata: {
        action,

        blockedReason:
          blockedReason ??
          null,
      },
    });
  } catch (error) {
    // Usage analytics must never turn a successful vector/hash decision into a
    // failed Shopify webhook job. AiSearchSyncJob remains the durable
    // operational log even if this analytics write is temporarily unavailable.
    console.error(
      "[AI Search] Product sync usage logging failed:",
      {
        shop,
        productId,

        error:
          error instanceof
          Error
            ? error.message
            : String(
                error,
              ),
      },
    );
  }
}

/**
 * Remove one product completely from the AI Search searchable state.
 *
 * This is the common cleanup path for:
 *
 * Only an authoritative products/delete event reaches this hard-delete path.
 * Draft, archived, unpublished, or temporarily missing storefront products
 * retain their cached vector and are marked non-searchable elsewhere.
 *
 * Native-render transport keys are derived from the semantic profile and are
 * never persisted separately. The cleanup helper only invalidates the
 * per-shop derived transport cache after a hard delete.
 */
async function deleteProductFromAiIndex({
  shop,
  productId,
}: {
  shop: string;
  productId: string;
}) {
  // Fail closed before touching Qdrant. If the vector delete or a later DB
  // operation fails, the registry already prevents this product from being
  // returned by search.
  await markIndexedProductUnpublished(shop, productId);
  invalidateDerivedProductSearchCaches(shop, productId);
  await bumpSearchSemanticRevision(shop);

  await updateProductVectorSearchabilityForShop({
    shop,
    productIds: [productId],
    searchable: false,
  });

  // Hard delete is authoritative only for products/delete. Once the point is
  // non-searchable on both sources of truth, remove Qdrant and then the registry
  // row (semantic profile cascades from IndexedProduct).
  await deleteProductVectorForShop({
    shop,
    productId,
  });

  await removeIndexedProduct(
    shop,
    productId,
  );

  invalidateDerivedProductSearchCaches(shop, productId);

  // ----------------------------------------------------------
  // 4. Commercial/usage lifecycle.
  // ----------------------------------------------------------

  const entitlement =
    await getShopEntitlement(
      shop,
    );

  await recordProductDelete({
    shop,

    periodId:
      entitlement.usage.id,

    productId,
  });

  // ----------------------------------------------------------
  // 5. Product-slot recovery.
  // ----------------------------------------------------------

  if (
    entitlement.active
  ) {
    void recoverBlockedProducts(
      shop,
    ).catch(
      (error) => {
        console.error(
          "[AI Search] Blocked-product recovery after delete failed:",
          error,
        );
      },
    );

    if (
      entitlement.limits
        .productLimit !==
        null &&
      entitlement
        .productSlotAvailable
    ) {
      void enqueueCatalogRefresh(
        shop,
        "SLOT_REFILL",
      )
        .then(
          (jobId) => {
            if (jobId) {
              kickCatalogSyncQueue();
            }
          },
        )
        .catch(
          (error) => {
            console.error(
              "[AI Search] Catalog refill enqueue after delete failed:",
              error,
            );
          },
        );
    }
  }
}

export async function syncProductFromWebhook({
  admin,
  shop,
  productId,
  indexReason = "WEBHOOK",
}: {
  admin: AdminGraphqlClient;
  shop: string;
  productId:
    | string
    | number;
  indexReason?: ProductIndexReason;
}): Promise<ProductWebhookSyncResult> {
  const gid =
    normalizeProductGid(
      productId,
    );

  console.log(
    "[AI Search] Product webhook sync started:",
    {
      shop,
      productId: gid,
    },
  );

  await ensureProductCollection();

  // ----------------------------------------------------------
  // Shopify is the source of truth.
  //
  // fetchProductForIndexById() returns null when the product:
  //
  // - does not exist
  // - is not ACTIVE
  // - is not published to Online Store
  //
  // Therefore all of those states share the same cleanup path.
  // ----------------------------------------------------------

  const product =
    await fetchProductForIndexById(
      admin,
      gid,
    );

  if (!product) {
    const unpublishedRows = await markIndexedProductUnpublished(shop, gid);
    await updateProductVectorSearchabilityForShop({
      shop,
      productIds: [gid],
      searchable: false,
    });
    invalidateDerivedProductSearchCaches(shop, gid);
    if (unpublishedRows > 0) {
      await bumpSearchSemanticRevision(shop);
    }

    console.log(
      "[AI Search] Product removed from AI Search:",
      {
        shop,
        productId: gid,
        reason:
        "NOT_STOREFRONT_SEARCHABLE_VECTOR_RETAINED",
      },
    );

    return {
      action:
        "unpublished",

      productId:
        gid,
    };
  }

  // ----------------------------------------------------------
  // Searchable product:
  //
  // indexProduct() now owns both:
  //
  // - semantic vector lifecycle
  // - native render transport-key refresh
  //
  // Transport keys are refreshed both when:
  //
  // - vector is newly embedded
  // - document hash is unchanged and embedding is skipped
  // ----------------------------------------------------------

  const result =
    await indexProduct({
      shop,
      product,
      reason: indexReason,
    });

  if (
    result.action ===
    "skipped"
  ) {
    console.log(
      "[AI Search] Product unchanged, webhook skipped embedding:",
      product.handle,
    );
  } else if (
    result.action ===
    "blocked"
  ) {
    console.log(
      "[AI Search] Product webhook blocked by entitlement:",
      {
        handle:
          product.handle,

        reason:
          result.blockedReason,
      },
    );
  } else {
    console.log(
      "[AI Search] Product webhook indexed:",
      product.handle,
    );
  }

  await recordProductSyncOutcome({
    shop,

    productId:
      product.id,

    action:
      result.action,

    blockedReason:
      result.blockedReason,
  });

  return {
    action:
      result.action,

    productId:
      product.id,

    handle:
      product.handle,

    documentHash:
      result.documentHash,

    blockedReason:
      result.blockedReason,
  };
}

export async function deleteProductFromWebhook({
  shop,
  productId,
}: {
  shop: string;

  productId:
    | string
    | number;
}): Promise<ProductWebhookSyncResult> {
  const gid =
    normalizeProductGid(
      productId,
    );

  console.log(
    "[AI Search] Product delete webhook:",
    {
      shop,
      productId: gid,
    },
  );

  await ensureProductCollection();

  // Explicit Shopify products/delete is the sole hard-delete path.
  await deleteProductFromAiIndex({
    shop,
    productId: gid,
  });

  console.log(
    "[AI Search] Product deleted from AI Search:",
    {
      shop,
      productId: gid,
    },
  );

  return {
    action:
      "deleted",

    productId:
      gid,
  };
}
