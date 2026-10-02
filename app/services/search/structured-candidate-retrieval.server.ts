import { listSearchableIndexedProducts } from "../commerce/indexed-products.server";
import type { QueryPlan, QueryConstraint } from "./query-plan.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";
import type { SearchResult } from "./semantic-search.server";
import { loadShopSemanticRows } from "./product-semantic-profile.server";

export const STRUCTURED_RANKING_WEIGHTS = {
  IDENTIFIER: 100,
  MODEL: 70,
  PRODUCT_TYPE: 40,
  BRAND: 20,
  COMPATIBILITY: 18,
  AUDIENCE: 10,
  MEASUREMENT: 8,
  ATTRIBUTE: 6,
  CONTEXT: 4,
} as const;

type WantedKind = keyof typeof STRUCTURED_RANKING_WEIGHTS;
type WantedTerm = { kind: WantedKind; constraint: QueryConstraint };

const STRUCTURED_ANCHOR_KINDS = new Set<WantedKind>([
  "IDENTIFIER",
  "MODEL",
  "PRODUCT_TYPE",
  "BRAND",
  "COMPATIBILITY",
  "MEASUREMENT",
]);

const STRUCTURED_SCORE_CEILINGS: Record<WantedKind, number> = {
  IDENTIFIER: 0.995,
  MODEL: 0.96,
  PRODUCT_TYPE: 0.92,
  BRAND: 0.88,
  COMPATIBILITY: 0.84,
  MEASUREMENT: 0.8,
  AUDIENCE: 0.68,
  ATTRIBUTE: 0.62,
  CONTEXT: 0.58,
};

function isRetrievalAnchor(term: WantedTerm) {
  if (
    term.kind === "MEASUREMENT" &&
    term.constraint.mode !== "MUST"
  ) {
    return false;
  }

  return (
    term.constraint.mode !== "MUST_NOT" &&
    STRUCTURED_ANCHOR_KINDS.has(term.kind) &&
    term.constraint.confidence >= 0.75
  );
}

function wantedTerms(plan: QueryPlan): WantedTerm[] {
  return [
    ...plan.entities.identifiers.map((constraint) => ({ kind: "IDENTIFIER" as const, constraint })),
    ...plan.entities.models.map((constraint) => ({ kind: "MODEL" as const, constraint })),
    ...plan.identities.map((constraint) => ({ kind: "PRODUCT_TYPE" as const, constraint })),
    ...plan.entities.brands.map((constraint) => ({ kind: "BRAND" as const, constraint })),
    ...plan.compatibility.map((constraint) => ({ kind: "COMPATIBILITY" as const, constraint })),
    ...plan.audiences.map((constraint) => ({ kind: "AUDIENCE" as const, constraint })),
    ...plan.measurements.map(({ name: _name, ...constraint }) => ({ kind: "MEASUREMENT" as const, constraint })),
    ...plan.attributes.map(({ name: _name, ...constraint }) => ({ kind: "ATTRIBUTE" as const, constraint })),
    ...plan.contexts.map((constraint) => ({ kind: "CONTEXT" as const, constraint })),
  ];
}

export function hasStructuredAnchor(plan: QueryPlan) {
  // Exact measurements and explicit compatibility are valid retrieval
  // anchors too. A SHOULD color/style remains non-anchoring, but a MUST
  // 700x35C/65W/128GB or exact fitment must be able to seed candidates even
  // when a merchant taxonomy labels the product noun as a generic ATTRIBUTE.
  return wantedTerms(plan).some(isRetrievalAnchor);
}

function rowMatchesWantedKind(rowKind: string, term: WantedTerm) {
  if (term.kind === "IDENTIFIER") {
    return ["IDENTIFIER", "SKU", "BARCODE"].includes(rowKind);
  }
  if (term.kind === "MODEL") return rowKind === "MODEL";
  if (term.kind === "PRODUCT_TYPE") {
    return ["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "ALIAS", "CATEGORY"].includes(rowKind);
  }
  if (term.kind === "BRAND") return ["BRAND", "VENDOR"].includes(rowKind);
  if (term.kind === "COMPATIBILITY") return rowKind === "COMPATIBILITY";
  if (term.kind === "AUDIENCE") return rowKind === "AUDIENCE";
  if (term.kind === "MEASUREMENT") {
    return ["MEASUREMENT", "VARIANT_OPTION"].includes(rowKind);
  }
  if (term.kind === "ATTRIBUTE") {
    if (["ATTRIBUTE", "VARIANT_OPTION"].includes(rowKind)) return true;
    return rowKind === "TAG" && term.constraint.mode === "SHOULD";
  }
  if (term.kind === "CONTEXT") {
    return ["USE_CASE", "SOFT_CONTEXT"].includes(rowKind);
  }
  return false;
}

export async function retrieveStructuredCandidates(args: {
  shop: string;
  plan: QueryPlan;
  limit: number;
}): Promise<SearchResult[]> {
  const wanted = wantedTerms(args.plan);
  if (!wanted.length) return [];
  // A weak attribute/context/tag match cannot establish product identity on
  // its own. Otherwise a single common color is normalized to score=1 and
  // floods the semantic result set with unrelated products.
  if (!hasStructuredAnchor(args.plan)) return [];

  // Structured retrieval is an exact-fact lane, not a second broad semantic
  // search engine. Weak SHOULD attributes/context such as "blue", "goods" or
  // "camping" may boost/rerank anchored candidates, but must never create a
  // standalone candidate pool.
  const anchorTerms = wanted.filter(isRetrievalAnchor);
  if (!anchorTerms.length) return [];

  const normalizedValues = [...new Set(wanted.map(({ constraint }) =>
    constraint.normalizedValue || normalizeQueryText(constraint.value),
  ))];

  const normalizedSet = new Set(normalizedValues);
  const rows = (await loadShopSemanticRows(args.shop)).filter((row) =>
    normalizedSet.has(row.normalizedValue),
  );
  const scores = new Map<string, number>();
  const matchedMust = new Map<string, Set<string>>();
  const matchedKeys = new Map<string, Set<string>>();
  const excluded = new Set<string>();
  const mustKeys = new Set(
    wanted.filter(({ constraint }) => constraint.mode === "MUST")
      .map(({ kind, constraint }) =>
        `${kind}:${constraint.normalizedValue || normalizeQueryText(constraint.value)}`,
      ),
  );

  for (const row of rows) {
    for (const term of wanted) {
      if (!rowMatchesWantedKind(row.kind, term)) continue;
      const normalized =
        term.constraint.normalizedValue || normalizeQueryText(term.constraint.value);
      if (normalized !== row.normalizedValue) continue;
      if (term.constraint.mode === "MUST_NOT") {
        excluded.add(row.productId);
        continue;
      }
      const key = `${term.kind}:${normalized}`;
      scores.set(
        row.productId,
        (scores.get(row.productId) || 0) +
          STRUCTURED_RANKING_WEIGHTS[term.kind] * term.constraint.confidence,
      );
      const matched = matchedKeys.get(row.productId) || new Set<string>();
      matched.add(key);
      matchedKeys.set(row.productId, matched);
      if (term.constraint.mode === "MUST") {
        const set = matchedMust.get(row.productId) || new Set<string>();
        set.add(key);
        matchedMust.set(row.productId, set);
      }
    }
  }

  const anchorKeys = new Set(
    anchorTerms.map(
      ({ kind, constraint }) =>
        `${kind}:${constraint.normalizedValue || normalizeQueryText(constraint.value)}`,
    ),
  );
  const identityKeys = new Set(
    wanted
      .filter(
        ({ kind, constraint }) =>
          kind === "PRODUCT_TYPE" && constraint.mode !== "MUST_NOT",
      )
      .map(
        ({ kind, constraint }) =>
          `${kind}:${constraint.normalizedValue || normalizeQueryText(constraint.value)}`,
      ),
  );
  const hasMustIdentity = wanted.some(
    ({ kind, constraint }) =>
      kind === "PRODUCT_TYPE" && constraint.mode === "MUST",
  );

  const ids = [...scores.entries()]
    .filter(([id]) => {
      if (excluded.has(id)) return false;
      if (![...mustKeys].every((key) => matchedMust.get(id)?.has(key))) {
        return false;
      }
      const matched = matchedKeys.get(id);
      if (![...anchorKeys].some((key) => matched?.has(key))) {
        return false;
      }
      if (identityKeys.size > 0 && !hasMustIdentity) {
        if (![...identityKeys].some((key) => matched?.has(key))) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.limit)
    .map(([id]) => id);

  if (!ids.length) return [];
  const products = await listSearchableIndexedProducts(args.shop, ids);
  const byId = new Map(products.map((product) => [product.productId, product]));
  const top = Math.max(...ids.map((id) => scores.get(id) || 0), 1);

  return ids.flatMap((id) => {
    const product = byId.get(id);
    if (!product) return [];

    const matched = matchedKeys.get(id) ?? new Set<string>();
    const strongestCeiling = Math.max(
      ...[...matched].map((key) => {
        const kind = key.slice(0, key.indexOf(":")) as WantedKind;
        return STRUCTURED_SCORE_CEILINGS[kind] ?? 0.55;
      }),
      0.55,
    );
    const relative = Math.max(0, Math.min(1, (scores.get(id) || 0) / top));
    const floor = Math.max(0, strongestCeiling - 0.12);
    const calibratedScore = Math.min(
      strongestCeiling,
      floor + relative * 0.12,
    );

    return [{ ...product, score: calibratedScore }];
  });
}
