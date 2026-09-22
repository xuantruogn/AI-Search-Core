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
  const hasIdentity = matches.some((match) => match.entry.field === "PRODUCT_TYPE");
  let route: QueryRoute;

  if (hasExactIdentifier || hasStrongModel) {
    route = "STRUCTURED_ONLY";
    reasons.push(hasExactIdentifier ? "EXACT_IDENTIFIER" : "STRONG_EXACT_MODEL");
  } else if (deterministic.hasComplexRelation || deterministic.hasConflictingConstraints) {
    route = "FULL_LLM";
    reasons.push(
      deterministic.hasComplexRelation ? "COMPLEX_RELATION_OR_NEGATION" : "CONFLICTING_CONSTRAINTS",
    );
  } else if (unresolvedSegments.length === 0 && hasIdentity) {
    route = matches.length <= 2 ? "STRUCTURED_ONLY" : "CODE_SEMANTIC";
    reasons.push("DICTIONARY_FULLY_RESOLVED");
  } else if (hasIdentity) {
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
