import db from "../../db.server";
import { hashSearchQuery } from "../commerce/usage.server";

export type RankedSearchProduct = {
  productId: string;
  handle: string;
  rank: number;
  score: number;
};

export type SearchAnalyticsDiagnostics = {
  candidateCount: number;
  topCandidateScore: number | null;
  vectorThreshold: number;
  embeddingCacheHit: boolean;
  llmStatus: "SUCCESS" | "FALLBACK" | "CACHE_HIT" | "OUTSIDE_CATALOG";
  llmFallbackReason: string | null;
};

function normalizeQuery(query: string) {
  return query.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

export async function recordSearchQueryLog({
  shop,
  query,
  queryVector,
  analyzedQuery,
  llmAnalysis,
  selectedContext,
  rankedProducts,
  diagnostics,
  totalDurationMs,
  onDiagnostics,
}: {
  shop: string;
  query: string;
  queryVector?: number[] | null;
  analyzedQuery?: string | null;
  llmAnalysis?: unknown;
  selectedContext?: unknown;
  rankedProducts: RankedSearchProduct[];
  diagnostics: SearchAnalyticsDiagnostics;
  totalDurationMs: number;
  onDiagnostics?: (diagnostics: {
    serializationCodeMs: number;
    dbWriteMs: number;
    totalMs: number;
  }) => void;
}) {
  const totalStartedAt = Date.now();
  const serializationStartedAt = Date.now();
  const queryVectorJson =
    rankedProducts.length === 0 &&
    queryVector?.length &&
    queryVector.every(Number.isFinite)
      ? JSON.stringify(queryVector.map((value) => Number(value.toFixed(6))))
      : null;
  const llmAnalysisJson = llmAnalysis ? JSON.stringify(llmAnalysis) : null;
  const selectedContextJson = selectedContext
    ? JSON.stringify(selectedContext)
    : null;
  const rankedProductsJson = JSON.stringify(rankedProducts);
  const serializationCodeMs = Date.now() - serializationStartedAt;
  const dbStartedAt = Date.now();
  const log = await db.aiSearchQueryLog.create({
    data: {
      shop,
      query: query.slice(0, 500),
      normalizedQuery: normalizeQuery(query).slice(0, 500),
      queryHash: hashSearchQuery(query),
      queryVectorJson,
      analyzedQuery: analyzedQuery?.slice(0, 4_000) ?? null,
      llmAnalysisJson,
      selectedContextJson,
      // Store the complete post-threshold list once. Pagination is a browser
      // concern and must never create additional analytics rows.
      rankedProductsJson,
      resultCount: rankedProducts.length,
      candidateCount: diagnostics.candidateCount,
      topScore: rankedProducts[0]?.score ?? null,
      topCandidateScore: diagnostics.topCandidateScore,
      vectorThreshold: diagnostics.vectorThreshold,
      embeddingCacheHit: diagnostics.embeddingCacheHit,
      llmStatus: diagnostics.llmStatus,
      llmFallbackReason: diagnostics.llmFallbackReason,
      totalDurationMs: Math.max(0, Math.trunc(totalDurationMs)),
    },
    select: { id: true },
  });
  const dbWriteMs = Date.now() - dbStartedAt;
  onDiagnostics?.({
    serializationCodeMs,
    dbWriteMs,
    totalMs: Date.now() - totalStartedAt,
  });

  return log.id;
}

function parseRankedProducts(value: string): RankedSearchProduct[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Partial<RankedSearchProduct>;
      if (
        typeof row.productId !== "string" ||
        typeof row.handle !== "string" ||
        typeof row.rank !== "number" ||
        typeof row.score !== "number"
      ) {
        return [];
      }
      return [row as RankedSearchProduct];
    });
  } catch {
    return [];
  }
}

export async function recordSearchProductClick({
  shop,
  searchLogId,
  productId,
}: {
  shop: string;
  searchLogId: string;
  productId: string;
}) {
  const log = await db.aiSearchQueryLog.findFirst({
    where: { id: searchLogId, shop },
    select: { rankedProductsJson: true },
  });
  if (!log) return false;

  const product = parseRankedProducts(log.rankedProductsJson).find(
    (candidate) => candidate.productId === productId,
  );
  if (!product) return false;

  await db.aiSearchQueryClick.upsert({
    where: {
      searchLogId_productId: { searchLogId, productId },
    },
    create: {
      searchLogId,
      shop,
      productId,
      rank: product.rank,
      score: product.score,
    },
    update: {},
  });

  return true;
}

function rankSimilarity(
  left: RankedSearchProduct[],
  right: RankedSearchProduct[],
) {
  const leftWeights = new Map(
    left.slice(0, 20).map((product) => [product.productId, 1 / product.rank]),
  );
  const rightWeights = new Map(
    right.slice(0, 20).map((product) => [product.productId, 1 / product.rank]),
  );
  const ids = new Set([...leftWeights.keys(), ...rightWeights.keys()]);
  if (ids.size === 0) return 0;

  let intersection = 0;
  let union = 0;
  for (const id of ids) {
    const leftWeight = leftWeights.get(id) ?? 0;
    const rightWeight = rightWeights.get(id) ?? 0;
    intersection += Math.min(leftWeight, rightWeight);
    union += Math.max(leftWeight, rightWeight);
  }
  return union > 0 ? intersection / union : 0;
}

function parseQueryVector(value: string | null): number[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function cosineSimilarity(left: number[] | null, right: number[] | null) {
  if (!left || !right || left.length !== right.length) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator > 0 ? dot / denominator : 0;
}

type ClusterAccumulator = {
  label: string;
  representative: RankedSearchProduct[];
  representativeQueryVector: number[] | null;
  queryCounts: Map<string, number>;
  searchCount: number;
  searchesWithResults: number;
  clickedSearches: number;
  clickCount: number;
  zeroResultCount: number;
  scoreTotal: number;
  scoreCount: number;
  thresholdTotal: number;
  productStats: Map<
    string,
    {
      handle: string;
      appearances: number;
      rankTotal: number;
      clickCount: number;
    }
  >;
};

export async function getMerchantSearchClusters(shop: string, days = 30) {
  const safeDays = Math.max(1, Math.min(Math.trunc(days), 365));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60_000);
  const logs = await db.aiSearchQueryLog.findMany({
    where: { shop, createdAt: { gte: cutoff } },
    orderBy: { createdAt: "desc" },
    take: 2_000,
    include: { clicks: { select: { id: true, productId: true } } },
  });

  const clusters: ClusterAccumulator[] = [];

  for (const log of logs) {
    const products = parseRankedProducts(log.rankedProductsJson);
    const queryVector = parseQueryVector(log.queryVectorJson);
    const hasResults = products.length > 0;
    const cluster =
      clusters.find((candidate) => {
        if (candidate.label === log.normalizedQuery) return true;

        const candidateHasResults = candidate.representative.length > 0;
        if (hasResults && candidateHasResults) {
          return rankSimilarity(candidate.representative, products) >= 0.7;
        }

        // Empty result lists contain no product signal. Compare two such
        // queries through the embedding already created during search, and
        // never merge them into a product-rank cluster.
        return (
          !hasResults &&
          !candidateHasResults &&
          cosineSimilarity(candidate.representativeQueryVector, queryVector) >=
            0.82
        );
      }) ??
      (() => {
        const created: ClusterAccumulator = {
          label: log.normalizedQuery,
          representative: products,
          representativeQueryVector: queryVector,
          queryCounts: new Map(),
          searchCount: 0,
          searchesWithResults: 0,
          clickedSearches: 0,
          clickCount: 0,
          zeroResultCount: 0,
          scoreTotal: 0,
          scoreCount: 0,
          thresholdTotal: 0,
          productStats: new Map(),
        };
        clusters.push(created);
        return created;
      })();

    if (cluster.representative.length === 0 && products.length > 0) {
      cluster.representative = products;
    }
    if (!cluster.representativeQueryVector && queryVector) {
      cluster.representativeQueryVector = queryVector;
    }

    cluster.searchCount += 1;
    cluster.searchesWithResults += log.resultCount > 0 ? 1 : 0;
    cluster.zeroResultCount += log.resultCount === 0 ? 1 : 0;
    cluster.clickedSearches += log.clicks.length > 0 ? 1 : 0;
    cluster.clickCount += log.clicks.length;
    cluster.thresholdTotal += log.vectorThreshold;
    cluster.queryCounts.set(
      log.query,
      (cluster.queryCounts.get(log.query) ?? 0) + 1,
    );

    const comparisonScore = log.topScore ?? log.topCandidateScore;
    if (comparisonScore !== null) {
      cluster.scoreTotal += comparisonScore;
      cluster.scoreCount += 1;
    }

    const clickedProductIds = new Set(
      log.clicks.map((click) => click.productId),
    );
    for (const product of products) {
      const current = cluster.productStats.get(product.productId) ?? {
        handle: product.handle,
        appearances: 0,
        rankTotal: 0,
        clickCount: 0,
      };
      current.appearances += 1;
      current.rankTotal += product.rank;
      current.clickCount += clickedProductIds.has(product.productId) ? 1 : 0;
      cluster.productStats.set(product.productId, current);
    }
  }

  return clusters
    .map((cluster) => {
      const averageTopScore =
        cluster.scoreCount > 0 ? cluster.scoreTotal / cluster.scoreCount : null;
      const averageThreshold = cluster.thresholdTotal / cluster.searchCount;
      const resultRate = cluster.searchesWithResults / cluster.searchCount;
      const clickThroughRate =
        cluster.searchesWithResults > 0
          ? cluster.clickedSearches / cluster.searchesWithResults
          : 0;

      let classification = "HEALTHY";
      if (cluster.searchesWithResults === 0) {
        classification = "NO_RESULTS";
      } else if (
        averageTopScore !== null &&
        averageTopScore < averageThreshold
      ) {
        classification = "LOW_SIMILARITY";
      } else if (
        cluster.searchesWithResults >= 3 &&
        cluster.clickedSearches === 0
      ) {
        classification = "RESULTS_WITHOUT_CLICKS";
      }

      const variants = [...cluster.queryCounts.entries()]
        .map(([query, searchCount]) => ({ query, searchCount }))
        .sort((left, right) => right.searchCount - left.searchCount);

      return {
        label: variants[0]?.query ?? cluster.label,
        variants,
        searchCount: cluster.searchCount,
        zeroResultCount: cluster.zeroResultCount,
        resultRate,
        clickedSearches: cluster.clickedSearches,
        clickCount: cluster.clickCount,
        clickThroughRate,
        averageTopScore,
        classification,
        commonProducts: [...cluster.productStats.entries()]
          .map(([productId, stats]) => ({
            productId,
            handle: stats.handle,
            appearances: stats.appearances,
            averageRank: stats.rankTotal / stats.appearances,
            clickCount: stats.clickCount,
          }))
          .sort(
            (left, right) =>
              right.clickCount - left.clickCount ||
              right.appearances - left.appearances ||
              left.averageRank - right.averageRank,
          )
          .slice(0, 10),
      };
    })
    .sort((left, right) => right.searchCount - left.searchCount);
}
