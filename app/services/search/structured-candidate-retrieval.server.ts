import db from "../../db.server";
import { listSearchableIndexedProducts } from "../commerce/indexed-products.server";
import type { QueryPlan, QueryConstraint } from "./query-plan.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";
import type { SearchResult } from "./semantic-search.server";

export const STRUCTURED_RANKING_WEIGHTS = {
  IDENTIFIER: 100,
  MODEL: 70,
  PRODUCT_TYPE: 40,
  BRAND: 20,
  COMPATIBILITY: 18,
  AUDIENCE: 10,
  ATTRIBUTE: 6,
  CONTEXT: 4,
} as const;

type WantedTerm = { kind: keyof typeof STRUCTURED_RANKING_WEIGHTS; constraint: QueryConstraint };

function wantedTerms(plan: QueryPlan): WantedTerm[] {
  return [
    ...plan.entities.identifiers.map((constraint) => ({ kind: "IDENTIFIER" as const, constraint })),
    ...plan.entities.models.map((constraint) => ({ kind: "MODEL" as const, constraint })),
    ...plan.identities.map((constraint) => ({ kind: "PRODUCT_TYPE" as const, constraint })),
    ...plan.entities.brands.map((constraint) => ({ kind: "BRAND" as const, constraint })),
    ...plan.compatibility.map((constraint) => ({ kind: "COMPATIBILITY" as const, constraint })),
    ...plan.audiences.map((constraint) => ({ kind: "AUDIENCE" as const, constraint })),
    ...plan.attributes.map(({ name: _name, ...constraint }) => ({ kind: "ATTRIBUTE" as const, constraint })),
    ...plan.contexts.map((constraint) => ({ kind: "CONTEXT" as const, constraint })),
  ];
}

export async function retrieveStructuredCandidates(args: {
  shop: string;
  plan: QueryPlan;
  limit: number;
}): Promise<SearchResult[]> {
  const wanted = wantedTerms(args.plan);
  if (!wanted.length) return [];
  const normalizedValues = [...new Set(wanted.map(({ constraint }) =>
    constraint.normalizedValue || normalizeQueryText(constraint.value),
  ))];
  const rows = await db.aiSearchShopContextTerm.findMany({
    where: { shop: args.shop, normalizedValue: { in: normalizedValues } },
    select: { productId: true, kind: true, normalizedValue: true },
    take: 50_000,
  });
  const scores = new Map<string, number>();
  const matchedMust = new Map<string, Set<string>>();
  const excluded = new Set<string>();
  const mustKeys = new Set(
    wanted.filter(({ constraint }) => constraint.mode === "MUST")
      .map(({ kind, constraint }) => `${kind}:${constraint.normalizedValue || normalizeQueryText(constraint.value)}`),
  );
  for (const row of rows) {
    for (const term of wanted) {
      const normalized = term.constraint.normalizedValue || normalizeQueryText(term.constraint.value);
      if (normalized !== row.normalizedValue) continue;
      if (term.constraint.mode === "MUST_NOT") { excluded.add(row.productId); continue; }
      const key = `${term.kind}:${normalized}`;
      scores.set(row.productId, (scores.get(row.productId) || 0) + STRUCTURED_RANKING_WEIGHTS[term.kind] * term.constraint.confidence);
      if (term.constraint.mode === "MUST") {
        const set = matchedMust.get(row.productId) || new Set<string>();
        set.add(key); matchedMust.set(row.productId, set);
      }
    }
  }
  const ids = [...scores.entries()]
    .filter(([id]) => !excluded.has(id) && [...mustKeys].every((key) => matchedMust.get(id)?.has(key)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.limit)
    .map(([id]) => id);
  if (!ids.length) return [];
  const products = await listSearchableIndexedProducts(args.shop, ids);
  const byId = new Map(products.map((product) => [product.productId, product]));
  const top = Math.max(...ids.map((id) => scores.get(id) || 0), 1);
  return ids.flatMap((id) => {
    const product = byId.get(id);
    return product ? [{ ...product, score: (scores.get(id) || 0) / top }] : [];
  });
}
