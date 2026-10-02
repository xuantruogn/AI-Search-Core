import {
  QUERY_ROUTER_VERSION,
  type QueryRoute,
} from "./query-plan.server";
import type { DeterministicQueryParse } from "./deterministic-query-parser.server";
import type { CatalogTermMatch } from "./catalog-term-matcher.server";

const UNRESOLVED_CONTROL_TOKENS = new Set([
  "only", "just", "exactly", "please", "show", "find", "need", "want",
  "chi", "chỉ", "dung", "đúng",
]);

export function shouldAnalyzeUnresolvedIdentityRemainder(
  unresolvedSegments: string[],
) {
  const tokens = unresolvedSegments
    .flatMap((segment) => segment.toLowerCase().split(/\s+/).filter(Boolean));
  return tokens.some((token) => !UNRESOLVED_CONTROL_TOKENS.has(token));
}

export function routeQuery(args: {
  deterministic: DeterministicQueryParse;
  matches: CatalogTermMatch[];
  unresolvedSegments: string[];
}) {
  const { deterministic, matches, unresolvedSegments } = args;
  const reasons: string[] = [];
  const hasExactIdentifier = matches.some(
    (match) => match.entry.field === "IDENTIFIER" && match.confidence === 1,
  );
  const hasStrongModel = matches.some(
    (match) => match.entry.field === "MODEL" && match.confidence >= 0.99,
  );
  const hasStrongBrand = matches.some(
    (match) => match.entry.field === "BRAND" && match.confidence >= 0.9,
  );
  const hasCanonicalIdentity = matches.some(
    (match) => match.entry.field === "PRODUCT_TYPE",
  );
  const hasStrongIdentityAlias = matches.some(
    (match) => match.entry.field === "ALIAS" && match.confidence >= 0.8,
  );
  const hasIdentitySignal = hasCanonicalIdentity || hasStrongIdentityAlias;
  const hasBroadCategory = matches.some(
    (match) => match.entry.field === "CATEGORY" && match.confidence >= 0.9,
  );
  const hasBroadCategoryModifier = matches.some(
    (match) =>
      ["ATTRIBUTE", "CONTEXT", "AUDIENCE"].includes(match.entry.field) &&
      match.confidence >= 0.5,
  );
  const hasSoftSemanticModifier = matches.some(
    (match) =>
      ["ATTRIBUTE", "CONTEXT", "AUDIENCE"].includes(match.entry.field) &&
      match.confidence >= 0.5,
  );
  const unresolvedTokenCount = unresolvedSegments
    .flatMap((segment) => segment.split(/\s+/).filter(Boolean))
    .length;
  const hasStrongStructuredConstraint =
    deterministic.measurements.length > 0 ||
    matches.some(
      (match) =>
        ["BRAND", "MODEL", "IDENTIFIER", "COMPATIBILITY", "MEASUREMENT"].includes(
          match.entry.field,
        ) && match.confidence >= 0.9,
    );
  let route: QueryRoute;

  if (
    hasExactIdentifier ||
    (
      hasStrongModel &&
      (
        hasIdentitySignal ||
        hasStrongBrand ||
        deterministic.measurements.length > 0 ||
        unresolvedSegments.length === 0
      )
    )
  ) {
    route = "STRUCTURED_ONLY";
    reasons.push(hasExactIdentifier ? "EXACT_IDENTIFIER" : "STRONG_EXACT_MODEL");
  } else if (deterministic.hasComplexRelation || deterministic.hasConflictingConstraints) {
    route = "FULL_LLM";
    reasons.push(
      deterministic.hasComplexRelation ? "COMPLEX_RELATION_OR_NEGATION" : "CONFLICTING_CONSTRAINTS",
    );
  } else if (
    unresolvedSegments.length === 0 &&
    !hasIdentitySignal &&
    hasBroadCategory &&
    hasBroadCategoryModifier
  ) {
    // "winter clothing", "summer apparel", "women's clothing", etc. name a
    // broad retail family plus a semantic condition, not one exact product
    // identity. Let the LLM expand concrete purchasable leaf classes while the
    // source category/context remains the authoritative need.
    route = "LIGHT_LLM";
    reasons.push("BROAD_CATEGORY_CONTEXT_DISCOVERY");
  } else if (unresolvedSegments.length === 0 && hasCanonicalIdentity) {
    // A fully resolved product identity can stay structured-only only when the
    // remaining constraints are closed-world/exact. Ordinary color, material,
    // style, audience and use-case terms are semantic preferences: they need
    // vector recall plus typed reranking so nearby catalog concepts are not
    // collapsed into exact equality.
    route =
      matches.length <= 2 && !hasSoftSemanticModifier
        ? "STRUCTURED_ONLY"
        : "CODE_SEMANTIC";
    reasons.push(
      hasSoftSemanticModifier
        ? "IDENTITY_WITH_SOFT_SEMANTIC_MODIFIER"
        : "DICTIONARY_FULLY_RESOLVED",
    );
  } else if (unresolvedSegments.length === 0 && hasStrongIdentityAlias) {
    route = "CODE_SEMANTIC";
    reasons.push("IDENTITY_ALIAS_RESOLVED");
  } else if (unresolvedSegments.length === 0 && hasStrongStructuredConstraint) {
    route = "STRUCTURED_ONLY";
    reasons.push("STRUCTURED_CONSTRAINTS_FULLY_RESOLVED");
  } else if (unresolvedSegments.length === 0 && matches.length > 0) {
    route = "CODE_SEMANTIC";
    reasons.push("NON_IDENTITY_TERMS_FULLY_RESOLVED");
  } else if (
    hasIdentitySignal &&
    shouldAnalyzeUnresolvedIdentityRemainder(unresolvedSegments)
  ) {
    // A catalog family plus an unresolved content word may name a missing
    // subtype rather than a soft preference ("smart speaker", "computer
    // monitor"). Let the lightweight analyzer preserve the full requested
    // class so a broad homonym cannot satisfy it by itself. Control words such
    // as "only" remain code-owned and do not incur an LLM call.
    route = "LIGHT_LLM";
    reasons.push(
      unresolvedTokenCount >= 3
        ? "IDENTITY_WITH_SUBSTANTIAL_SEMANTIC_REMAINDER"
        : "IDENTITY_WITH_UNGROUNDED_SEMANTIC_REMAINDER",
    );
  } else if (hasIdentitySignal) {
    route = "VECTOR_SEMANTIC";
    reasons.push("IDENTITY_RESOLVED_CONTROL_REMAINDER");
  } else if (unresolvedSegments.length <= 1 && matches.length > 0) {
    route = "LIGHT_LLM";
    reasons.push("PARTIALLY_RESOLVED_SINGLE_REMAINDER");
  } else {
    route = "FULL_LLM";
    reasons.push("IDENTITY_UNRESOLVED_OR_AMBIGUOUS");
  }

  return { route, reasons, version: QUERY_ROUTER_VERSION };
}
