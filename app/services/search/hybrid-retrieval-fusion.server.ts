import type { QueryPlan } from "./query-plan.server";
import type { SearchResult } from "./semantic-search.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";

const CLOSED_WORLD_KINDS = new Set([
  "IDENTIFIER",
  "MODEL",
  "COMPATIBILITY",
  "MEASUREMENT",
]);

const NON_SEMANTIC_REMAINDER = new Set([
  "price","priced","cheap","cheapest","affordable","budget","expensive",
  "priciest","premium","luxury","most","least","newest","latest","under",
  "over","below","above","usd","dollar","dollars",
]);

function meaningfulUnresolved(plan: QueryPlan | null) {
  if (!plan) return [];
  return plan.unresolvedSegments
    .flatMap((value) => value.toLowerCase().split(/\s+/))
    .map((value) => value.replace(/[^\p{L}\p{N}-]+/gu, ""))
    .filter((value) => value.length > 1)
    .filter((value) => !NON_SEMANTIC_REMAINDER.has(value));
}

function uniqueSources(...groups: Array<SearchResult["retrievalSources"]>) {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

function isClosedWorldStructured(result: SearchResult) {
  return (result.structuredAnchorKinds ?? []).some((kind) =>
    CLOSED_WORLD_KINDS.has(kind),
  );
}

function coversPositiveSemanticFacets(result: SearchResult, plan: QueryPlan | null) {
  if (!plan) return true;
  const required = [
    ...plan.attributes.map((constraint) => ({ kind: "ATTRIBUTE", constraint })),
    ...plan.contexts.map((constraint) => ({ kind: "CONTEXT", constraint })),
  ].filter(({ constraint }) => constraint.mode !== "MUST_NOT");
  return required.every(({ kind, constraint }) =>
    (result.structuredMatchedTerms ?? []).some((term) =>
      term.kind === kind && normalizeQueryText(term.value) ===
        normalizeQueryText(constraint.normalizedValue || constraint.value),
    ),
  );
}

function structuredCanRescueGuard(
  result: SearchResult,
  plan: QueryPlan | null,
) {
  if (isClosedWorldStructured(result)) return true;
  const kinds = new Set(result.structuredMatchedKinds ?? []);
  if (kinds.has("BRAND") && kinds.has("PRODUCT_TYPE") &&
      meaningfulUnresolved(plan).length === 0 && coversPositiveSemanticFacets(result, plan)) return true;
  const typedMultiFact =
    kinds.has("PRODUCT_TYPE") &&
    ["ATTRIBUTE", "AUDIENCE", "CONTEXT"].some((kind) => kinds.has(kind));
  if (
    meaningfulUnresolved(plan).length === 0 &&
    coversPositiveSemanticFacets(result, plan) &&
    (result.structuredExactCanonicalIdentity || typedMultiFact)
  ) {
    return true;
  }
  return false;
}

function boundedBoost(baseScore: number, boost: number, ceiling = 0.995) {
  const base = Math.max(0, Math.min(ceiling, baseScore));
  const strength = Math.max(0, Math.min(0.75, boost));
  return Math.min(ceiling, base + (ceiling - base) * strength);
}

function structuredStandaloneCeiling(result: SearchResult) {
  const kinds = new Set(result.structuredMatchedKinds ?? []);
  const multiFact = kinds.size >= 2;
  if (isClosedWorldStructured(result)) return 0.96;
  if (kinds.has("BRAND") && kinds.has("PRODUCT_TYPE")) return 0.86;
  if (result.structuredExactCanonicalIdentity && multiFact) return 0.82;
  if (result.structuredExactCanonicalIdentity) return 0.78;
  if (multiFact && kinds.has("PRODUCT_TYPE")) return 0.72;
  return 0.66;
}

function mergeMetadata(
  current: SearchResult,
  incoming: SearchResult,
): SearchResult {
  return {
    ...current,
    lexicalScore: Math.max(
      current.lexicalScore ?? 0,
      incoming.lexicalScore ?? 0,
    ) || undefined,
    lexicalMatchType:
      (incoming.lexicalScore ?? 0) > (current.lexicalScore ?? 0)
        ? incoming.lexicalMatchType
        : current.lexicalMatchType,
    sparseScore: Math.max(
      current.sparseScore ?? 0,
      incoming.sparseScore ?? 0,
    ) || undefined,
    sparseRank:
      Math.min(
        current.sparseRank ?? Number.POSITIVE_INFINITY,
        incoming.sparseRank ?? Number.POSITIVE_INFINITY,
      ) < Number.POSITIVE_INFINITY
        ? Math.min(
            current.sparseRank ?? Number.POSITIVE_INFINITY,
            incoming.sparseRank ?? Number.POSITIVE_INFINITY,
          )
        : undefined,
    rrfScore: Math.max(current.rrfScore ?? 0, incoming.rrfScore ?? 0) || undefined,
    structuredScore: Math.max(
      current.structuredScore ?? 0,
      incoming.structuredScore ?? 0,
    ) || undefined,
    structuredMatchedKinds: [
      ...new Set([
        ...(current.structuredMatchedKinds ?? []),
        ...(incoming.structuredMatchedKinds ?? []),
      ]),
    ],
    structuredMatchedTerms: [...new Map([
      ...(current.structuredMatchedTerms ?? []),
      ...(incoming.structuredMatchedTerms ?? []),
    ].map((term) => [`${term.kind}:${normalizeQueryText(term.value)}`, term])).values()],
    structuredMatchedRowKinds: [
      ...new Set([
        ...(current.structuredMatchedRowKinds ?? []),
        ...(incoming.structuredMatchedRowKinds ?? []),
      ]),
    ],
    structuredAnchorKinds: [
      ...new Set([
        ...(current.structuredAnchorKinds ?? []),
        ...(incoming.structuredAnchorKinds ?? []),
      ]),
    ],
    structuredGuardRescue:
      current.structuredGuardRescue || incoming.structuredGuardRescue,
    structuredExactCanonicalIdentity:
      current.structuredExactCanonicalIdentity ||
      incoming.structuredExactCanonicalIdentity,
    retrievalSources: uniqueSources(
      current.retrievalSources,
      incoming.retrievalSources,
    ),
  };
}

export type HybridFusionDiagnostics = {
  semanticCount: number;
  structuredCount: number;
  lexicalCount: number;
  sparseCount: number;
  sparseRecallAdded: number;
  rrfConfirmedCount: number;
  structuredSuppressedByGuard: number;
  structuredRecallAdded: number;
  lexicalRecallAdded: number;
  hybridConfirmedCount: number;
};

export function fuseHybridRetrieval(args: {
  plan: QueryPlan | null;
  semantic: SearchResult[];
  sparse?: SearchResult[];
  structured: SearchResult[];
  lexical: SearchResult[];
  semanticNoEvidence: boolean;
  sourceProductClassAbsent?: boolean;
  semanticThreshold: number;
  limit: number;
}) {
  const sparse = args.sparse ?? [];
  const diagnostics: HybridFusionDiagnostics = {
    semanticCount: args.semantic.length,
    structuredCount: args.structured.length,
    lexicalCount: args.lexical.length,
    sparseCount: sparse.length,
    sparseRecallAdded: 0,
    rrfConfirmedCount: 0,
    structuredSuppressedByGuard: 0,
    structuredRecallAdded: 0,
    lexicalRecallAdded: 0,
    hybridConfirmedCount: 0,
  };

  // Dense cosine and BM25 scores live on incompatible scales. Fuse ranks first
  // with plain RRF. Exact lexical and structured truth are applied afterward.
  const RRF_K = 60;
  const RRF_MAX_TWO_LANES = 2 / (RRF_K + 1);
  const rrf = new Map<string, { result: SearchResult; raw: number }>();

  const addRrfLane = (
    results: SearchResult[],
    source: "SEMANTIC" | "SPARSE",
  ) => {
    results.forEach((result, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const current = rrf.get(result.productId);
      const incoming: SearchResult = {
        ...result,
        retrievalSources: uniqueSources(result.retrievalSources, [source]),
      };
      if (!current) {
        rrf.set(result.productId, { result: incoming, raw: contribution });
        if (source === "SPARSE") diagnostics.sparseRecallAdded += 1;
        return;
      }
      current.result = mergeMetadata(current.result, incoming);
      current.raw += contribution;
      if (source === "SPARSE") diagnostics.rrfConfirmedCount += 1;
    });
  };

  addRrfLane(args.semantic, "SEMANTIC");
  addRrfLane(sparse, "SPARSE");

  const merged = new Map<string, SearchResult>();
  for (const [productId, entry] of rrf) {
    const normalizedRrf = Math.min(1, entry.raw / RRF_MAX_TWO_LANES);
    merged.set(productId, {
      ...entry.result,
      rrfScore: normalizedRrf,
      score: normalizedRrf,
    });
  }

  // Exact lexical title/handle evidence is an authority override, not another
  // incomparable retrieval score mixed into RRF.
  for (const result of args.lexical) {
    const current = merged.get(result.productId);
    if (!current) {
      merged.set(result.productId, {
        ...result,
        retrievalSources: uniqueSources(result.retrievalSources, ["LEXICAL"]),
      });
      diagnostics.lexicalRecallAdded += 1;
      continue;
    }
    const combined = mergeMetadata(current, result);
    combined.score = Math.max(
      current.score,
      result.lexicalScore ?? result.score,
    );
    merged.set(result.productId, combined);
    diagnostics.hybridConfirmedCount += 1;
  }

  const semanticFloor = Math.max(
    0,
    Math.min(0.99, args.semanticThreshold - 0.001),
  );

  // Structured/PSF is a truth/evidence layer. It can rescue closed-world exact
  // facts, or confirm/rerank already-retrieved candidates, but must not behave
  // like a generic third semantic ranker.
  for (const result of args.structured) {
    const current = merged.get(result.productId);
    const canRescue =
      !args.sourceProductClassAbsent &&
      structuredCanRescueGuard(result, args.plan);

    if (!current && args.semanticNoEvidence && !canRescue) {
      diagnostics.structuredSuppressedByGuard += 1;
      continue;
    }

    if (!current) {
      const matchedKinds = new Set(result.structuredMatchedKinds ?? []);
      const multiFact = matchedKinds.size >= 2;
      const informativeStandalone =
        canRescue ||
        isClosedWorldStructured(result) ||
        (multiFact &&
          coversPositiveSemanticFacets(result, args.plan) &&
          result.structuredExactCanonicalIdentity === true);
      if (!informativeStandalone) {
        diagnostics.structuredSuppressedByGuard += 1;
        continue;
      }
      const standaloneCeiling = structuredStandaloneCeiling(result);
      const score = canRescue
        ? Math.min(result.structuredScore ?? result.score, standaloneCeiling)
        : Math.min(
            result.structuredScore ?? result.score,
            Math.min(standaloneCeiling, semanticFloor + 0.03),
          );
      merged.set(result.productId, {
        ...result,
        score,
        retrievalSources: uniqueSources(result.retrievalSources, ["STRUCTURED"]),
      });
      diagnostics.structuredRecallAdded += 1;
      continue;
    }

    const combined = mergeMetadata(current, result);
    const matchedKinds = new Set(combined.structuredMatchedKinds ?? []);
    const multiFact = matchedKinds.size >= 2;
    const directIdentityBoost =
      args.plan?.retrievalMode === "DIRECT" &&
      combined.structuredExactCanonicalIdentity &&
      meaningfulUnresolved(args.plan).length === 0
        ? 0.055
        : 0;
    const closedWorldBoost = isClosedWorldStructured(combined) ? 0.08 : 0;
    const multiFactBoost = multiFact ? 0.045 : 0;
    combined.score = boundedBoost(
      current.score,
      directIdentityBoost + closedWorldBoost + multiFactBoost,
    );
    merged.set(result.productId, combined);
    diagnostics.hybridConfirmedCount += 1;
  }

  return {
    results: [...merged.values()]
      .sort((left, right) =>
        right.score - left.score ||
        (right.rrfScore ?? 0) - (left.rrfScore ?? 0) ||
        (right.lexicalScore ?? 0) - (left.lexicalScore ?? 0) ||
        (right.structuredScore ?? 0) - (left.structuredScore ?? 0) ||
        (right.vectorSimilarity ?? -Infinity) -
          (left.vectorSimilarity ?? -Infinity),
      )
      .slice(0, Math.max(1, args.limit)),
    diagnostics,
  };

}
