import { rewriteSearchQuery, type QueryRewriteResult } from "./query-rewriter.server";
import type { QueryPlan } from "./query-plan.server";
import {
  mergeLlmRewriteIntoPlan,
  queryPlanToLegacyRewrite,
} from "./legacy-query-rewrite-adapter.server";

export async function prepareQueryRewrite(args: {
  shop: string;
  query: string;
  plan: QueryPlan;
}): Promise<QueryRewriteResult> {
  const baseline = queryPlanToLegacyRewrite(args.plan, args.query);
  if (!["LIGHT_LLM", "FULL_LLM"].includes(args.plan.route)) return baseline;

  const llmInput = args.plan.route === "LIGHT_LLM"
    ? args.plan.unresolvedSegments.join(" ").trim() || args.query
    : args.query;
  const llm = await rewriteSearchQuery({ shop: args.shop, query: llmInput });
  return mergeLlmRewriteIntoPlan(baseline, llm);
}
