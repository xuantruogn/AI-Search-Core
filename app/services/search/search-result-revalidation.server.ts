import type { SearchResult } from "./semantic-search.server";
import {
  deleteProductVectorForShop,
  updateProductVectorPayloadForShop,
} from "./vector-store.server";
import {
  fetchSearchableProductSnapshotsByIds,
} from "../products/product-sync.server";
import {
  markIndexedProductUnpublished,
  removeIndexedProduct,
  touchIndexedProductLiveSeen,
} from "../commerce/indexed-products.server";
import { invalidateDerivedProductSearchCaches } from "../theme/theme-search-transport-key.server";
import {
  bumpSearchCatalogRevision,
  bumpSearchSemanticRevision,
} from "./search-catalog-revision.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type RevalidatedSearchResults = {
  results: SearchResult[];
  staleProductIds: string[];
  repairedMetadata: number;
};

/**
 * Shopify is the storefront source of truth. Qdrant can briefly lag a product
 * unpublish/delete/handle change, so every ranked candidate is revalidated
 * before its handle is passed to Liquid. This does not call OpenAI.
 */
export async function revalidateSearchResults({
  admin,
  shop,
  results,
  limit,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  results: SearchResult[];
  limit: number;
}): Promise<RevalidatedSearchResults> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), results.length));
  if (results.length === 0) {
    return { results: [], staleProductIds: [], repairedMetadata: 0 };
  }

  const live = await fetchSearchableProductSnapshotsByIds(
    admin,
    results.map((result) => result.productId),
  );

  const validated: SearchResult[] = [];
  const staleProductIds: string[] = [];
  let repairedMetadata = 0;

  for (const result of results) {
    const snapshot = live.get(result.productId);
    if (!snapshot) {
      staleProductIds.push(result.productId);
      continue;
    }

    const metadataChanged =
      snapshot.handle !== result.handle || snapshot.title !== result.title;

    if (metadataChanged) {
      repairedMetadata += 1;
      try {
        await updateProductVectorPayloadForShop({
          shop,
          productId: result.productId,
          payload: {
            handle: snapshot.handle,
            title: snapshot.title,
          },
        });
      } catch (error) {
        console.error("[AI Search] Search-time vector metadata repair failed:", {
          shop,
          productId: result.productId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      await touchIndexedProductLiveSeen({
        shop,
        productId: result.productId,
        handle: snapshot.handle,
        title: snapshot.title,
      });
    } catch (error) {
      console.error("[AI Search] Search-time registry touch failed:", {
        shop,
        productId: result.productId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    validated.push({
      ...result,
      handle: snapshot.handle,
      title: snapshot.title,
    });

    if (validated.length >= safeLimit) break;
  }

  if (repairedMetadata > 0) {
    // Handle/title repair changes storefront output/cache identity, but the
    // semantic profile remains authoritative until the durable product-sync
    // job rebuilds it. Do not force a semantic-cache rebuild with stale facts.
    await bumpSearchCatalogRevision(shop);
  }

  // Stale result cleanup is correctness maintenance, not paid AI work. It is
  // intentionally best-effort so one temporary Qdrant/DB failure cannot hide
  // the remaining valid search results.
  await Promise.all(
    staleProductIds.map(async (productId) => {
      try {
        await markIndexedProductUnpublished(shop, productId);
        invalidateDerivedProductSearchCaches(shop, productId);
        await bumpSearchSemanticRevision(shop);
        await deleteProductVectorForShop({ shop, productId });
        await removeIndexedProduct(shop, productId);
        invalidateDerivedProductSearchCaches(shop, productId);
      } catch (error) {
        console.error("[AI Search] Search-time stale product cleanup failed:", {
          shop,
          productId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return { results: validated, staleProductIds, repairedMetadata };
}
