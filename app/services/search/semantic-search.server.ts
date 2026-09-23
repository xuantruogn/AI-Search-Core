import {
  createEmbedding,
  getEmbeddingModel,
  type EmbeddingRequestDiagnostics,
} from "./embeddings.server";
import { searchProductVectors } from "./vector-store.server";
import { ensureProductCollection } from "./qdrant.server";
import { rewriteSearchQuery, type QueryRewriteResult } from "./query-rewriter.server";
import { applyShopContextToQuery } from "./shop-context-index.server";

import db from "../../db.server";

function readMinimumVectorScore() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_VECTOR_SCORE_THRESHOLD || "",
  );
  return Number.isFinite(value) && value >= -1 && value <= 1 ? value : 0.25;
}

function readRelativeVectorScoreRatio() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_VECTOR_RELATIVE_SCORE_RATIO || "",
  );
  return Number.isFinite(value) && value >= 0.5 && value <= 1 ? value : 0.78;
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
  minVariantPrice?: number;
  maxVariantPrice?: number;
  currencyCode?: string;
};

export type SemanticSearchDiagnostics = {
  candidateCount: number;
  topCandidateScore: number | null;
  vectorThreshold: number;
  embeddingCacheHit: boolean;
  llmStatus: "SUCCESS" | "FALLBACK" | "CACHE_HIT" | "OUTSIDE_CATALOG";
  llmFallbackReason: string | null;
  ensureCollectionMs: number;
  embeddingMs: number;
  embeddingCallCount: number;
  embeddingOpenAiProcessingMs: number | null;
  embeddingNetworkAndSdkMs: number | null;
  embeddingRequestId: string | null;
  embeddingClientRequestId: string | null;
  embeddingMaxRetries: number;
  qdrantMs: number;
  usageLoggingMs: number;
  collectionWaitMs: number;
  embeddingPreparationCodeMs: number;
  qdrantRequestMs: number;
  qdrantResponseMappingCodeMs: number;
  qdrantPassCount: number;
  qdrantFinalCandidateWindow: number;
  thresholdFilterCodeMs: number;
  resultMappingCodeMs: number;
  otherCodeMs: number;
  totalMs: number;
};

export type SemanticSearchInput = {
  preparedRewrite?: QueryRewriteResult;
  shop: string;
  query: string;
  limit?: number;
  vectorOverride?: number[];
  onEmbeddingCreated?: (
    vector: number[],
    metadata: { cacheable: boolean },
  ) => void | Promise<void>;
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

  const stageStartedAt = Date.now();

  let embeddingMs = 0;
  let embeddingRequestDiagnostics:
    | EmbeddingRequestDiagnostics
    | null = null;

  let usageMs = 0;
  let ensureMs = 0;
  let collectionWaitMs = 0;
  let embeddingPreparationCodeMs = 0;
  let qdrantRequestMs = 0;
  let qdrantResponseMappingCodeMs = 0;
  let qdrantPassCount = 0;
  let qdrantFinalCandidateWindow = 0;
  let thresholdFilterCodeMs = 0;
  let resultMappingCodeMs = 0;
  let effectiveRewrite = preparedRewrite;

  // Start Qdrant lazily.
  // Query ngoài catalog không cần chạm Qdrant.
  let collectionReady:
    | Promise<
        | { ok: true }
        | {
            ok: false;
            error: unknown;
          }
      >
    | null = null;

  const ensureCollectionReady = () => {
    if (!collectionReady) {
      const ensureStartedAt =
        Date.now();

      collectionReady =
        ensureProductCollection().then(
          () => {
            ensureMs =
              Date.now() -
              ensureStartedAt;

            return {
              ok: true as const,
            };
          },

          (error: unknown) => {
            ensureMs =
              Date.now() -
              ensureStartedAt;

            return {
              ok: false as const,
              error,
            };
          },
        );
    }

    return collectionReady;
  };

  let usageCompleted:
    Promise<void> =
      Promise.resolve();

  let queryVector:
    number[];

  const minimumScore =
    readMinimumVectorScore();

  let llmStatus:
    SemanticSearchDiagnostics["llmStatus"] =
      "CACHE_HIT";

  let llmFallbackReason:
    string | null =
      null;

  // ============================================================
  // 1. QUERY EMBEDDING
  // ============================================================

  if (
    vectorOverride &&
    Array.isArray(
      vectorOverride,
    ) &&
    vectorOverride.length > 0
  ) {
    queryVector =
      vectorOverride;
  } else {
    const preparationStartedAt =
      Date.now();

    const interpreted =
      preparedRewrite ??
      await rewriteSearchQuery({
        shop,
        query:
          cleanQuery,
      });

    const rewrite =
      interpreted.context
        ? interpreted
        : await applyShopContextToQuery({
            shop,

            originalQuery:
              cleanQuery,

            rewrite:
              interpreted,
          });
    effectiveRewrite = rewrite;

    llmStatus =
      rewrite.fallbackReason
        ? "FALLBACK"
        : "SUCCESS";

    llmFallbackReason =
      rewrite.fallbackReason;

    if (
      shouldLogEmbeddingInput()
    ) {
      console.log(
        "[AI Search][QUERY TRACE] Query analysis prepared",
        {
          shop,

          originalQuery:
            cleanQuery,

          rewrittenQuery:
            rewrite.query,

          catalogRelevant:
            rewrite.catalogRelevant,

          rewritten:
            rewrite.rewritten,

          llmAnalysis:
            rewrite.analysis,

          selectedShopContext:
            rewrite.context
              ?.selectedTerms ??
            [],

          rewriteModel:
            rewrite.model,

          rewriteFallbackReason:
            rewrite.fallbackReason,

          route: rewrite.planning?.route ?? "LEGACY",

          analysisSource: rewrite.timing?.llmCallCount
            ? "LLM"
            : "CODE",

          semanticQuery: rewrite.planning?.semanticQuery ?? rewrite.query,

          semanticResolution: rewrite.planning?.semanticResolution ?? "LEGACY",

          semanticResolutionConfidence:
            rewrite.planning?.semanticResolutionConfidence ?? rewrite.analysis.confidence,

          embeddingModel:
            getEmbeddingModel(),

          willCreateEmbedding:
            rewrite.catalogRelevant,
        },
      );
    }

    if (
      !rewrite.catalogRelevant
    ) {
      embeddingPreparationCodeMs +=
        Date.now() -
        preparationStartedAt;

      console.log(
        "[AI Search] Query rejected as outside shop catalog",
        {
          shop,

          rewriteModel:
            rewrite.model,

          reason:
            rewrite.analysis
              .decisionReason,

          fallbackReason:
            rewrite.fallbackReason,
        },
      );

      onDiagnostics?.({
        candidateCount:
          0,

        topCandidateScore:
          null,

        vectorThreshold:
          minimumScore,

        embeddingCacheHit:
          false,

        llmStatus:
          "OUTSIDE_CATALOG",

        llmFallbackReason,

        ensureCollectionMs:
          ensureMs,

        embeddingMs,

        embeddingCallCount:
          0,

        embeddingOpenAiProcessingMs:
          null,

        embeddingNetworkAndSdkMs:
          null,

        embeddingRequestId:
          null,

        embeddingClientRequestId:
          null,

        embeddingMaxRetries:
          0,

        qdrantMs:
          0,

        usageLoggingMs:
          usageMs,

        collectionWaitMs,

        embeddingPreparationCodeMs,

        qdrantRequestMs,

        qdrantResponseMappingCodeMs,

        qdrantPassCount,

        qdrantFinalCandidateWindow,

        thresholdFilterCodeMs,

        resultMappingCodeMs,

        otherCodeMs:
          Math.max(
            0,

            Date.now() -
              stageStartedAt -
              ensureMs,
          ),

        totalMs:
          Date.now() -
          stageStartedAt,
      });

      return [];
    }

    if (
      shouldLogEmbeddingInput()
    ) {
      console.log(
        "[AI Search][EMBEDDING INPUT]",
        {
          model:
            getEmbeddingModel(),

          dimensions:
            768,

          input:
            rewrite.query,
        },
      );
    }

    embeddingPreparationCodeMs +=
      Date.now() -
      preparationStartedAt;

    // Chạy chuẩn bị Qdrant song song
    // với OpenAI embedding.
    void ensureCollectionReady();

    const embeddingStartedAt =
      Date.now();

    queryVector =
      await createEmbedding(
        rewrite.query,
        {
          maxRetries:
            0,

          onDiagnostics:
            (
              diagnostics,
            ) => {
              embeddingRequestDiagnostics =
                diagnostics;
            },
        },
      );

    embeddingMs =
      Date.now() -
      embeddingStartedAt;

    const embeddingDetails =
      embeddingRequestDiagnostics as
        | EmbeddingRequestDiagnostics
        | null;

    console.log(
      "[AI Search][PERF] OpenAI embedding request",
      {
        shop,

        model:
          getEmbeddingModel(),

        inputLength:
          rewrite.query.length,

        dimensions:
          768,

        endToEndMs:
          embeddingDetails
            ?.endToEndMs ??
          embeddingMs,

        openAiProcessingMs:
          embeddingDetails
            ?.openAiProcessingMs ??
          null,

        networkAndSdkMs:
          embeddingDetails
            ?.networkAndSdkMs ??
          null,

        requestId:
          embeddingDetails
            ?.requestId ??
          null,

        clientRequestId:
          embeddingDetails
            ?.clientRequestId ??
          null,

        timeoutMs:
          embeddingDetails
            ?.timeoutMs ??
          null,

        maxRetries:
          embeddingDetails
            ?.maxRetries ??
          0,

        remainingRequests:
          embeddingDetails
            ?.remainingRequests ??
          null,

        remainingTokens:
          embeddingDetails
            ?.remainingTokens ??
          null,

        resetRequests:
          embeddingDetails
            ?.resetRequests ??
          null,

        resetTokens:
          embeddingDetails
            ?.resetTokens ??
          null,

        responseEncoding:
          embeddingDetails
            ?.responseEncoding ??
          "base64",

        clientAgeMs:
          embeddingDetails?.clientAgeMs ?? null,

        clientRequestOrdinal:
          embeddingDetails?.clientRequestOrdinal ?? null,
      },
    );

    console.log(
      "[AI Search] Query prepared for embedding",
      {
        shop,

        rewritten:
          rewrite.rewritten,

        rewriteModel:
          rewrite.model,

        fallbackReason:
          rewrite.fallbackReason,

        embeddingInputLength:
          rewrite.query.length,

        embeddingInput:
          rewrite.query,

        route:
          rewrite.planning?.route ?? "LEGACY",

        semanticResolution:
          rewrite.planning?.semanticResolution ?? "LEGACY",

        semanticResolutionConfidence:
          rewrite.planning?.semanticResolutionConfidence ?? rewrite.analysis.confidence,
      },
    );

    if (
      onEmbeddingCreated &&
      typeof onEmbeddingCreated ===
        "function"
    ) {
      const usageStartedAt =
        Date.now();

      usageCompleted =
        (async () => {
          try {
            await onEmbeddingCreated(
              queryVector,
              {
                cacheable:
                  true,
              },
            );
          } catch (
            usageError
          ) {
            console.error(
              "[AI Search] Query embedding callback failed:",
              usageError,
            );
          } finally {
            usageMs =
              Date.now() -
              usageStartedAt;
          }
        })();
    }
  }

  console.log(
    "[AI Search] Query embedding dimensions:",
    queryVector.length,
  );

  // ============================================================
  // 2. QDRANT RETRIEVAL
  // ============================================================

  const collectionWaitStartedAt =
    Date.now();

  const ready =
    await ensureCollectionReady();

  collectionWaitMs =
    Date.now() -
    collectionWaitStartedAt;

  if (
    !ready.ok
  ) {
    await usageCompleted;

    throw ready.error;
  }

  const qdrantStartedAt =
    Date.now();

  let qdrantMs =
    0;

  const retrievalPromise =
    searchProductVectors({
      shop,

      vector:
        queryVector,

      limit,

      scoreThreshold:
        minimumScore,

      onDiagnostics:
        (
          diagnostics,
        ) => {
          qdrantRequestMs =
            diagnostics
              .requestMs;

          qdrantResponseMappingCodeMs =
            diagnostics
              .responseMappingCodeMs;

          qdrantPassCount = diagnostics.passCount;
          qdrantFinalCandidateWindow = diagnostics.finalCandidateWindow;
        },
    }).then(
      (value) => {
        qdrantMs =
          Date.now() -
          qdrantStartedAt;

        return value;
      },

      (
        error:
          unknown,
      ) => {
        qdrantMs =
          Date.now() -
          qdrantStartedAt;

        throw error;
      },
    );

  const [
    retrieval,
  ] =
    await Promise.allSettled([
      retrievalPromise,
      usageCompleted,
    ]);

  // Usage accounting phải hoàn tất
  // trước khi caller rollback failed search.
  if (
    retrieval.status ===
    "rejected"
  ) {
    throw retrieval.reason;
  }

  let results = retrieval.value;

  const identityIds = effectiveRewrite?.context?.identityCandidateProductIds ?? [];
  const vectorCandidateCount = results.length;
  if (identityIds.length > 0) {
    const existing = new Set(results.map((result) => result.productId));
    const identityRows = await db.aiSearchIndexedProduct.findMany({
      where: {
        shop,
        productId: { in: identityIds.filter((id) => !existing.has(id)).slice(0, limit) },
        status: "INDEXED",
        hasVector: true,
      },
      select: { productId: true, handle: true, title: true },
    });
    const identitySet = new Set(identityIds);
    results = [
      ...results.map((result) => identitySet.has(result.productId)
        ? { ...result, score: Math.min(1, result.score + 0.2) }
        : result),
      ...identityRows.map((row) => ({ ...row, score: 0.5 })),
    ].sort((left, right) => right.score - left.score).slice(0, limit);
  }
  console.log("[AI Search][CANDIDATE GENERATION]", {
    shop,
    route: effectiveRewrite?.planning?.route ?? "LEGACY",
    identityCandidateCount: identityIds.length,
    vectorCandidateCount,
    unionCandidateCount: results.length,
    canonicalTypeCoverageComplete:
      effectiveRewrite?.context?.canonicalTypeCoverageComplete ?? false,
  });

  // ============================================================
  // 3. REGISTRY GUARD
  //
  // Qdrant không phải source of truth cuối cùng.
  //
  // Chỉ giữ vector khi DB registry xác nhận:
  //
  // status = INDEXED
  // hasVector = true
  //
  // Mục tiêu:
  //
  // - orphan vector không xuất hiện trên storefront
  // - orphan vector không ảnh hưởng relative threshold
  // - orphan vector không bị đưa vào render receipt
  //
  // Search-time chỉ FILTER, không DELETE.
  //
  // Không delete ngay ở đây vì search có thể trúng đúng khoảng
  // thời gian rất ngắn:
  //
  // Qdrant upsert
  //       ↓
  // DB registry upsert
  //
  // Background reconciliation sẽ xử lý delete lâu dài.
  // ============================================================

  const resultProductIds =
    [
      ...new Set(
        results
          .map(
            (
              result,
            ) =>
              String(
                result.productId ||
                  "",
              ).trim(),
          )
          .filter(
            Boolean,
          ),
      ),
    ];

  let registryValidatedResults =
    results;

  if (
    resultProductIds.length >
    0
  ) {
    const validRegistryRows =
      await db
        .aiSearchIndexedProduct
        .findMany({
          where: {
            shop,

            productId: {
              in:
                resultProductIds,
            },

            status:
              "INDEXED",

            hasVector:
              true,
          },

          select: {
            productId:
              true,
          },
        });

    const validProductIds =
      new Set(
        validRegistryRows.map(
          (
            row,
          ) =>
            row.productId,
        ),
      );

    registryValidatedResults =
      results.filter(
        (
          result,
        ) =>
          validProductIds.has(
            result.productId,
          ),
      );

    const orphanProductIds =
      resultProductIds.filter(
        (
          productId,
        ) =>
          !validProductIds.has(
            productId,
          ),
      );

    if (
      orphanProductIds.length >
      0
    ) {
      console.warn(
        "[AI Search] Qdrant orphan/stale vectors filtered from search",
        {
          shop,

          qdrantCandidateCount:
            results.length,

          validCandidateCount:
            registryValidatedResults.length,

          filteredCount:
            orphanProductIds.length,

          productIds:
            orphanProductIds,
        },
      );
    }
  }

  console.log(
    "[AI Search][PERF] Retrieval stages",
    {
      shop,

      ensureMs,

      qdrantEnsureMs:
        ensureMs,

      embeddingMs,

      usageMs,

      qdrantMs,

      totalMs:
        Date.now() -
        stageStartedAt,

      embeddingCacheHit:
        Boolean(
          vectorOverride,
        ),
    },
  );

  // ============================================================
  // 4. SIMILARITY THRESHOLD
  //
  // Quan trọng:
  //
  // threshold phải tính SAU registry guard.
  //
  // Nếu orphan vector có score cao nhất,
  // nó không được phép đẩy threshold lên
  // và làm loại nhầm product hợp lệ.
  // ============================================================

  const thresholdStartedAt =
    Date.now();

  const topVectorScore =
    registryValidatedResults[
      0
    ]?.score;

  const relativeRatio =
    readRelativeVectorScoreRatio();

  const effectiveMinimumScore =
    typeof topVectorScore ===
      "number" &&
    Number.isFinite(
      topVectorScore,
    )
      ? Math.max(
          minimumScore,

          topVectorScore *
            relativeRatio,
        )
      : minimumScore;

  const relevantResults =
    registryValidatedResults.filter(
      (
        result,
      ) =>
        Number.isFinite(
          result.score,
        ) &&
        result.score >=
          effectiveMinimumScore,
    );

  thresholdFilterCodeMs =
    Date.now() -
    thresholdStartedAt;

  console.log(
    "[AI Search] Qdrant results:",
    {
      minimumScore,

      effectiveMinimumScore:
        Number(
          effectiveMinimumScore.toFixed(
            4,
          ),
        ),

      relativeRatio,

      qdrantCandidateCount:
        results.length,

      candidateCount:
        registryValidatedResults.length,

      filteredOrphanCount:
        results.length -
        registryValidatedResults.length,

      relevantCount:
        relevantResults.length,

      resultsPreview:
        relevantResults
          .slice(
            0,
            10,
          )
          .map(
            (
              result,
            ) => ({
              handle:
                result.handle,

              score:
                result.score,
            }),
          ),
    },
  );

  const rawTopScore =
    registryValidatedResults[
      0
    ]?.score;

  // ============================================================
  // 5. MAP FINAL SEARCH RESULTS
  // ============================================================

  const resultMappingStartedAt =
    Date.now();

  const mappedResults =
    relevantResults.map(
      (
        result,
      ) => ({
        productId:
          result.productId,

        handle:
          result.handle,

        title:
          result.title,

        score:
          result.score,

        minVariantPrice:
          result.minVariantPrice,

        maxVariantPrice:
          result.maxVariantPrice,

        currencyCode:
          result.currencyCode,
      }),
    );

  resultMappingCodeMs =
    Date.now() -
    resultMappingStartedAt;

  const totalMs =
    Date.now() -
    stageStartedAt;

  const knownSerialMs =
    embeddingPreparationCodeMs +
    embeddingMs +
    collectionWaitMs +
    qdrantMs +
    thresholdFilterCodeMs +
    resultMappingCodeMs;

  const finalEmbeddingDetails =
    embeddingRequestDiagnostics as
      | EmbeddingRequestDiagnostics
      | null;

  onDiagnostics?.({
    candidateCount:
      registryValidatedResults.length,

    topCandidateScore:
      typeof rawTopScore ===
        "number" &&
      Number.isFinite(
        rawTopScore,
      )
        ? rawTopScore
        : null,

    vectorThreshold:
      effectiveMinimumScore,

    embeddingCacheHit:
      Boolean(
        vectorOverride,
      ),

    llmStatus,

    llmFallbackReason,

    ensureCollectionMs:
      ensureMs,

    embeddingMs,

    embeddingCallCount:
      vectorOverride
        ? 0
        : 1,

    embeddingOpenAiProcessingMs:
      finalEmbeddingDetails
        ?.openAiProcessingMs ??
      null,

    embeddingNetworkAndSdkMs:
      finalEmbeddingDetails
        ?.networkAndSdkMs ??
      null,

    embeddingRequestId:
      finalEmbeddingDetails
        ?.requestId ??
      null,

    embeddingClientRequestId:
      finalEmbeddingDetails
        ?.clientRequestId ??
      null,

    embeddingMaxRetries:
      finalEmbeddingDetails
        ?.maxRetries ??
      0,

    qdrantMs,

    usageLoggingMs:
      usageMs,

    collectionWaitMs,

    embeddingPreparationCodeMs,

    qdrantRequestMs,

    qdrantResponseMappingCodeMs,

    qdrantPassCount,

    qdrantFinalCandidateWindow,

    thresholdFilterCodeMs,

    resultMappingCodeMs,

    otherCodeMs:
      Math.max(
        0,

        totalMs -
          knownSerialMs,
      ),

    totalMs,
  });

  return mappedResults;
}
