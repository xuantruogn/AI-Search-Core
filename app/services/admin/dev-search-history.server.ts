import { Prisma } from "@prisma/client";

import db from "../../db.server";

const PAGE_SIZES = [25, 50, 100, 250] as const;
const DEFAULT_PAGE_SIZE = 50;

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePageSize(value: string | null) {
  const parsed = positiveInt(value, DEFAULT_PAGE_SIZE);
  return PAGE_SIZES.includes(parsed as (typeof PAGE_SIZES)[number])
    ? parsed
    : DEFAULT_PAGE_SIZE;
}

function readTopVectorSimilarity(rankedProductsJson: string) {
  try {
    const parsed = JSON.parse(rankedProductsJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { vectorSimilarity: null, primaryVectorSimilarity: null };
    }
    const first = parsed[0] as Record<string, unknown>;
    return {
      vectorSimilarity:
        typeof first.vectorSimilarity === "number" &&
        Number.isFinite(first.vectorSimilarity)
          ? first.vectorSimilarity
          : null,
      primaryVectorSimilarity:
        typeof first.primaryVectorSimilarity === "number" &&
        Number.isFinite(first.primaryVectorSimilarity)
          ? first.primaryVectorSimilarity
          : null,
    };
  } catch {
    return { vectorSimilarity: null, primaryVectorSimilarity: null };
  }
}

export async function getDevSearchHistoryData(searchParams: URLSearchParams) {
  const shop = searchParams.get("shop")?.trim() ?? "";
  const query = searchParams.get("query")?.trim() ?? "";
  const llmStatus = searchParams.get("llmStatus")?.trim() ?? "";
  const requestedPage = positiveInt(searchParams.get("page"), 1);
  const pageSize = normalizePageSize(searchParams.get("pageSize"));

  const where: Prisma.AiSearchQueryLogWhereInput = {
    ...(shop ? { shop } : {}),
    ...(llmStatus ? { llmStatus } : {}),
    ...(query
      ? {
          OR: [
            { query: { contains: query } },
            { analyzedQuery: { contains: query } },
            { llmExpandedQuery: { contains: query } },
          ],
        }
      : {}),
  };

  const [shopRows, statusRows, total] = await Promise.all([
    db.aiSearchShop.findMany({
      orderBy: { shop: "asc" },
      select: { shop: true },
    }),
    db.aiSearchQueryLog.groupBy({
      by: ["llmStatus"],
      orderBy: { llmStatus: "asc" },
    }),
    db.aiSearchQueryLog.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const skip = (page - 1) * pageSize;
  const take = pageSize;

  const logs = await db.aiSearchQueryLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip,
    take,
    select: {
      id: true,
      shop: true,
      query: true,
      analyzedQuery: true,
      llmExpandedQuery: true,
      llmAnalysisJson: true,
      selectedContextJson: true,
      rankedProductsJson: true,
      resultCount: true,
      candidateCount: true,
      topScore: true,
      topCandidateScore: true,
      vectorThreshold: true,
      embeddingCacheHit: true,
      llmStatus: true,
      llmFallbackReason: true,
      totalDurationMs: true,
      createdAt: true,
    },
  });

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      shop,
      query,
      llmStatus,
      page,
      pageSize,
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      from: total === 0 ? 0 : skip + 1,
      to: total === 0 ? 0 : Math.min(total, skip + logs.length),
    },
    shops: shopRows.map((row) => row.shop),
    llmStatuses: statusRows.map((row) => row.llmStatus),
    logs: logs.map((log) => {
      const vector = readTopVectorSimilarity(log.rankedProductsJson);
      return {
        ...log,
        topVectorSimilarity: vector.vectorSimilarity,
        topPrimaryVectorSimilarity: vector.primaryVectorSimilarity,
        createdAt: log.createdAt.toISOString(),
      };
    }),
  };
}

export type DevSearchHistoryData = Awaited<
  ReturnType<typeof getDevSearchHistoryData>
>;
