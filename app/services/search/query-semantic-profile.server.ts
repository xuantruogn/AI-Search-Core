import type {
  AttributeConstraint,
  QueryConstraint,
  QueryPlan,
} from "./query-plan.server";
import type { QueryRewriteResult } from "./query-rewriter.server";
import {
  mergeLlmRewriteIntoPlan,
  queryPlanToLegacyRewrite,
} from "./legacy-query-rewrite-adapter.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";

export type QuerySemanticProfile = {
  rawPlan: QueryPlan;
  expandedPlan: QueryPlan;
  finalPlan: QueryPlan;
  rewrite: QueryRewriteResult;
  embeddingInput: string;
};

function keyOf(value: QueryConstraint) {
  return value.normalizedValue || normalizeQueryText(value.value);
}
function mergeConstraints(
  raw: QueryConstraint[],
  expanded: QueryConstraint[],
  hardenExpanded = false,
) {
  const merged = new Map<string, QueryConstraint>();
  for (const item of raw) merged.set(keyOf(item), item);
  for (const item of expanded) {
    const key = keyOf(item);
    if (!key || merged.has(key)) continue;
    merged.set(key, {
      ...item,
      mode: hardenExpanded ? item.mode : "SHOULD",
    });
  }
  return [...merged.values()];
}

function mergeAttributes(
  raw: AttributeConstraint[],
  expanded: AttributeConstraint[],
) {
  const merged = new Map<string, AttributeConstraint>();
  for (const item of raw) merged.set(`${item.name}:${keyOf(item)}`, item);
  for (const item of expanded) {
    const key = `${item.name}:${keyOf(item)}`;
    if (!merged.has(key)) merged.set(key, { ...item, mode: "SHOULD" });
  }
  return [...merged.values()];
}
function semanticTermMatches(
  constraint: QueryConstraint,
  terms: string[],
  strictSingleToken = false,
) {
  const value = keyOf(constraint);
  if (!value) return false;
  const valueTokens = value.split(" ").filter(Boolean);
  return terms.some((term) => {
    const normalizedTerm = normalizeQueryText(term);
    if (normalizedTerm === value) return true;
    if (strictSingleToken && valueTokens.length === 1) return false;
    return normalizedTerm.includes(value) || value.includes(normalizedTerm);
  });
}

function exactSemanticTermMatches(
  constraint: QueryConstraint,
  terms: string[],
) {
  const value = keyOf(constraint);
  if (!value) return false;
  return terms.some(
    (term) => normalizeQueryText(term) === value,
  );
}

export function resolveCodeOwnedRetrievalMode(args: {
  rawRetrievalMode: QueryPlan["retrievalMode"];
  hasDirectTargetIdentity: boolean;
}) {
  if (args.rawRetrievalMode === "COMPLEMENT") return "COMPLEMENT" as const;
  if (args.hasDirectTargetIdentity) return "DIRECT" as const;
  return args.rawRetrievalMode === "DISCOVERY"
    ? "DISCOVERY" as const
    : "DIRECT" as const;
}

export function shouldPromoteSourceNamedDirectTarget(args: {
  originalQuery: string;
  sourceMustTerms: string[];
  rawRoute: QueryPlan["route"];
  groundedIdentityOrCategory: boolean;
}) {
  const sourceNamesExactRequiredConcept = args.sourceMustTerms.some(
    (term) =>
      normalizeQueryText(term) === normalizeQueryText(args.originalQuery),
  );
  return (
    args.rawRoute === "FULL_LLM" &&
    sourceNamesExactRequiredConcept &&
    args.groundedIdentityOrCategory
  );
}

function applySemanticPolarity(
  plan: QueryPlan,
  llm: QueryRewriteResult,
): QueryPlan {
  const mustTerms = [
    ...(llm.analysis.semanticMustTerms ?? []),
    ...(llm.analysis.semanticSourceMustTerms ?? []),
  ];
  const mustNotTerms = llm.analysis.semanticMustNotTerms ?? [];
  const apply = <T extends QueryConstraint>(items: T[]) =>
    items.map((item) => ({
      ...item,
      mode: semanticTermMatches(item, mustNotTerms)
        ? "MUST_NOT" as const
        : exactSemanticTermMatches(item, mustTerms)
          ? "MUST" as const
          : item.mode,
    }));

  return {
    ...plan,
    // LLM semantic MUST means important for meaning, not an exact catalog
    // requirement. Only code/source-owned markers may harden an attribute.
    attributes: plan.attributes.map((item) => ({
      ...item,
      mode: semanticTermMatches(item, mustNotTerms)
        ? "MUST_NOT" as const
        : item.mode,
    })),
    audiences: apply(plan.audiences),
    contexts: apply(plan.contexts),
    compatibility: apply(plan.compatibility),
  };
}

function mergeSegments(raw: QueryPlan, expanded: QueryPlan) {
  const seen = new Set<string>();
  return [...raw.resolvedSegments, ...expanded.resolvedSegments].filter((item) => {
    const key = `${item.field}:${normalizeQueryText(item.canonicalValue)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeQueryFacetPlans(
  raw: QueryPlan,
  expanded: QueryPlan,
): QueryPlan {
  const expandedIdentity = raw.identities.length
    ? []
    : expanded.identities.slice(0, 1).map((item) => ({ ...item, mode: "MUST" as const }));

  return {
    ...raw,
    identities: mergeConstraints(raw.identities, expandedIdentity, true),
    // Brand/model/identifier tokens are language-stable exact entities.
    // Pass 2 must never invent them from translated/expanded prose (e.g. "cỏ"
    // folding to "co" and colliding with a short brand).
    entities: {
      brands: raw.entities.brands,
      models: raw.entities.models,
      identifiers: raw.entities.identifiers,
    },
    attributes: mergeAttributes(raw.attributes, expanded.attributes),
    measurements: raw.measurements,
    audiences: mergeConstraints(raw.audiences, expanded.audiences),
    contexts: mergeConstraints(raw.contexts, expanded.contexts),
    compatibility: mergeConstraints(raw.compatibility, expanded.compatibility),
    semanticQuery: expanded.semanticQuery || raw.semanticQuery,
    resolvedSegments: mergeSegments(raw, expanded),
    unresolvedSegments: expanded.unresolvedSegments,
    routerReason: [...new Set([...raw.routerReason, "FACET_PASS_2"])],
  };
}

function facetValues(plan: QueryPlan) {
  return [
    ...plan.identities,
    ...plan.entities.brands,
    ...plan.entities.models,
    ...plan.entities.identifiers,
    ...plan.attributes,
    ...plan.audiences,
    ...plan.contexts,
    ...plan.compatibility,
  ].map((item) => item.value);
}
function baseLanguage(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .split("-")[0];
}

const COMPLEMENT_REFERENCE_FILLER_TOKENS = new Set([
  "a", "an", "the", "mot", "một",
]);

function complementReferenceTokenScope(
  originalQuery: string,
  rawPlan: QueryPlan,
) {
  if (rawPlan.retrievalMode !== "COMPLEMENT") return null;
  const sourceTokens = normalizeQueryText(originalQuery)
    .split(" ")
    .filter(Boolean);
  const relationIndex = sourceTokens.findIndex(
    (token, index) =>
      token === "with" ||
      token === "voi" ||
      (token === "cung" && sourceTokens[index + 1] === "voi"),
  );
  if (relationIndex < 0) return null;
  const referenceStart =
    sourceTokens[relationIndex] === "cung" &&
    sourceTokens[relationIndex + 1] === "voi"
      ? relationIndex + 2
      : relationIndex + 1;
  const targetTokens = new Set(sourceTokens.slice(0, relationIndex));
  const referenceTokens = new Set(
    sourceTokens
      .slice(referenceStart)
      .filter((token) => !COMPLEMENT_REFERENCE_FILLER_TOKENS.has(token)),
  );
  for (const reference of rawPlan.referenceTerms ?? []) {
    for (const token of normalizeQueryText(reference).split(" ").filter(Boolean)) {
      referenceTokens.add(token);
    }
  }
  return { targetTokens, referenceTokens };
}

export function stripComplementReferenceMustTerms(args: {
  originalQuery: string;
  rawPlan: QueryPlan;
  values: string[];
}) {
  const scope = complementReferenceTokenScope(args.originalQuery, args.rawPlan);
  if (!scope || scope.referenceTokens.size === 0) return args.values;
  return args.values.filter((value) => {
    const tokens = normalizeQueryText(value).split(" ").filter(Boolean);
    if (tokens.length === 0) return false;
    const belongsToReference = tokens.every((token) =>
      scope.referenceTokens.has(token),
    );
    const alsoOwnedByTarget = tokens.some((token) =>
      scope.targetTokens.has(token),
    );
    return !belongsToReference || alsoOwnedByTarget;
  });
}

export function stripReferenceScopedFacetsFromEmbedding(args: {
  originalQuery: string;
  rawPlan: QueryPlan;
  value: string;
}) {
  if (args.rawPlan.retrievalMode !== "COMPLEMENT" || !args.value.trim()) {
    return args.value;
  }

  const sourceTokens = normalizeQueryText(args.originalQuery)
    .split(" ")
    .filter(Boolean);
  const relationIndex = sourceTokens.findIndex(
    (token, index) =>
      token === "with" ||
      token === "voi" ||
      (token === "cung" && sourceTokens[index + 1] === "voi"),
  );
  if (relationIndex < 0) return args.value;

  const referenceStart =
    sourceTokens[relationIndex] === "cung" &&
    sourceTokens[relationIndex + 1] === "voi"
      ? relationIndex + 2
      : relationIndex + 1;

  const blockedTokens = new Set<string>();
  for (const segment of args.rawPlan.resolvedSegments) {
    if (
      segment.start < referenceStart ||
      !["ATTRIBUTE", "MEASUREMENT"].includes(segment.field)
    ) {
      continue;
    }
    for (const candidate of [segment.text, segment.canonicalValue]) {
      for (const token of normalizeQueryText(candidate).split(" ").filter(Boolean)) {
        blockedTokens.add(token);
      }
    }
  }
  if (blockedTokens.size === 0) return args.value;

  return args.value
    .split(/(\s+)/)
    .filter((piece) => {
      const pieceTokens = normalizeQueryText(piece).split(" ").filter(Boolean);
      return (
        pieceTokens.length === 0 ||
        !pieceTokens.every((token) => blockedTokens.has(token))
      );
    })
    .join("")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([|;])/g, " $1")
    .trim();
}

function composeFacetEmbeddingInput(
  semanticQuery: string,
  finalPlan: QueryPlan,
  expandedPlan: QueryPlan,
  llm: QueryRewriteResult,
) {
  const detectedLanguage = baseLanguage(llm.analysis.detectedLanguage);
  const shopLanguage = baseLanguage(llm.analysis.shopLanguage);
  const crossLanguage =
    detectedLanguage &&
    shopLanguage &&
    detectedLanguage !== "unknown" &&
    shopLanguage !== "unknown" &&
    detectedLanguage !== shopLanguage;

  const facetTerms = crossLanguage
    ? [
        ...(llm.analysis.semanticMustTerms ?? []),
        ...expandedPlan.resolvedSegments.map((segment) => segment.text),
      ]
    : facetValues(finalPlan);

  const values: string[] = [];
  const seen = new Set<string>();
  for (const value of [semanticQuery, ...facetTerms]) {
    const clean = value.replace(/\s+/g, " ").trim();
    const normalized = normalizeQueryText(clean);
    if (!clean || !normalized || seen.has(normalized)) continue;
    if (values.some((current) => normalizeQueryText(current).includes(normalized))) {
      continue;
    }
    seen.add(normalized);
    values.push(clean);
    if (values.length >= 12) break;
  }
  return values.join(" ; ");
}

export function buildQuerySemanticProfile(args: {
  originalQuery: string;
  rawPlan: QueryPlan;
  expandedPlan: QueryPlan;
  llm: QueryRewriteResult;
}): QuerySemanticProfile {
  const safeLlm: QueryRewriteResult =
    args.rawPlan.retrievalMode === "COMPLEMENT"
      ? {
          ...args.llm,
          analysis: {
            ...args.llm.analysis,
            semanticMustTerms: stripComplementReferenceMustTerms({
              originalQuery: args.originalQuery,
              rawPlan: args.rawPlan,
              values: args.llm.analysis.semanticMustTerms ?? [],
            }),
            semanticSourceMustTerms: stripComplementReferenceMustTerms({
              originalQuery: args.originalQuery,
              rawPlan: args.rawPlan,
              values: args.llm.analysis.semanticSourceMustTerms ?? [],
            }),
          },
        }
      : args.llm;
  const semanticMustTerms = [
    ...(safeLlm.analysis.semanticMustTerms ?? []),
    ...(safeLlm.analysis.semanticSourceMustTerms ?? []),
  ];

  // Typed non-identity facets must never promote an expansion into a hard
  // product identity. Example: "women" is an AUDIENCE constraint; it must not
  // make "Women's floral dress" the single required identity for a broad
  // Valentine outfit query.
  const expandedNonIdentityConstraints: QueryConstraint[] = [
    ...args.expandedPlan.attributes,
    ...args.expandedPlan.audiences,
    ...args.expandedPlan.contexts,
    ...args.expandedPlan.compatibility,
  ];

  const semanticIdentityTerms = semanticMustTerms.filter(
    (term) =>
      !expandedNonIdentityConstraints.some((constraint) =>
        semanticTermMatches(constraint, [term]),
      ),
  );

  const llmDirectIdentity =
    args.expandedPlan.identities.some((item) =>
      exactSemanticTermMatches(item, semanticIdentityTerms),
    );
  const llmDirectCategory =
    args.expandedPlan.resolvedSegments.some((segment) =>
      segment.field === "CATEGORY" &&
      segment.confidence >= 0.95 &&
      semanticIdentityTerms.some((term) =>
        normalizeQueryText(term) === normalizeQueryText(segment.canonicalValue),
      ),
    );
  // Cross-language named product classes can be source-DIRECT even when
  // Gemini occasionally labels the translated class as DISCOVERY. Promotion
  // requires FULL_LLM source resolution plus independent typed grounding.
  const sourceGroundedDirectTarget =
    shouldPromoteSourceNamedDirectTarget({
      originalQuery: args.originalQuery,
      sourceMustTerms: safeLlm.analysis.semanticSourceMustTerms ?? [],
      rawRoute: args.rawPlan.route,
      groundedIdentityOrCategory: llmDirectIdentity || llmDirectCategory,
    });
  const hasDirectTargetIdentity =
    args.rawPlan.identities.some(
      (item) =>
        item.mode === "MUST" &&
        item.confidence >= 0.85,
    ) ||
    args.rawPlan.entities.identifiers.length > 0 ||
    args.rawPlan.entities.models.some(
      (item) => item.confidence >= 0.9,
    ) ||
    sourceGroundedDirectTarget;

  // Retrieval relation is code-owned. Gemini may translate/expand a query,
  // but it must never invent COMPLEMENT/DISCOVERY semantics that are absent
  // from the source plan. The only promotion allowed here is a source-grounded
  // DIRECT product class that pass 2 independently maps to the catalog.
  const retrievalMode: QueryPlan["retrievalMode"] =
    resolveCodeOwnedRetrievalMode({
      rawRetrievalMode: args.rawPlan.retrievalMode,
      hasDirectTargetIdentity,
    });

  // LLM expansions are recall hints. In DISCOVERY/COMPLEMENT mode they must
  // never be promoted into a single hard product identity. DIRECT mode may
  // promote only an exact identity explicitly returned as a semantic MUST.
  const safeExpandedIdentities =
    retrievalMode === "DIRECT"
      ? args.expandedPlan.identities.filter((item) =>
          exactSemanticTermMatches(item, semanticIdentityTerms),
        )
      : [];
  const safeExpandedIdentityValues = new Set(
    safeExpandedIdentities.map((item) => keyOf(item)),
  );
  const safeExpandedPlan: QueryPlan = {
    ...args.expandedPlan,
    retrievalMode,
    identities: safeExpandedIdentities,
    // Pass-2 prose cannot establish ownership of an attribute in a
    // complementary relation. Only source-query target spans may do that.
    attributes: retrievalMode === "COMPLEMENT" ? [] : args.expandedPlan.attributes,
    resolvedSegments: args.expandedPlan.resolvedSegments.filter((segment) => {
      if (["BRAND", "MODEL", "IDENTIFIER"].includes(segment.field)) {
        return false;
      }
      if (segment.field !== "PRODUCT_TYPE") return true;
      return safeExpandedIdentityValues.has(
        normalizeQueryText(segment.canonicalValue),
      );
    }),
  };
  const finalPlan = {
    ...applySemanticPolarity(
      mergeQueryFacetPlans(args.rawPlan, safeExpandedPlan),
      safeLlm,
    ),
    retrievalMode,
  };
  const baseline = queryPlanToLegacyRewrite(finalPlan, args.originalQuery);
  const mergedRewriteBase = mergeLlmRewriteIntoPlan(baseline, safeLlm);
  const rawResolvedReferenceTerms =
    args.rawPlan.retrievalMode === "COMPLEMENT"
      ? args.rawPlan.resolvedSegments
          .filter((segment) => segment.field === "CONTEXT")
          .map((segment) => segment.canonicalValue)
          .filter(Boolean)
      : [];
  const rawFallbackReferenceTerms =
    args.rawPlan.retrievalMode === "COMPLEMENT"
      ? (args.rawPlan.referenceTerms ?? [])
      : [];
  const llmReferenceTerms = safeLlm.analysis.referenceTerms ?? [];
  const trustedReferenceTerms =
    rawResolvedReferenceTerms.length > 0
      ? rawResolvedReferenceTerms
      : rawFallbackReferenceTerms.length > 0
        ? rawFallbackReferenceTerms
        : llmReferenceTerms;
  const mergedRewrite: QueryRewriteResult = {
    ...mergedRewriteBase,
    analysis: {
      ...mergedRewriteBase.analysis,
      retrievalMode,
      referenceTerms:
        retrievalMode === "COMPLEMENT"
          ? [...new Set(trustedReferenceTerms)]
          : [],
    },
  };
  const embeddingSeed = stripReferenceScopedFacetsFromEmbedding({
    originalQuery: args.originalQuery,
    rawPlan: args.rawPlan,
    value: mergedRewrite.query,
  });
  const embeddingInput = stripReferenceScopedFacetsFromEmbedding({
    originalQuery: args.originalQuery,
    rawPlan: args.rawPlan,
    value: composeFacetEmbeddingInput(
      embeddingSeed,
      finalPlan,
      safeExpandedPlan,
      safeLlm,
    ),
  });

  return {
    rawPlan: args.rawPlan,
    expandedPlan: args.expandedPlan,
    finalPlan,
    embeddingInput,
    rewrite: {
      ...mergedRewrite,
      query: embeddingInput || mergedRewrite.query,
      planning: mergedRewrite.planning
        ? {
            ...mergedRewrite.planning,
            semanticQuery: embeddingInput || mergedRewrite.query,
          }
        : mergedRewrite.planning,
    },
  };
}
