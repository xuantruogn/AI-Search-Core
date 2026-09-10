import { fetchProductsForIndex } from "./product-sync.server";

import { buildProductDocument } from "./product-document.server";

import { createProductDocumentHash } from "./product-indexer.server";

import {
  getProductVectorForShop,
  migrateProductVectorPointIdIfNeeded,
  updateProductVectorPayloadForShop,
} from "../search/vector-store.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

export type BackfillProductHashesInput = {
  admin: AdminGraphqlClient;
  shop: string;
  pageSize?: number;
};

export type BackfillHashResult = {
  shop: string;
  productsProcessed: number;
  hashesUpdated: number;
  alreadyHashed: number;
  missingVectors: number;
};

export async function backfillProductHashes({
  admin,
  shop,
  pageSize = 50,
}: BackfillProductHashesInput): Promise<BackfillHashResult> {
  console.log("[AI Search] Product hash backfill started:", shop);

  const result: BackfillHashResult = {
    shop,
    productsProcessed: 0,
    hashesUpdated: 0,
    alreadyHashed: 0,
    missingVectors: 0,
  };

  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const page = await fetchProductsForIndex(admin, {
      first: pageSize,
      after,
    });

    for (const product of page.products) {
      result.productsProcessed += 1;

      const rawExisting = await getProductVectorForShop({
        shop,
        productId: product.id,
        withVector: true,
      });
      const existingRecord = await migrateProductVectorPointIdIfNeeded({
        shop,
        productId: product.id,
        record: rawExisting,
      });
      const existing = existingRecord?.payload ?? null;

      if (!existing) {
        result.missingVectors += 1;

        console.log(
          "[AI Search] Vector missing, skip hash backfill:",
          product.handle,
        );

        continue;
      }

      if (existing.documentHash) {
        result.alreadyHashed += 1;
        continue;
      }

      const document = buildProductDocument(product);

      const documentHash = createProductDocumentHash(document);

      await updateProductVectorPayloadForShop({
        shop,
        productId: product.id,
        payload: { documentHash },
      });

      result.hashesUpdated += 1;

      console.log("[AI Search] Hash backfilled:", product.handle);
    }

    hasNextPage = page.hasNextPage;
    after = page.endCursor;

    if (hasNextPage && !after) {
      throw new Error("Shopify returned hasNextPage=true but no endCursor");
    }
  }

  console.log("[AI Search] Product hash backfill completed:", result);

  return result;
}
