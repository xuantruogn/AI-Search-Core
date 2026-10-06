import type { SearchResult } from "./semantic-search.server";
import { searchProductSparse } from "./vector-store.server";

export async function retrieveSparseCandidates(args: {
  shop: string;
  query: string;
  limit?: number;
}): Promise<SearchResult[]> {
  const results = await searchProductSparse({
    shop: args.shop,
    query: args.query,
    limit: args.limit ?? 100,
  });
  return results.map((result, index) => ({
    ...result,
    sparseScore: result.sparseScore ?? result.score,
    sparseRank: result.sparseRank ?? index + 1,
    retrievalSources: ["SPARSE"],
  }));
}
