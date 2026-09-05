import { fetchProductsForIndex } from "./product-sync.server";
import {
  indexProduct,
  type ProductIndexReason,
} from "./product-indexer.server";
import { ensureProductCollection } from "../search/qdrant.server";
import { getShopEntitlement } from "../commerce/entitlement.server";
import { touchIndexedProductCatalogSeen } from "../commerce/indexed-products.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type CatalogSyncProgress = {
  shop: string;
  pagesProcessed: number;
  productsProcessed: number;
  productsIndexed: number;
  productsSkipped: number;
  productsBlocked: number;
  productsFailed: number;
  stoppedByProductLimit: boolean;
  failures: Array<{ productId: string; handle: string; error: string }>;
};

export type SyncEntireCatalogInput = {
  admin: AdminGraphqlClient;
  shop: string;
  pageSize?: number;
  after?: string | null;
  initialProgress?: Partial<
    Omit<CatalogSyncProgress, "shop" | "failures" | "stoppedByProductLimit">
  >;
  indexReason?: ProductIndexReason;
  stopWhenProductLimitReached?: boolean;
  onPageCompleted?: (
    nextCursor: string | null,
    progress: CatalogSyncProgress,
  ) => void | Promise<void>;
  onProductFailed?: (failure: {
    productId: string;
    handle: string;
    error: string;
  }) => void | Promise<void>;
};

export async function syncEntireCatalog({
  admin,
  shop,
  pageSize = 50,
  after: initialCursor = null,
  initialProgress,
  indexReason = "INITIAL_SYNC",
  stopWhenProductLimitReached = indexReason === "INITIAL_SYNC",
  onPageCompleted,
  onProductFailed,
}: SyncEntireCatalogInput): Promise<CatalogSyncProgress> {
  console.log("[AI Search] Catalog sync started:", { shop, initialCursor });
  await ensureProductCollection();

  const progress: CatalogSyncProgress = {
    shop,
    pagesProcessed: initialProgress?.pagesProcessed ?? 0,
    productsProcessed: initialProgress?.productsProcessed ?? 0,
    productsIndexed: initialProgress?.productsIndexed ?? 0,
    productsSkipped: initialProgress?.productsSkipped ?? 0,
    productsBlocked: initialProgress?.productsBlocked ?? 0,
    productsFailed: initialProgress?.productsFailed ?? 0,
    stoppedByProductLimit: false,
    failures: [],
  };

  let after = initialCursor;
  let hasNextPage = true;
  const stopAtProductLimit = stopWhenProductLimitReached;

  while (hasNextPage) {
    const entitlement = await getShopEntitlement(shop);

    if (!entitlement.active) {
      throw new Error(`AI Search subscription is inactive for ${shop}`);
    }

    if (
      stopAtProductLimit &&
      !entitlement.productSlotAvailable &&
      entitlement.limits.productLimit !== null
    ) {
      progress.stoppedByProductLimit = true;
      break;
    }

    const page = await fetchProductsForIndex(admin, { first: pageSize, after });
    progress.pagesProcessed += 1;

    for (const product of page.products) {
      progress.productsProcessed += 1;

      // Mark registry rows as seen before paid/retriable indexing work. If
      // OpenAI/Qdrant fails for an ACTIVE product, stale cleanup must not
      // mistake that transient failure for a Shopify deletion.
      await touchIndexedProductCatalogSeen({
        shop,
        productId: product.id,
        handle: product.handle,
        title: product.title,
      });

      try {
        const result = await indexProduct({
          shop,
          product,
          reason: indexReason,
        });

        if (result.action === "indexed") progress.productsIndexed += 1;
        else if (result.action === "skipped") progress.productsSkipped += 1;
        else {
          progress.productsBlocked += 1;
          if (result.blockedReason === "PRODUCT_LIMIT" && stopAtProductLimit) {
            progress.stoppedByProductLimit = true;
            break;
          }
        }
      } catch (error) {
        progress.productsFailed += 1;
        const message = error instanceof Error ? error.message : String(error);
        const failure = {
          productId: product.id,
          handle: product.handle,
          error: message,
        };
        progress.failures.push(failure);
        console.error(
          "[AI Search] Product index failed:",
          product.handle,
          message,
        );

        // Persist the retry before this catalog page is checkpointed. If the
        // process dies after the checkpoint, an in-memory failures array would
        // otherwise lose the product ID forever and the ACTIVE product could
        // remain unindexed until a later full reconciliation.
        await onProductFailed?.(failure);
      }

      // A new registry row can be created by indexProduct (INDEXED or BLOCKED)
      // after the pre-index touch above. Mark it as catalog-seen as well.
      await touchIndexedProductCatalogSeen({
        shop,
        productId: product.id,
        handle: product.handle,
        title: product.title,
      });
    }

    if (progress.stoppedByProductLimit) {
      await onPageCompleted?.(null, progress);
      break;
    }

    hasNextPage = page.hasNextPage;
    after = page.endCursor;

    if (hasNextPage && !after) {
      throw new Error("Shopify returned hasNextPage=true but no endCursor");
    }

    await onPageCompleted?.(hasNextPage ? after : null, progress);
  }

  console.log("[AI Search] Catalog sync completed:", progress);
  return progress;
}
