import { rewriteSearchQuery, type QueryRewriteResult } from "./query-rewriter.server";
import type { QueryPlan } from "./query-plan.server";
import {
  mergeLlmRewriteIntoPlan,
  queryPlanToLegacyRewrite,
} from "./legacy-query-rewrite-adapter.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";
import { getShopSearchDictionary } from "./shop-search-dictionary.server";

async function validateLlmProposal(shop: string, llm: QueryRewriteResult) {
  if (llm.fallbackReason) return llm;
  const dictionary = await getShopSearchDictionary(shop);
  const catalogValues = (field: string) => new Map(
    dictionary.entries
      .filter((entry) => entry.field === field)
      .flatMap((entry) => [
        [normalizeQueryText(entry.normalized), entry.canonical] as const,
        [normalizeQueryText(entry.canonical), entry.canonical] as const,
        ...entry.aliases.map((alias) => [normalizeQueryText(alias), entry.canonical] as const),
      ]),
  );
  const rejected: string[] = [];
  const validate = (values: string[], field: string) => {
    const allowed = catalogValues(field);
    return [...new Set(values.flatMap((value) => {
      const canonical = allowed.get(normalizeQueryText(value));
      if (!canonical) {
        rejected.push(`${field}:${value}`);
        return [];
      }
      return [canonical];
    }))];
  };
  const productTypes = validate(llm.analysis.productTypes, "PRODUCT_TYPE");
  const brands = validate(llm.analysis.brands, "BRAND");
  const models = validate(llm.analysis.models, "MODEL");
  const identifiers = validate(llm.analysis.identifiers, "IDENTIFIER");
  return {
    ...llm,
    analysis: {
      ...llm.analysis,
      productTypes,
      productType: productTypes[0] ?? "",
      shopLanguageProductType: productTypes[0] ?? "",
      brands,
      models,
      identifiers,
      semanticExpansions: [
        ...llm.analysis.semanticExpansions,
        ...rejected.filter((item) => item.startsWith("PRODUCT_TYPE:"))
          .map((item) => item.slice("PRODUCT_TYPE:".length)),
      ],
      decisionReason: `${llm.analysis.decisionReason};CATALOG_VALIDATOR_REJECTED:${rejected.join("|") || "none"}`,
    },
  };
}

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
  const validated = await validateLlmProposal(args.shop, llm);
  return mergeLlmRewriteIntoPlan(baseline, validated);
}
