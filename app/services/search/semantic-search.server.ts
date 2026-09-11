import { createEmbedding, getEmbeddingModel } from "./embeddings.server";
import { searchProductVectors } from "./vector-store.server";
import { ensureProductCollection } from "./qdrant.server";
import { rewriteSearchQuery, type QueryRewriteResult } from "./query-rewriter.server";

function readMinimumVectorScore() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_VECTOR_SCORE_THRESHOLD || "",
  );
  return Number.isFinite(value) && value >= -1 && value <= 1 ? value : 0.25;
}

function shouldLogEmbeddingInput() {
  const value = process.env.AI_SEARCH_LOG_EMBEDDING_INPUT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export type SearchResult = {
  productId: string;
  handle: string;
  title: string;
  score: number;
};

export type SemanticSearchDiagnostics = {
  candidateCount: number;
  topCandidateScore: number | null;
  vectorThreshold: number;
  embeddingCacheHit: boolean;
  llmStatus: "SUCCESS" | "FALLBACK" | "CACHE_HIT" | "OUTSIDE_CATALOG";
  llmFallbackReason: string | null;
};

export type SemanticSearchInput = {
  preparedRewrite?: QueryRewriteResult;
  shop: string;
  query: string;
  limit?: number;
  vectorOverride?: number[]; // Hỗ trợ Vector cache truyền vào
  onEmbeddingCreated?: (
    vector: number[],
    metadata: { cacheable: boolean },
  ) => void | Promise<void>; // Trả về mảng vector và cho biết có an toàn để cache hay không
  onDiagnostics?: (diagnostics: SemanticSearchDiagnostics) => void;
};

export async function semanticSearch({
  preparedRewrite,
  shop,
  query,
  limit = 20,
  vectorOverride,
  onEmbeddingCreated,
  onDiagnostics,
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
  const minimumScore = readMinimumVectorScore();
  let llmStatus: SemanticSearchDiagnostics["llmStatus"] = "CACHE_HIT";
  let llmFallbackReason: string | null = null;

  // 1. Nếu có vectorOverride từ Cache -> Dùng lại ngay, không gọi OpenAI API
  if (
    vectorOverride &&
    Array.isArray(vectorOverride) &&
    vectorOverride.length > 0
  ) {
    queryVector = vectorOverride;
  } else {
    // 2. Rewrite theo vocabulary của đúng shop trước khi tạo embedding.
    // Nếu LLM lỗi/timeout, service tự trả lại cleanQuery để search vẫn hoạt động.
    const rewrite = preparedRewrite ?? await rewriteSearchQuery({ shop, query: cleanQuery });
    llmStatus = rewrite.fallbackReason ? "FALLBACK" : "SUCCESS";
    llmFallbackReason = rewrite.fallbackReason;

    if (shouldLogEmbeddingInput()) {
      const traceMessage = rewrite.fallbackReason
        ? "[AI Search][QUERY TRACE] LLM analysis unavailable; fallback used"
        : "[AI Search][QUERY TRACE] LLM analysis completed";

      console.log(traceMessage, {
        shop,
        originalQuery: cleanQuery,
        rewrittenQuery: rewrite.query,
        catalogRelevant: rewrite.catalogRelevant,
        rewritten: rewrite.rewritten,
        llmAnalysis: rewrite.analysis,
        rewriteModel: rewrite.model,
        rewriteFallbackReason: rewrite.fallbackReason,
        embeddingModel: getEmbeddingModel(),
        willCreateEmbedding: rewrite.catalogRelevant,
      });
    }

    if (!rewrite.catalogRelevant) {
      console.log("[AI Search] Query rejected as outside shop catalog", {
        shop,
        rewriteModel: rewrite.model,
        reason: rewrite.analysis.decisionReason,
        fallbackReason: rewrite.fallbackReason,
      });
      onDiagnostics?.({
        candidateCount: 0,
        topCandidateScore: null,
        vectorThreshold: minimumScore,
        embeddingCacheHit: false,
        llmStatus: "OUTSIDE_CATALOG",
        llmFallbackReason,
      });
      return [];
    }

    if (shouldLogEmbeddingInput()) {
      console.log("[AI Search][EMBEDDING INPUT]", {
        model: getEmbeddingModel(),
        dimensions: 768,
        input: rewrite.query,
      });
    }

    queryVector = await createEmbedding(rewrite.query);

    console.log("[AI Search] Query prepared for embedding", {
      shop,
      rewritten: rewrite.rewritten,
      rewriteModel: rewrite.model,
      fallbackReason: rewrite.fallbackReason,
      embeddingInputLength: rewrite.query.length,
    });

    // Bắn callback lưu mảng Vector (number[]) vào queryEmbeddingCache trên Server
    if (onEmbeddingCreated && typeof onEmbeddingCreated === "function") {
      try {
        await onEmbeddingCreated(queryVector, {
          cacheable: rewrite.fallbackReason === null,
        });
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

  const relevantResults = results.filter(
    (result) => Number.isFinite(result.score) && result.score >= minimumScore,
  );

  console.log("[AI Search] Qdrant results:", {
    minimumScore,
    candidateCount: results.length,
    relevantCount: relevantResults.length,
    results: relevantResults.map((result) => ({
      handle: result.handle,
      score: result.score,
    })),
  });

  const rawTopScore = results[0]?.score;
  onDiagnostics?.({
    candidateCount: results.length,
    topCandidateScore:
      typeof rawTopScore === "number" && Number.isFinite(rawTopScore)
        ? rawTopScore
        : null,
    vectorThreshold: minimumScore,
    embeddingCacheHit: Boolean(vectorOverride),
    llmStatus,
    llmFallbackReason,
  });

  return relevantResults.map((result) => ({
    productId: result.productId,
    handle: result.handle,
    title: result.title,
    score: result.score,
  }));
}
