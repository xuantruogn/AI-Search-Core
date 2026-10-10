import type { LoaderFunctionArgs } from "react-router";
import { Prisma } from "@prisma/client";
import db from "../db.server";
import { requireDevPermission } from "../services/dev-auth.server";
import { devSecurityHeaders } from "../services/dev-security.server";
import { csvRow, historyFilters } from "../services/admin/search-history-export";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireDevPermission(request, "shops.read");
  const params = new URL(request.url).searchParams;
  const { where } = historyFilters(params);
  if (params.get("source") === "attempts") return exportAttempts(request, params);
  const snapshot = new Date();
  const scope = { AND: [where, { createdAt: { lte: snapshot } }] };
  // Fail before starting a successful download if DB is unavailable.
  await db.aiSearchQueryLog.count({ where: scope });
  let cursor: string | undefined;
  let header = true;
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled || request.signal.aborted) { controller.close(); return; }
      try {
        const rows = await db.aiSearchQueryLog.findMany({
          where: scope, take: 250, orderBy: { id: "asc" },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, shop: true, createdAt: true, query: true, analyzedQuery: true, llmExpandedQuery: true, resultCount: true, candidateCount: true, llmStatus: true, llmFallbackReason: true, totalDurationMs: true, embeddingCacheHit: true, _count: { select: { clicks: true } } },
        });
        if (cancelled) return;
        let chunk = header ? "\uFEFF" + csvRow(["search_log_id", "attempt_id", "shop", "created_at_utc", "query", "analyzed_query", "expanded_query", "result_status", "results", "candidates", "product_clicks", "llm_status", "llm_fallback_reason", "duration_ms", "embedding_cache_hit"]) : "";
        header = false;
        for (const row of rows) chunk += csvRow([row.id, row.id.startsWith("att_") ? row.id : "", row.shop, row.createdAt.toISOString(), row.query, row.analyzedQuery, row.llmExpandedQuery, row.resultCount ? "HAS_RESULTS" : "ZERO_RESULTS", row.resultCount, row.candidateCount, row._count.clicks, row.llmStatus, row.llmFallbackReason, row.totalDurationMs, row.embeddingCacheHit]);
        if (chunk) controller.enqueue(encoder.encode(chunk));
        if (rows.length < 250) controller.close();
        else cursor = rows[rows.length - 1].id;
      } catch { controller.error(new Error("Search export interrupted; discard the incomplete file and retry.")); }
    },
    cancel() { cancelled = true; },
  });
  const headers = new Headers(devSecurityHeaders());
  headers.set("Content-Type", "text/csv; charset=utf-8");
  headers.set("Content-Disposition", 'attachment; filename="ai-search-history.csv"');
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(stream, { headers });
}

async function exportAttempts(request: Request, params: URLSearchParams) {
  const filters = historyFilters(params);
  const snapshot = new Date();
  const conditions = Prisma.sql`a.purpose = 'SEARCH' AND a.createdAt <= ${snapshot}
    ${filters.shop ? Prisma.sql`AND a.shop = ${filters.shop}` : Prisma.empty}
    ${filters.from ? Prisma.sql`AND a.createdAt >= ${new Date(filters.from + "T00:00:00Z")}` : Prisma.empty}
    ${filters.to ? Prisma.sql`AND a.createdAt < ${new Date(new Date(filters.to + "T00:00:00Z").getTime() + 86400000)}` : Prisma.empty}
    ${filters.attemptStatus ? Prisma.sql`AND a.status = ${filters.attemptStatus}` : Prisma.empty}
    ${filters.llmStatus ? Prisma.sql`AND q.llmStatus = ${filters.llmStatus}` : Prisma.empty}
    ${filters.resultStatus === "ZERO_RESULTS" ? Prisma.sql`AND a.resultCount = 0 AND a.nativeFallback = FALSE` : filters.resultStatus === "HAS_RESULTS" ? Prisma.sql`AND a.resultCount > 0 AND a.nativeFallback = FALSE` : Prisma.empty}
    ${filters.query ? Prisma.sql`AND (q.query LIKE ${"%" + filters.query + "%"} OR q.analyzedQuery LIKE ${"%" + filters.query + "%"} OR q.llmExpandedQuery LIKE ${"%" + filters.query + "%"})` : Prisma.empty}`;
  const join = Prisma.sql`FROM AiSearchAttempt a LEFT JOIN AiSearchQueryLog q ON q.id = a.searchLogId AND q.shop = a.shop`;
  await db.$queryRaw(Prisma.sql`SELECT COUNT(*) ${join} WHERE ${conditions}`);
  let cursor = ""; let header = true; let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled || request.signal.aborted) { controller.close(); return; }
      try {
        const rows = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT a.id, a.shop, a.createdAt, a.status, a.failureKind, a.reason, a.queryHash,
            a.aiExecuted, a.cacheHit, a.nativeFallback, a.resultCount, a.durationMs,
            a.searchLogId, a.reservationId, q.query, q.analyzedQuery, q.llmExpandedQuery,
            CASE WHEN a.searchLogId IS NULL OR a.nativeFallback = TRUE THEN NULL ELSE
              (SELECT COUNT(*) FROM AiSearchQueryClick c WHERE c.searchLogId = a.searchLogId AND c.shop = a.shop)
            END AS clicks
          ${join} WHERE ${conditions} AND a.id > ${cursor} ORDER BY a.id ASC LIMIT 250
        `);
        if (cancelled) return;
        const columns = ["id", "shop", "createdAt", "status", "failureKind", "reason", "queryHash", "aiExecuted", "cacheHit", "nativeFallback", "resultCount", "durationMs", "searchLogId", "reservationId", "query", "analyzedQuery", "llmExpandedQuery", "clicks"];
        let chunk = header ? "\uFEFF" + csvRow(columns) : ""; header = false;
        for (const row of rows) chunk += csvRow(columns.map((column) => row[column] instanceof Date ? (row[column] as Date).toISOString() : row[column]));
        if (chunk) controller.enqueue(encoder.encode(chunk));
        if (rows.length < 250) controller.close(); else cursor = String(rows[rows.length - 1].id);
      } catch { controller.error(new Error("Attempt export interrupted; discard partial file and retry.")); }
    }, cancel() { cancelled = true; },
  });
  const headers = new Headers(devSecurityHeaders());
  headers.set("Content-Type", "text/csv; charset=utf-8");
  headers.set("Content-Disposition", 'attachment; filename="ai-search-attempts.csv"');
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(stream, { headers });
}
