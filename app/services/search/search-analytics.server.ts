
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

export type SearchClusterClassification =
  | "HEALTHY"
  | "NO_RESULTS"
  | "LOW_SIMILARITY"
  | "HIGH_SIMILARITY_NO_CLICK";

const MAX_RANKED_PRODUCTS_FOR_ANALYTICS = 20;
const QUERY_FINGERPRINT_DIMENSIONS = 64;
const RESULT_CLUSTER_SIMILARITY = 0.7;
const EMPTY_CLUSTER_SIMILARITY = 0.82;
const LOW_SIMILARITY_MARGIN = 0.03;
const HIGH_SIMILARITY_MARGIN = 0.08;
const MIN_RECURRING_SEARCHES = 2;
const MIN_NO_CLICK_SEARCHES = 3;
const DEFAULT_NO_CLICK_GRACE_MINUTES = 30;

function normalizeQuery(query: string) {
  return query.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

/**
 * Compact the already-created embedding into a small deterministic fingerprint.
 * This never makes another embedding request and avoids persisting the complete
 * query embedding just to group NO_RESULTS searches.
 */
function createQueryFingerprint(queryVector?: number[] | null) {
  if (
    !queryVector?.length ||
    !queryVector.every((value) => Number.isFinite(value))
  ) {
    return null;
  }

  const projected = Array.from(
    { length: QUERY_FINGERPRINT_DIMENSIONS },
    () => 0,
  );

  for (let index = 0; index < queryVector.length; index += 1) {
    const bucket = index % QUERY_FINGERPRINT_DIMENSIONS;
    // Deterministic alternating sign prevents every source dimension in a
    // bucket from simply summing in the same direction.
    const sign = ((index * 2654435761) >>> 30) % 2 === 0 ? 1 : -1;
    projected[bucket] += queryVector[index] * sign;
  }

  const magnitude = Math.sqrt(
    projected.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;

  return projected.map((value) => Number((value / magnitude).toFixed(6)));
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
  const compactProducts = rankedProducts.slice(
    0,
    MAX_RANKED_PRODUCTS_FOR_ANALYTICS,
  );
  const queryFingerprint =
    compactProducts.length === 0 ? createQueryFingerprint(queryVector) : null;
  const queryVectorJson = queryFingerprint
    ? JSON.stringify(queryFingerprint)
    : null;
  const llmAnalysisJson = llmAnalysis ? JSON.stringify(llmAnalysis) : null;
  const selectedContextJson = selectedContext
    ? JSON.stringify(selectedContext)
    : null;
  const rankedProductsJson = JSON.stringify(compactProducts);
  const serializationCodeMs = Date.now() - serializationStartedAt;
  const dbStartedAt = Date.now();
  const log = await db.aiSearchQueryLog.create({
    data: {
      shop,
      query: query.slice(0, 500),
      normalizedQuery: normalizeQuery(query).slice(0, 500),
      queryHash: hashSearchQuery(query),
      // Historical column name retained for migration compatibility. The value
      // is now a compact 64D semantic fingerprint, not the full embedding.
      queryVectorJson,
      analyzedQuery: analyzedQuery?.slice(0, 4_000) ?? null,
      llmAnalysisJson,
      selectedContextJson,
      // Only the compact top-ranked set is needed for cluster similarity,
      // product statistics and click attribution across pagination.
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

  let product = parseRankedProducts(log.rankedProductsJson).find(
    (candidate) => candidate.productId === productId,
  );

  // SearchLog intentionally keeps only the compact top-20 list. For clicks on
  // later pagination pages, resolve rank/score from the receipt that stores the
  // complete ranked list instead of bloating every analytics row.
  if (!product) {
    const receipt = await db.aiSearchResultReceipt.findFirst({
      where: { searchLogId, shop },
      orderBy: { createdAt: "desc" },
      select: { rankedProductsJson: true },
    });

    if (receipt) {
      try {
        const parsed = JSON.parse(receipt.rankedProductsJson) as unknown;
        if (Array.isArray(parsed)) {
          const index = parsed.findIndex(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              (entry as { productId?: unknown }).productId === productId,
          );
          if (index >= 0) {
            const row = parsed[index] as {
              productId: string;
              handle?: unknown;
              score?: unknown;
            };
            product = {
              productId: row.productId,
              handle: typeof row.handle === "string" ? row.handle : "",
              rank: index + 1,
              score: typeof row.score === "number" ? row.score : 0,
            };
          }
        }
      } catch {
        // Best-effort telemetry: malformed/expired receipt data must never
        // affect storefront navigation.
      }
    }
  }

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

function parseQueryFingerprint(value: string | null): number[] | null {
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

type QueryStats = {
  count: number;
  latestAt: number;
};

type ClusterAccumulator = {
  normalizedLabel: string;
  representative: RankedSearchProduct[];
  representativeQueryFingerprint: number[] | null;
  hasResults: boolean;
  queryCounts: Map<string, QueryStats>;
  searchCount: number;
  searchesWithResults: number;
  clickedSearches: number;
  matureSearches: number;
  matureClickedSearches: number;
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
  const configuredGrace = Number.parseFloat(
    process.env.AI_SEARCH_QUALITY_NO_CLICK_GRACE_MINUTES ?? "",
  );
  const graceMinutes = Number.isFinite(configuredGrace)
    ? Math.max(0, configuredGrace)
    : DEFAULT_NO_CLICK_GRACE_MINUTES;
  const graceCutoff = Date.now() - graceMinutes * 60_000;

  for (const log of logs) {
    const products = parseRankedProducts(log.rankedProductsJson);
    const queryFingerprint = parseQueryFingerprint(log.queryVectorJson);
    const hasResults = log.resultCount > 0;
    const cluster =
      clusters.find((candidate) => {
        // Never combine a NO_RESULTS event with a result-bearing event. The same
        // literal query can change behaviour as inventory/index state changes.
        if (candidate.hasResults !== hasResults) return false;

        if (candidate.normalizedLabel === log.normalizedQuery) return true;

        if (hasResults) {
          return (
            rankSimilarity(candidate.representative, products) >=
            RESULT_CLUSTER_SIMILARITY
          );
        }

        // Empty result lists have no product signal. Compare only the compact
        // semantic fingerprints derived from embeddings already created during
        // the original searches.
        return (
          cosineSimilarity(
            candidate.representativeQueryFingerprint,
            queryFingerprint,
          ) >= EMPTY_CLUSTER_SIMILARITY
        );
      }) ??
      (() => {
        const created: ClusterAccumulator = {
          normalizedLabel: log.normalizedQuery,
          representative: products,
          representativeQueryFingerprint: queryFingerprint,
          hasResults,
          queryCounts: new Map(),
          searchCount: 0,
          searchesWithResults: 0,
          clickedSearches: 0,
          matureSearches: 0,
          matureClickedSearches: 0,
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

    cluster.searchCount += 1;
    cluster.searchesWithResults += hasResults ? 1 : 0;
    cluster.zeroResultCount += hasResults ? 0 : 1;
    cluster.clickedSearches += log.clicks.length > 0 ? 1 : 0;
    if (log.createdAt.getTime() <= graceCutoff) {
      cluster.matureSearches += 1;
      cluster.matureClickedSearches += log.clicks.length > 0 ? 1 : 0;
    }
    cluster.clickCount += log.clicks.length;
    cluster.thresholdTotal += log.vectorThreshold;

    const existingQuery = cluster.queryCounts.get(log.query);
    cluster.queryCounts.set(log.query, {
      count: (existingQuery?.count ?? 0) + 1,
      latestAt: Math.max(existingQuery?.latestAt ?? 0, log.createdAt.getTime()),
    });

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
    .filter((cluster) => cluster.searchCount >= MIN_RECURRING_SEARCHES)
    .map((cluster) => {
      const averageTopScore =
        cluster.scoreCount > 0 ? cluster.scoreTotal / cluster.scoreCount : null;
      const averageThreshold = cluster.thresholdTotal / cluster.searchCount;
      const resultRate = cluster.searchesWithResults / cluster.searchCount;
      const clickThroughRate =
        cluster.searchesWithResults > 0
          ? cluster.clickedSearches / cluster.searchesWithResults
          : 0;

      let classification: SearchClusterClassification = "HEALTHY";
      if (!cluster.hasResults) {
        classification = "NO_RESULTS";
      } else if (
        averageTopScore !== null &&
        averageTopScore < averageThreshold + LOW_SIMILARITY_MARGIN
      ) {
        classification = "LOW_SIMILARITY";
      } else if (
        cluster.matureSearches >= MIN_NO_CLICK_SEARCHES &&
        cluster.matureClickedSearches === 0 &&
        averageTopScore !== null &&
        averageTopScore >= averageThreshold + HIGH_SIMILARITY_MARGIN
      ) {
        classification = "HIGH_SIMILARITY_NO_CLICK";
      }

      const variants = [...cluster.queryCounts.entries()]
        .map(([query, stats]) => ({
          query,
          searchCount: stats.count,
          latestAt: stats.latestAt,
        }))
        .sort(
          (left, right) =>
            right.searchCount - left.searchCount ||
            right.latestAt - left.latestAt ||
            left.query.localeCompare(right.query),
        )
        .map(({ query, searchCount }) => ({ query, searchCount }));

      return {
        label: variants[0]?.query ?? cluster.normalizedLabel,
        variants,
        searchCount: cluster.searchCount,
        zeroResultCount: cluster.zeroResultCount,
        resultRate,
        clickedSearches: cluster.clickedSearches,
        clickCount: cluster.clickCount,
        clickThroughRate,
        averageTopScore,
        averageThreshold,
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