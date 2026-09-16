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

import {
  deleteProductThemeSearchTransportKeys,
} from "../theme/theme-search-transport-key.server";

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
 * - products/delete
 * - ACTIVE -> DRAFT
 * - ACTIVE -> ARCHIVED
 * - product unpublished from Online Store
 * - product missing from Shopify
 *
 * Important:
 * AiSearchRenderTransportKey currently has no Prisma relation/cascade to
 * AiSearchIndexedProduct, so its rows must be deleted explicitly here.
 */
async function deleteProductFromAiIndex({
  shop,
  productId,
}: {
  shop: string;
  productId: string;
}) {
  // ----------------------------------------------------------
  // 1. Remove semantic-search vector.
  // ----------------------------------------------------------

  await deleteProductVectorForShop({
    shop,
    productId,
  });

  // ----------------------------------------------------------
  // 2. Remove indexed-product registry.
  //
  // Context terms that are related to AiSearchIndexedProduct can
  // continue using their existing cascade/lifecycle behavior.
  // ----------------------------------------------------------

  await removeIndexedProduct(
    shop,
    productId,
  );

  // ----------------------------------------------------------
  // 3. Remove native-render transport signatures.
  //
  // This MUST be explicit because AiSearchRenderTransportKey
  // currently has no relation/cascade to AiSearchIndexedProduct.
  //
  // Otherwise a deleted product could remain an "owner" of a
  // signature and incorrectly make another product appear
  // non-unique during transport-key resolution.
  // ----------------------------------------------------------

  const deletedTransportKeys =
    await deleteProductThemeSearchTransportKeys({
      shop,
      productId,
    });

  if (
    deletedTransportKeys > 0
  ) {
    console.log(
      "[AI Search] Product render transport keys deleted:",
      {
        shop,
        productId,
        deletedTransportKeys,
      },
    );
  }

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
}: {
  admin: AdminGraphqlClient;
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
    await deleteProductFromAiIndex({
      shop,
      productId: gid,
    });

    console.log(
      "[AI Search] Product removed from AI Search:",
      {
        shop,
        productId: gid,
        reason:
          "NOT_STOREFRONT_SEARCHABLE",
      },
    );

    return {
      action:
        "deleted",

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
      reason:
        "WEBHOOK",
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

  // Explicit Shopify products/delete webhook uses exactly
  // the same cleanup path as DRAFT/ARCHIVED/unpublished.
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