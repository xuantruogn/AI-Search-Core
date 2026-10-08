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

import { sourceProductTypeOwnsTarget } from "./query-planner.server";

export const QUERY_SEMANTIC_PROFILE_VERSION =
  "query-semantic-profile-v6-parser-target-authority";
export const QUERY_EMBEDDING_PIPELINE_VERSION =
  "semantic-expansion-v21-pure-target-equivalence";

export type QuerySemanticProfile = {
  rawPlan: QueryPlan;
  expandedPlan: QueryPlan;
  finalPlan: QueryPlan;
  rewrite: QueryRewriteResult;
  embeddingInput: string;
};

export { isGenericDiscoveryFamily } from "./query-family.server";
import { isGenericDiscoveryFamily } from "./query-family.server";

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

/**
 * Preserve only shopper-owned semantic identity across the legacy adapter.
 *
 * DISCOVERY intentionally does not promote LLM-expanded identities into hard
 * QueryPlan constraints. That must not erase an identity the shopper actually
 * named (including a translated source phrase) from downstream evidence
 * assessment. Aligned mandatoryConcepts keep the shopper-source phrase paired
 * with the canonical target concept so translation provenance survives without
 * relying on parallel array order.
 */
export function sourceOwnedSemanticDemandIdentities(args: {
  originalQuery: string;
  identities: string[];
  mandatoryConcepts: Array<{ target: string; source: string }>;
  exactConstraints?: string[];
  modifiers?: string[];
}) {
  const sourceQuery = normalizeQueryText(args.originalQuery);
  const concepts = args.mandatoryConcepts.map((concept) => ({
    target: normalizeQueryText(concept.target),
    source: normalizeQueryText(concept.source),
  }));

  const sourceContains = (value: string) =>
    Boolean(
      value &&
      (
        ` ${sourceQuery} `.includes(` ${value} `) ||
        value === sourceQuery
      ),
    );

  return [...new Set(
    args.identities.flatMap((identity) => {
      const normalizedIdentity = normalizeQueryText(identity);
      if (!normalizedIdentity) return [];

      return concepts
        .filter((concept) => {
          // Exact shopper-owned modifiers may wrap a real target noun
          // ("white shirt"), but semantic/open-world modifiers must not
          // fossilize into identity ("winter apparel", "waterproof jacket").
          const identityTokens = normalizedIdentity.split(" ");
          const targetTokens = concept.target.split(" ");
          const identityModifiers = identityTokens.filter(
            (token) => !targetTokens.includes(token),
          );
          const exactTokens = new Set(
            (args.exactConstraints ?? []).flatMap((value) =>
              normalizeQueryText(value).split(" ")
            ),
          );
          const identityMatchesTarget =
            concept.target === normalizedIdentity || concept.source === normalizedIdentity ||
            (
              normalizedIdentity.endsWith(` ${concept.target}`) &&
              identityModifiers.length > 0 &&
              identityModifiers.every((token) => exactTokens.has(token) || (args.modifiers ?? []).some((modifier) => normalizeQueryText(modifier).split(" ").includes(token)))
            );
          if (!identityMatchesTarget || !sourceContains(concept.source)) {
            return false;
          }

          const sourceTokens = sourceQuery.split(" ");
          const phraseTokens = concept.source.split(" ");
          const sourceStart = sourceTokens.findIndex((_, index) =>
            phraseTokens.every(
              (token, offset) => sourceTokens[index + offset] === token,
            ),
          );
          return sourceStart >= 0 && sourceProductTypeOwnsTarget({
            query: args.originalQuery,
            start: sourceStart,
            end: sourceStart + phraseTokens.length,
          });
        })
        .map((concept) => {
          // Strip only semantic modifiers that are explicitly carried on their
          // own Demand axes. The remaining noun is the source-owned target.
          const semanticModifiers = [
            ...(args.modifiers ?? []),
          ]
            .map(normalizeQueryText)
            .filter(Boolean)
            .sort((left, right) => right.length - left.length);
          let target = concept.target;
          for (const modifier of semanticModifiers) {
            if (target.startsWith(`${modifier} `)) {
              target = target.slice(modifier.length + 1);
            }
          }
          return target;
        })
        .filter(Boolean);
    }),
  )];
}

export function sourceOwnedSemanticExactConstraints(args: {
  originalQuery: string;
  exactConstraints: string[];
  mandatoryConcepts: Array<{ target: string; source: string }>;
  rawPlan?: QueryPlan;
}) {
  const sourceQuery = normalizeQueryText(args.originalQuery);
  const complementScope = args.rawPlan
    ? complementReferenceTokenScope(args.originalQuery, args.rawPlan)
    : null;
  const concepts = args.mandatoryConcepts.map((concept) => ({
    target: normalizeQueryText(concept.target),
    source: normalizeQueryText(concept.source),
  }));

  const sourceContains = (value: string) =>
    Boolean(
      value &&
      (
        ` ${sourceQuery} `.includes(` ${value} `) ||
        value === sourceQuery
      ),
    );
  const belongsToComplementTarget = (value: string) => {
    if (!complementScope) return true;
    const tokens = value.split(" ").filter(Boolean);
    if (tokens.length === 0) return false;
    const onlyReference = tokens.every((token) =>
      complementScope.referenceTokens.has(token),
    );
    const targetOwned = tokens.some((token) =>
      complementScope.targetTokens.has(token),
    );
    return !onlyReference || targetOwned;
  };

  return [...new Set(
    args.exactConstraints.filter((constraint) => {
      const normalizedConstraint = normalizeQueryText(constraint);
      if (!normalizedConstraint) return false;
      return concepts.some((concept) => {
        const targetMatches =
          concept.target === normalizedConstraint;
        return (
          targetMatches &&
          sourceContains(concept.source) &&
          belongsToComplementTarget(concept.source)
        );
      });
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

export function applySemanticPolarity(
  plan: QueryPlan,
  llm: QueryRewriteResult,
): QueryPlan {
  const mustNotTerms = llm.analysis.semanticMustNotTerms ?? [];
  const applyNegationOnly = <T extends QueryConstraint>(items: T[]) =>
    items.map((item) => ({
      ...item,
      // LLM semantic MUST expresses importance for meaning, not closed-world
      // catalog truth. Never upgrade audience/context/compatibility/attribute
      // SHOULD values to MUST from semantic prose alone. Explicit negatives
      // may still exclude because negative intent owns its own filter lane.
      mode: semanticTermMatches(item, mustNotTerms)
        ? "MUST_NOT" as const
        : item.mode,
    }));

  return {
    ...plan,
    attributes: applyNegationOnly(plan.attributes),
    audiences: applyNegationOnly(plan.audiences),
    contexts: applyNegationOnly(plan.contexts),
    compatibility: applyNegationOnly(plan.compatibility),
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
      /^(?:matches|matching|matched)$/.test(token) ||
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
      /^(?:matches|matching|matched)$/.test(token) ||
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

export function pureTargetDemandEmbedding(args: {
  originalQuery: string;
  retrievalMode: string;
  identities: string[];
  concepts: Array<{target: string; source: string}>;
  demand?: import("./semantic-contract.server").SemanticDemandProfile;
}) {
  const demand = args.demand;
  if (args.retrievalMode !== "DIRECT" || args.identities.length !== 1 || !demand) return null;
  if (isGenericDiscoveryFamily(args.identities[0])) return null;
  if ([demand.desiredOutcomes, demand.useCases, demand.contexts, demand.qualities,
       demand.audience, demand.styles, demand.negativeConstraints, demand.exactConstraints]
       .some((axis) => axis.length > 0)) return null;
  const target = normalizeQueryText(args.identities[0]);
  return args.concepts.some((concept) =>
    normalizeQueryText(concept.source) === normalizeQueryText(args.originalQuery) &&
    normalizeQueryText(concept.target) === target
  ) ? args.identities[0] : null;
}

export function composeFacetEmbeddingInput(
  semanticQuery: string,
  finalPlan: QueryPlan,
  _expandedPlan: QueryPlan,
  llm: QueryRewriteResult,
  canonicalReferenceTerms: string[] = [],
) {
  // The dense query vector should represent the shopper's natural semantic
  // intent, not a serialized copy of structured facets. Exact attributes,
  // identity, brand/model/SKU, compatibility, price and negatives already
  // have dedicated structured/lexical/filter lanes and separate semantic
  // branches. Injecting them again here distorts cosine geometry.
  // A source-aligned translation of the entire identity-only query is the
  // complete Demand. Duplicating languages and request boilerplate here changes
  // cosine geometry; no semantic axis is being discarded.
  const pureTarget = !llm.fallbackReason ? pureTargetDemandEmbedding({
    originalQuery: finalPlan.rawQuery, retrievalMode: finalPlan.retrievalMode,
    identities: llm.analysis.sourceOwnedTargetIdentities ?? [],
    concepts: llm.analysis.semanticMandatoryConcepts ?? [],
    demand: llm.analysis.semanticDemand,
  }) : null;
  if (pureTarget) return pureTarget;
  const demandText = llm.analysis.semanticDemand && !llm.fallbackReason
    ? renderSemanticDemand(llm.analysis.semanticDemand) : "";
  // The shopper's raw text is kept in QueryPlan for provenance/exact validation.
  // When translation succeeded, the dense input must contain only shop-language
  // meaning aligned with product Semantic Supply. In COMPLEMENT, preserve the
  // target/reference relation in the LLM's canonical semanticQuery, not by
  // prepending untranslated shopper text.
  const naturalIntent = [semanticQuery, demandText]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((value, index, values) =>
      values.findIndex((candidate) =>
        normalizeQueryText(candidate) === normalizeQueryText(value)
      ) === index
    )
    .join(". ") || (!llm.fallbackReason && llm.analysis.intent !== "unknown"
      ? llm.analysis.intent : semanticQuery);
  const cleanSemanticQuery = naturalIntent.split(/\s*;\s*/)[0].replace(/\s+/g, " ").trim();
  // The reference belongs to the shopper's relationship, not to target
  // identity/exact facts. The LLM's referenceTerms are already in shop language;
  // do NOT use the source-language rawPlan reference strings for dense input.
  if (finalPlan.retrievalMode === "COMPLEMENT" &&
      !llm.fallbackReason && canonicalReferenceTerms.length > 0) {
    const references = canonicalReferenceTerms
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 2);
    const missingReferences = references.filter((reference) =>
      !normalizeQueryText(cleanSemanticQuery).includes(normalizeQueryText(reference))
    );
    if (missingReferences.length > 0) {
      return `${cleanSemanticQuery} to pair with ${missingReferences.join(" and ")}`.trim();
    }
  }
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
  const parserOwnedTargetIdentities = args.rawPlan.identities
    .filter((item) => item.mode === "MUST" && item.confidence >= 0.85 &&
      ["CODE", "DICTIONARY"].includes(item.source))
    .map((item) => item.value);
  const sourceOwnedDemandIdentities = [...new Set([
    ...parserOwnedTargetIdentities,
    ...sourceOwnedSemanticDemandIdentities({
    originalQuery: args.originalQuery,
    identities: safeLlm.analysis.semanticDemand?.identity ?? [],
    mandatoryConcepts: safeLlm.analysis.semanticMandatoryConcepts ?? [],
    exactConstraints: safeLlm.analysis.semanticDemand?.exactConstraints ?? [],
    modifiers: [
      ...(safeLlm.analysis.semanticDemand?.contexts ?? []),
      ...(safeLlm.analysis.semanticDemand?.qualities ?? []),
      ...(safeLlm.analysis.semanticDemand?.styles ?? []),
      ...(safeLlm.analysis.semanticDemand?.audience ?? []),
    ],
    }),
  ])].filter((value, index, values) => values.findIndex((candidate) =>
    normalizeQueryText(candidate) === normalizeQueryText(value),
  ) === index);
  const sourceOwnedExactConstraints = sourceOwnedSemanticExactConstraints({
    originalQuery: args.originalQuery,
    exactConstraints: safeLlm.analysis.semanticDemand?.exactConstraints ?? [],
    mandatoryConcepts: safeLlm.analysis.semanticMandatoryConcepts ?? [],
    rawPlan: args.rawPlan,
  });
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
    sourceGroundedDirectTarget ||
    sourceOwnedDemandIdentities.some(
      (identity) => !isGenericDiscoveryFamily(identity),
    );

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
  // Keep source-owned identity available to legacy evidence consumers without
  // converting it into a QueryPlan MUST. This is semantic provenance, not a
  // closed-world filter.
  const mergedRewriteBaseWithDemand =
    sourceOwnedDemandIdentities.length === 0
      ? {
          ...mergedRewriteBase,
          analysis: {
            ...mergedRewriteBase.analysis,
            sourceOwnedTargetIdentities: [],
            sourceOwnedExactConstraints,
          },
        }
      : {
          ...mergedRewriteBase,
          analysis: {
            ...mergedRewriteBase.analysis,
            sourceOwnedTargetIdentities: sourceOwnedDemandIdentities,
            sourceOwnedExactConstraints,
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
          .filter(
            (segment) =>
              segment.field === "CONTEXT" &&
              (args.rawPlan.referenceTerms ?? []).some((reference) =>
                ` ${normalizeQueryText(reference)} `.includes(
                  ` ${normalizeQueryText(segment.text)} `,
                ),
              ),
          )
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
      semanticDemand: mergedRewriteBaseWithDemand.analysis.semanticDemand
        ? {
            ...mergedRewriteBaseWithDemand.analysis.semanticDemand,
            // Parser-owned source target cannot be revoked by LLM omission or
            // replaced by an expanded product class. Preserve semantic axes.
            identity: [...new Set([
              ...sourceOwnedDemandIdentities,
              ...normalizeQueryText(args.originalQuery).split(" ").filter((token, index) =>
                isGenericDiscoveryFamily(token) && sourceProductTypeOwnsTarget({
                  query: args.originalQuery, start: index, end: index + 1,
                })
              ),
              ...args.rawPlan.identities.filter((item) =>
                isGenericDiscoveryFamily(item.value) && item.mode !== "MUST_NOT"
              ).map((item) => item.value),
            ])],
          }
        : undefined,
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
  // Reference facets are excluded from target fact authority, not from full
  // Demand meaning. Keep the source relation (including reference color/size)
  // in the primary vector; composeFacetEmbeddingInput already preserves roles.
  const embeddingInput = composeFacetEmbeddingInput(
    embeddingSeed,
    finalPlan,
    safeExpandedPlan,
    mergedRewrite,
    !safeLlm.fallbackReason ? (safeLlm.analysis.referenceTerms ?? []) : [],
  );

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
