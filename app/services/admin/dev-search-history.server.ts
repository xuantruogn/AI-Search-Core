import { Prisma } from "@prisma/client";

import db from "../../db.server";

const PAGE_SIZES = [25, 50, 100, 250] as const;
const DEFAULT_PAGE_SIZE = 50;

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePageSize(value: string | null) {
  if (value === "all") return "all" as const;
  const parsed = positiveInt(value, DEFAULT_PAGE_SIZE);
  return PAGE_SIZES.includes(parsed as (typeof PAGE_SIZES)[number])
    ? parsed
    : DEFAULT_PAGE_SIZE;
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

  const totalPages =
    pageSize === "all" ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const page = pageSize === "all" ? 1 : Math.min(requestedPage, totalPages);
  const skip = pageSize === "all" ? undefined : (page - 1) * pageSize;
  const take = pageSize === "all" ? undefined : pageSize;

  const logs = await db.aiSearchQueryLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(skip === undefined ? {} : { skip }),
    ...(take === undefined ? {} : { take }),
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
      from: total === 0 ? 0 : pageSize === "all" ? 1 : skip! + 1,
      to:
        total === 0
          ? 0
          : pageSize === "all"
            ? total
            : Math.min(total, skip! + logs.length),
    },
    shops: shopRows.map((row) => row.shop),
    llmStatuses: statusRows.map((row) => row.llmStatus),
    logs: logs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
  };
}

export type DevSearchHistoryData = Awaited<
  ReturnType<typeof getDevSearchHistoryData>
>;
