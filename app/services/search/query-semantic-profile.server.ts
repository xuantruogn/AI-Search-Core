import { renderSemanticDemand } from "./semantic-contract.server";
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

const GENERIC_DISCOVERY_FAMILIES = new Set([
  "apparel",
  "clothing",
  "fashion",
  "gear",
  "equipment",
  "accessory",
  "accessories",
  "outfit",
  "outfits",
  "products",
  "items",
]);

export function isGenericDiscoveryFamily(value: string) {
  const normalized = normalizeQueryText(value);
  return Boolean(normalized) && GENERIC_DISCOVERY_FAMILIES.has(normalized);
}

function buildFallbackDiscoverySemanticTerms(plan: QueryPlan) {
  const allowedFields = new Set([
    "ATTRIBUTE",
    "CONTEXT",
    "AUDIENCE",
    "COMPATIBILITY",
  ]);
  const target: string[] = [];
  const source: string[] = [];
  const seenTarget = new Set<string>();
  const seenSource = new Set<string>();
  const negativeValues = new Set(
    [
      ...plan.identities,
      ...plan.attributes,
      ...plan.contexts,
      ...plan.compatibility,
      ...plan.entities.brands,
      ...plan.entities.models,
      ...plan.entities.identifiers,
    ]
      .filter((item) => item.mode === "MUST_NOT")
      .map((item) => keyOf(item)),
  );

  const addTerm = (canonical: string, sourceText: string) => {
    const cleanCanonical = canonical.replace(/\s+/g, " ").trim();
    const cleanSource = sourceText.replace(/\s+/g, " ").trim();
    const normalizedCanonical = normalizeQueryText(cleanCanonical);
    const normalizedSource = normalizeQueryText(cleanSource);
    if (
      !cleanCanonical ||
      !normalizedCanonical ||
      negativeValues.has(normalizedCanonical) ||
      /\b(?:price|cheap|cheapest|budget|expensive|premium|luxury)\b/.test(
        normalizedCanonical,
      )
    ) {
      return;
    }
    if (!seenTarget.has(normalizedCanonical)) {
      seenTarget.add(normalizedCanonical);
      target.push(cleanCanonical);
    }
    if (
      cleanSource &&
      normalizedSource &&
      !negativeValues.has(normalizedSource) &&
      !seenSource.has(normalizedSource)
    ) {
      seenSource.add(normalizedSource);
      source.push(cleanSource);
    }
  };

  const genericLowConfidenceFacets = new Set([
    "home", "clothes", "clothing", "weather", "goods", "items", "products",
  ]);
  for (const segment of plan.resolvedSegments) {
    if (!allowedFields.has(segment.field) || segment.confidence < 0.5) continue;
    const normalized = normalizeQueryText(segment.canonicalValue);
    if (
      segment.confidence < 0.7 &&
      genericLowConfidenceFacets.has(normalized)
    ) {
      continue;
    }
    addTerm(segment.canonicalValue, segment.text);
    if (target.length >= 3) break;
  }

  const unresolvedStopWords = new Set([
    "a", "an", "the", "for", "with", "without", "to", "from", "on", "at",
    "in", "of", "and", "or", "need", "want", "something", "someone", "thing",
    "i", "me", "my", "this", "that", "these", "those", "please",
    "who", "love", "loves", "loving",
    "cho", "voi", "khong", "de", "tu", "tren", "duoi", "va", "hoac",
    "toi", "minh", "mot", "cai", "thu", "gi", "do", "nay",
  ]);
  for (const unresolved of plan.unresolvedSegments) {
    const tokens = normalizeQueryText(unresolved)
      .split(" ")
      .filter(Boolean)
      .filter((token) => !unresolvedStopWords.has(token));
    const clean = [...new Set(tokens)].join(" ").trim();
    if (!clean || clean.length < 3) continue;
    addTerm(clean, clean);
    if (target.length >= 3) break;
  }

  return { target: target.slice(0, 3), source: source.slice(0, 3) };
}

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

/**
 * Preserve only shopper-owned semantic identity across the legacy adapter.
 *
 * DISCOVERY intentionally does not promote LLM-expanded identities into hard
 * QueryPlan constraints. That must not erase an identity the shopper actually
 * named (including a translated source phrase) from downstream evidence
 * assessment. sourceMustTerms prove source ownership; mustTerms tie that source
 * meaning to the canonical semantic identity.
 */
export function sourceOwnedSemanticDemandIdentities(args: {
  originalQuery: string;
  identities: string[];
  semanticMustTerms: string[];
  semanticSourceMustTerms: string[];
}) {
  const sourceQuery = normalizeQueryText(args.originalQuery);
  const sourceOwned = args.semanticSourceMustTerms.some((value) => {
    const normalized = normalizeQueryText(value);
    return Boolean(
      normalized &&
      (
        sourceQuery.includes(normalized) ||
        normalized.includes(sourceQuery)
      ),
    );
  });
  if (!sourceOwned) return [];

  const mustTerms = args.semanticMustTerms
    .map(normalizeQueryText)
    .filter(Boolean);

  return [...new Set(
    args.identities.filter((identity) => {
      const normalizedIdentity = normalizeQueryText(identity);
      if (!normalizedIdentity) return false;
      return mustTerms.some(
        (term) =>
          term === normalizedIdentity ||
          term.includes(normalizedIdentity) ||
          normalizedIdentity.includes(term),
      );
    }),
  )];
}

export function semanticTermsCoverConstraint(
  constraint: QueryConstraint,
  terms: string[],
) {
  const valueTokens = keyOf(constraint).split(" ").filter(Boolean);
  if (valueTokens.length === 0) return false;
  const termTokens = new Set(
    terms.flatMap((term) =>
      normalizeQueryText(term).split(" ").filter(Boolean),
    ),
  );
  return valueTokens.every((token) => termTokens.has(token));
}

export function semanticTermsExplainedByIdentityOrFacets(
  identity: QueryConstraint,
  terms: string[],
  facets: QueryConstraint[],
) {
  const identityTokens = new Set(keyOf(identity).split(" ").filter(Boolean));
  if (identityTokens.size === 0 || terms.length === 0) return false;
  const facetTokens = new Set(
    facets.flatMap((facet) =>
      keyOf(facet).split(" ").filter(Boolean),
    ),
  );
  const requiredTokens = terms.flatMap((term) =>
    normalizeQueryText(term).split(" ").filter(Boolean),
  );
  if (requiredTokens.length === 0) return false;
  return requiredTokens.every(
    (token) => identityTokens.has(token) || facetTokens.has(token),
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
  llmRetrievalMode?: QueryPlan["retrievalMode"];
}) {
  const normalizedSource = normalizeQueryText(args.originalQuery);
  const sourceTokens = normalizedSource.split(" ").filter((token) => token.length >= 2);
  const mustTokens = new Set(
    args.sourceMustTerms.flatMap((term) =>
      normalizeQueryText(term).split(" ").filter((token) => token.length >= 2),
    ),
  );
  const coveredSourceTokens = sourceTokens.filter((token) => mustTokens.has(token));
  const sourceCoverage =
    sourceTokens.length > 0 ? coveredSourceTokens.length / sourceTokens.length : 0;
  const sourceNamesExactRequiredConcept =
    args.sourceMustTerms.some(
      (term) => normalizeQueryText(term) === normalizedSource,
    ) ||
    (
      sourceTokens.length >= 2 &&
      // Source MUST terms may intentionally omit audience or preference
      // tokens (for example Vietnamese "ví da đen nữ" -> wallet/black/leather).
      // Requiring 80% of the entire surface query made an explicitly named
      // product class look like DISCOVERY. Grounding still has to be proven
      // independently by pass 2, so 70% keeps need-only discovery queries out.
      sourceCoverage >= 0.7
    );

  return (
    (args.rawRoute === "FULL_LLM" || args.rawRoute === "LIGHT_LLM") &&
    args.llmRetrievalMode !== "COMPLEMENT" &&
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
  _expandedPlan: QueryPlan,
  llm: QueryRewriteResult,
) {
  // The dense query vector should represent the shopper's natural semantic
  // intent, not a serialized copy of structured facets. Exact attributes,
  // identity, brand/model/SKU, compatibility, price and negatives already
  // have dedicated structured/lexical/filter lanes and separate semantic
  // branches. Injecting them again here distorts cosine geometry.
  const demandText = llm.analysis.semanticDemand && !llm.fallbackReason
    ? renderSemanticDemand(llm.analysis.semanticDemand) : "";
  const naturalIntent = demandText || (!llm.fallbackReason && llm.analysis.intent !== "unknown"
    ? llm.analysis.intent : semanticQuery);
  const cleanSemanticQuery = naturalIntent.split(/\s*;\s*/)[0].replace(/\s+/g, " ").trim();
  if (cleanSemanticQuery) return cleanSemanticQuery;

  // Deterministic/LLM fallback only: if no semantic sentence survived,
  // preserve the smallest natural phrase that still represents the need.
  const fallbackValues = [
    finalPlan.semanticQuery,
    ...(llm.analysis.semanticMustTerms ?? []),
  ]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return fallbackValues[0] ?? "";
}

export function buildQuerySemanticProfile(args: {
  originalQuery: string;
  rawPlan: QueryPlan;
  expandedPlan: QueryPlan;
  llm: QueryRewriteResult;
}): QuerySemanticProfile {
  const fallbackDiscoveryTerms = buildFallbackDiscoverySemanticTerms(
    args.rawPlan,
  );
  const llmWithDeterministicFallback: QueryRewriteResult =
    args.llm.fallbackReason &&
    fallbackDiscoveryTerms.target.length > 0
      ? {
          ...args.llm,
          analysis: {
            ...args.llm.analysis,
            semanticMustTerms:
              (args.llm.analysis.semanticMustTerms ?? []).length > 0
                ? args.llm.analysis.semanticMustTerms
                : fallbackDiscoveryTerms.target,
            semanticSourceMustTerms:
              (args.llm.analysis.semanticSourceMustTerms ?? []).length > 0
                ? args.llm.analysis.semanticSourceMustTerms
                : fallbackDiscoveryTerms.source,
            decisionReason:
              `${args.llm.analysis.decisionReason} Deterministic source meaning preserved after LLM fallback.`,
          },
        }
      : args.llm;
  const safeLlm: QueryRewriteResult =
    args.rawPlan.retrievalMode === "COMPLEMENT"
      ? {
          ...llmWithDeterministicFallback,
          analysis: {
            ...llmWithDeterministicFallback.analysis,
            semanticMustTerms: stripComplementReferenceMustTerms({
              originalQuery: args.originalQuery,
              rawPlan: args.rawPlan,
              values:
                llmWithDeterministicFallback.analysis.semanticMustTerms ?? [],
            }),
            semanticSourceMustTerms: stripComplementReferenceMustTerms({
              originalQuery: args.originalQuery,
              rawPlan: args.rawPlan,
              values:
                llmWithDeterministicFallback.analysis.semanticSourceMustTerms ?? [],
            }),
          },
        }
      : llmWithDeterministicFallback;
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

  const targetSemanticMustTerms =
    safeLlm.analysis.semanticMustTerms ?? [];
  const semanticIdentityTerms = targetSemanticMustTerms.filter(
    (term) =>
      !expandedNonIdentityConstraints.some((constraint) =>
        semanticTermMatches(constraint, [term]),
      ),
  );

  const llmDirectIdentity =
    args.expandedPlan.identities.some((item) =>
      !isGenericDiscoveryFamily(item.value) &&
      semanticTermsExplainedByIdentityOrFacets(
        item,
        targetSemanticMustTerms,
        expandedNonIdentityConstraints,
      ),
    );
  const llmDirectCategory =
    args.expandedPlan.resolvedSegments.some((segment) =>
      segment.field === "CATEGORY" &&
      segment.confidence >= 0.95 &&
      !isGenericDiscoveryFamily(segment.canonicalValue) &&
      semanticIdentityTerms.some((term) =>
        normalizeQueryText(term) === normalizeQueryText(segment.canonicalValue),
      ),
    );
  // Cross-language named product classes may be promoted from an unresolved
  // source query to DIRECT only when the source itself names the required
  // concept and pass 2 independently grounds that concept to a catalog
  // identity/category. LLM DISCOVERY is not allowed to veto this source-owned
  // relation; COMPLEMENT still is, because a referenced item changes the
  // target relation rather than merely translating a product class.
  const sourceGroundedDirectTarget =
    shouldPromoteSourceNamedDirectTarget({
      originalQuery: args.originalQuery,
      sourceMustTerms: safeLlm.analysis.semanticSourceMustTerms ?? [],
      rawRoute: args.rawPlan.route,
      groundedIdentityOrCategory: llmDirectIdentity || llmDirectCategory,
      llmRetrievalMode: safeLlm.analysis.retrievalMode,
    });
  const hasDirectTargetIdentity =
    args.rawPlan.identities.some(
      (item) =>
        item.mode === "MUST" &&
        item.confidence >= 0.85 &&
        !isGenericDiscoveryFamily(item.value),
    ) ||
    args.rawPlan.entities.identifiers.length > 0 ||
    (
      args.rawPlan.retrievalMode === "DIRECT" &&
      args.rawPlan.entities.models.some(
        (item) => item.confidence >= 0.9,
      )
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
          semanticTermsExplainedByIdentityOrFacets(
            item,
            targetSemanticMustTerms,
            expandedNonIdentityConstraints,
          ),
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
  const sourceOwnedDemandIdentities = sourceOwnedSemanticDemandIdentities({
    originalQuery: args.originalQuery,
    identities: safeLlm.analysis.semanticDemand?.identity ?? [],
    semanticMustTerms: safeLlm.analysis.semanticMustTerms ?? [],
    semanticSourceMustTerms: safeLlm.analysis.semanticSourceMustTerms ?? [],
  });
  // Keep source-owned identity available to legacy evidence consumers without
  // converting it into a QueryPlan MUST. This is semantic provenance, not a
  // closed-world filter.
  const mergedRewriteBaseWithDemand =
    sourceOwnedDemandIdentities.length === 0
      ? mergedRewriteBase
      : {
          ...mergedRewriteBase,
          analysis: {
            ...mergedRewriteBase.analysis,
            productType:
              mergedRewriteBase.analysis.productType ||
              sourceOwnedDemandIdentities[0] ||
              "",
            productTypes: [
              ...new Set([
                ...mergedRewriteBase.analysis.productTypes,
                ...sourceOwnedDemandIdentities,
              ]),
            ],
            productRelation:
              mergedRewriteBase.analysis.productRelation !== "NONE"
                ? mergedRewriteBase.analysis.productRelation
                : sourceOwnedDemandIdentities.length > 1
                  ? "ANY"
                  : "SINGLE",
            shopLanguageProductType:
              mergedRewriteBase.analysis.shopLanguageProductType ||
              sourceOwnedDemandIdentities[0] ||
              "",
          },
        };
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
    rawFallbackReferenceTerms.length > 0
      ? [
          ...rawFallbackReferenceTerms,
          ...rawResolvedReferenceTerms,
        ].filter(
          (value, index, list) =>
            list.findIndex(
              (candidate) =>
                normalizeQueryText(candidate) === normalizeQueryText(value),
            ) === index,
        )
      : rawResolvedReferenceTerms.length > 0
        ? rawResolvedReferenceTerms
        : llmReferenceTerms;
  const mergedRewrite: QueryRewriteResult = {
    ...mergedRewriteBaseWithDemand,
    analysis: {
      ...mergedRewriteBaseWithDemand.analysis,
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
