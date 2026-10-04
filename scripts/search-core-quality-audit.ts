import db from "../app/db.server";
import { prepareParallelQueryPipeline } from "../app/services/search/parallel-query-pipeline.server";
import { semanticSearch } from "../app/services/search/semantic-search.server";
import { applyShopContextToQuery, filterResultsByExplicitGender } from "../app/services/search/shop-context-index.server";

if (process.env.NODE_ENV === "production") throw new Error("Development audit only");
const shop = process.env.AI_SEARCH_TEST_SHOP || "dev-app-6fvh2isn.myshopify.com";
const queries = process.argv.slice(2);
if (!queries.length) throw new Error("Pass queries as arguments");
try {
  const settings = await db.aiSearchShopSettings.findUnique({ where: { shop } });
  for (const query of queries) {
    const started = Date.now();
    const pipeline = await prepareParallelQueryPipeline({ shop, query, searchLanguage: settings?.searchLanguage ?? null });
    if (!pipeline.profile) {
      console.log(JSON.stringify({ query, count: 0, earlyNoResult: true, proof: pipeline.rawProof, ms: Date.now() - started }));
      continue;
    }
    const rewrite = await applyShopContextToQuery({ shop, originalQuery: query, rewrite: pipeline.profile.rewrite });
    let diagnostics: any;
    const vector = await semanticSearch({ shop, query, preparedRewrite: rewrite, limit: 1000,
      onDiagnostics: (value) => { diagnostics = value; } });
    const filtered = await filterResultsByExplicitGender({ shop, originalQuery: query, rewrite, results: vector });
    console.log(JSON.stringify({ query, route: rewrite.planning?.route, retrievalMode: rewrite.planning?.retrievalMode,
      count: filtered.length, noEvidence: diagnostics?.noEvidenceGuardTriggered,
      topVectorScore: diagnostics?.topVectorScore, threshold: diagnostics?.vectorThreshold,
      strongEvidence: diagnostics?.hasStrongCatalogEvidence,
      top: filtered.slice(0, 5).map((result) => ({
        title: result.title,
        finalScore: result.score,
        vectorSimilarity: result.vectorSimilarity ?? null,
        primaryVectorSimilarity: result.primaryVectorSimilarity ?? result.vectorSimilarity ?? null,
      })),
      ms: Date.now() - started }));
  }
} finally { await db.$disconnect(); }
