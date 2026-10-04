import db from "../app/db.server";
import { loadProductSemanticRows } from "../app/services/search/product-semantic-profile.server";

const limit = Math.max(1, Math.min(Number(process.argv[2] || 30), 100));
try {
  const logs = await db.aiSearchQueryLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  for (const log of logs) {
    let ranked: any[] = [];
    let analysis: any = null;
    try { ranked = JSON.parse(log.rankedProductsJson || "[]"); } catch {}
    try { analysis = JSON.parse(log.llmAnalysisJson || "null"); } catch {}
    const top = ranked.slice(0, 8);
    const ids = top.map((p) => {
      const id = String(p.productId ?? p.id ?? "");
      return /^\d+$/.test(id) ? `gid://shopify/Product/${id}` : id;
    }).filter(Boolean);
    const [products, facts] = await Promise.all([
      db.aiSearchIndexedProduct.findMany({ where: { shop: log.shop, productId: { in: ids } }, select: { productId: true, title: true } }),
      loadProductSemanticRows(log.shop, ids),
    ]);
    console.log(JSON.stringify({ id: log.id, at: log.createdAt, query: log.query,
      analyzed: log.analyzedQuery, results: log.resultCount, durationMs: log.totalDurationMs,
      route: analysis?.route, llm: log.llmStatus, diagnostics: analysis?.searchDiagnostics,
      filters: analysis?.filterDiagnostics, top: ids.map((id, index) => ({ rank: index + 1,
        title: products.find((p) => p.productId === id)?.title,
        score: top[index]?.score,
        facts: facts.filter((f) => f.productId === id && ["CANONICAL_PRODUCT_TYPE", "AUDIENCE", "ATTRIBUTE"].includes(f.kind)).slice(0, 8).map((f) => `${f.kind}:${f.value}`),
      })) }));
  }
} finally { await db.$disconnect(); }
