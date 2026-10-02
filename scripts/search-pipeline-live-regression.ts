import db from "../app/db.server";
import { prepareParallelQueryPipeline } from "../app/services/search/parallel-query-pipeline.server";
import { retrieveStructuredCandidates } from "../app/services/search/structured-candidate-retrieval.server";
import { semanticSearch, type SemanticSearchDiagnostics } from "../app/services/search/semantic-search.server";
import { applyShopContextToQuery, filterResultsByExplicitGender, type ExplicitGenderFilterDiagnostics } from "../app/services/search/shop-context-index.server";
import { getShopSettings } from "../app/services/commerce/shop-registry.server";

const shop = process.env.AI_SEARCH_REGRESSION_SHOP || "dev-app-6fvh2isn.myshopify.com";
const cases = [
  ["DIRECT", "waterproof jacket"],
  ["DIRECT", "blue dress"],
  ["DIRECT", "black cardigan"],
  ["DIRECT", "only black cardigan"],
  ["DIRECT", "cardigan not black"],
  ["DIRECT", "leather jacket"],
  ["DIRECT", "jacket not leather"],
  ["DIRECT", "700x35C tire"],
  ["DIRECT", "Shimano Dura-Ace crankset"],
  ["DIRECT", "kính mắt"],
  ["DISCOVERY", "đồ gia dụng"],
  ["DISCOVERY", "What can I wear on a rainy day?"],
  ["DISCOVERY", "something for camping"],
  ["DISCOVERY", "something for someone who likes minimalist fashion"],
  ["DISCOVERY", "I need something that keeps my feet comfortable all day"],
  ["COMPLEMENT", "Items that pair well with jeans"],
  ["COMPLEMENT", "what should I wear with a black skirt"],
  ["DIRECT", "women's black leather wallet"],
  ["DIRECT", "men's grey sneakers"],
  ["DIRECT", "white women's top"],
  ["DIRECT", "navy coat for women"],
  ["DISCOVERY", "something useful for hiking"],
  ["DIRECT", "a bag for commuting to work"],
  ["DISCOVERY", "something to wear in warm weather"],
  ["DISCOVERY", "a gift for someone who loves jewelry"],
  ["COMPLEMENT", "what goes well with a navy coat"],
  ["COMPLEMENT", "something to wear with grey sneakers"],
] as const;

const settings = await getShopSettings(shop);
const originalLog = console.log;
const reports: unknown[] = [];
const failures: string[] = [];
const expectedTopFacetByQuery = new Map<string, string>([
  ["blue dress", "blue"],
  ["black cardigan", "black"],
  ["men's grey sneakers", "grey"],
  ["white women's top", "white"],
]);
async function topProductHasFacetToken(productId: string, facet: string) {
  const rows = await db.aiSearchShopContextTerm.findMany({
    where: {
      shop,
      productId,
      kind: { in: ["ATTRIBUTE", "VARIANT_OPTION"] },
    },
    select: { normalizedValue: true },
  });
  const token = facet.trim().toLowerCase();
  return rows.some((row) =>
    ` ${row.normalizedValue.toLowerCase()} `.includes(` ${token} `),
  );
}
for (const [group, query] of cases.filter(([, query]) =>
  !process.env.AI_SEARCH_REGRESSION_FILTER ||
  query.toLowerCase().includes(process.env.AI_SEARCH_REGRESSION_FILTER.toLowerCase()),
)) {
  const started = Date.now();
  console.log = () => undefined;
  try {
    const pipeline = await prepareParallelQueryPipeline({ shop, query, searchLanguage: settings.searchLanguage });
    const plan = pipeline.profile?.finalPlan ?? pipeline.rawPlan;
    const proof = pipeline.finalProof ? await pipeline.finalProof : pipeline.rawProof;
    const rewrite = pipeline.profile?.rewrite;
    if (!rewrite) {
      reports.push({ query, expectedMode: group, mode: plan.retrievalMode, route: plan.route, finalProof: proof.status, finalCount: 0, ms: Date.now() - started });
      continue;
    }
    const contextual = await applyShopContextToQuery({ shop, originalQuery: query, rewrite });
    const structured = await retrieveStructuredCandidates({ shop, plan, limit: 100 });
    let diagnostics: SemanticSearchDiagnostics | null = null;
    const semantic = plan.route === "STRUCTURED_ONLY" ? [] : await semanticSearch({
      shop, query, limit: 100, preparedRewrite: contextual,
      onDiagnostics(value) { diagnostics = value; },
    });
    const semanticDiagnostics = diagnostics as SemanticSearchDiagnostics | null;
    const merged = new Map<string, (typeof structured)[number]>();
    for (const result of semantic) merged.set(result.productId, result);
    const floor = Math.max(0, Math.min(0.99, (semanticDiagnostics?.vectorThreshold ?? 0.35) - 0.001));
    const suppressStructuredRecall =
      plan.route !== "STRUCTURED_ONLY" &&
      semanticDiagnostics?.noEvidenceGuardTriggered === true;
    if (!suppressStructuredRecall) {
      for (const result of structured) {
        if (!merged.has(result.productId)) merged.set(result.productId, {
          ...result, score: plan.route === "STRUCTURED_ONLY" ? result.score : Math.min(result.score, floor),
        });
      }
    }
    let filterDiagnostics: ExplicitGenderFilterDiagnostics | null = null;
    const final = await filterResultsByExplicitGender({
      shop, originalQuery: query, rewrite: contextual,
      results: [...merged.values()].sort((a, b) => b.score - a.score),
      onDiagnostics(value) { filterDiagnostics = value; },
    });
    if (!rewrite.fallbackReason && plan.retrievalMode !== group) {
      failures.push(`${query}: expected mode ${group}, got ${plan.retrievalMode}`);
    }
    if (
      ["blue dress", "black cardigan", "leather jacket", "white women's top"].includes(query) &&
      plan.route === "STRUCTURED_ONLY"
    ) {
      failures.push(`${query}: soft semantic facet bypassed vector recall`);
    }
    if (
      ["700x35C tire", "Shimano Dura-Ace crankset"].includes(query) &&
      plan.route !== "STRUCTURED_ONLY"
    ) {
      failures.push(`${query}: exact commerce constraint left structured-only lane`);
    }
    if (group !== "COMPLEMENT" && (rewrite.analysis.referenceTerms ?? []).length > 0) {
      failures.push(`${query}: unexpected reference terms`);
    }
    if (group === "DISCOVERY") {
      const sourceIdentities = new Set(pipeline.rawPlan.identities.map((identity) => identity.normalizedValue ?? identity.value.toLowerCase()));
      if (plan.identities.some((identity) => identity.mode === "MUST" &&
        !sourceIdentities.has(identity.normalizedValue ?? identity.value.toLowerCase()))) {
        failures.push(`${query}: expansion identity was hardened`);
      }
    }
    if (query === "what should I wear with a black skirt") {
      if ((filterDiagnostics as ExplicitGenderFilterDiagnostics | null)?.colorFilteredCount !== 0) {
        failures.push(`${query}: reference color filtered target products`);
      }
      if (final.some((product) => /\bskirt\b/i.test(product.title))) {
        failures.push(`${query}: reference skirt remained in target results`);
      }
    }
    if (query === "blue dress" && (filterDiagnostics as ExplicitGenderFilterDiagnostics | null)?.colorFilteredCount !== 0) {
      failures.push(`${query}: ordinary color was hard-filtered`);
    }
    if (["What can I wear on a rainy day?", "something for camping", "I need something that keeps my feet comfortable all day"].includes(query) &&
        !rewrite.fallbackReason && final.length === 0) {
      failures.push(`${query}: open-world discovery returned no products`);
    }
    if (query === "I need something that keeps my feet comfortable all day" &&
        /maintenance|protecting footwear|variety of footwear/i.test(contextual.query)) {
      failures.push(`${query}: context drift in embedding input`);
    }
    const expectedTopFacet = expectedTopFacetByQuery.get(query);
    if (expectedTopFacet) {
      if (!final[0]) {
        failures.push(`${query}: no top result available for preferred facet check`);
      } else if (!(await topProductHasFacetToken(final[0].productId, expectedTopFacet))) {
        failures.push(
          `${query}: top result did not preserve preferred facet ${expectedTopFacet}`,
        );
      }
    }
    reports.push({
      query, mode: plan.retrievalMode, route: plan.route,
      semanticQuery: rewrite.planning?.semanticQuery ?? rewrite.query,
      productType: rewrite.analysis.productType,
      productTypes: rewrite.analysis.productTypes,
      shopLanguageProductType: rewrite.analysis.shopLanguageProductType,
      embeddingInput: contextual.query,
      selectedContext: contextual.context.selectedTerms.map(({ kind, value }) => ({ kind, value })),
      strongCatalogEvidence: semanticDiagnostics?.hasStrongCatalogEvidence ?? null,
      primaryEmbeddingInput: semanticDiagnostics?.primaryEmbeddingInput ?? null,
      semanticFacetBranches: semanticDiagnostics?.semanticFacetBranches ?? [],
      topVectorScore: semanticDiagnostics?.topVectorScore ?? null,
      threshold: semanticDiagnostics?.noEvidenceThreshold ?? null,
      noEvidenceGuard: semanticDiagnostics?.noEvidenceGuardTriggered ?? null,
      finalProof: { status: proof.status, reason: proof.reason },
      structuredCount: structured.length, candidateCount: semanticDiagnostics?.candidateCount ?? 0,
      finalCount: final.length, filterDiagnostics,
      topResults: final.slice(0, 5).map(({ handle, score }) => ({ handle, score: Number(score.toFixed(4)) })),
      ms: Date.now() - started,
    });
  } finally {
    console.log = originalLog;
  }
}
if (process.argv.includes("--compact")) {
  for (const item of reports as Array<Record<string, any>>) {
    console.log(JSON.stringify({
      query: item.query, mode: item.mode, route: item.route,
      semanticQuery: item.semanticQuery,
      productType: item.productType, productTypes: item.productTypes,
      shopLanguageProductType: item.shopLanguageProductType,
      embeddingInput: item.embeddingInput,
      selectedContext: item.selectedContext?.map((term: { value: string }) => term.value),
      strongCatalogEvidence: item.strongCatalogEvidence,
      primaryEmbeddingInput: item.primaryEmbeddingInput,
      semanticFacetBranches: item.semanticFacetBranches,
      topVectorScore: item.topVectorScore, threshold: item.threshold,
      noEvidenceGuard: item.noEvidenceGuard, finalProof: item.finalProof,
      candidateCount: item.candidateCount, finalCount: item.finalCount,
      filters: item.filterDiagnostics && {
        identity: item.filterDiagnostics.identityFilteredCount,
        color: item.filterDiagnostics.colorFilteredCount,
        negative: item.filterDiagnostics.negativeFilteredCount,
      },
      top: item.topResults?.slice(0, 3).map((result: { handle: string }) => result.handle),
    }));
  }
  console.log(JSON.stringify({ failures }));
} else {
  console.log(JSON.stringify({ failures, reports }, null, 2));
}
await db.$disconnect();
if (failures.length > 0) process.exitCode = 2;
