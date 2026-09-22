import type { QueryPlan, QueryConstraint } from "./query-plan.server";
import type {
  QueryRewriteAnalysis,
  QueryRewriteResult,
} from "./query-rewriter.server";

const values = (items: QueryConstraint[], mode?: QueryConstraint["mode"]) =>
  items.filter((item) => !mode || item.mode === mode).map((item) => item.value);

export function queryPlanToLegacyRewrite(
  plan: QueryPlan,
  originalQuery: string,
): QueryRewriteResult {
  const mustAttributes = plan.attributes.filter((item) => item.mode === "MUST");
  const shouldAttributes = plan.attributes.filter((item) => item.mode === "SHOULD");
  const excluded = [
    ...values(plan.identities, "MUST_NOT"),
    ...values(plan.entities.brands, "MUST_NOT"),
    ...values(plan.entities.models, "MUST_NOT"),
    ...values(plan.attributes, "MUST_NOT"),
    ...values(plan.contexts, "MUST_NOT"),
  ];
  const productTypes = values(plan.identities).filter(
    (value) => !values(plan.identities, "MUST_NOT").includes(value),
  );
  const sortIntent: QueryRewriteAnalysis["sortIntent"] =
    plan.sort.field === "PRICE"
      ? plan.sort.direction === "DESC" ? "PRICE_DESC" : "PRICE_ASC"
      : plan.marketPreference === "PREMIUM" ? "PREMIUM"
      : plan.marketPreference === "BUDGET" ? "BUDGET"
      : "RELEVANCE";
  const analysis: QueryRewriteAnalysis = {
    sortIntent,
    marketPreference: plan.marketPreference,
    intent: "PRODUCT_SEARCH",
    detectedLanguage: "auto",
    complexity: plan.route === "FULL_LLM" ? "COMPLEX" : "SIMPLE",
    confidence: plan.resolvedSegments.length ? 0.92 : 0.55,
    verticalFit: "IN_SCOPE",
    productType: productTypes[0] ?? "",
    productTypes,
    productRelation: productTypes.length ? plan.relation : "NONE",
    shopLanguageProductType: productTypes[0] ?? "",
    category: "",
    subcategory: "",
    brands: values(plan.entities.brands),
    models: values(plan.entities.models),
    identifiers: values(plan.entities.identifiers),
    audience: values(plan.audiences),
    requiredAttributes: mustAttributes.map((item) => item.value),
    optionalPreferences: shouldAttributes.map((item) => item.value),
    // CONTEXT/ALIAS is catalog vocabulary, not necessarily a use case. Keep
    // legacy fields empty unless their meaning is proven by the planner.
    useCases: [],
    compatibility: values(plan.compatibility),
    negativeAttributes: excluded,
    entities: [
      ...values(plan.entities.brands),
      ...values(plan.entities.models),
      ...values(plan.entities.identifiers),
    ],
    attributes: plan.attributes.map((item) => item.value),
    negativeTerms: excluded,
    semanticExpansions: [],
    shopLanguage: "auto",
    shopLanguageTerms: [],
    englishTerms: [],
    matchedCatalogTerms: plan.resolvedSegments.map((item) => item.canonicalValue),
    decisionReason: `QUERY_PLAN:${plan.route}:${plan.routerReason.join(",")}`,
  };
  return {
    query: plan.semanticQuery || originalQuery,
    rewritten: plan.semanticQuery !== originalQuery,
    catalogRelevant: true,
    analysis,
    model: null,
    fallbackReason: null,
    planning: {
      route: plan.route,
      semanticQuery: plan.semanticQuery,
      semanticResolution: plan.route === "VECTOR_SEMANTIC" ? "VECTOR" : "CODE",
      semanticResolutionConfidence: plan.unresolvedSegments.length === 0 ? 1 : 0.72,
      resolvedSegments: plan.resolvedSegments,
      unresolvedSegments: plan.unresolvedSegments,
    },
    timing: {
      cacheStatus: "BYPASS",
      totalMs: 0,
      llmMs: 0,
      llmCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      complexityRoute: plan.route === "FULL_LLM" ? "COMPLEX" : "SIMPLE",
    },
  };
}

export function mergeLlmRewriteIntoPlan(
  baseline: QueryRewriteResult,
  llm: QueryRewriteResult,
): QueryRewriteResult {
  const unique = (left: string[], right: string[]) => [...new Set([...left, ...right])];
  const queryParts = unique(
    baseline.query ? [baseline.query] : [],
    llm.query ? [llm.query] : [],
  );
  return {
    ...llm,
    // LIGHT_LLM only receives the unresolved fragment. Preserve the code-built
    // product identity and append the LLM expansion instead of replacing it.
    query: queryParts.join(" ; "),
    planning: {
      ...baseline.planning!,
      semanticQuery: queryParts.join(" ; "),
      semanticResolution: baseline.planning?.route === "LIGHT_LLM" ? "LIGHT_LLM" : "FULL_LLM",
      semanticResolutionConfidence: llm.analysis.confidence,
    },
    analysis: {
      ...llm.analysis,
      productTypes: unique(baseline.analysis.productTypes, llm.analysis.productTypes),
      brands: unique(baseline.analysis.brands, llm.analysis.brands),
      models: unique(baseline.analysis.models, llm.analysis.models),
      identifiers: unique(baseline.analysis.identifiers, llm.analysis.identifiers),
      audience: unique(baseline.analysis.audience, llm.analysis.audience),
      requiredAttributes: unique(baseline.analysis.requiredAttributes, llm.analysis.requiredAttributes),
      optionalPreferences: unique(baseline.analysis.optionalPreferences, llm.analysis.optionalPreferences),
      useCases: unique(baseline.analysis.useCases, llm.analysis.useCases),
      compatibility: unique(baseline.analysis.compatibility, llm.analysis.compatibility),
      negativeTerms: unique(baseline.analysis.negativeTerms, llm.analysis.negativeTerms),
      matchedCatalogTerms: unique(baseline.analysis.matchedCatalogTerms, llm.analysis.matchedCatalogTerms),
      sortIntent: baseline.analysis.sortIntent === "RELEVANCE" ? llm.analysis.sortIntent : baseline.analysis.sortIntent,
      marketPreference: baseline.analysis.marketPreference === "ANY" ? llm.analysis.marketPreference : baseline.analysis.marketPreference,
      decisionReason: `${baseline.analysis.decisionReason};LLM:${llm.analysis.decisionReason}`,
    },
  };
}
