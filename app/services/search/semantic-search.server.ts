import {
  createEmbeddings,
  getEmbeddingModel,
  type EmbeddingRequestDiagnostics,
} from "./embeddings.server";
import {
  searchProductVectors,
  searchProductVectorsBatch,
} from "./vector-store.server";
import { ensureProductCollection } from "./qdrant.server";
import { rewriteSearchQuery, type QueryRewriteResult } from "./query-rewriter.server";
import { applyShopContextToQuery } from "./shop-context-index.server";

import db from "../../db.server";
import { listSearchableIndexedProducts } from "../commerce/indexed-products.server";

function readMinimumVectorScore() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_VECTOR_SCORE_THRESHOLD || "",
  );
  return Number.isFinite(value) && value >= -1 && value <= 1 ? value : 0.35;
}

function readRelativeVectorScoreRatio() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_VECTOR_RELATIVE_SCORE_RATIO || "",
  );
  return Number.isFinite(value) && value >= 0.5 && value <= 1 ? value : 0.78;
}

function readDiscoveryRelativeVectorScoreRatio() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_DISCOVERY_VECTOR_RELATIVE_SCORE_RATIO || "",
  );
  return Number.isFinite(value) && value >= 0.5 && value <= 1 ? value : 0.88;
}

function readDiscoveryMinRecallResults() {
  const value = Number.parseInt(
    process.env.AI_SEARCH_DISCOVERY_MIN_RECALL_RESULTS || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 1
    ? Math.min(value, 50)
    : 8;
}

export function computeDiscoveryRecallThreshold(args: {
  retrievalMode: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
  baseThreshold: number;
  retrievalMinimumScore: number;
  candidateScores: number[];
  hasStrongCatalogEvidence: boolean;
  minRecallResults: number;
}) {
  if (
    args.retrievalMode !== "DISCOVERY" ||
    !args.hasStrongCatalogEvidence ||
    args.minRecallResults <= 0
  ) {
    return args.baseThreshold;
  }

  const finiteScores = args.candidateScores.filter(Number.isFinite);
  const passing = finiteScores.filter(
    (score) => score >= args.baseThreshold,
  ).length;
  if (
    passing >= args.minRecallResults ||
    finiteScores.length < args.minRecallResults
  ) {
    return args.baseThreshold;
  }

  const nthScore = finiteScores[args.minRecallResults - 1];
  return Math.max(
    args.retrievalMinimumScore,
    Math.min(args.baseThreshold, nthScore),
  );
}

function retrievalModeOf(
  rewrite: QueryRewriteResult | null | undefined,
) {
  return rewrite?.planning?.retrievalMode ?? "DIRECT";
}

function readDiscoveryVectorScore() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_DISCOVERY_VECTOR_SCORE_THRESHOLD || "0.24",
  );
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0.24;
}

function readQueryEmbeddingTimeoutMs() {
  const value = Number.parseInt(
    process.env.AI_SEARCH_QUERY_EMBEDDING_TIMEOUT_MS || "",
    10,
  );

  return Number.isSafeInteger(value) && value >= 500
    ? Math.min(value, 5_000)
    : 5_000;
}

function shouldLogEmbeddingInput() {
  const value = process.env.AI_SEARCH_LOG_EMBEDDING_INPUT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const GENERIC_DISCOVERY_BRANCH_CONTEXT = new Set([
  "apparel", "clothing", "gear", "equipment", "item", "items",
  "product", "products", "goods", "outfit", "outfits", "fashion",
]);

function normalizeEmbeddingBranch(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildDiscoveryEmbeddingBranches(
  rewrite: QueryRewriteResult | null | undefined,
) {
  if (!rewrite || retrievalModeOf(rewrite) !== "DISCOVERY") return [];

  const primary = normalizeEmbeddingBranch(
    rewrite.analysis.intent ||
      rewrite.planning?.semanticQuery ||
      rewrite.query,
  );
  const semanticContext = [
    ...(rewrite.analysis.semanticMustTerms ?? []),
    ...rewrite.analysis.requiredAttributes,
    ...rewrite.analysis.useCases,
    ...rewrite.analysis.compatibility,
  ]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((value) => !/\d/.test(value))
    .filter((value) => {
      const tokens = normalizeEmbeddingBranch(value).split(" ").filter(Boolean);
      return (
        tokens.length > 0 &&
        !tokens.every((token) => GENERIC_DISCOVERY_BRANCH_CONTEXT.has(token))
      );
    })
    .slice(0, 3);

  const seen = new Set<string>();
  const branches: string[] = [];
  for (const rawExpansion of rewrite.analysis.semanticExpansions ?? []) {
    const expansion = rawExpansion.replace(/\s+/g, " ").trim();
    const normalizedExpansion = normalizeEmbeddingBranch(expansion);
    if (!normalizedExpansion || normalizedExpansion === primary) continue;
    if (
      primary &&
      (primary === normalizedExpansion ||
        primary.includes(normalizedExpansion) ||
        normalizedExpansion.includes(primary))
    ) {
      continue;
    }
    if (seen.has(normalizedExpansion)) continue;
    seen.add(normalizedExpansion);

    const parts = [expansion];
    for (const context of semanticContext) {
      const normalizedContext = normalizeEmbeddingBranch(context);
      if (
        !normalizedContext ||
        normalizeEmbeddingBranch(parts.join(" ; ")).includes(normalizedContext)
      ) {
        continue;
      }
      parts.push(context);
    }
    const branch = parts.join(" ; ").slice(0, 260).trim();
    if (branch) branches.push(branch);
    if (branches.length >= 6) break;
  }
  return branches;
}

export function buildDirectEmbeddingPlan(
  rewrite: QueryRewriteResult | null | undefined,
) {
  if (!rewrite || retrievalModeOf(rewrite) !== "DIRECT") {
    return { primary: rewrite?.query ?? "", branches: [] as string[] };
  }
  const identity = [
    rewrite.analysis.shopLanguageProductType,
    rewrite.analysis.productType,
    ...(rewrite.analysis.productTypes ?? []),
  ].map((value) => value?.replace(/\s+/g, " ").trim()).find(Boolean);
  const primary = identity || rewrite.planning?.semanticQuery || rewrite.query;
  const negative = new Set(
    (rewrite.analysis.negativeTerms ?? []).map(normalizeEmbeddingBranch),
  );
  const facets = [
    ...rewrite.analysis.brands,
    ...rewrite.analysis.models,
    ...rewrite.analysis.requiredAttributes,
    ...rewrite.analysis.optionalPreferences,
    ...rewrite.analysis.attributes,
    ...rewrite.analysis.audience,
  ]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((value) => !/\d/.test(value))
    .filter((value) => !negative.has(normalizeEmbeddingBranch(value)))
    .filter((value, index, list) =>
      list.findIndex((candidate) =>
        normalizeEmbeddingBranch(candidate) === normalizeEmbeddingBranch(value),
      ) === index,
    )
    .filter((value) => !normalizeEmbeddingBranch(primary).includes(normalizeEmbeddingBranch(value)))
    .slice(0, 4);
  const facetBranch = facets.length > 0
    ? [primary, ...facets].join(" ; ").slice(0, 260)
    : "";
  return {
    primary,
    branches: facetBranch && normalizeEmbeddingBranch(facetBranch) !== normalizeEmbeddingBranch(primary)
      ? [facetBranch]
      : [],
  };
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

export function fuseSemanticVectorBranches(
  resultSets: SearchResult[][],
  limit: number,
) {
  const fused = new Map<
    string,
    { result: SearchResult; score: number; branchHits: number }
  >();

  resultSets.forEach((results, branchIndex) => {
    const branchWeight = branchIndex === 0 ? 1 : 0.98;
    for (const result of results) {
      const weightedScore = result.score * branchWeight;
      const current = fused.get(result.productId);
      if (!current) {
        fused.set(result.productId, {
          result,
          score: weightedScore,
          branchHits: 1,
        });
        continue;
      }
      current.branchHits += 1;
      if (weightedScore > current.score) {
        current.result = result;
        current.score = weightedScore;
      }
    }
  });

  return [...fused.values()]
    .map(({ result, score, branchHits }) => ({
      ...result,
      // Tiny consensus bonus helps a product supported by both the general
      // need vector and a product-class branch without allowing broad branch
      // membership to dominate ranking.
      score: Math.min(1, score + Math.min(0.03, (branchHits - 1) * 0.01)),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
}

export type SemanticSearchDiagnostics = {
  primaryEmbeddingInput?: string;
  semanticFacetBranches?: string[];
  retrievalMode: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
  noEvidenceGuardTriggered: boolean;
  noEvidenceThreshold: number;
  topVectorScore: number | null;
  hasStrongCatalogEvidence: boolean;
  candidateCount: number;
  topCandidateScore: number | null;
  vectorThreshold: number;
  embeddingCacheHit: boolean;
  llmStatus:
    | "SUCCESS"
    | "FALLBACK"
    | "CACHE_HIT"
    | "CODE_ONLY"
    | "OUTSIDE_CATALOG";
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

function inferLlmStatus(
  rewrite: QueryRewriteResult | undefined,
): SemanticSearchDiagnostics["llmStatus"] {
  if (!rewrite) return "CODE_ONLY";
  if (rewrite.fallbackReason) return "FALLBACK";
  if (!rewrite.model) return "CODE_ONLY";
  if (
    rewrite.timing?.cacheStatus === "HIT" ||
    rewrite.timing?.cacheStatus === "JOINED"
  ) {
    return "CACHE_HIT";
  }
  return "SUCCESS";
}

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
  let embeddingCallCount = 0;
  let semanticBranchInputs: string[] = [];
  let semanticBranchVectors: number[][] = [];
  let primaryEmbeddingInputForDiagnostics = cleanQuery;
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
  // Query ngoÃ i catalog khÃ´ng cáº§n cháº¡m Qdrant.
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
      inferLlmStatus(preparedRewrite);

  let llmFallbackReason:
    string | null =
      preparedRewrite?.fallbackReason ?? null;

  const transientLlmFallbackReasons = new Set([
    "LLM_TIMEOUT",
    "LLM_ERROR",
    "LLM_INCOMPLETE",
    "LLM_OUTPUT_TRUNCATED",
    "INVALID_LLM_OUTPUT",
  ]);

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

    const directPlan = buildDirectEmbeddingPlan(preparedRewrite);
    semanticBranchInputs = retrievalModeOf(preparedRewrite) === "DISCOVERY"
      ? buildDiscoveryEmbeddingBranches(preparedRewrite)
      : directPlan.branches;
    if (semanticBranchInputs.length > 0) {
      void ensureCollectionReady();
      const embeddingStartedAt = Date.now();
      semanticBranchVectors = await createEmbeddings(
        semanticBranchInputs,
        {
          maxRetries: 0,
          timeoutMs: readQueryEmbeddingTimeoutMs(),
          usageContext: {
            shop,
            operation: "QUERY_EMBEDDING",
          },
          onDiagnostics: (diagnostics) => {
            embeddingRequestDiagnostics = diagnostics;
          },
        },
      );
      embeddingCallCount = 1;
      embeddingMs = Date.now() - embeddingStartedAt;

      // The primary vector came from cache, but the expansion batch is a real
      // provider call and must consume the same query-embedding reservation.
      if (onEmbeddingCreated) {
        const usageStartedAt = Date.now();
        usageCompleted = (async () => {
          try {
            await onEmbeddingCreated(queryVector, { cacheable: false });
          } catch (usageError) {
            console.error(
              "[AI Search] Query expansion embedding callback failed:",
              usageError,
            );
          } finally {
            usageMs = Date.now() - usageStartedAt;
          }
        })();
      }
    }
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
      inferLlmStatus(rewrite);

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
        retrievalMode: retrievalModeOf(rewrite),
        noEvidenceGuardTriggered: false,
        noEvidenceThreshold: 0,
        topVectorScore: null,
        hasStrongCatalogEvidence: false,
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

    const directPlan = buildDirectEmbeddingPlan(rewrite);
    const primaryEmbeddingInput = directPlan.primary || rewrite.query;
    primaryEmbeddingInputForDiagnostics = primaryEmbeddingInput;
    semanticBranchInputs = retrievalModeOf(rewrite) === "DISCOVERY"
      ? buildDiscoveryEmbeddingBranches(rewrite)
      : directPlan.branches;
    const embeddingInputs = [
      primaryEmbeddingInput,
      ...semanticBranchInputs,
    ];

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
            primaryEmbeddingInput,

          semanticBranchInputs,
          batchInputCount:
            embeddingInputs.length,
        },
      );
    }

    embeddingPreparationCodeMs +=
      Date.now() -
      preparationStartedAt;

    // Cháº¡y chuáº©n bá»‹ Qdrant song song
    // vá»›i OpenAI embedding.
    void ensureCollectionReady();

    const embeddingStartedAt =
      Date.now();

    const embeddingVectors =
      await createEmbeddings(
        embeddingInputs,
        {
          maxRetries:
            0,

          timeoutMs:
            readQueryEmbeddingTimeoutMs(),

          usageContext: {
            shop,
            operation: "QUERY_EMBEDDING",
          },

          onDiagnostics:
            (
              diagnostics,
            ) => {
              embeddingRequestDiagnostics =
                diagnostics;
            },
        },
      );

    embeddingCallCount = 1;
    queryVector = embeddingVectors[0];
    semanticBranchVectors = embeddingVectors.slice(1);

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
          primaryEmbeddingInput.length,

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
          primaryEmbeddingInput.length,

        embeddingInput:
          primaryEmbeddingInput,

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

  const transientLlmFallback =
    Boolean(
      llmFallbackReason &&
      transientLlmFallbackReasons.has(llmFallbackReason),
    );

  const configuredFallbackScore = Number.parseFloat(
    process.env.AI_SEARCH_TRANSIENT_FALLBACK_VECTOR_SCORE_THRESHOLD || "0.18",
  );
  const safeFallbackScore =
    Number.isFinite(configuredFallbackScore) &&
    configuredFallbackScore >= 0 &&
    configuredFallbackScore <= 1
      ? configuredFallbackScore
      : 0.18;

  const retrievalMode =
    retrievalModeOf(effectiveRewrite);
  const discoveryMinimumScore =
    readDiscoveryVectorScore();

  const retrievalMinimumScore =
    transientLlmFallback
      ? Math.min(minimumScore, safeFallbackScore)
      : retrievalMode === "DISCOVERY" ||
          retrievalMode === "COMPLEMENT"
        ? Math.min(minimumScore, discoveryMinimumScore)
        : minimumScore;

  const onQdrantDiagnostics = (
    diagnostics: {
      requestMs: number;
      responseMappingCodeMs: number;
      passCount: number;
      finalCandidateWindow: number;
    },
  ) => {
    qdrantRequestMs = diagnostics.requestMs;
    qdrantResponseMappingCodeMs = diagnostics.responseMappingCodeMs;
    qdrantPassCount = diagnostics.passCount;
    qdrantFinalCandidateWindow = diagnostics.finalCandidateWindow;
  };

  const retrievalTask =
    semanticBranchVectors.length > 0
      ? searchProductVectorsBatch({
          shop,
          vectors: [
            queryVector,
            ...semanticBranchVectors,
          ],
          limits: [
            limit,
            ...semanticBranchVectors.map(() =>
              Math.min(
                60,
                Math.max(
                  20,
                  Math.ceil(limit / Math.max(8, semanticBranchVectors.length * 2)),
                ),
              ),
            ),
          ],
          scoreThreshold:
            retrievalMinimumScore,
          onDiagnostics:
            onQdrantDiagnostics,
        }).then((resultSets) =>
          fuseSemanticVectorBranches(resultSets, limit),
        )
      : searchProductVectors({
          shop,
          vector:
            queryVector,
          limit,
          scoreThreshold:
            retrievalMinimumScore,
          onDiagnostics:
            onQdrantDiagnostics,
        });

  const retrievalPromise =
    retrievalTask.then(
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

  // Usage accounting pháº£i hoÃ n táº¥t
  // trÆ°á»›c khi caller rollback failed search.
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
    const identityRows = await listSearchableIndexedProducts(
      shop,
      identityIds.filter((id) => !existing.has(id)).slice(0, limit),
    );
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
  // Qdrant khÃ´ng pháº£i source of truth cuá»‘i cÃ¹ng.
  //
  // Chá»‰ giá»¯ vector khi DB registry xÃ¡c nháº­n:
  //
  // searchable = true
  // hasVector = true
  //
  // Má»¥c tiÃªu:
  //
  // - orphan vector khÃ´ng xuáº¥t hiá»‡n trÃªn storefront
  // - orphan vector khÃ´ng áº£nh hÆ°á»Ÿng relative threshold
  // - orphan vector khÃ´ng bá»‹ Ä‘Æ°a vÃ o render receipt
  //
  // Search-time chá»‰ FILTER, khÃ´ng DELETE.
  //
  // KhÃ´ng delete ngay á»Ÿ Ä‘Ã¢y vÃ¬ search cÃ³ thá»ƒ trÃºng Ä‘Ãºng khoáº£ng
  // thá»i gian ráº¥t ngáº¯n:
  //
  // Qdrant upsert
  //       â†“
  // DB registry upsert
  //
  // Background reconciliation sáº½ xá»­ lÃ½ delete lÃ¢u dÃ i.
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
      await listSearchableIndexedProducts(shop, resultProductIds);

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
  // Quan trá»ng:
  //
  // threshold pháº£i tÃ­nh SAU registry guard.
  //
  // Náº¿u orphan vector cÃ³ score cao nháº¥t,
  // nÃ³ khÃ´ng Ä‘Æ°á»£c phÃ©p Ä‘áº©y threshold lÃªn
  // vÃ  lÃ m loáº¡i nháº§m product há»£p lá»‡.
  // ============================================================

  const thresholdStartedAt =
    Date.now();

  const topVectorScore =
    registryValidatedResults[
      0
    ]?.score;

  const relativeRatio =
    retrievalMode === "DIRECT"
      ? readRelativeVectorScoreRatio()
      : readDiscoveryRelativeVectorScoreRatio();

  const baseMinimumScore =
    typeof topVectorScore ===
      "number" &&
    Number.isFinite(
      topVectorScore,
    )
      ? Math.max(
          retrievalMinimumScore,

          topVectorScore *
            relativeRatio,
        )
      : retrievalMinimumScore;

  const discoveryExpansionGroundedIds =
    retrievalMode === "DISCOVERY"
      ? (effectiveRewrite?.context?.discoveryExpansionGroundedProductIds ?? [])
      : [];
  const strongContextKinds = new Set([
    "CATEGORY",
    "CANONICAL_PRODUCT_TYPE",
    "PRODUCT_TYPE",
    "ALIAS",
    "USE_CASE",
    "SOFT_CONTEXT",
    "ATTRIBUTE",
    "AUDIENCE",
    "COMPATIBILITY",
  ]);
  const hasStrongCatalogEvidence =
    Boolean(
      effectiveRewrite?.context?.selectedTerms.some(
        (term) =>
          strongContextKinds.has(term.kind) &&
          term.score >= 12 &&
          !(
            retrievalMode === "DISCOVERY" &&
            ["PRODUCT_TYPE", "ALIAS"].includes(term.kind)
          ),
      ),
    ) ||
    discoveryExpansionGroundedIds.length > 0;
  const discoveryMinRecallResults = readDiscoveryMinRecallResults();
  const effectiveMinimumScore = computeDiscoveryRecallThreshold({
    retrievalMode,
    baseThreshold: baseMinimumScore,
    retrievalMinimumScore,
    candidateScores: registryValidatedResults.map((result) => result.score),
    hasStrongCatalogEvidence,
    minRecallResults: discoveryMinRecallResults,
  });
  const configuredTransientNoEvidenceTopScore = Number.parseFloat(
    process.env.AI_SEARCH_TRANSIENT_FALLBACK_NO_EVIDENCE_MIN_TOP_SCORE || "0.30",
  );
  const transientNoEvidenceTopScore =
    Number.isFinite(configuredTransientNoEvidenceTopScore) &&
    configuredTransientNoEvidenceTopScore >= 0 &&
    configuredTransientNoEvidenceTopScore <= 1
      ? configuredTransientNoEvidenceTopScore
      : 0.30;
  const configuredNoEvidenceTopScore = Number.parseFloat(
    process.env.AI_SEARCH_NO_EVIDENCE_MIN_TOP_SCORE || "0.45",
  );
  const noEvidenceTopScore =
    Number.isFinite(configuredNoEvidenceTopScore) &&
    configuredNoEvidenceTopScore >= 0 && configuredNoEvidenceTopScore <= 1
      ? configuredNoEvidenceTopScore
      : 0.45;

  const transientNoEvidenceThreshold =
    retrievalMode === "COMPLEMENT"
      ? noEvidenceTopScore
      : transientNoEvidenceTopScore;
  const weakNoEvidenceVector =
    !hasStrongCatalogEvidence &&
    typeof topVectorScore === "number" &&
    Number.isFinite(topVectorScore) &&
    (
      (
        (llmStatus === "SUCCESS" || llmStatus === "CACHE_HIT") &&
        effectiveRewrite?.fallbackReason === null &&
        effectiveRewrite?.model !== null &&
        topVectorScore < noEvidenceTopScore
      ) ||
      (
        transientLlmFallback &&
        topVectorScore < transientNoEvidenceThreshold
      )
    );

  let relevantResults =
    weakNoEvidenceVector
      ? []
      : registryValidatedResults.filter(
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
      minimumScore:
        retrievalMinimumScore,

      configuredMinimumScore:
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

      weakNoEvidenceVector,
      noEvidenceTopScore,
      topVectorScore,
      hasStrongCatalogEvidence,

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
    primaryEmbeddingInput: primaryEmbeddingInputForDiagnostics.slice(0, 300),
    semanticFacetBranches: semanticBranchInputs.slice(0, 6).map((value) => value.slice(0, 300)),
    retrievalMode,
    noEvidenceGuardTriggered: weakNoEvidenceVector,
    noEvidenceThreshold: transientLlmFallback
      ? transientNoEvidenceThreshold
      : noEvidenceTopScore,
    topVectorScore: typeof topVectorScore === "number" ? topVectorScore : null,
    hasStrongCatalogEvidence,
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

    embeddingCallCount,

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
