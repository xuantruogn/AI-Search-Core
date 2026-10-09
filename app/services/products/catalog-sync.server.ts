import { fetchProductsForIndex } from "./product-sync.server";
import {
  indexProduct,
  type ProductIndexReason,
} from "./product-indexer.server";
import { ensureProductCollection } from "../search/qdrant.server";
import { getShopEntitlement } from "../commerce/entitlement.server";
import { touchIndexedProductCatalogSeen } from "../commerce/indexed-products.server";
import { readCatalogLanguageState, resolveCatalogIndexLanguage } from "../catalog/catalog-language.server";

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const PRODUCT_SYNC_CONCURRENCY = Math.max(
  1,
  Math.min(
    readPositiveInteger("AI_SEARCH_CATALOG_PRODUCT_CONCURRENCY", 3),
    10,
  ),
);

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
  catalogLanguage?: string | null;
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
  onProgress?: (progress: CatalogSyncProgress) => void | Promise<void>;
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
  catalogLanguage,
  stopWhenProductLimitReached = indexReason === "INITIAL_SYNC",
  onPageCompleted,
  onProgress,
  onProductFailed,
}: SyncEntireCatalogInput): Promise<CatalogSyncProgress> {
  console.log("[AI Search] Catalog sync started:", { shop, initialCursor });
  await ensureProductCollection();
  const languageState = await readCatalogLanguageState(shop);
  const languageAtStart = resolveCatalogIndexLanguage(catalogLanguage, languageState);

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

    for (
      let offset = 0;
      offset < page.products.length;
      offset += PRODUCT_SYNC_CONCURRENCY
    ) {
      const batch = page.products.slice(
        offset,
        offset + PRODUCT_SYNC_CONCURRENCY,
      );

      const outcomes = await Promise.all(
        batch.map(async (product) => {
          // Mark existing registry rows as seen before paid/retriable work so
          // stale cleanup cannot mistake a transient provider failure for a
          // Shopify deletion.
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
              catalogLanguage: languageAtStart,
            });
            return { product, result, failure: null };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failure = {
              productId: product.id,
              handle: product.handle,
              error: message,
            };
            console.error(
              "[AI Search] Product index failed:",
              product.handle,
              message,
            );

            // Persist retry intent before the page checkpoint can advance.
            await onProductFailed?.(failure);
            return { product, result: null, failure };
          } finally {
            // indexProduct may create the registry row after the pre-touch.
            await touchIndexedProductCatalogSeen({
              shop,
              productId: product.id,
              handle: product.handle,
              title: product.title,
            });
          }
        }),
      );

      for (const outcome of outcomes) {
        progress.productsProcessed += 1;

        if (outcome.failure) {
          progress.productsFailed += 1;
          progress.failures.push(outcome.failure);
        } else if (outcome.result?.action === "indexed") {
          progress.productsIndexed += 1;
        } else if (outcome.result?.action === "skipped") {
          progress.productsSkipped += 1;
        } else if (outcome.result?.action === "blocked") {
          progress.productsBlocked += 1;
          if (
            outcome.result.blockedReason === "PRODUCT_LIMIT" &&
            stopAtProductLimit
          ) {
            progress.stoppedByProductLimit = true;
          }
        }

        await onProgress?.(progress);
      }

      if (progress.stoppedByProductLimit) break;
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
