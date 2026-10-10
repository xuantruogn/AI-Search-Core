import db from "../../db.server";

export type DailySearchMetric = { date: string; searches: number; clickedSearches: number; clicks: number; rankTotal: number };

// One click group per search prevents multiple clicks inflating searches/CTR.
export async function getDailySearchMetrics(shop: string, start: Date, end: Date): Promise<DailySearchMetric[]> {
  const rows = await db.$queryRaw<Array<{ date: string; searches: bigint; clickedSearches: bigint; clicks: unknown; rankTotal: unknown }>>`
    SELECT DATE_FORMAT(l.createdAt, '%Y-%m-%d') AS date,
      COUNT(*) AS searches, SUM(CASE WHEN c.clicks > 0 THEN 1 ELSE 0 END) AS clickedSearches,
      COALESCE(SUM(c.clicks), 0) AS clicks, COALESCE(SUM(c.rankTotal), 0) AS rankTotal
    FROM AiSearchQueryLog l
    LEFT JOIN (
      SELECT c.searchLogId, COUNT(*) AS clicks, SUM(c.rank) AS rankTotal
      FROM AiSearchQueryClick c JOIN AiSearchQueryLog scoped ON scoped.id = c.searchLogId
      WHERE c.shop = ${shop} AND scoped.shop = ${shop} AND scoped.createdAt >= ${start} AND scoped.createdAt <= ${end}
      GROUP BY c.searchLogId
    ) c ON c.searchLogId = l.id
    WHERE l.shop = ${shop} AND l.createdAt >= ${start} AND l.createdAt <= ${end}
    GROUP BY DATE_FORMAT(l.createdAt, '%Y-%m-%d') ORDER BY date
  `;
  return rows.map((row) => ({ date: row.date, searches: Number(row.searches), clickedSearches: Number(row.clickedSearches), clicks: Number(row.clicks), rankTotal: Number(row.rankTotal) }));
}

export function sumSearchMetrics(rows: DailySearchMetric[]) {
  return rows.reduce((sum, row) => ({ searches: sum.searches + row.searches, clickedSearches: sum.clickedSearches + row.clickedSearches, clicks: sum.clicks + row.clicks, rankTotal: sum.rankTotal + row.rankTotal }), { searches: 0, clickedSearches: 0, clicks: 0, rankTotal: 0 });
}
