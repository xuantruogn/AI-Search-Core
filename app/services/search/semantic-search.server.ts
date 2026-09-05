import { createEmbedding } from "./embeddings.server";
import { searchProductVectors } from "./vector-store.server";
import { ensureProductCollection } from "./qdrant.server";

export type SearchResult = {
  productId: string;
  handle: string;
  title: string;
  score: number;
};

export type SemanticSearchInput = {
  shop: string;
  query: string;
  limit?: number;
  onEmbeddingCreated?: (dimensions: number) => void | Promise<void>;
};

export async function semanticSearch({
  shop,
  query,
  limit = 20,
  onEmbeddingCreated,
}: SemanticSearchInput): Promise<SearchResult[]> {
  const cleanQuery = query.trim();

  if (!cleanQuery) {
    return [];
  }

  // Do not emit raw customer queries into operational logs. Persistent usage
  // events store only a deterministic keyed digest (HMAC when configured).
  console.log("[AI Search] Semantic search", {
    shop,
    queryLength: cleanQuery.length,
    limit,
  });

  await ensureProductCollection();

  // The callback fires immediately after OpenAI succeeds, before Qdrant is
  // called. This lets usage accounting keep the real embedding cost even if
  // the downstream vector query or theme renderer later fails.
  const queryVector = await createEmbedding(cleanQuery);
  await onEmbeddingCreated?.(queryVector.length);

  console.log("[AI Search] Query embedding dimensions:", queryVector.length);

  const results = await searchProductVectors({
    shop,
    vector: queryVector,
    limit,
  });

  console.log(
    "[AI Search] Qdrant results:",
    results.map((result) => ({
      handle: result.handle,
      score: result.score,
    })),
  );

  return results.map((result) => ({
    productId: result.productId,
    handle: result.handle,
    title: result.title,
    score: result.score,
  }));
}
