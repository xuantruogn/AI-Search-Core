export const QUERY_PARSER_VERSION = "deterministic-v1";
export const QUERY_ROUTER_VERSION = "coverage-router-v1";

export type QueryRoute =
  | "STRUCTURED_ONLY"
  | "CODE_SEMANTIC"
  | "VECTOR_SEMANTIC"
  | "LIGHT_LLM"
  | "FULL_LLM";

export type ConstraintMode = "MUST" | "SHOULD" | "MUST_NOT";
export type ConstraintSource =
  | "CODE"
  | "DICTIONARY"
  | "VECTOR"
  | "LIGHT_LLM"
  | "FULL_LLM";

export type QueryConstraint = {
  value: string;
  normalizedValue?: string;
  mode: ConstraintMode;
  confidence: number;
  source: ConstraintSource;
};

export type AttributeConstraint = QueryConstraint & { name: string };

export type ResolvedQuerySegment = {
  text: string;
  field: string;
  canonicalValue: string;
  confidence: number;
  source: ConstraintSource;
};

export type QueryPlan = {
  route: QueryRoute;
  identities: QueryConstraint[];
  entities: {
    brands: QueryConstraint[];
    models: QueryConstraint[];
    identifiers: QueryConstraint[];
  };
  attributes: AttributeConstraint[];
  measurements: AttributeConstraint[];
  audiences: QueryConstraint[];
  contexts: QueryConstraint[];
  compatibility: QueryConstraint[];
  price?: { min?: number; max?: number; currency?: string };
  marketPreference: "ANY" | "BUDGET" | "PREMIUM";
  relation: "SINGLE" | "ANY" | "ALL";
  sort: {
    field: "RELEVANCE" | "PRICE" | "NEWEST";
    direction?: "ASC" | "DESC";
  };
  semanticQuery: string;
  resolvedSegments: ResolvedQuerySegment[];
  unresolvedSegments: string[];
  routerReason: string[];
  versions: {
    dictionaryVersion: string;
    queryParserVersion: string;
    queryRouterVersion: string;
  };
};
