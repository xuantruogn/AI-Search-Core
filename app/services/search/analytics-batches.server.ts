import db from "../../db.server";

export async function* cursorBatches<T extends { id: string; createdAt: Date }>(load: (cursor: { id: string; createdAt: Date } | undefined) => Promise<T[]>) {
  let cursor: { id: string; createdAt: Date } | undefined;
  while (true) {
    const rows = await load(cursor);
    if (!rows.length) return;
    yield rows;
    cursor = rows[rows.length - 1];
  }
}

// Cursor over a fixed time window, deterministic ties, bounded raw-row memory.
export async function* searchAnalyticsBatches(shop: string, from: Date, to: Date) {
  yield* cursorBatches((cursor) => db.aiSearchQueryLog.findMany({
      where: { shop, createdAt: { gte: from, lte: to }, ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 250,
      select: { id: true, query: true, normalizedQuery: true, queryVectorJson: true, llmAnalysisJson: true, llmStatus: true, rankedProductsJson: true, resultCount: true, topScore: true, topCandidateScore: true, vectorThreshold: true, createdAt: true, clicks: { select: { productId: true } } },
    }));
}
