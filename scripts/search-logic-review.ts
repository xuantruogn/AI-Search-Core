import { readFileSync } from "node:fs";
import db from "../app/db.server";
import { prepareParallelQueryPipeline } from "../app/services/search/parallel-query-pipeline.server";
import { applyShopContextToQuery, filterResultsByExplicitGender } from "../app/services/search/shop-context-index.server";
import { semanticSearch } from "../app/services/search/semantic-search.server";
import { retrieveStructuredCandidates, retrieveGroundedFacetCandidates } from "../app/services/search/structured-candidate-retrieval.server";
import { retrieveLexicalCandidates } from "../app/services/search/lexical-candidate-retrieval.server";
import { fuseHybridRetrieval } from "../app/services/search/hybrid-retrieval-fusion.server";
import { loadProductSemanticRows } from "../app/services/search/product-semantic-profile.server";

// Reuse recorded interpretation for a deterministic retrieval/ranking audit;
// --fresh also verifies the current planner/provider path.
const fresh = process.argv.includes("--fresh");
const queries = process.argv.slice(2).filter(x => x !== "--fresh");
const saved = JSON.parse(readFileSync(".tmp/v6-acceptance-results.json", "utf8"));
const shop = "dev-app-6fvh2isn.myshopify.com";
try {
  for (const query of queries) {
    const prior = saved.find((r: any) => r.query === query);
    const pipeline = fresh || !prior
      ? await prepareParallelQueryPipeline({ shop, query, searchLanguage: "en" }) : null;
    const plan = pipeline?.profile?.finalPlan ?? pipeline?.rawPlan ?? prior.plan;
    if (pipeline && !pipeline.profile) {
      console.log("REVIEW " + JSON.stringify({ query, proof: pipeline.rawProof, count: 0 }));
      continue;
    }
    const rewrite = await applyShopContextToQuery({ shop, originalQuery: query,
      rewrite: pipeline?.profile?.rewrite ?? { ...prior.rewrite, status: "SUCCESS", rewritten: true,
        catalogRelevant: true, fallbackReason: null, timing: { llmCallCount: 0 } } });
    let semanticDiagnostics: any, filterDiagnostics: any;
    const [structured, lexical, semantic, groundedFacets] = await Promise.all([
      retrieveStructuredCandidates({ shop, plan, limit: 1000 }),
      retrieveLexicalCandidates({ shop, query, limit: 100 }),
      plan.route === "STRUCTURED_ONLY" ? Promise.resolve([]) :
        semanticSearch({ shop, query, preparedRewrite: rewrite, limit: 1000,
          onDiagnostics: d => { semanticDiagnostics = d; } }),
      retrieveGroundedFacetCandidates({ shop, rewrite }),
    ]);
    const proof = pipeline ? await pipeline.finalProof : null;
    const fusion = fuseHybridRetrieval({ plan, semantic, structured: [...structured, ...groundedFacets], lexical,
      semanticNoEvidence: semanticDiagnostics?.noEvidenceGuardTriggered === true,
      sourceProductClassAbsent: semanticDiagnostics?.sourceProductClassAbsent === true,
      semanticThreshold: semanticDiagnostics?.vectorThreshold ?? 0.35, limit: 1000 });
    const results = proof?.status === "CERTAIN_NO_RESULT" ? [] :
      await filterResultsByExplicitGender({ shop, originalQuery: query, rewrite,
        results: fusion.results, onDiagnostics: d => { filterDiagnostics = d; } });
    const facts = await loadProductSemanticRows(shop, results.slice(0, 6).map(r => r.productId));
    console.log("REVIEW " + JSON.stringify({ query, route: plan.route, mode: plan.retrievalMode,
      plan, analysis: rewrite.analysis, context: rewrite.context,
      input: semanticDiagnostics?.primaryEmbeddingInput, branches: semanticDiagnostics?.semanticFacetBranches,
      guard: semanticDiagnostics?.noEvidenceGuardTriggered, proof, fusion: fusion.diagnostics,
      filters: filterDiagnostics, count: results.length,
      top: results.slice(0, 6).map(r => ({ title: r.title, id: r.productId, score: r.score,
        vector: r.vectorSimilarity, primary: r.primaryVectorSimilarity, sources: r.retrievalSources,
        facts: facts.filter(f => f.productId === r.productId &&
          ["CANONICAL_PRODUCT_TYPE", "CATEGORY", "ATTRIBUTE", "USE_CASE", "COMPATIBILITY"].includes(f.kind))
          .map(f => f.kind + ":" + f.value) })) }));
  }
} finally { await db.$disconnect(); }
