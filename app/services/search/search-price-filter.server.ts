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

export async function filterSearchResultsByPrice({
  admin,
  shop,
  results,
  constraint,
  sortIntent = "RELEVANCE",
}: {
  admin: AdminGraphqlClient;
  shop: string;
  results: SearchResult[];
  constraint: PriceConstraint | null;
  sortIntent?: QueryRewriteAnalysis["sortIntent"];
}) {
  if (results.length === 0) return results;

  const gidByProductId = new Map<string, string>();
  for (const result of results) {
    try {
      gidByProductId.set(result.productId, normalizeProductGid(result.productId));
    } catch {
      // Invalid legacy payloads cannot be verified and therefore fail closed.
    }
  }

  const snapshots = await fetchSearchableProductSnapshotsByIds(
    admin,
    [...gidByProductId.values()],
  );

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

  // Soft preferences reorder nearby relevance scores. Explicit price sorting
  // preserves the complete list already accepted by semantic retrieval.
  const topScore = Math.max(...filtered.map((item) => item.score));
  const candidates = filtered;
  const price = (item: SearchResult) => snapshots.get(item.productId)!.minVariantPrice;
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
  console.log("[AI Search] Query preferences applied", {
    sortIntent,
    shop,
    constraint,
    beforeCount: results.length,
    afterCount: candidates.length,
    filteredCount: results.length - filtered.length,
  });

  return candidates;
}
