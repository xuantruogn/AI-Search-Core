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
  vectorOverride?: number[]; // Hỗ trợ Vector cache truyền vào
  onEmbeddingCreated?: (vector: number[]) => void | Promise<void>; // Trả về mảng vector để lưu vào Cache
};

export async function semanticSearch({
  shop,
  query,
  limit = 20,
  vectorOverride,
  onEmbeddingCreated,
}: SemanticSearchInput): Promise<SearchResult[]> {
  const cleanQuery = query.trim();

  if (!cleanQuery) {
    return [];
  }

  console.log("[AI Search] Semantic search", {
    shop,
    queryLength: cleanQuery.length,
    limit,
    cacheHit: Boolean(vectorOverride),
  });

  await ensureProductCollection();

  let queryVector: number[];

  // 1. Nếu có vectorOverride từ Cache -> Dùng lại ngay, không gọi OpenAI API
  if (
    vectorOverride &&
    Array.isArray(vectorOverride) &&
    vectorOverride.length > 0
  ) {
    queryVector = vectorOverride;
  } else {
    // 2. Nếu chưa có trong Cache -> Gọi OpenAI API để tạo Embedding
    queryVector = await createEmbedding(cleanQuery);

    // Bắn callback lưu mảng Vector (number[]) vào queryEmbeddingCache trên Server
    if (onEmbeddingCreated && typeof onEmbeddingCreated === "function") {
      try {
        await onEmbeddingCreated(queryVector);
      } catch (usageError) {
        console.error(
          "[AI Search] Query embedding callback failed:",
          usageError,
        );
      }
    }
  }

  console.log("[AI Search] Query embedding dimensions:", queryVector.length);

  // 3. Tìm kiếm Vector trên Qdrant
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