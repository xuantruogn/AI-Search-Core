import db from "../app/db.server";
import { loadProductSemanticRows } from "../app/services/search/product-semantic-profile.server";

// Runs the existing development proxy adapter, not a second search engine.
if (process.env.NODE_ENV === "production") throw new Error("Development audit only");
const live = process.argv.includes("--live");
const planOnly = process.argv.includes("--plan");
const core = process.argv.includes("--core");
const queries = process.argv.slice(2).filter((arg) => !["--live", "--plan", "--core"].includes(arg));
const productIdOf = (p: any) => {
  const id = String(p.productId ?? p.id);
  return /^\d+$/.test(id) ? `gid://shopify/Product/${id}` : id;
};
if (!queries.length) throw new Error("Pass representative queries as arguments");
try {
  for (const query of queries) {
    const started = Date.now();
    if (core) {
      const shop = "dev-app-6fvh2isn.myshopify.com";
      const { prepareParallelQueryPipeline } = await import("../app/services/search/parallel-query-pipeline.server");
      const { applyShopContextToQuery } = await import("../app/services/search/shop-context-index.server");
      const { semanticSearch } = await import("../app/services/search/semantic-search.server");
      const settings = await db.aiSearchShopSettings.findUnique({ where: { shop } });
      const pipeline = await prepareParallelQueryPipeline({ shop, query, searchLanguage: settings?.searchLanguage ?? null });
      if (!pipeline.profile) { console.log("CORE " + JSON.stringify({ query, proof: pipeline.rawProof })); continue; }
      const rewrite = await applyShopContextToQuery({ shop, originalQuery: query, rewrite: pipeline.profile.rewrite });
      let diagnostics: unknown;
      const results = await semanticSearch({ shop, query, preparedRewrite: rewrite, limit: 1000,
        onDiagnostics: value => { diagnostics = value; } });
      await pipeline.finalProof;
      console.log("CORE " + JSON.stringify({ query, context: rewrite.context, planning: rewrite.planning,
        analysis: rewrite.analysis, diagnostics, top: results.slice(0, 10), ms: Date.now() - started }));
      continue;
    }
    if (planOnly) {
      const shop = "dev-app-6fvh2isn.myshopify.com";
      const { buildQueryPlan } = await import("../app/services/search/query-planner.server");
      const { retrieveStructuredCandidates } = await import("../app/services/search/structured-candidate-retrieval.server");
      const plan = await buildQueryPlan(shop, query);
      const candidates = await retrieveStructuredCandidates({ shop, plan, limit: 1000 });
      const { queryPlanToLegacyRewrite } = await import("../app/services/search/legacy-query-rewrite-adapter.server");
      const { filterResultsByExplicitGender } = await import("../app/services/search/shop-context-index.server");
      let filterDiagnostics: unknown;
      const filtered = await filterResultsByExplicitGender({ shop, originalQuery: query,
        rewrite: queryPlanToLegacyRewrite(plan, query), results: candidates,
        onDiagnostics: (value) => { filterDiagnostics = value; },
      });
      console.log("AUDIT " + JSON.stringify({ query, source: "CURRENT_PLAN_AND_STRUCTURED_RETRIEVAL",
        route: plan.route, semanticQuery: plan.semanticQuery, resolvedSegments: plan.resolvedSegments,
        unresolvedSegments: plan.unresolvedSegments, count: candidates.length,
        filteredCount: filtered.length, filterDiagnostics,
        top: filtered.slice(0, 10), ms: Date.now() - started,
      }));
      continue;
    }
    const historical = live ? null : await db.aiSearchQueryLog.findFirst({
      where: { normalizedQuery: query.trim().toLowerCase() }, orderBy: { createdAt: "desc" },
    });
    if (!live && !historical) { console.log("AUDIT " + JSON.stringify({ query, source: "HISTORICAL", status: "NO_LOG" })); continue; }
    const response = live ? await (await import("../app/routes/dev.proxy-e2e")).loader({ request: new Request(
      "http://localhost/dev/proxy-e2e?q=" + encodeURIComponent(query)),
      params: {}, context: {},
    } as any) : null;
    const body = response ? await response.json() : { search_log_id: historical!.id };
    const log = historical ?? (body.search_log_id ? await db.aiSearchQueryLog.findUnique({
      where: { id: body.search_log_id },
    }) : null);
    const receipt = body.render_receipt?.id ? await db.aiSearchResultReceipt.findUnique({
      where: { receiptId: body.render_receipt.id },
    }) : null;
    const ranked = JSON.parse(receipt?.rankedProductsJson ?? log?.rankedProductsJson ?? "[]") as any[];
    const top = ranked.slice(0, 10);
    const ids = top.map(productIdOf);
    const shop = log?.shop ?? receipt?.shop;
    const products = shop ? await db.aiSearchIndexedProduct.findMany({
      where: { shop, productId: { in: ids } },
      select: { productId: true, title: true, searchable: true, hasVector: true },
    }) : [];
    const facts = shop ? await loadProductSemanticRows(shop, ids) : [];
    console.log("AUDIT " + JSON.stringify({
      query, source: live ? "LIVE" : "HISTORICAL", createdAt: log?.createdAt,
      status: body.status, reason: body.reason, total: body.pagination?.total_products ?? log?.resultCount,
      ms: Date.now() - started, logMs: log?.totalDurationMs,
      analysis: log?.llmAnalysisJson ? JSON.parse(log.llmAnalysisJson) : null,
      top: top.map((p) => {
        const id = productIdOf(p);
        return { ...p, product: products.find((r) => r.productId === id),
          facts: facts.filter((f) => f.productId === id && [
            "CANONICAL_PRODUCT_TYPE", "AUDIENCE", "ATTRIBUTE", "MODEL",
          ].includes(f.kind)).map((f) => `${f.kind}:${f.value}`),
        };
      }),
    }));
  }
} finally { await db.$disconnect(); }
