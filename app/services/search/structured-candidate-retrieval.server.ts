import { listSearchableIndexedProducts } from "../commerce/indexed-products.server";
import type { QueryPlan, QueryConstraint } from "./query-plan.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";
import type { SearchResult } from "./semantic-search.server";
import type { ContextualQueryResult } from "./shop-context-index.server";
import {
  findSemanticRowsByNormalizedValues,
  loadProductSemanticRows,
  semanticPayloadToken,
} from "./product-semantic-profile.server";
import {
  findProductsBySemanticPayload,
  getSemanticPayloadCoverage,
} from "./vector-store.server";

export function typedProductFamilyMatches(actual: string, requested: string) {
  const fold = (value: string) => normalizeQueryText(value).split(" ").map((token) =>
    token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token
  ).join(" ");
  const source = fold(actual), target = fold(requested);
  // A subtype may add modifiers before the family noun. Accessory/component
  // families have their own final noun and do not inherit authority from a
  // reference word (bicycle helmet is not a bicycle).
  return Boolean(target) && (source === target || source.endsWith(` ${target}`));
}

export function resolveTypedAliasFamilyHeads(
  rows: Array<{productId: string; kind: string; value: string}>, targets: string[],
) {
  const byProduct = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    if (!["ALIAS", "PRODUCT_TYPE", "CANONICAL_PRODUCT_TYPE"].includes(row.kind)) continue;
    const kinds = byProduct.get(row.productId) ?? new Map<string, string[]>();
    const values = kinds.get(row.kind) ?? []; values.push(normalizeQueryText(row.value));
    kinds.set(row.kind, values); byProduct.set(row.productId, kinds);
  }
  const resolved = new Set<string>();
  for (const target of targets) {
    const heads = new Set<string>();
    for (const kinds of byProduct.values()) {
      if (!(kinds.get("ALIAS") ?? []).includes(normalizeQueryText(target))) continue;
      for (const actual of kinds.get("PRODUCT_TYPE") ?? []) {
        const head = actual.split(" ").at(-1)!;
        if ((kinds.get("CANONICAL_PRODUCT_TYPE") ?? []).some((canonical) => typedProductFamilyMatches(canonical, head))) heads.add(head);
      }
    }
    // Ambiguous aliases do not prove a family equivalence. The merchant type
    // and canonical class must agree on the same head across the alias seeds.
    if (heads.size === 1) resolved.add([...heads][0]);
  }
  return [...resolved];
}

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

/** Recall exact source-grounded profile facts missed by vector retrieval.
 * Context membership is only a shortlist, not proof: a compound component fact
 * such as "waterproof synthetic sole" does not prove "waterproof shoes".
 * Recheck complete fact equality and the searchable tenant registry here.
 * No vector score is invented. */
export async function retrieveGroundedFacetCandidates(args: {
  shop: string;
  rewrite: ContextualQueryResult;
}): Promise<SearchResult[]> {
  if (args.rewrite.planning?.retrievalMode !== "DIRECT") return [];
  const ids = args.rewrite.context.directSourceFacetConsensusProductIds;
  if (!ids.length) return [];
  const negatives = (args.rewrite.analysis.negativeTerms ?? []).map(normalizeQueryText);
  const facets = args.rewrite.planning.resolvedSegments.filter((segment) =>
    ["ATTRIBUTE", "COMPATIBILITY"].includes(segment.field) && segment.confidence >= 0.8 &&
    !negatives.includes(normalizeQueryText(segment.canonicalValue)),
  );
  if (!facets.length) return [];
  const [products, rows] = await Promise.all([
    listSearchableIndexedProducts(args.shop, ids), loadProductSemanticRows(args.shop, ids),
  ]);
  // Index candidate facts once. The former nested rows.some() walked every
  // flattened PSF row for every (product, facet), which scaled quadratically
  // on broad direct searches even after Qdrant had shortlisted the IDs.
  const allowedKinds = new Set([
    "ATTRIBUTE", "VARIANT_OPTION", "USE_CASE", "SOFT_CONTEXT", "COMPATIBILITY",
  ]);
  const factValuesByProduct = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!allowedKinds.has(row.kind)) continue;
    const values = factValuesByProduct.get(row.productId) ?? new Set<string>();
    values.add(normalizeQueryText(row.value));
    factValuesByProduct.set(row.productId, values);
  }
  const requiredValues = facets.map((facet) => normalizeQueryText(facet.canonicalValue));
  return products.filter((product) =>
    requiredValues.every((value) => factValuesByProduct.get(product.productId)?.has(value) === true),
  ).map((product) => ({
    ...product, score: 0.72, structuredScore: 0.72,
    structuredMatchedKinds: ["PRODUCT_TYPE", ...new Set(facets.map(f => f.field))],
    structuredMatchedTerms: facets.map(f => ({ kind: f.field, value: normalizeQueryText(f.canonicalValue) })),
    structuredAnchorKinds: ["PRODUCT_TYPE"], retrievalSources: ["STRUCTURED"],
  }));
}

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

function structuredEquivalenceKey(value: string) {
  return normalizeQueryText(value)
    .split(" ")
    .filter(Boolean)
    .map((token) => {
      if (token.length > 4 && token.endsWith("ies")) {
        return token.slice(0, -3) + "y";
      }
      if (
        token.length > 3 &&
        token.endsWith("s") &&
        !token.endsWith("ss") &&
        !token.endsWith("us") &&
        !token.endsWith("is")
      ) {
        return token.slice(0, -1);
      }
      return token;
    })
    .join(" ");
}

function wantedTerms(plan: QueryPlan): WantedTerm[] {
  const raw: WantedTerm[] = [
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
  const seen = new Set<string>();
  return raw.filter((term) => {
    const normalized =
      term.constraint.normalizedValue || normalizeQueryText(term.constraint.value);
    const key = `${term.kind}:${structuredEquivalenceKey(normalized)}:${term.constraint.mode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hasStructuredAnchor(plan: QueryPlan) {
  // Exact measurements and explicit compatibility are valid retrieval
  // anchors too. A SHOULD color/style remains non-anchoring, but a MUST
  // 700x35C/65W/128GB or exact fitment must be able to seed candidates even
  // when a merchant taxonomy labels the product noun as a generic ATTRIBUTE.
  return wantedTerms(plan).some(isRetrievalAnchor);
}

function rowKindsForWantedTerm(term: WantedTerm) {
  if (term.kind === "IDENTIFIER") return ["IDENTIFIER", "SKU", "BARCODE"];
  if (term.kind === "MODEL") return ["MODEL"];
  if (term.kind === "PRODUCT_TYPE") {
    return ["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "ALIAS", "CATEGORY"];
  }
  if (term.kind === "BRAND") return ["BRAND", "VENDOR"];
  if (term.kind === "COMPATIBILITY") return ["COMPATIBILITY"];
  if (term.kind === "AUDIENCE") return ["AUDIENCE"];
  if (term.kind === "MEASUREMENT") return ["MEASUREMENT", "VARIANT_OPTION"];
  if (term.kind === "ATTRIBUTE") {
    return term.constraint.mode === "SHOULD"
      ? ["ATTRIBUTE", "VARIANT_OPTION", "TAG"]
      : ["ATTRIBUTE", "VARIANT_OPTION"];
  }
  if (term.kind === "CONTEXT") return ["USE_CASE", "SOFT_CONTEXT"];
  return [];
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
  // search engine. Weak SHOULD attributes/context may boost/rerank anchored
  // candidates, but must never create a standalone candidate pool.
  const anchorTerms = wanted.filter(isRetrievalAnchor);
  if (!anchorTerms.length) return [];

  const normalizedValues = [...new Set(wanted.map(({ constraint }) =>
    constraint.normalizedValue || normalizeQueryText(constraint.value),
  ))];

  const anchorSemanticTokens = [...new Set(
    anchorTerms.flatMap((term) => {
      const normalized =
        term.constraint.normalizedValue ||
        normalizeQueryText(term.constraint.value);
      return rowKindsForWantedTerm(term)
        .map((kind) => semanticPayloadToken(kind, normalized))
        .filter(Boolean);
    }),
  )];

  const requiredSemanticGroups = anchorTerms
    .filter((term) => term.constraint.mode === "MUST")
    .map((term) => {
      const normalized =
        term.constraint.normalizedValue ||
        normalizeQueryText(term.constraint.value);
      return rowKindsForWantedTerm(term)
        .map((kind) => semanticPayloadToken(kind, normalized))
        .filter(Boolean);
    })
    .filter((group) => group.length > 0);

  let qdrantCandidateIds: string[] = [];
  let qdrantCoverageComplete = false;

  try {
    const coverage = await getSemanticPayloadCoverage(args.shop);
    qdrantCoverageComplete = coverage.complete;

    if (qdrantCoverageComplete) {
      const qdrantCandidates = await findProductsBySemanticPayload({
        shop: args.shop,
        // Qdrant is only the compact pre-filter. Do not seed it with weak
        // context/attribute terms that can swamp a finite candidate window.
        semanticTerms: anchorSemanticTokens,
        requiredGroups: requiredSemanticGroups,
        limit: Math.min(5_000, Math.max(500, args.limit * 8)),
      });
      qdrantCandidateIds = qdrantCandidates.map(
        (candidate) => candidate.productId,
      );
    }
  } catch (error) {
    // Exact retrieval is an optimization over the authoritative JSON profile.
    // A transient Qdrant/index problem must never turn into missing products.
    console.warn("[AI Search][STRUCTURED] semantic payload lookup fallback", {
      shop: args.shop,
      error: error instanceof Error ? error.message : String(error),
    });
    qdrantCoverageComplete = false;
  }

  const normalizedSet = new Set(normalizedValues);
  const rows = qdrantCoverageComplete
    ? (
        await loadProductSemanticRows(args.shop, qdrantCandidateIds)
      ).filter((row) => normalizedSet.has(row.normalizedValue))
    : await findSemanticRowsByNormalizedValues(args.shop, normalizedValues);
  const scores = new Map<string, number>();
  const matchedMust = new Map<string, Set<string>>();
  const matchedKeys = new Map<string, Set<string>>();
  const matchedRowKinds = new Map<string, Set<string>>();
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
      const rowKindSet =
        matchedRowKinds.get(row.productId) || new Set<string>();
      rowKindSet.add(row.kind);
      matchedRowKinds.set(row.productId, rowKindSet);
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
  const wantedByKey = new Map(
    wanted.map((term) => [
      `${term.kind}:${
        term.constraint.normalizedValue ||
        normalizeQueryText(term.constraint.value)
      }`,
      term,
    ]),
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
  const [products, identityFacts] = await Promise.all([
    listSearchableIndexedProducts(args.shop, ids), loadProductSemanticRows(args.shop, ids),
  ]);
  const familyFacts = new Map<string, string[]>();
  for (const fact of identityFacts) {
    if (!["PRODUCT_TYPE", "CANONICAL_PRODUCT_TYPE"].includes(fact.kind)) continue;
    const values = familyFacts.get(fact.productId) ?? [];
    values.push(fact.value); familyFacts.set(fact.productId, values);
  }
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
    const matchedTerms = [...matched]
      .map((key) => wantedByKey.get(key))
      .filter((term): term is WantedTerm => Boolean(term));
    const matchedKinds = [
      ...new Set(matchedTerms.map((term) => term.kind)),
    ];
    const matchedAnchorKinds = [
      ...new Set(
        matchedTerms
          .filter(isRetrievalAnchor)
          .map((term) => term.kind),
      ),
    ];
    const rowKinds = [...(matchedRowKinds.get(id) ?? new Set<string>())];
    const exactCanonicalIdentity =
      matchedKinds.includes("PRODUCT_TYPE") &&
      (rowKinds.includes("CANONICAL_PRODUCT_TYPE") || (rowKinds.includes("ALIAS") && (familyFacts.get(id)?.length ?? 0) > 0) || matchedTerms.some((term) =>
        term.kind === "PRODUCT_TYPE" && (familyFacts.get(id) ?? []).some((actual) =>
          typedProductFamilyMatches(actual, term.constraint.normalizedValue || term.constraint.value)
        )
      ));
    const hasClosedWorldAnchor = matchedAnchorKinds.some((kind) =>
      ["IDENTIFIER", "MODEL", "COMPATIBILITY", "MEASUREMENT"].includes(kind),
    );
    const exactHighConfidenceIdentity = matchedTerms.some(
      (term) =>
        term.kind === "PRODUCT_TYPE" &&
        term.constraint.confidence >= 0.92 &&
        ["CODE", "DICTIONARY"].includes(term.constraint.source),
    );
    const brandPlusIdentity =
      matchedAnchorKinds.includes("BRAND") &&
      matchedAnchorKinds.includes("PRODUCT_TYPE");
    const guardRescue =
      hasClosedWorldAnchor ||
      exactHighConfidenceIdentity ||
      brandPlusIdentity;

    return [{
      ...product,
      score: calibratedScore,
      structuredScore: calibratedScore,
      structuredMatchedKinds: matchedKinds,
      structuredMatchedTerms: matchedTerms.map((term) => ({
        kind: term.kind,
        value: term.constraint.normalizedValue || normalizeQueryText(term.constraint.value),
      })),
      structuredMatchedRowKinds: rowKinds,
      structuredAnchorKinds: matchedAnchorKinds,
      structuredGuardRescue: guardRescue,
      structuredExactCanonicalIdentity: exactCanonicalIdentity,
      retrievalSources: ["STRUCTURED" as const],
    }];
  });
}
