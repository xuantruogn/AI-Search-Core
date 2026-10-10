import { Prisma } from "@prisma/client";
import db from "../../db.server";

export async function getSearchAttemptMetrics(from: Date, to: Date, shop?: string) {
  const rows = await db.$queryRaw<Array<Record<string, number | bigint | Date | null>>>(Prisma.sql`
    SELECT COUNT(*) AS proxyRequests,
      SUM(a.purpose = 'SEARCH') AS searchRequests,
      SUM(a.purpose = 'SEARCH' AND a.aiExecuted = TRUE) AS pipelineExecutions,
      SUM(a.purpose = 'SEARCH' AND a.cacheHit = TRUE) AS cacheHits,
      SUM(a.purpose = 'SEARCH' AND a.nativeFallback = TRUE) AS nativeFallbacks,
      SUM(a.purpose = 'SEARCH' AND a.resultCount > 0 AND a.nativeFallback = FALSE) AS searchesWithResults,
      SUM(a.purpose = 'SEARCH' AND a.searchLogId IS NOT NULL AND a.nativeFallback = FALSE) AS aiLoggedSearches,
      SUM(a.purpose = 'SEARCH' AND a.nativeFallback = FALSE AND EXISTS (
        SELECT 1 FROM AiSearchQueryClick c WHERE c.searchLogId = a.searchLogId AND c.shop = a.shop
      )) AS aiSearchesWithClick,
      SUM(a.status = 'STARTED') AS incompleteAttempts,
      MIN(a.createdAt) AS recordedSince
    FROM AiSearchAttempt a WHERE a.createdAt >= ${from} AND a.createdAt <= ${to}
      ${shop ? Prisma.sql`AND a.shop = ${shop}` : Prisma.empty}
  `);
  const row = rows[0] ?? {};
  const count = (key: string) => Number(row[key] ?? 0);
  const aiLoggedSearches = count("aiLoggedSearches");
  return { proxyRequests: count("proxyRequests"), searchRequests: count("searchRequests"), pipelineExecutions: count("pipelineExecutions"), cacheHits: count("cacheHits"), nativeFallbacks: count("nativeFallbacks"), searchesWithResults: count("searchesWithResults"), aiLoggedSearches, aiSearchesWithClick: count("aiSearchesWithClick"), incompleteAttempts: count("incompleteAttempts"), aiCtr: aiLoggedSearches > 0 ? count("aiSearchesWithClick") / aiLoggedSearches : null, recordedSince: row.recordedSince instanceof Date ? row.recordedSince.toISOString() : null, scope: "Authenticated proxy requests recorded since SearchAttempt was enabled; historical QueryLog rows are not backfilled." };
}
