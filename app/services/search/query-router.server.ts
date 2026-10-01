import {
  QUERY_ROUTER_VERSION,
  type QueryRoute,
} from "./query-plan.server";
import type { DeterministicQueryParse } from "./deterministic-query-parser.server";
import type { CatalogTermMatch } from "./catalog-term-matcher.server";

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
  const hasStrongStructuredConstraint =
    deterministic.measurements.length > 0 ||
    matches.some(
      (match) =>
        ["BRAND", "MODEL", "IDENTIFIER", "COMPATIBILITY", "MEASUREMENT"].includes(
          match.entry.field,
        ) && match.confidence >= 0.9,
    );
  let route: QueryRoute;

  if (hasExactIdentifier || hasStrongModel) {
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
    route = matches.length <= 2 ? "STRUCTURED_ONLY" : "CODE_SEMANTIC";
    reasons.push("DICTIONARY_FULLY_RESOLVED");
  } else if (unresolvedSegments.length === 0 && hasStrongIdentityAlias) {
    route = "CODE_SEMANTIC";
    reasons.push("IDENTITY_ALIAS_RESOLVED");
  } else if (unresolvedSegments.length === 0 && hasStrongStructuredConstraint) {
    route = "STRUCTURED_ONLY";
    reasons.push("STRUCTURED_CONSTRAINTS_FULLY_RESOLVED");
  } else if (unresolvedSegments.length === 0 && matches.length > 0) {
    route = "CODE_SEMANTIC";
    reasons.push("NON_IDENTITY_TERMS_FULLY_RESOLVED");
  } else if (hasIdentitySignal) {
    route = "VECTOR_SEMANTIC";
    reasons.push("IDENTITY_RESOLVED_SEMANTIC_REMAINDER");
  } else if (unresolvedSegments.length <= 1 && matches.length > 0) {
    route = "LIGHT_LLM";
    reasons.push("PARTIALLY_RESOLVED_SINGLE_REMAINDER");
  } else {
    route = "FULL_LLM";
    reasons.push("IDENTITY_UNRESOLVED_OR_AMBIGUOUS");
  }

  return { route, reasons, version: QUERY_ROUTER_VERSION };
}
