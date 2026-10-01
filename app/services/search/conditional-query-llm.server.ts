import { getShopSettings } from "../commerce/shop-registry.server";
import { rewriteSearchQuery, type QueryRewriteResult } from "./query-rewriter.server";
import type { QueryPlan } from "./query-plan.server";
import {
  mergeLlmRewriteIntoPlan,
  queryPlanToLegacyRewrite,
} from "./legacy-query-rewrite-adapter.server";

function withDecisionReason(
  baseline: QueryRewriteResult,
  reason: string,
): QueryRewriteResult {
  return {
    ...baseline,
    analysis: {
      ...baseline.analysis,
      decisionReason: `${baseline.analysis.decisionReason};${reason}`,
    },
  };
}

export async function prepareQueryRewrite(args: {
  shop: string;
  query: string;
  plan: QueryPlan;
}): Promise<QueryRewriteResult> {
  const baseline = queryPlanToLegacyRewrite(args.plan, args.query);

  // Exact/structured lookups do not need semantic normalization or embedding.
  if (args.plan.route === "STRUCTURED_ONLY") return baseline;

  const shopSettings = await getShopSettings(args.shop);
  const shopLanguage = shopSettings.searchLanguage?.trim() || null;
  if (!shopLanguage) {
    return withDecisionReason(
      baseline,
      "LLM_SKIPPED_SHOP_LANGUAGE_NOT_CONFIGURED",
    );
  }

  const llmInput =
    args.plan.route === "LIGHT_LLM"
      ? args.plan.unresolvedSegments.join(" ").trim() || args.query
      : args.query;

  // Gemini is authoritative for language detection and semantic normalization.
  // Every semantic route waits for the normalized shop-language retrieval text
  // before embedding. Deterministic code still owns hard constraints/filters.
  const llm = await rewriteSearchQuery({
    shop: args.shop,
    query: llmInput,
    searchLanguage: shopLanguage,
  });

  return mergeLlmRewriteIntoPlan(baseline, llm);
}
