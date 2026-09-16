import { normalizeProductGid } from "../products/product-id.server";
import { fetchSearchableProductSnapshotsByIds } from "../products/product-sync.server";
import type { SearchResult } from "./semantic-search.server";
import type { QueryRewriteAnalysis } from "./query-rewriter.server";
import {
  productPriceMatchesConstraint,
  type PriceConstraint,
} from "./query-constraints.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type SearchPriceFilterDiagnostics = {
  normalizeIdsCodeMs: number;
  shopifyApiMs: number;
  filterCodeMs: number;
  sortCodeMs: number;
  totalMs: number;
  payloadPriceHits: number;
  shopifyPriceMisses: number;
};

export async function filterSearchResultsByPrice({
  admin,
  shop,
  results,
  constraint,
  sortIntent = "RELEVANCE",
  onDiagnostics,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  results: SearchResult[];
  constraint: PriceConstraint | null;
  sortIntent?: QueryRewriteAnalysis["sortIntent"];
  onDiagnostics?: (diagnostics: SearchPriceFilterDiagnostics) => void;
}) {
  if (results.length === 0) return results;

  const totalStartedAt = Date.now();
  const normalizeStartedAt = Date.now();
  const gidByProductId = new Map<string, string>();
  const snapshots = new Map<string, {
    productId: string;
    handle: string;
    title: string;
    minVariantPrice: number;
    maxVariantPrice: number;
    currencyCode: string;
  }>();
  for (const result of results) {
    try {
      const gid = normalizeProductGid(result.productId);
      gidByProductId.set(result.productId, gid);
      if (
        typeof result.minVariantPrice === "number" &&
        Number.isFinite(result.minVariantPrice) &&
        typeof result.maxVariantPrice === "number" &&
        Number.isFinite(result.maxVariantPrice) &&
        result.currencyCode
      ) {
        snapshots.set(gid, {
          productId: gid,
          handle: result.handle,
          title: result.title,
          minVariantPrice: result.minVariantPrice,
          maxVariantPrice: result.maxVariantPrice,
          currencyCode: result.currencyCode.toUpperCase(),
        });
      }
    } catch {
      // Invalid legacy payloads cannot be verified and therefore fail closed.
    }
  }
  const normalizeIdsCodeMs = Date.now() - normalizeStartedAt;

  const shopifyStartedAt = Date.now();
  const missingIds = [...new Set(gidByProductId.values())]
    .filter((gid) => !snapshots.has(gid));
  if (missingIds.length > 0) {
    const fetched = await fetchSearchableProductSnapshotsByIds(admin, missingIds);
    for (const [gid, snapshot] of fetched) snapshots.set(gid, snapshot);
  }
  const shopifyApiMs = Date.now() - shopifyStartedAt;

  const filterStartedAt = Date.now();
  const filtered = results.flatMap((result) => {
    const gid = gidByProductId.get(result.productId);
    const snapshot = gid ? snapshots.get(gid) : null;
    if (
      !snapshot ||
      (constraint && !productPriceMatchesConstraint(
        {
          min: snapshot.minVariantPrice,
          max: snapshot.maxVariantPrice,
          currencyCode: snapshot.currencyCode,
        },
        constraint,
      ))
    ) {
      return [];
    }

    return [
      {
        ...result,
        productId: snapshot.productId,
        handle: snapshot.handle,
        title: snapshot.title,
      },
    ];
  });
  const filterCodeMs = Date.now() - filterStartedAt;

  // Soft preferences reorder nearby relevance scores. Explicit price sorting
  // preserves the complete list already accepted by semantic retrieval.
  const topScore = Math.max(...filtered.map((item) => item.score));
  const candidates = filtered;
  const price = (item: SearchResult) => snapshots.get(item.productId)!.minVariantPrice;
  const sortStartedAt = Date.now();
  if (sortIntent !== "RELEVANCE") {
    candidates.sort((a, b) => {
      if (sortIntent === "PREMIUM" || sortIntent === "BUDGET") {
        const bandDifference = Math.floor((topScore - a.score) / 0.03) - Math.floor((topScore - b.score) / 0.03);
        if (bandDifference) return bandDifference;
      }
      const direction = sortIntent === "PRICE_ASC" || sortIntent === "BUDGET" ? 1 : -1;
      return direction * (price(a) - price(b)) || b.score - a.score;
    });
  }
  const sortCodeMs = Date.now() - sortStartedAt;
  onDiagnostics?.({
    normalizeIdsCodeMs,
    shopifyApiMs,
    filterCodeMs,
    sortCodeMs,
    totalMs: Date.now() - totalStartedAt,
    payloadPriceHits: results.length - missingIds.length,
    shopifyPriceMisses: missingIds.length,
  });
  console.log("[AI Search] Query preferences applied", {
    sortIntent,
    shop,
    constraint,
    beforeCount: results.length,
    afterCount: candidates.length,
    filteredCount: results.length - filtered.length,
    payloadPriceHits: results.length - missingIds.length,
    shopifyPriceMisses: missingIds.length,
  });

  return candidates;
}
