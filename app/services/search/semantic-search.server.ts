import {
  createEmbeddings,
  getEmbeddingDimensions,
  getEmbeddingModel,
  type EmbeddingRequestDiagnostics,
} from "./embeddings.server";
import {
  searchProductVectors,
  searchProductVectorsBatch,
} from "./vector-store.server";
import { ensureProductCollection } from "./qdrant.server";
import { rewriteSearchQuery, type QueryRewriteResult } from "./query-rewriter.server";
import {
  applyShopContextToQuery,
  discoveryExpansionTypeMatch,
  normalizeIdentitySignalTokens,
} from "./shop-context-index.server";

import { listSearchableIndexedProducts } from "../commerce/indexed-products.server";

function readMinimumVectorScore() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_VECTOR_SCORE_THRESHOLD || "",
  );
  return Number.isFinite(value) && value >= -1 && value <= 1 ? value : 0.35;
}

export function validTopVectorScore(scores: number[]): number | undefined {
  const finite = scores.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : undefined;
}

function readRelativeVectorScoreRatio() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_VECTOR_RELATIVE_SCORE_RATIO || "",
  );
  return Number.isFinite(value) && value >= 0.5 && value <= 1 ? value : 0.78;
}

function readDiscoveryRelativeVectorScoreRatio() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_DISCOVERY_VECTOR_RELATIVE_SCORE_RATIO || "",
  );
  return Number.isFinite(value) && value >= 0.5 && value <= 1 ? value : 0.88;
}

function readDiscoveryMinRecallResults() {
  const value = Number.parseInt(
    process.env.AI_SEARCH_DISCOVERY_MIN_RECALL_RESULTS || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 1
    ? Math.min(value, 50)
    : 8;
}

function readDiscoveryBranchRelativeRatio() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_DISCOVERY_BRANCH_RELATIVE_RATIO || "",
  );
  return Number.isFinite(value) && value >= 0.75 && value <= 1
    ? value
    : 0.92;
}

function readDiscoveryBranchMinimumScore() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_DISCOVERY_BRANCH_MIN_SCORE || "",
  );
  return Number.isFinite(value) && value >= -1 && value <= 1
    ? value
    : 0.35;
}

export function computeDiscoveryNoEvidenceThreshold(args: {
  retrievalMode: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
  baseThreshold: number;
  hasStrongCatalogEvidence: boolean;
  expansionGroundedCount: number;
}) {
  if (args.retrievalMode === "DIRECT") {
    return args.hasStrongCatalogEvidence
      ? args.baseThreshold
      : Math.max(args.baseThreshold, 0.60);
  }
  if (args.retrievalMode !== "DISCOVERY") return args.baseThreshold;
  if (!args.hasStrongCatalogEvidence && args.expansionGroundedCount === 0) {
    // With no source-grounded or expansion-grounded catalog evidence, vector
    // similarity alone must clear a conservative bar. This blocks sibling
    // product classes such as a plain digital watch for an absent "smart
    // watch" query.
    return Math.max(args.baseThreshold, 0.55);
  }
  if (!args.hasStrongCatalogEvidence && args.expansionGroundedCount > 0) {
    // Expansion-only taxonomy is recall evidence, not proof that the shopper's
    // requested product family exists. Keep the normal no-evidence floor so an
    // ambiguous expansion such as "headphones" -> "headset" cannot resurrect
    // bicycle headsets. Source-grounded context/identity is handled above.
    return args.baseThreshold;
  }
  return args.baseThreshold;
}

export function computeDiscoveryRecallThreshold(args: {
  retrievalMode: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
  baseThreshold: number;
  retrievalMinimumScore: number;
  candidateScores: number[];
  hasStrongCatalogEvidence: boolean;
  minRecallResults: number;
}) {
  if (
    args.retrievalMode !== "DISCOVERY" ||
    !args.hasStrongCatalogEvidence ||
    args.minRecallResults <= 0
  ) {
    return args.baseThreshold;
  }

  const finiteScores = args.candidateScores.filter(Number.isFinite);
  const passing = finiteScores.filter(
    (score) => score >= args.baseThreshold,
  ).length;
  if (
    passing >= args.minRecallResults ||
    finiteScores.length < args.minRecallResults
  ) {
    return args.baseThreshold;
  }

  const nthScore = finiteScores[args.minRecallResults - 1];
  return Math.max(
    args.retrievalMinimumScore,
    Math.min(args.baseThreshold, nthScore),
  );
}

export function shouldRejectNoEvidenceVector(args: {
  hasStrongCatalogEvidence: boolean;
  topVectorScore: number | undefined;
  normalThreshold: number;
  transientFallback: boolean;
  transientThreshold: number;
}) {
  if (args.hasStrongCatalogEvidence) return false;
  if (typeof args.topVectorScore !== "number" || !Number.isFinite(args.topVectorScore)) {
    return false;
  }
  return args.topVectorScore < (
    args.transientFallback ? args.transientThreshold : args.normalThreshold
  );
}

function retrievalModeOf(
  rewrite: QueryRewriteResult | null | undefined,
) {
  return rewrite?.planning?.retrievalMode ?? "DIRECT";
}

function readDiscoveryVectorScore() {
  const value = Number.parseFloat(
    process.env.AI_SEARCH_DISCOVERY_VECTOR_SCORE_THRESHOLD || "0.24",
  );
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0.24;
}

function readQueryEmbeddingTimeoutMs() {
  const value = Number.parseInt(
    process.env.AI_SEARCH_QUERY_EMBEDDING_TIMEOUT_MS || "",
    10,
  );

  return Number.isSafeInteger(value) && value >= 500
    ? Math.min(value, 5_000)
    : 5_000;
}

function readQueryEmbeddingMaxRetries() {
  const value = Number.parseInt(
    process.env.AI_SEARCH_QUERY_EMBEDDING_MAX_RETRIES || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 2)
    : 1;
}

function shouldLogEmbeddingInput() {
  const value = process.env.AI_SEARCH_LOG_EMBEDDING_INPUT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const GENERIC_DISCOVERY_BRANCH_CONTEXT = new Set([
  "apparel", "clothing", "gear", "equipment", "item", "items",
  "product", "products", "goods", "outfit", "outfits", "fashion",
]);

const DIRECT_RESIDUAL_STOP_WORDS = new Set([
  "i", "m", "im", "do", "you", "have", "has", "that", "are", "is", "am",
  "be", "been", "being", "a", "an", "the", "for", "with", "to", "in", "on",
  "of", "and", "or", "but", "still", "something", "anything", "looking",
  "need", "want", "suitable", "enough", "please", "show", "me", "find", "get",
]);

function normalizeEmbeddingBranch(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function naturalLanguageList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

const GENERIC_CATALOG_EVIDENCE_TOKENS = new Set([
  "apparel", "clothing", "fashion", "style", "styles", "gear", "equipment",
  "accessory", "accessories", "item", "items", "product", "products", "goods",
  "outfit", "outfits", "wear",
]);

function isGenericCatalogEvidenceValue(value: string) {
  const tokens = normalizeEmbeddingBranch(value).split(" ").filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.every((token) => GENERIC_CATALOG_EVIDENCE_TOKENS.has(token))
  );
}

export function singleTokenSourceIdentityEvidence(args: {
  sourceQuery: string;
  sourceMustTerms: string[];
  catalogTerms: Array<{ kind: string; value: string; score: number }>;
}) {
  const sourceTokens = normalizeEmbeddingBranch(args.sourceQuery)
    .split(" ")
    .filter(Boolean);
  if (sourceTokens.length !== 1) return false;

  const sourceToken = sourceTokens[0];
  const sourceMustOwnsToken = args.sourceMustTerms.some(
    (term) => normalizeEmbeddingBranch(term) === sourceToken,
  );
  if (!sourceMustOwnsToken) return false;

  return args.catalogTerms.some((term) => {
    if (
      !["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "ALIAS"].includes(term.kind) ||
      term.score < 18 ||
      isGenericCatalogEvidenceValue(term.value)
    ) {
      return false;
    }
    const catalogTokens = normalizeEmbeddingBranch(term.value)
      .split(" ")
      .filter(Boolean);
    return catalogTokens.includes(sourceToken);
  });
}

export function catalogEvidenceNeedMatches(
  needValue: string,
  catalogValue: string,
) {
  const needTokens = normalizeEmbeddingBranch(needValue).split(" ").filter(Boolean);
  const catalogTokens = normalizeEmbeddingBranch(catalogValue).split(" ").filter(Boolean);
  if (needTokens.length === 0 || catalogTokens.length === 0) return false;
  if (
    needTokens.length === catalogTokens.length &&
    needTokens.every((token, index) => token === catalogTokens[index])
  ) {
    return true;
  }

  const containsSequence = (haystack: string[], needle: string[]) => {
    if (needle.length < 2 || needle.length > haystack.length) return false;
    for (let start = 0; start <= haystack.length - needle.length; start += 1) {
      if (needle.every((token, offset) => haystack[start + offset] === token)) {
        return true;
      }
    }
    return false;
  };

  return (
    containsSequence(needTokens, catalogTokens) ||
    containsSequence(catalogTokens, needTokens)
  );
}

export function catalogEvidenceCoversSemanticMustTerms(
  semanticMustTerms: string[],
  catalogValues: string[],
) {
  const needGroups = semanticMustTerms
    .map((value) =>
      normalizeEmbeddingBranch(value).split(" ").filter(Boolean),
    )
    .filter((tokens) => tokens.length > 0);
  if (needGroups.length === 0) return true;

  const catalogTokens = new Set(
    catalogValues.flatMap((value) =>
      normalizeEmbeddingBranch(value).split(" ").filter(Boolean),
    ),
  );
  if (catalogTokens.size === 0) return false;

  return needGroups.every((needTokens) =>
    needTokens.every((token) => catalogTokens.has(token)),
  );
}

export function buildDiscoveryEmbeddingBranches(
  rewrite: QueryRewriteResult | null | undefined,
) {
  if (!rewrite || retrievalModeOf(rewrite) !== "DISCOVERY") return [];

  const primary = normalizeEmbeddingBranch(
    rewrite.analysis.intent ||
      rewrite.planning?.semanticQuery ||
      rewrite.query,
  );
  const semanticContext = [
    ...(rewrite.analysis.semanticMustTerms ?? []),
    ...rewrite.analysis.requiredAttributes,
    ...(rewrite.analysis.useCases ?? []),
    ...rewrite.analysis.compatibility,
  ]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((value) => !/\d/.test(value))
    .filter((value) => {
      const tokens = normalizeEmbeddingBranch(value).split(" ").filter(Boolean);
      return (
        tokens.length > 0 &&
        !tokens.every((token) => GENERIC_DISCOVERY_BRANCH_CONTEXT.has(token))
      );
    })
    .slice(0, 3);

  const groundedCanonicalTypes =
    rewrite.context?.selectedTerms
      .filter(
        (term) =>
          term.kind === "CANONICAL_PRODUCT_TYPE" &&
          term.score >= 18,
      )
      .map((term) =>
        normalizeEmbeddingBranch(term.value).split(" ").filter(Boolean),
      ) ?? [];
  const orderedExpansions = (rewrite.analysis.semanticExpansions ?? [])
    .map((rawExpansion, index) => ({
      rawExpansion,
      index,
      grounded: groundedCanonicalTypes.some((typeTokens) =>
        discoveryExpansionTypeMatch(typeTokens, [rawExpansion]),
      ),
    }))
    .sort(
      (left, right) =>
        Number(right.grounded) - Number(left.grounded) ||
        left.index - right.index,
    );

  const seen = new Set<string>();
  const branches: string[] = [];
  for (const { rawExpansion } of orderedExpansions) {
    const expansion = rawExpansion.replace(/\s+/g, " ").trim();
    const normalizedExpansion = normalizeEmbeddingBranch(expansion);
    if (!normalizedExpansion || normalizedExpansion === primary) continue;
    if (
      primary &&
      (primary === normalizedExpansion ||
        primary.includes(normalizedExpansion) ||
        normalizedExpansion.includes(primary))
    ) {
      continue;
    }
    if (seen.has(normalizedExpansion)) continue;
    seen.add(normalizedExpansion);

    const needs: string[] = [];
    for (const context of semanticContext) {
      const normalizedContext = normalizeEmbeddingBranch(context);
      if (
        !normalizedContext ||
        normalizedExpansion.includes(normalizedContext) ||
        needs.some((value) =>
          normalizeEmbeddingBranch(value).includes(normalizedContext),
        )
      ) {
        continue;
      }
      needs.push(context);
    }
    const branch =
      needs.length > 0
        ? `${expansion} suitable for ${naturalLanguageList(needs)}`
            .slice(0, 260)
            .trim()
        : expansion.slice(0, 260).trim();
    if (branch) branches.push(branch);
    // The primary vector already keeps the broad recall horizon. Secondary
    // discovery branches are targeted recall probes, so cap them at four to
    // avoid multiplying Qdrant work for the 500-result storefront horizon.
    if (branches.length >= 4) break;
  }
  return branches;
}

export function buildComplementEmbeddingBranches(
  rewrite: QueryRewriteResult | null | undefined,
) {
  if (!rewrite || retrievalModeOf(rewrite) !== "COMPLEMENT") return [];

  const primary = normalizeEmbeddingBranch(
    rewrite.planning?.semanticQuery || rewrite.analysis.intent || rewrite.query,
  );
  const referenceTokens = new Set(
    (rewrite.analysis.referenceTerms ?? []).flatMap((value) =>
      normalizeEmbeddingBranch(value).split(" ").filter(Boolean),
    ),
  );
  const selectedValues = new Set(
    (rewrite.context?.selectedTerms ?? [])
      .filter((term) => term.score >= 18)
      .map((term) => normalizeEmbeddingBranch(term.value))
      .filter(Boolean),
  );

  const ordered = (rewrite.analysis.semanticExpansions ?? [])
    .map((rawExpansion, index) => {
      const normalized = normalizeEmbeddingBranch(rawExpansion);
      return {
        rawExpansion,
        normalized,
        index,
        grounded: [...selectedValues].some(
          (value) =>
            value === normalized ||
            catalogEvidenceNeedMatches(rawExpansion, value),
        ),
      };
    })
    .filter(({ normalized }) => {
      if (!normalized || normalized === primary) return false;
      const tokens = normalized.split(" ").filter(Boolean);
      if (tokens.length === 0) return false;
      // Do not create a branch that is merely the reference product again.
      return !tokens.every((token) => referenceTokens.has(token));
    })
    .sort(
      (left, right) =>
        Number(right.grounded) - Number(left.grounded) ||
        left.index - right.index,
    );

  const branches: string[] = [];
  const seen = new Set<string>();

  // COMPLEMENT must remain usable when the LLM times out. The deterministic
  // planner already extracted the target family and reference item from the
  // source relation, so preserve that information in a semantic branch rather
  // than embedding only the stripped target phrase.
  const targetIdentity = [
    rewrite.analysis.shopLanguageProductType,
    rewrite.analysis.productType,
    ...(rewrite.analysis.productTypes ?? []),
  ]
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .find((value): value is string => Boolean(value));
  const referenceValue = (rewrite.analysis.referenceTerms ?? [])
    .map((value) => value.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (referenceValue) {
    const target = targetIdentity || rewrite.planning?.semanticQuery || rewrite.query;
    const deterministicBranch =
      `${target} ; pair with ${referenceValue}`.slice(0, 220).trim();
    const normalizedBranch = normalizeEmbeddingBranch(deterministicBranch);
    if (normalizedBranch && normalizedBranch !== primary) {
      seen.add(normalizedBranch);
      branches.push(deterministicBranch);
    }
  }

  for (const item of ordered) {
    if (seen.has(item.normalized)) continue;
    seen.add(item.normalized);
    branches.push(item.rawExpansion.replace(/\s+/g, " ").trim().slice(0, 220));
    if (branches.length >= 4) break;
  }
  return branches.filter(Boolean);
}

export function buildDirectEmbeddingPlan(
  rewrite: QueryRewriteResult | null | undefined,
) {
  if (!rewrite || retrievalModeOf(rewrite) !== "DIRECT") {
    return {
      primary: rewrite?.query ?? "",
      branches: [] as string[],
      sourceResidualBranchIndex: null as number | null,
    };
  }
  const planningContextValues = (rewrite.planning?.resolvedSegments ?? [])
    .filter((segment) => segment.field === "CONTEXT")
    .map((segment) => segment.canonicalValue);
  const rawFacetValues = [
    ...rewrite.analysis.brands,
    ...rewrite.analysis.models,
    ...rewrite.analysis.requiredAttributes,
    ...rewrite.analysis.optionalPreferences,
    ...rewrite.analysis.attributes,
    ...rewrite.analysis.audience,
    ...rewrite.analysis.compatibility,
    ...(rewrite.analysis.useCases ?? []),
    ...planningContextValues,
  ]
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const facetTokens = new Set(
    rawFacetValues.flatMap((value) => normalizeEmbeddingBranch(value).split(" ").filter(Boolean)),
  );
  const identity = [
    rewrite.analysis.shopLanguageProductType,
    rewrite.analysis.productType,
    ...(rewrite.analysis.productTypes ?? []),
  ]
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => {
      const identityTokens = normalizeIdentitySignalTokens(value);
      if (!identityTokens.length) return "";
      // Product identity is the retrieval anchor. Never subtract facet tokens
      // from it: "Phone Case" + facet "Phone" must remain "phone case", not
      // collapse to the generic word "case". Facets belong in separate
      // branches and must not mutate the identity representation.
      return identityTokens.join(" ");
    })
    .find(Boolean);
  const primary = rewrite.query || rewrite.planning?.semanticQuery || rewrite.analysis.intent || identity || "";
  const negative = new Set(
    (rewrite.analysis.negativeTerms ?? []).map(normalizeEmbeddingBranch),
  );
  const negativeTokens = new Set(
    [...negative].flatMap((value) => value.split(" ").filter(Boolean)),
  );
  const facets = rawFacetValues
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    // Keep alphanumeric model/compatibility facets such as "iPhone 18 Pro"
    // and "25.4mm handlebars". Only discard a facet that is effectively a
    // bare number; typed price/measurement handling owns those separately.
    .filter((value) => !/^\s*\d+(?:[.,]\d+)?\s*$/.test(value))
    .filter((value) => !negative.has(normalizeEmbeddingBranch(value)))
    .filter((value, index, list) =>
      list.findIndex((candidate) =>
        normalizeEmbeddingBranch(candidate) === normalizeEmbeddingBranch(value),
      ) === index,
    )
    .filter((value) => !normalizeEmbeddingBranch(primary).includes(normalizeEmbeddingBranch(value)))
    .slice(0, 4);
  const facetBranch = facets.length > 0
    ? `${primary} with ${naturalLanguageList(facets)}`.slice(0, 260)
    : "";

  const coveredTokens = new Set([
    ...normalizeEmbeddingBranch(primary).split(" ").filter(Boolean),
    ...rawFacetValues.flatMap((value) =>
      normalizeEmbeddingBranch(value).split(" ").filter(Boolean),
    ),
  ]);
  const semanticSource =
    rewrite.planning?.semanticQuery ||
    rewrite.query;
  const residualTokens = normalizeEmbeddingBranch(semanticSource)
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !coveredTokens.has(token))
    .filter((token) => !negativeTokens.has(token))
    .filter((token) => !DIRECT_RESIDUAL_STOP_WORDS.has(token));
  const residual = [...new Set(residualTokens)].join(" ");
  const residualBranch = residual
    ? `${primary} for ${residual}`.slice(0, 260)
    : "";

  // LLM expansions are retrieval probes, not truth. Let the first few
  // expansion phrases open semantic recall for short DIRECT need queries
  // (e.g. "office bag" -> work/laptop bag) without turning those phrases into
  // hard catalog evidence.
  const expansionBranches = (rewrite.analysis.semanticExpansions ?? [])
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((value) => !negative.has(normalizeEmbeddingBranch(value)))
    .filter(
      (value, index, list) =>
        list.findIndex(
          (candidate) =>
            normalizeEmbeddingBranch(candidate) ===
            normalizeEmbeddingBranch(value),
        ) === index,
    )
    .filter(
      (value) =>
        normalizeEmbeddingBranch(value) !== normalizeEmbeddingBranch(primary),
    )
    .slice(0, 2);

  const branches = [identity, facetBranch, residualBranch, ...expansionBranches]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter(
      (value, index, list) =>
        normalizeEmbeddingBranch(value) !== normalizeEmbeddingBranch(primary) &&
        list.findIndex(
          (candidate) =>
            normalizeEmbeddingBranch(candidate) ===
            normalizeEmbeddingBranch(value),
        ) === index,
    )
    .slice(0, 3);
  const sourceResidualBranchIndex = residualBranch
    ? branches.findIndex(
        (value) =>
          normalizeEmbeddingBranch(value) ===
          normalizeEmbeddingBranch(residualBranch),
      ) + 1
    : 0;

  return {
    primary,
    branches,
    sourceResidualBranchIndex:
      sourceResidualBranchIndex > 0 ? sourceResidualBranchIndex : null,
  };
}

export type SearchResult = {
  productId: string;
  handle: string;
  title: string;
  /** Final retrieval/rerank score; not a probability or raw cosine. */
  score: number;
  /** Best raw Qdrant cosine similarity seen across retrieval branches. */
  vectorSimilarity?: number;
  /** Raw cosine similarity to the primary interpreted-query embedding. */
  primaryVectorSimilarity?: number;
  /** Best relative score within any secondary semantic branch (0..1). */
  semanticBranchRelativeScore?: number;
  /** One-based secondary branch index that best supports this candidate. */
  semanticBranchIndex?: number;
  semanticBranchInput?: string;
  /** Qdrant BM25 sparse score; raw scale is not mixed with cosine. */
  sparseScore?: number;
  sparseRank?: number;
  /** Normalized RRF score after dense+sparse rank fusion. */
  rrfScore?: number;
  /** Exact lexical-title lane score, kept separate from vector similarity. */
  lexicalScore?: number;
  lexicalMatchType?: "EXACT_TITLE" | "TITLE_PHRASE" | "TITLE_TOKENS" | "HANDLE";
  /** Calibrated score from exact structured facts. */
  structuredScore?: number;
  structuredMatchedKinds?: string[];
  structuredMatchedTerms?: Array<{ kind: string; value: string }>;
  structuredMatchedRowKinds?: string[];
  structuredAnchorKinds?: string[];
  structuredGuardRescue?: boolean;
  structuredExactCanonicalIdentity?: boolean;
  /** Final lane provenance for diagnostics; score remains the fused rank score. */
  retrievalSources?: Array<"SEMANTIC" | "SPARSE" | "STRUCTURED" | "LEXICAL">;
  minVariantPrice?: number;
  maxVariantPrice?: number;
  currencyCode?: string;
};

export function fuseSemanticVectorBranches(
  resultSets: SearchResult[][],
  limit: number,
) {
  const fused = new Map<
    string,
    {
      result: SearchResult;
      score: number;
      branchHits: number;
      vectorSimilarity: number;
      primaryVectorSimilarity?: number;
      semanticBranchRelativeScore: number;
      semanticBranchIndex?: number;
    }
  >();
  const branchTopScores = resultSets.map((results) =>
    validTopVectorScore(
      results.map((result) => result.vectorSimilarity ?? result.score),
    ) ?? 0,
  );

  resultSets.forEach((results, branchIndex) => {
    // Secondary vectors are recall probes, not independent ranking truth.
    // Discount branch-only similarity so one broad expansion cannot outrank a
    // product that actually matches the primary interpreted need.
    const branchWeight = branchIndex === 0 ? 1 : 0.90;
    for (const result of results) {
      const rawSimilarity = result.vectorSimilarity ?? result.score;
      const weightedScore = result.score * branchWeight;
      const branchTopScore = branchTopScores[branchIndex] ?? 0;
      const branchRelativeScore =
        branchIndex > 0 && branchTopScore > 0
          ? Math.max(0, Math.min(1, rawSimilarity / branchTopScore))
          : 0;
      const current = fused.get(result.productId);
      if (!current) {
        fused.set(result.productId, {
          result,
          score: weightedScore,
          branchHits: 1,
          vectorSimilarity: result.vectorSimilarity ?? result.score,
          primaryVectorSimilarity:
            branchIndex === 0 ? rawSimilarity : undefined,
          semanticBranchRelativeScore: branchRelativeScore,
          semanticBranchIndex: branchIndex > 0 ? branchIndex : undefined,
        });
        continue;
      }
      current.branchHits += 1;
      current.vectorSimilarity = Math.max(
        current.vectorSimilarity,
        result.vectorSimilarity ?? result.score,
      );
      if (branchIndex === 0) {
        current.primaryVectorSimilarity = rawSimilarity;
      } else if (
        branchRelativeScore > current.semanticBranchRelativeScore
      ) {
        current.semanticBranchRelativeScore = branchRelativeScore;
        current.semanticBranchIndex = branchIndex;
      }
      if (weightedScore > current.score) {
        current.result = result;
        current.score = weightedScore;
      }
    }
  });

  return [...fused.values()]
    .map(({
      result,
      score,
      branchHits,
      vectorSimilarity,
      primaryVectorSimilarity,
      semanticBranchRelativeScore,
      semanticBranchIndex,
    }) => ({
      ...result,
      vectorSimilarity,
      primaryVectorSimilarity,
      semanticBranchRelativeScore,
      semanticBranchIndex,
      // Tiny consensus bonus helps a product supported by both the general
      // need vector and a product-class branch without allowing broad branch
      // membership to dominate ranking.
      score: Math.min(1, score + Math.min(0.03, (branchHits - 1) * 0.01)),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, limit));
}

export type SemanticSearchDiagnostics = {
  /** Open-world context uncertainty; never a certain absence proof. */
  contextProductClassUncertain?: boolean;
  /** Deprecated certainty flag. Certain absence is owned by absence-proof.server. */
  sourceProductClassAbsent?: boolean;
  primaryEmbeddingInput?: string;
  semanticFacetBranches?: string[];
  retrievalMode: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
  noEvidenceGuardTriggered: boolean;
  noEvidenceThreshold: number;
  topVectorScore: number | null;
  hasStrongCatalogEvidence: boolean;
  candidateCount: number;
  topCandidateScore: number | null;
  vectorThreshold: number;
  embeddingCacheHit: boolean;
  llmStatus:
    | "SUCCESS"
    | "FALLBACK"
    | "CACHE_HIT"
    | "CODE_ONLY"
    | "OUTSIDE_CATALOG";
  llmFallbackReason: string | null;
  ensureCollectionMs: number;
  embeddingMs: number;
  embeddingCallCount: number;
  embeddingOpenAiProcessingMs: number | null;
  embeddingNetworkAndSdkMs: number | null;
  embeddingRequestId: string | null;
  embeddingClientRequestId: string | null;
  embeddingMaxRetries: number;
  qdrantMs: number;
  usageLoggingMs: number;
  collectionWaitMs: number;
  embeddingPreparationCodeMs: number;
  qdrantRequestMs: number;
  qdrantResponseMappingCodeMs: number;
  qdrantPassCount: number;
  qdrantFinalCandidateWindow: number;
  thresholdFilterCodeMs: number;
  resultMappingCodeMs: number;
  otherCodeMs: number;
  totalMs: number;
};

export type SemanticSearchInput = {
  preparedRewrite?: QueryRewriteResult;
  shop: string;
  query: string;
  limit?: number;
  vectorOverride?: number[];
  onEmbeddingCreated?: (
    vector: number[],
    metadata: { cacheable: boolean },
  ) => void | Promise<void>;
  onDiagnostics?: (diagnostics: SemanticSearchDiagnostics) => void;
};

function inferLlmStatus(
  rewrite: QueryRewriteResult | undefined,
): SemanticSearchDiagnostics["llmStatus"] {
  if (!rewrite) return "CODE_ONLY";
  if (rewrite.fallbackReason) return "FALLBACK";
  if (!rewrite.model) return "CODE_ONLY";
  if (
    rewrite.timing?.cacheStatus === "HIT" ||
    rewrite.timing?.cacheStatus === "JOINED"
  ) {
    return "CACHE_HIT";
  }
  return "SUCCESS";
}

export async function semanticSearch({
  preparedRewrite,
  shop,
  query,
  limit = 20,
  vectorOverride,
  onEmbeddingCreated,
  onDiagnostics,
}: SemanticSearchInput): Promise<SearchResult[]> {
  const cleanQuery = query.trim();

  if (!cleanQuery) {
    return [];
  }

  console.log("[AI Search] Semantic search", {
    shop,
    queryLength: cleanQuery.length,
    limit,
    cacheHit: Boolean(vectorOverride),
  });

  const stageStartedAt = Date.now();

  let embeddingMs = 0;
  let embeddingCallCount = 0;
  let semanticBranchInputs: string[] = [];
  let semanticBranchVectors: number[][] = [];
  let directSourceResidualBranchIndex: number | null = null;
  let primaryEmbeddingInputForDiagnostics = cleanQuery;
  let embeddingRequestDiagnostics:
    | EmbeddingRequestDiagnostics
    | null = null;

  let usageMs = 0;
  let ensureMs = 0;
  let collectionWaitMs = 0;
  let embeddingPreparationCodeMs = 0;
  let qdrantRequestMs = 0;
  let qdrantResponseMappingCodeMs = 0;
  let qdrantPassCount = 0;
  let qdrantFinalCandidateWindow = 0;
  let thresholdFilterCodeMs = 0;
  let resultMappingCodeMs = 0;
  let effectiveRewrite = preparedRewrite;

  // Start Qdrant lazily.
  // Query ngoÃ i catalog khÃ´ng cáº§n cháº¡m Qdrant.
  let collectionReady:
    | Promise<
        | { ok: true }
        | {
            ok: false;
            error: unknown;
          }
      >
    | null = null;

  const ensureCollectionReady = () => {
    if (!collectionReady) {
      const ensureStartedAt =
        Date.now();

      collectionReady =
        ensureProductCollection().then(
          () => {
            ensureMs =
              Date.now() -
              ensureStartedAt;

            return {
              ok: true as const,
            };
          },

          (error: unknown) => {
            ensureMs =
              Date.now() -
              ensureStartedAt;

            return {
              ok: false as const,
              error,
            };
          },
        );
    }

    return collectionReady;
  };

  let usageCompleted:
    Promise<void> =
      Promise.resolve();

  let queryVector:
    number[];

  const minimumScore =
    readMinimumVectorScore();

  let llmStatus:
    SemanticSearchDiagnostics["llmStatus"] =
      inferLlmStatus(preparedRewrite);

  let llmFallbackReason:
    string | null =
      preparedRewrite?.fallbackReason ?? null;

  const transientLlmFallbackReasons = new Set([
    "LLM_TIMEOUT",
    "LLM_ERROR",
    "LLM_INCOMPLETE",
    "LLM_OUTPUT_TRUNCATED",
    "INVALID_LLM_OUTPUT",
  ]);

  // ============================================================
  // 1. QUERY EMBEDDING
  // ============================================================

  if (
    vectorOverride &&
    Array.isArray(
      vectorOverride,
    ) &&
    vectorOverride.length > 0
  ) {
    queryVector =
      vectorOverride;

    const directPlan = buildDirectEmbeddingPlan(preparedRewrite);
    const preparedMode = retrievalModeOf(preparedRewrite);
    directSourceResidualBranchIndex =
      preparedMode === "DIRECT"
        ? directPlan.sourceResidualBranchIndex
        : null;
    semanticBranchInputs =
      preparedMode === "DISCOVERY"
        ? buildDiscoveryEmbeddingBranches(preparedRewrite)
        : preparedMode === "COMPLEMENT"
          ? buildComplementEmbeddingBranches(preparedRewrite)
          : directPlan.branches;
    if (semanticBranchInputs.length > 0) {
      void ensureCollectionReady();
      const embeddingStartedAt = Date.now();
      semanticBranchVectors = await createEmbeddings(
        semanticBranchInputs,
        {
          maxRetries: readQueryEmbeddingMaxRetries(),
          timeoutMs: readQueryEmbeddingTimeoutMs(),
          usageContext: {
            shop,
            operation: "QUERY_EMBEDDING",
          },
          onDiagnostics: (diagnostics) => {
            embeddingRequestDiagnostics = diagnostics;
          },
        },
      );
      embeddingCallCount = 1;
      embeddingMs = Date.now() - embeddingStartedAt;

      // The primary vector came from cache, but the expansion batch is a real
      // provider call and must consume the same query-embedding reservation.
      if (onEmbeddingCreated) {
        const usageStartedAt = Date.now();
        usageCompleted = (async () => {
          try {
            await onEmbeddingCreated(queryVector, { cacheable: false });
          } catch (usageError) {
            console.error(
              "[AI Search] Query expansion embedding callback failed:",
              usageError,
            );
          } finally {
            usageMs = Date.now() - usageStartedAt;
          }
        })();
      }
    }
  } else {
    const preparationStartedAt =
      Date.now();

    const interpreted =
      preparedRewrite ??
      await rewriteSearchQuery({
        shop,
        query:
          cleanQuery,
      });

    const rewrite =
      interpreted.context
        ? interpreted
        : await applyShopContextToQuery({
            shop,

            originalQuery:
              cleanQuery,

            rewrite:
              interpreted,
          });
    effectiveRewrite = rewrite;

    llmStatus =
      inferLlmStatus(rewrite);

    llmFallbackReason =
      rewrite.fallbackReason;

    if (
      shouldLogEmbeddingInput()
    ) {
      console.log(
        "[AI Search][QUERY TRACE] Query analysis prepared",
        {
          shop,

          originalQuery:
            cleanQuery,

          rewrittenQuery:
            rewrite.query,

          catalogRelevant:
            rewrite.catalogRelevant,

          rewritten:
            rewrite.rewritten,

          llmAnalysis:
            rewrite.analysis,

          selectedShopContext:
            rewrite.context
              ?.selectedTerms ??
            [],

          rewriteModel:
            rewrite.model,

          rewriteFallbackReason:
            rewrite.fallbackReason,

          route: rewrite.planning?.route ?? "LEGACY",

          analysisSource: rewrite.timing?.llmCallCount
            ? "LLM"
            : "CODE",

          semanticQuery: rewrite.planning?.semanticQuery ?? rewrite.query,

          semanticResolution: rewrite.planning?.semanticResolution ?? "LEGACY",

          semanticResolutionConfidence:
            rewrite.planning?.semanticResolutionConfidence ?? rewrite.analysis.confidence,

          embeddingModel:
            getEmbeddingModel(),

          willCreateEmbedding:
            rewrite.catalogRelevant,
        },
      );
    }

    if (
      !rewrite.catalogRelevant
    ) {
      embeddingPreparationCodeMs +=
        Date.now() -
        preparationStartedAt;

      console.log(
        "[AI Search] Query rejected as outside shop catalog",
        {
          shop,

          rewriteModel:
            rewrite.model,

          reason:
            rewrite.analysis
              .decisionReason,

          fallbackReason:
            rewrite.fallbackReason,
        },
      );

      onDiagnostics?.({
        retrievalMode: retrievalModeOf(rewrite),
        noEvidenceGuardTriggered: false,
        noEvidenceThreshold: 0,
        topVectorScore: null,
        hasStrongCatalogEvidence: false,
        candidateCount:
          0,

        topCandidateScore:
          null,

        vectorThreshold:
          minimumScore,

        embeddingCacheHit:
          false,

        llmStatus:
          "OUTSIDE_CATALOG",

        llmFallbackReason,

        ensureCollectionMs:
          ensureMs,

        embeddingMs,

        embeddingCallCount:
          0,

        embeddingOpenAiProcessingMs:
          null,

        embeddingNetworkAndSdkMs:
          null,

        embeddingRequestId:
          null,

        embeddingClientRequestId:
          null,

        embeddingMaxRetries:
          0,

        qdrantMs:
          0,

        usageLoggingMs:
          usageMs,

        collectionWaitMs,

        embeddingPreparationCodeMs,

        qdrantRequestMs,

        qdrantResponseMappingCodeMs,

        qdrantPassCount,

        qdrantFinalCandidateWindow,

        thresholdFilterCodeMs,

        resultMappingCodeMs,

        otherCodeMs:
          Math.max(
            0,

            Date.now() -
              stageStartedAt -
              ensureMs,
          ),

        totalMs:
          Date.now() -
          stageStartedAt,
      });

      return [];
    }

    const directPlan = buildDirectEmbeddingPlan(rewrite);
    const primaryEmbeddingInput = directPlan.primary || rewrite.query;
    primaryEmbeddingInputForDiagnostics = primaryEmbeddingInput;
    const currentEmbeddingMode = retrievalModeOf(rewrite);
    directSourceResidualBranchIndex =
      currentEmbeddingMode === "DIRECT"
        ? directPlan.sourceResidualBranchIndex
        : null;
    semanticBranchInputs =
      currentEmbeddingMode === "DISCOVERY"
        ? buildDiscoveryEmbeddingBranches(rewrite)
        : currentEmbeddingMode === "COMPLEMENT"
          ? buildComplementEmbeddingBranches(rewrite)
          : directPlan.branches;
    const embeddingInputs = [
      primaryEmbeddingInput,
      ...semanticBranchInputs,
    ];

    if (
      shouldLogEmbeddingInput()
    ) {
      console.log(
        "[AI Search][EMBEDDING INPUT]",
        {
          model:
            getEmbeddingModel(),

          dimensions:
            getEmbeddingDimensions(),

          input:
            primaryEmbeddingInput,

          semanticBranchInputs,
          batchInputCount:
            embeddingInputs.length,
        },
      );
    }

    embeddingPreparationCodeMs +=
      Date.now() -
      preparationStartedAt;

    // Cháº¡y chuáº©n bá»‹ Qdrant song song
    // vá»›i OpenAI embedding.
    void ensureCollectionReady();

    const embeddingStartedAt =
      Date.now();

    const embeddingVectors =
      await createEmbeddings(
        embeddingInputs,
        {
          maxRetries:
            readQueryEmbeddingMaxRetries(),

          timeoutMs:
            readQueryEmbeddingTimeoutMs(),

          usageContext: {
            shop,
            operation: "QUERY_EMBEDDING",
          },

          onDiagnostics:
            (
              diagnostics,
            ) => {
              embeddingRequestDiagnostics =
                diagnostics;
            },
        },
      );

    embeddingCallCount = 1;
    queryVector = embeddingVectors[0];
    semanticBranchVectors = embeddingVectors.slice(1);

    embeddingMs =
      Date.now() -
      embeddingStartedAt;

    const embeddingDetails =
      embeddingRequestDiagnostics as
        | EmbeddingRequestDiagnostics
        | null;

    console.log(
      "[AI Search][PERF] OpenAI embedding request",
      {
        shop,

        model:
          getEmbeddingModel(),

        inputLength:
          primaryEmbeddingInput.length,

        dimensions:
          getEmbeddingDimensions(),

        endToEndMs:
          embeddingDetails
            ?.endToEndMs ??
          embeddingMs,

        openAiProcessingMs:
          embeddingDetails
            ?.openAiProcessingMs ??
          null,

        networkAndSdkMs:
          embeddingDetails
            ?.networkAndSdkMs ??
          null,

        requestId:
          embeddingDetails
            ?.requestId ??
          null,

        clientRequestId:
          embeddingDetails
            ?.clientRequestId ??
          null,

        timeoutMs:
          embeddingDetails
            ?.timeoutMs ??
          null,

        maxRetries:
          embeddingDetails
            ?.maxRetries ??
          0,

        remainingRequests:
          embeddingDetails
            ?.remainingRequests ??
          null,

        remainingTokens:
          embeddingDetails
            ?.remainingTokens ??
          null,

        resetRequests:
          embeddingDetails
            ?.resetRequests ??
          null,

        resetTokens:
          embeddingDetails
            ?.resetTokens ??
          null,

        responseEncoding:
          embeddingDetails
            ?.responseEncoding ??
          "base64",

        clientAgeMs:
          embeddingDetails?.clientAgeMs ?? null,

        clientRequestOrdinal:
          embeddingDetails?.clientRequestOrdinal ?? null,
      },
    );

    console.log(
      "[AI Search] Query prepared for embedding",
      {
        shop,

        rewritten:
          rewrite.rewritten,

        rewriteModel:
          rewrite.model,

        fallbackReason:
          rewrite.fallbackReason,

        embeddingInputLength:
          primaryEmbeddingInput.length,

        embeddingInput:
          primaryEmbeddingInput,

        route:
          rewrite.planning?.route ?? "LEGACY",

        semanticResolution:
          rewrite.planning?.semanticResolution ?? "LEGACY",

        semanticResolutionConfidence:
          rewrite.planning?.semanticResolutionConfidence ?? rewrite.analysis.confidence,
      },
    );

    if (
      onEmbeddingCreated &&
      typeof onEmbeddingCreated ===
        "function"
    ) {
      const usageStartedAt =
        Date.now();

      usageCompleted =
        (async () => {
          try {
            await onEmbeddingCreated(
              queryVector,
              {
                cacheable:
                  true,
              },
            );
          } catch (
            usageError
          ) {
            console.error(
              "[AI Search] Query embedding callback failed:",
              usageError,
            );
          } finally {
            usageMs =
              Date.now() -
              usageStartedAt;
          }
        })();
    }
  }

  console.log(
    "[AI Search] Query embedding dimensions:",
    queryVector.length,
  );

  // ============================================================
  // 2. QDRANT RETRIEVAL
  // ============================================================

  const collectionWaitStartedAt =
    Date.now();

  const ready =
    await ensureCollectionReady();

  collectionWaitMs =
    Date.now() -
    collectionWaitStartedAt;

  if (
    !ready.ok
  ) {
    await usageCompleted;

    throw ready.error;
  }

  const qdrantStartedAt =
    Date.now();

  let qdrantMs =
    0;

  const transientLlmFallback =
    Boolean(
      llmFallbackReason &&
      transientLlmFallbackReasons.has(llmFallbackReason),
    );

  const configuredFallbackScore = Number.parseFloat(
    process.env.AI_SEARCH_TRANSIENT_FALLBACK_VECTOR_SCORE_THRESHOLD || "0.18",
  );
  const safeFallbackScore =
    Number.isFinite(configuredFallbackScore) &&
    configuredFallbackScore >= 0 &&
    configuredFallbackScore <= 1
      ? configuredFallbackScore
      : 0.18;

  const retrievalMode =
    retrievalModeOf(effectiveRewrite);
  const discoveryMinimumScore =
    readDiscoveryVectorScore();

  const identityIds = effectiveRewrite?.context?.identityCandidateProductIds ?? [];
  const directExpansionScopeIds =
    effectiveRewrite?.context?.directExpansionGroundedProductIds ?? [];
  const discoverySourceIdentityIds =
    effectiveRewrite?.context?.discoverySourceIdentityProductIds ?? [];
  const hasExactCanonicalIdentityEvidence = Boolean(
    effectiveRewrite?.context?.selectedTerms.some(
      (term) =>
        term.kind === "CANONICAL_PRODUCT_TYPE" &&
        term.score >= 25,
    ),
  );
  const exactIdentityScope =
    retrievalMode === "DIRECT" &&
    identityIds.length > 0 &&
    hasExactCanonicalIdentityEvidence &&
    effectiveRewrite?.context?.canonicalTypeCoverageComplete === true;

  const retrievalMinimumScore =
    transientLlmFallback
      ? Math.min(minimumScore, safeFallbackScore)
      : exactIdentityScope
        ? Math.min(minimumScore, discoveryMinimumScore)
      : retrievalMode === "DISCOVERY" ||
          retrievalMode === "COMPLEMENT"
        ? Math.min(minimumScore, discoveryMinimumScore)
        : minimumScore;

  const retrievalScopeIds =
    exactIdentityScope
      ? [...new Set([...identityIds, ...directExpansionScopeIds])]
      : retrievalMode === "DISCOVERY" &&
          discoverySourceIdentityIds.length > 0 &&
          discoverySourceIdentityIds.length <= 2_000
        ? [...new Set(discoverySourceIdentityIds)]
        : undefined;

  const onQdrantDiagnostics = (
    diagnostics: {
      requestMs: number;
      responseMappingCodeMs: number;
      passCount: number;
      finalCandidateWindow: number;
    },
  ) => {
    qdrantRequestMs = diagnostics.requestMs;
    qdrantResponseMappingCodeMs = diagnostics.responseMappingCodeMs;
    qdrantPassCount = diagnostics.passCount;
    qdrantFinalCandidateWindow = diagnostics.finalCandidateWindow;
  };

  const retrievalTask =
    semanticBranchVectors.length > 0
      ? searchProductVectorsBatch({
          shop,
          vectors: [
            queryVector,
            ...semanticBranchVectors,
          ],
          limits: [
            limit,
            // Branch vectors only supplement the primary 500-result horizon.
            // Keep their per-branch recall budget fixed so a broad storefront
            // limit does not inflate every semantic expansion query.
            ...semanticBranchVectors.map(() => 20),
          ],
          scoreThreshold:
            retrievalMinimumScore,
          productIds:
            retrievalScopeIds,
          onDiagnostics:
            onQdrantDiagnostics,
        }).then((resultSets) =>
          fuseSemanticVectorBranches(resultSets, limit),
        )
      : searchProductVectors({
          shop,
          vector:
            queryVector,
          limit,
          scoreThreshold:
            retrievalMinimumScore,
          productIds:
            retrievalScopeIds,
          onDiagnostics:
            onQdrantDiagnostics,
        });

  const retrievalPromise =
    retrievalTask.then(
      (value) => {
        qdrantMs =
          Date.now() -
          qdrantStartedAt;

        return value;
      },

      (
        error:
          unknown,
      ) => {
        qdrantMs =
          Date.now() -
          qdrantStartedAt;

        throw error;
      },
    );

  const [
    retrieval,
  ] =
    await Promise.allSettled([
      retrievalPromise,
      usageCompleted,
    ]);

  // Usage accounting pháº£i hoÃ n táº¥t
  // trÆ°á»›c khi caller rollback failed search.
  if (
    retrieval.status ===
    "rejected"
  ) {
    throw retrieval.reason;
  }

  let results = retrieval.value;

  // Retrieval has already passed the authoritative registry guard. Capture
  // raw similarity before identity boosts/synthetic evidence scores are merged;
  // ranking bonuses must not raise the relative similarity cutoff.
  const rawTopVectorScore = validTopVectorScore(
    results.map((result) => result.vectorSimilarity ?? result.score),
  );

  const vectorCandidateCount = results.length;
  // Broad DISCOVERY families (Clothing, Footwear, etc.) are retrieval scope,
  // not exact product identity. Injecting/boosting every family member by
  // +0.2 lets irrelevant siblings survive the semantic threshold. Synthetic
  // identity evidence is therefore reserved for DIRECT retrieval.
  const identityEvidenceIds =
    retrievalMode === "DIRECT" && hasExactCanonicalIdentityEvidence
      ? identityIds
      : [];
  const evidenceCandidateIds = [
    ...new Set([
      ...identityEvidenceIds,
      ...directExpansionScopeIds,
    ]),
  ];
  if (evidenceCandidateIds.length > 0) {
    const existing = new Set(results.map((result) => result.productId));
    const evidenceRows = await listSearchableIndexedProducts(
      shop,
      evidenceCandidateIds.filter((id) => !existing.has(id)).slice(0, limit),
    );
    const identitySet = new Set(identityEvidenceIds);
    results = [
      ...results.map((result) => identitySet.has(result.productId)
        ? { ...result, score: Math.min(1, result.score + 0.2) }
        : result),
      // Canonical expansion-grounded leaves are proven catalog candidates.
      // Give them a conservative floor so they survive vector thresholding;
      // the typed reranker decides their final order.
      ...evidenceRows.map((row) => ({ ...row, score: 0.5 })),
    ].sort((left, right) => right.score - left.score).slice(0, limit);
  }
  console.log("[AI Search][CANDIDATE GENERATION]", {
    shop,
    route: effectiveRewrite?.planning?.route ?? "LEGACY",
    identityCandidateCount: identityIds.length,
    vectorCandidateCount,
    unionCandidateCount: results.length,
    canonicalTypeCoverageComplete:
      effectiveRewrite?.context?.canonicalTypeCoverageComplete ?? false,
  });

  // ============================================================
  // 3. REGISTRY GUARD
  //
  // vector-store.server owns the fail-closed registry check for every Qdrant
  // response (shop + searchable + hasVector). The exact evidence rows merged
  // above are also fetched through listSearchableIndexedProducts(), so every
  // candidate in this union has already crossed the same DB source-of-truth
  // boundary. Do not query the registry a second time here.
  // ============================================================

  const registryValidatedResults = results;

  console.log(
    "[AI Search][PERF] Retrieval stages",
    {
      shop,

      ensureMs,

      qdrantEnsureMs:
        ensureMs,

      embeddingMs,

      usageMs,

      qdrantMs,

      totalMs:
        Date.now() -
        stageStartedAt,

      embeddingCacheHit:
        Boolean(
          vectorOverride,
        ),
    },
  );

  // ============================================================
  // 4. SIMILARITY THRESHOLD
  //
  // Quan trá»ng:
  //
  // threshold pháº£i tÃ­nh SAU registry guard.
  //
  // Náº¿u orphan vector cÃ³ score cao nháº¥t,
  // nÃ³ khÃ´ng Ä‘Æ°á»£c phÃ©p Ä‘áº©y threshold lÃªn
  // vÃ  lÃ m loáº¡i nháº§m product há»£p lá»‡.
  // ============================================================

  const thresholdStartedAt =
    Date.now();

  const topVectorScore = rawTopVectorScore;

  const relativeRatio =
    retrievalMode === "DIRECT"
      ? readRelativeVectorScoreRatio()
      : readDiscoveryRelativeVectorScoreRatio();

  const baseMinimumScore =
    typeof topVectorScore ===
      "number" &&
    Number.isFinite(
      topVectorScore,
    )
      ? Math.max(
          retrievalMinimumScore,

          topVectorScore *
            relativeRatio,
        )
      : retrievalMinimumScore;

  const directExpansionGroundedIds =
    retrievalMode === "DIRECT"
      ? (effectiveRewrite?.context?.directExpansionGroundedProductIds ?? [])
      : [];
  const directSourceFacetGroundedIds =
    retrievalMode === "DIRECT"
      ? (effectiveRewrite?.context?.directSourceFacetGroundedProductIds ?? [])
      : [];
  const identityIdSetForSourceResidual = new Set(identityIds);
  const directSourceResidualCandidateIds = new Set(
    retrievalMode === "DIRECT" &&
    directSourceResidualBranchIndex &&
    identityIdSetForSourceResidual.size > 0
      ? registryValidatedResults
          .filter((result) => {
            if (!identityIdSetForSourceResidual.has(result.productId)) return false;
            if (result.semanticBranchIndex !== directSourceResidualBranchIndex) {
              return false;
            }
            const raw = result.vectorSimilarity ?? result.score;
            const primary = result.primaryVectorSimilarity;
            return (
              Number.isFinite(raw) &&
              Number.isFinite(primary) &&
              (result.semanticBranchRelativeScore ?? 0) >= 0.82 &&
              raw >= 0.35 &&
              raw - (primary ?? raw) >= 0.07
            );
          })
          .map((result) => result.productId)
      : [],
  );
  const directSourceResidualSemanticEvidence = Boolean(
    retrievalMode === "DIRECT" &&
    directSourceResidualBranchIndex &&
    identityIdSetForSourceResidual.size > 0 &&
    registryValidatedResults.some((result) => {
      if (!identityIdSetForSourceResidual.has(result.productId)) return false;
      if (result.semanticBranchIndex !== directSourceResidualBranchIndex) {
        return false;
      }
      const raw = result.vectorSimilarity ?? result.score;
      const primary = result.primaryVectorSimilarity;
      return (
        Number.isFinite(raw) &&
        Number.isFinite(primary) &&
        (result.semanticBranchRelativeScore ?? 0) >= 0.9 &&
        raw >= 0.38 &&
        raw - (primary ?? raw) >= 0.10
      );
    }),
  );
  const discoverySourceGroundedIds =
    retrievalMode === "DISCOVERY"
      ? (effectiveRewrite?.context?.discoverySourceGroundedProductIds ?? [])
      : [];
  const discoveryExpansionGroundedIds =
    retrievalMode === "DISCOVERY"
      ? (effectiveRewrite?.context?.discoveryExpansionGroundedProductIds ?? [])
      : [];
  const strongContextKinds = new Set([
    "CATEGORY",
    "CANONICAL_PRODUCT_TYPE",
    "PRODUCT_TYPE",
    "ALIAS",
    "USE_CASE",
    "SOFT_CONTEXT",
    "ATTRIBUTE",
    "AUDIENCE",
    "COMPATIBILITY",
  ]);
  const selectedStrongCatalogTerms =
    effectiveRewrite?.context?.selectedTerms.filter(
      (term) =>
        strongContextKinds.has(term.kind) &&
        term.score >= 12 &&
        !isGenericCatalogEvidenceValue(term.value) &&
        !(
          retrievalMode === "DISCOVERY" &&
          ["PRODUCT_TYPE", "ALIAS"].includes(term.kind)
        ),
    ) ?? [];
  const selectedStrongCatalogEvidence = selectedStrongCatalogTerms.length > 0;
  const sourceExactTaxonomyEvidence = Boolean(
    effectiveRewrite?.context?.selectedTerms.some((term) =>
      ["CATEGORY", "CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE"].includes(term.kind) &&
      term.score >= 25 &&
      normalizeEmbeddingBranch(term.value) === normalizeEmbeddingBranch(cleanQuery),
    ),
  );
  const negativeEvidenceTerms = [
    ...(effectiveRewrite?.analysis.negativeTerms ?? []),
    ...(effectiveRewrite?.analysis.negativeAttributes ?? []),
    ...(effectiveRewrite?.analysis.semanticMustNotTerms ?? []),
  ]
    .map(normalizeEmbeddingBranch)
    .filter(Boolean);
  const semanticMustTermsForCatalogEvidence =
    (effectiveRewrite?.analysis.semanticMustTerms ?? []).filter((value) => {
      const normalized = normalizeEmbeddingBranch(value);
      if (
        /\b(?:price|priced|cheap|cheapest|affordable|budget|expensive|priciest|premium|luxury|luxurious|low cost|high end|most expensive)\b/i.test(
          normalized,
        )
      ) {
        return false;
      }
      // Negative intent belongs to exclusion filtering, not positive catalog
      // evidence. "jacket without hood" should prove "jacket" exists and let
      // the negative facet remove hooded products afterwards.
      return !negativeEvidenceTerms.some((negative) =>
        (` ${normalized} `).includes(` ${negative} `),
      );
    });
  const directSemanticMustCoverage =
    retrievalMode !== "DIRECT" ||
    catalogEvidenceCoversSemanticMustTerms(
      semanticMustTermsForCatalogEvidence,
      selectedStrongCatalogTerms.map((term) => term.value),
    );
  const semanticNeedValues = [
    ...(effectiveRewrite?.analysis.semanticMustTerms ?? []),
    ...(effectiveRewrite?.analysis.semanticSourceMustTerms ?? []),
  ]
    .map(normalizeEmbeddingBranch)
    .filter(Boolean);
  const translatedTaxonomyEvidence = Boolean(
    retrievalMode === "DISCOVERY" &&
    effectiveRewrite?.context?.selectedTerms.some((term) => {
      if (
        !["CATEGORY", "CANONICAL_PRODUCT_TYPE"].includes(term.kind) ||
        term.score < 25 ||
        isGenericCatalogEvidenceValue(term.value)
      ) {
        return false;
      }
      return semanticNeedValues.some((need) =>
        catalogEvidenceNeedMatches(need, term.value),
      );
    }),
  );
  const complementExpansionEvidence = Boolean(
    retrievalMode === "COMPLEMENT" &&
    effectiveRewrite?.context?.selectedTerms.some(
      (term) =>
        term.score >= 25 &&
        !isGenericCatalogEvidenceValue(term.value) &&
        (effectiveRewrite.analysis.semanticExpansions ?? []).some((expansion) =>
          catalogEvidenceNeedMatches(expansion, term.value),
        ),
    ),
  );
  const singleTokenSourceIdentityGrounded = Boolean(
    retrievalMode === "DISCOVERY" &&
    effectiveRewrite?.context?.selectedTerms &&
    singleTokenSourceIdentityEvidence({
      sourceQuery: effectiveRewrite.query,
      sourceMustTerms: effectiveRewrite.analysis.semanticSourceMustTerms ?? [],
      catalogTerms: effectiveRewrite.context.selectedTerms,
    }),
  );
  // DISCOVERY evidence has provenance: source-overlap is strongest; an exact
  // typed taxonomy match may also ground a translated cross-language need
  // (e.g. Vietnamese "kính mắt" -> CATEGORY=Eyewear). Expansion-only hits do
  // not prove the shopper's need exists in the catalog.
  //
  // A transient LLM failure must not erase deterministic evidence that code
  // already owns. DIRECT relational tails ("bag for daily office use") are
  // open-world context inside an already grounded product family; negative-only
  // queries ("jacket without hood") also do not require LLM semantic proof.
  // By contrast, an unresolved qualifier before the identity ("smart watch")
  // still needs evidence and therefore remains guarded.
  const normalizedSourceQuery = normalizeEmbeddingBranch(query);
  const directFallbackOpenContext = Boolean(
    transientLlmFallback &&
    retrievalMode === "DIRECT" &&
    identityIds.length > 0 &&
    /\b(?:for|during|when|while|using)\b/.test(normalizedSourceQuery) &&
    semanticMustTermsForCatalogEvidence.length > 0,
  );
  const directFallbackNegativeOnly = Boolean(
    transientLlmFallback &&
    retrievalMode === "DIRECT" &&
    identityIds.length > 0 &&
    semanticMustTermsForCatalogEvidence.length === 0 &&
    (effectiveRewrite?.analysis.negativeTerms?.length ?? 0) > 0,
  );
  const discoveryFallbackSourceGrounded = Boolean(
    transientLlmFallback &&
    retrievalMode === "DISCOVERY" &&
    discoverySourceGroundedIds.length > 0,
  );
  const fallbackNeedsSemanticGuard =
    transientLlmFallback &&
    ["LIGHT_LLM", "FULL_LLM"].includes(effectiveRewrite?.planning?.route ?? "") &&
    (effectiveRewrite?.planning?.unresolvedSegments?.length ?? 0) > 0 &&
    !directFallbackOpenContext &&
    !directFallbackNegativeOnly &&
    !discoveryFallbackSourceGrounded;
  const exactComplementTargetEvidence =
    retrievalMode === "COMPLEMENT" &&
    identityIds.length > 0 &&
    (effectiveRewrite?.analysis.productTypes?.length ?? 0) > 0;
  const hasStrongCatalogEvidence =
    retrievalMode === "DISCOVERY"
      ? !fallbackNeedsSemanticGuard &&
        (
          discoverySourceGroundedIds.length > 0 ||
          translatedTaxonomyEvidence ||
          singleTokenSourceIdentityGrounded
        )
      : exactComplementTargetEvidence ||
        directFallbackOpenContext ||
        directFallbackNegativeOnly ||
        (
          !fallbackNeedsSemanticGuard &&
          ((selectedStrongCatalogEvidence && directSemanticMustCoverage) ||
            sourceExactTaxonomyEvidence ||
            complementExpansionEvidence)
        ) ||
        directExpansionGroundedIds.length > 0 ||
        directSourceFacetGroundedIds.length > 0 ||
        directSourceResidualSemanticEvidence;
  const discoveryMinRecallResults = readDiscoveryMinRecallResults();
  const effectiveMinimumScore = computeDiscoveryRecallThreshold({
    retrievalMode,
    baseThreshold: baseMinimumScore,
    retrievalMinimumScore,
    candidateScores: registryValidatedResults.map(
      (result) => result.vectorSimilarity ?? result.score,
    ),
    hasStrongCatalogEvidence,
    minRecallResults: discoveryMinRecallResults,
  });
  const configuredTransientNoEvidenceTopScore = Number.parseFloat(
    process.env.AI_SEARCH_TRANSIENT_FALLBACK_NO_EVIDENCE_MIN_TOP_SCORE || "0.30",
  );
  const transientNoEvidenceTopScore =
    Number.isFinite(configuredTransientNoEvidenceTopScore) &&
    configuredTransientNoEvidenceTopScore >= 0 &&
    configuredTransientNoEvidenceTopScore <= 1
      ? configuredTransientNoEvidenceTopScore
      : 0.30;
  const configuredNoEvidenceTopScore = Number.parseFloat(
    process.env.AI_SEARCH_NO_EVIDENCE_MIN_TOP_SCORE || "0.50",
  );
  const noEvidenceTopScore =
    Number.isFinite(configuredNoEvidenceTopScore) &&
    configuredNoEvidenceTopScore >= 0 && configuredNoEvidenceTopScore <= 1
      ? configuredNoEvidenceTopScore
      : 0.50;

  const transientNoEvidenceThreshold =
    retrievalMode === "COMPLEMENT"
      ? noEvidenceTopScore
      : transientNoEvidenceTopScore;
  let effectiveNoEvidenceTopScore = computeDiscoveryNoEvidenceThreshold({
    retrievalMode,
    baseThreshold: noEvidenceTopScore,
    hasStrongCatalogEvidence,
    expansionGroundedCount: discoveryExpansionGroundedIds.length,
  });
  const broadDiscoveryIdentityEvidence =
    retrievalMode === "DISCOVERY" &&
    !hasStrongCatalogEvidence &&
    identityIds.length > 0;
  if (broadDiscoveryIdentityEvidence) {
    // A source-resolved broad catalog family (e.g. Clothing/Footwear) is not
    // strong enough to bypass semantic quality checks, but it is materially
    // better than pure open-world vector guessing. Use the normal no-evidence
    // floor rather than the stricter 0.55 unknown-catalog floor.
    effectiveNoEvidenceTopScore = Math.min(
      effectiveNoEvidenceTopScore,
      noEvidenceTopScore,
    );
  }
  const fallbackGuardThreshold =
    fallbackNeedsSemanticGuard &&
    retrievalMode === "DIRECT" &&
    cleanQuery.split(/\s+/).filter(Boolean).length >= 7
      ? Math.min(effectiveNoEvidenceTopScore, 0.55)
      : effectiveNoEvidenceTopScore;
  // Context grounding may report that a shopper-owned product class is not
  // currently grounded, but that signal is open-world uncertainty rather than
  // a closed-world absence proof. Do not let it independently zero the result
  // set. Certain absence is owned by absence-proof.server; semantic quality
  // still has to pass the normal vector evidence guard below.
  const weakNoEvidenceVector =
    effectiveRewrite?.context?.ungroundedExplicitFeature === true ||
    shouldRejectNoEvidenceVector({
      hasStrongCatalogEvidence,
      topVectorScore,
      normalThreshold: effectiveNoEvidenceTopScore,
      transientFallback: transientLlmFallback,
      transientThreshold: fallbackNeedsSemanticGuard
        ? fallbackGuardThreshold
        : transientNoEvidenceThreshold,
    });
  const expansionOnlyRescue =
    retrievalMode === "DISCOVERY" &&
    !hasStrongCatalogEvidence &&
    discoveryExpansionGroundedIds.length > 0 &&
    typeof topVectorScore === "number" &&
    Number.isFinite(topVectorScore) &&
    topVectorScore >= effectiveNoEvidenceTopScore &&
    topVectorScore < noEvidenceTopScore;
  const expansionOnlyIds = expansionOnlyRescue
    ? new Set(discoveryExpansionGroundedIds)
    : null;

  const discoveryBranchRelativeRatio =
    readDiscoveryBranchRelativeRatio();
  const discoveryBranchMinimumScore = Math.max(
    retrievalMinimumScore,
    readDiscoveryBranchMinimumScore(),
  );
  let relevantResults =
    weakNoEvidenceVector
      ? []
      : registryValidatedResults.filter((result) => {
          const rawSimilarity = result.vectorSimilarity ?? result.score;
          const branchRecallEligible =
            retrievalMode === "DISCOVERY" &&
            semanticBranchVectors.length > 0 &&
            (result.semanticBranchRelativeScore ?? 0) >=
              discoveryBranchRelativeRatio &&
            rawSimilarity >= discoveryBranchMinimumScore;
          return (
            Number.isFinite(rawSimilarity) &&
            (
              rawSimilarity >= effectiveMinimumScore ||
              branchRecallEligible
            ) &&
            (!expansionOnlyIds || expansionOnlyIds.has(result.productId))
          );
        });

  if (directSourceResidualSemanticEvidence) {
    const explicitFacetIds = new Set(directSourceFacetGroundedIds);
    relevantResults = relevantResults.filter(
      (result) =>
        directSourceResidualCandidateIds.has(result.productId) ||
        explicitFacetIds.has(result.productId),
    );
  }

  thresholdFilterCodeMs =
    Date.now() -
    thresholdStartedAt;

  console.log(
    "[AI Search] Qdrant results:",
    {
      minimumScore:
        retrievalMinimumScore,

      configuredMinimumScore:
        minimumScore,

      effectiveMinimumScore:
        Number(
          effectiveMinimumScore.toFixed(
            4,
          ),
        ),

      relativeRatio,

      qdrantCandidateCount:
        results.length,

      candidateCount:
        registryValidatedResults.length,

      filteredOrphanCount:
        results.length -
        registryValidatedResults.length,

      relevantCount:
        relevantResults.length,

      weakNoEvidenceVector,
      noEvidenceTopScore,
      topVectorScore,
      hasStrongCatalogEvidence,

      resultsPreview:
        relevantResults
          .slice(
            0,
            10,
          )
          .map(
            (
              result,
            ) => ({
              handle:
                result.handle,

              score:
                result.score,

              vectorSimilarity:
                result.vectorSimilarity,

              primaryVectorSimilarity:
                result.primaryVectorSimilarity,
            }),
          ),
    },
  );

  const rawTopScore =
    registryValidatedResults[
      0
    ]?.score;

  // ============================================================
  // 5. MAP FINAL SEARCH RESULTS
  // ============================================================

  const resultMappingStartedAt =
    Date.now();

  const mappedResults =
    relevantResults.map(
      (
        result,
      ) => ({
        productId:
          result.productId,

        handle:
          result.handle,

        title:
          result.title,

        score:
          result.score,

        vectorSimilarity:
          result.vectorSimilarity,

        primaryVectorSimilarity:
          result.primaryVectorSimilarity ??
          (semanticBranchVectors.length === 0
            ? result.vectorSimilarity
            : undefined),

        semanticBranchRelativeScore:
          result.semanticBranchRelativeScore,

        semanticBranchIndex:
          result.semanticBranchIndex,
        semanticBranchInput:
          typeof result.semanticBranchIndex === "number" && result.semanticBranchIndex > 0
            ? semanticBranchInputs[result.semanticBranchIndex - 1]
            : undefined,

        minVariantPrice:
          result.minVariantPrice,

        maxVariantPrice:
          result.maxVariantPrice,

        currencyCode:
          result.currencyCode,
      }),
    );

  resultMappingCodeMs =
    Date.now() -
    resultMappingStartedAt;

  const totalMs =
    Date.now() -
    stageStartedAt;

  const knownSerialMs =
    embeddingPreparationCodeMs +
    embeddingMs +
    collectionWaitMs +
    qdrantMs +
    thresholdFilterCodeMs +
    resultMappingCodeMs;

  const finalEmbeddingDetails =
    embeddingRequestDiagnostics as
      | EmbeddingRequestDiagnostics
      | null;

  onDiagnostics?.({
    primaryEmbeddingInput: primaryEmbeddingInputForDiagnostics.slice(0, 300),
    semanticFacetBranches: semanticBranchInputs.slice(0, 6).map((value) => value.slice(0, 300)),
    retrievalMode,
    contextProductClassUncertain:
      effectiveRewrite?.context?.ungroundedSourceProductClass === true,
    // Certain class absence is decided by absence-proof.server before fusion.
    // Keep this legacy diagnostic false so open-world context inference cannot
    // suppress sparse recall downstream.
    sourceProductClassAbsent: false,
    noEvidenceGuardTriggered: weakNoEvidenceVector,
    noEvidenceThreshold: transientLlmFallback
      ? transientNoEvidenceThreshold
      : effectiveNoEvidenceTopScore,
    topVectorScore: typeof topVectorScore === "number" ? topVectorScore : null,
    hasStrongCatalogEvidence,
    candidateCount:
      registryValidatedResults.length,

    topCandidateScore:
      typeof rawTopScore ===
        "number" &&
      Number.isFinite(
        rawTopScore,
      )
        ? rawTopScore
        : null,

    vectorThreshold:
      effectiveMinimumScore,

    embeddingCacheHit:
      Boolean(
        vectorOverride,
      ),

    llmStatus,

    llmFallbackReason,

    ensureCollectionMs:
      ensureMs,

    embeddingMs,

    embeddingCallCount,

    embeddingOpenAiProcessingMs:
      finalEmbeddingDetails
        ?.openAiProcessingMs ??
      null,

    embeddingNetworkAndSdkMs:
      finalEmbeddingDetails
        ?.networkAndSdkMs ??
      null,

    embeddingRequestId:
      finalEmbeddingDetails
        ?.requestId ??
      null,

    embeddingClientRequestId:
      finalEmbeddingDetails
        ?.clientRequestId ??
      null,

    embeddingMaxRetries:
      finalEmbeddingDetails
        ?.maxRetries ??
      0,

    qdrantMs,

    usageLoggingMs:
      usageMs,

    collectionWaitMs,

    embeddingPreparationCodeMs,

    qdrantRequestMs,

    qdrantResponseMappingCodeMs,

    qdrantPassCount,

    qdrantFinalCandidateWindow,

    thresholdFilterCodeMs,

    resultMappingCodeMs,

    otherCodeMs:
      Math.max(
        0,

        totalMs -
          knownSerialMs,
      ),

    totalMs,
  });

  return mappedResults;
}
