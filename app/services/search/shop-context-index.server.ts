import db from "../../db.server";
import type { ProductForIndex } from "../products/product-document.server";
import type { ProductSemanticAnalysis } from "../products/product-embedding-input.server";
import type { QueryRewriteResult } from "./query-rewriter.server";

type ContextKind =
  | "PRODUCT_TITLE"
  | "PRODUCT_TYPE"
  | "CANONICAL_PRODUCT_TYPE"
  | "VENDOR"
  | "TAG"
  | "VARIANT"
  | "SKU"
  | "ATTRIBUTE"
  | "USE_CASE"
  | "ALIAS"
  | "CATEGORY"
  | "BRAND"
  | "MODEL"
  | "IDENTIFIER"
  | "AUDIENCE"
  | "COMPATIBILITY";

type ContextTerm = {
  kind: string;
  value: string;
  normalizedValue: string;
  productCount: number;
  productIds: Set<string>;
  tokens: string[];
};

export type SelectedShopContext = {
  kind: string;
  value: string;
  score: number;
  productCount: number;
};

export type ExplicitGenderFilterDiagnostics = {
  requestedGender: "MALE" | "FEMALE" | null;
  dbReadMs: number;
  filterCodeMs: number;
  removedCount: number;
  totalMs: number;
  identityFilteredCount: number;
  colorFilteredCount: number;
  negativeFilteredCount: number;
  rerankedCount: number;
  genderFilteredCount: number;
  exactConstraintFilteredCount: number;
};

export type ContextualQueryResult = QueryRewriteResult & {
  context: {
    selectedTerms: SelectedShopContext[];
    loadMs: number;
    filterMs: number;
    totalMs: number;
    cacheStatus: "HIT" | "MISS";
    dbReadMs: number;
    aggregateCodeMs: number;
    signalBuildCodeMs: number;
    scoreCodeMs: number;
    sortSelectCodeMs: number;
    composeCodeMs: number;
    canonicalTypeCoverageComplete: boolean;
    identityCandidateProductIds: string[];
  };
};

const contextCache = new Map<string, { expiresAt: number; terms: ContextTerm[] }>();
const VI_STOP_WORDS = new Set([
  "a", "an", "and", "buy", "cho", "cua", "cùng", "do", "find", "for",
  "gia", "giá", "in", "la", "là", "loai", "mau", "màu", "mot", "một",
  "mua", "need", "of", "phù", "san", "sản", "the", "tim", "tìm", "to",
  "tu", "từ", "va", "và", "voi", "với", "want",
]);

function clean(value: string | null | undefined, max = 180) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function normalizeContextTerm(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string) {
  return normalizeContextTerm(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !VI_STOP_WORDS.has(token));
}

function collectProductContextTerms(
  product: ProductForIndex,
  analysis: ProductSemanticAnalysis | null,
) {
  const terms = new Map<string, { kind: ContextKind; value: string; normalizedValue: string }>();
  const add = (kind: ContextKind, raw: string | null | undefined) => {
    const value = clean(raw);
    const normalizedValue = normalizeContextTerm(value);
    if (!value || !normalizedValue) return;
    terms.set(`${kind}\u0000${normalizedValue}`, { kind, value, normalizedValue });
  };

  add("PRODUCT_TITLE", product.title);
  add("PRODUCT_TYPE", product.productType);
  add("VENDOR", product.vendor);
  for (const tag of product.tags ?? []) add("TAG", tag);
  for (const variant of product.variants ?? []) {
    if (variant.title !== "Default Title") add("VARIANT", variant.title);
    add("SKU", variant.sku);
  }

  if (analysis) {
    add("CANONICAL_PRODUCT_TYPE", analysis.canonicalProductType);
    add("CANONICAL_PRODUCT_TYPE", analysis.shopLanguageProductType);
    add("CATEGORY", analysis.category);
    for (const value of analysis.brandTerms) add("BRAND", value);
    for (const value of analysis.modelTerms) add("MODEL", value);
    for (const value of analysis.identifiers) add("IDENTIFIER", value);
    for (const value of analysis.audiences) add("AUDIENCE", value);
    for (const value of analysis.compatibility) add("COMPATIBILITY", value);
    for (const value of analysis.exactAttributes) add("ATTRIBUTE", value);
    for (const value of analysis.supportedUseCases) add("USE_CASE", value);
    for (const value of analysis.sourceLanguageTerms) add("ALIAS", value);
    for (const value of analysis.shopLanguageTerms) add("ALIAS", value);
  }

  return [...terms.values()].slice(0, 80);
}

/** Replace one product's precomputed semantic vocabulary after its vector is durable. */
export async function replaceProductShopContext({
  shop,
  product,
  analysis,
}: {
  shop: string;
  product: ProductForIndex;
  analysis: ProductSemanticAnalysis | null;
}) {
  const terms = collectProductContextTerms(product, analysis);

  await db.$transaction(async (tx) => {
    await tx.aiSearchShopContextTerm.deleteMany({
      where: { shop, productId: product.id },
    });
    if (terms.length > 0) {
      await tx.aiSearchShopContextTerm.createMany({
        data: terms.map((term) => ({
          shop,
          productId: product.id,
          ...term,
        })),
      });
    }
  });

  contextCache.delete(shop);
  return terms.length;
}

export async function ensureProductShopContext({
  shop,
  product,
}: {
  shop: string;
  product: ProductForIndex;
}) {
  const existing = await db.aiSearchShopContextTerm.count({
    where: { shop, productId: product.id },
  });
  if (existing > 0) return existing;
  return replaceProductShopContext({ shop, product, analysis: null });
}

async function loadShopContext(shop: string) {
  const startedAt = Date.now();
  const cached = contextCache.get(shop);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      terms: cached.terms,
      cacheStatus: "HIT" as const,
      dbReadMs: 0,
      aggregateCodeMs: 0,
      totalMs: Date.now() - startedAt,
    };
  }

  const dbStartedAt = Date.now();
  const rows = await db.aiSearchShopContextTerm.findMany({
    where: { shop },
    select: { productId: true, kind: true, value: true, normalizedValue: true },
    take: 50_000,
  });
  const dbReadMs = Date.now() - dbStartedAt;
  const aggregateStartedAt = Date.now();
  const aggregated = new Map<string, ContextTerm>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.normalizedValue}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.productCount += 1;
      existing.productIds.add(row.productId);
    }
    else {
      aggregated.set(key, {
        kind: row.kind,
        value: row.value,
        normalizedValue: row.normalizedValue,
        productCount: 1,
        productIds: new Set([row.productId]),
        tokens: meaningfulTokens(row.normalizedValue),
      });
    }
  }
  const terms = [...aggregated.values()];
  const aggregateCodeMs = Date.now() - aggregateStartedAt;
  contextCache.set(shop, { expiresAt: Date.now() + 60_000, terms });
  while (contextCache.size > 100) {
    const oldest = contextCache.keys().next().value as string | undefined;
    if (!oldest) break;
    contextCache.delete(oldest);
  }
  return {
    terms,
    cacheStatus: "MISS" as const,
    dbReadMs,
    aggregateCodeMs,
    totalMs: Date.now() - startedAt,
  };
}

const PRODUCT_IDENTITY_KINDS = new Set([
  "CANONICAL_PRODUCT_TYPE",
]);

function buildProductIdentitySignals(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  return [
    rewrite.analysis.productType,
    rewrite.analysis.shopLanguageProductType,
    ...rewrite.analysis.semanticExpansions,
    // If GPT is unavailable, retain the original query as a best-effort
    // identity signal instead of treating an unanalysed query as out of scope.
    ...(rewrite.analysis.productType.trim() ? [] : [originalQuery]),
  ]
    .map((value) => ({
      value,
      normalized: normalizeContextTerm(value),
      tokens: meaningfulTokens(value),
    }))
    .filter((signal) => signal.normalized && signal.tokens.length > 0);
}

function strongIdentityMatch(
  term: Pick<ContextTerm, "normalizedValue" | "tokens">,
  signal: { normalized: string; tokens: string[] },
) {
  if (term.normalizedValue === signal.normalized) return 1;

  const termTokenSet = new Set(term.tokens);
  const common = [...new Set(signal.tokens)].filter((token) => termTokenSet.has(token));
  if (common.length === 0) return 0;

  const signalCoverage = common.length / new Set(signal.tokens).size;
  const termCoverage = common.length / Math.max(1, new Set(term.tokens).size);
  if (signal.tokens.length === 1) return 1;
  if (common.length >= 2 && signalCoverage >= 0.5) {
    return Math.max(signalCoverage, termCoverage);
  }
  return 0;
}

function scoreTerm(
  term: ContextTerm,
  signals: Array<{
    normalized: string;
    tokens: string[];
    tokenSet: Set<string>;
    weight: number;
  }>,
) {
  let best = 0;
  const termTokens = term.tokens;
  if (termTokens.length === 0) return 0;

  for (const signal of signals) {
    const normalizedSignal = signal.normalized;
    if (!normalizedSignal) continue;
    const signalTokens = signal.tokens;
    const exact = normalizedSignal === term.normalizedValue;
    const contained =
      term.normalizedValue.length >= 4 &&
      normalizedSignal.length >= 4 &&
      (normalizedSignal.includes(term.normalizedValue) ||
        term.normalizedValue.includes(normalizedSignal));
    const common = termTokens.filter((token) => signal.tokenSet.has(token));
    const coverageTerm = common.length / termTokens.length;
    const coverageSignal = common.length / Math.max(1, signalTokens.length);
    let score = exact
      ? 30
      : contained
        ? 15
        : common.length > 0
          ? common.length * 2 + coverageTerm * 6 + coverageSignal * 5
          : 0;

    if (!exact && !contained && common.length < 2) score = 0;

    // Vendor/SKU/title are identifiers, not broad semantic categories. They
    // may enter context only on a strong mention, preventing random brands or
    // individual product names from contaminating a generic query embedding.
    if (
      ["VENDOR", "SKU", "TAG", "BRAND", "MODEL", "IDENTIFIER"].includes(term.kind) &&
      !exact && !contained
    ) score = 0;
    if (term.kind === "PRODUCT_TITLE" && !exact && !(contained && common.length >= 2)) score = 0;
    if (
      term.kind === "ALIAS" &&
      termTokens.length >= 4 &&
      !exact &&
      !normalizedSignal.includes(term.normalizedValue)
    ) {
      score = 0;
    }
    best = Math.max(best, score * signal.weight);
  }

  if (best <= 0) return 0;
  return best + Math.min(2, Math.log2(term.productCount + 1) * 0.35);
}

function composeContextualEmbeddingInput(
  originalQuery: string,
  rewrite: QueryRewriteResult,
  selectedTerms: SelectedShopContext[],
) {
  if (rewrite.planning) {
    const base = normalizeContextTerm(clean(rewrite.planning.semanticQuery, 500));
    const additions = selectedTerms
      .filter((term) => term.kind !== "PRODUCT_TITLE")
      .map((term) => normalizeContextTerm(clean(term.value, 220)))
      .filter((term) => term && !base.includes(term));
    return [base, ...new Set(additions)].filter(Boolean).join(" ; ");
  }
  const semanticAttributes = [
    ...rewrite.analysis.requiredAttributes,
    ...rewrite.analysis.optionalPreferences,
  ].filter(
    (value) => !/\d|\b(?:price|budget|cheap|expensive|gia|giá|re|rẻ|đắt|dat)\b/i.test(value),
  );
  const hasStructuredEntities =
    rewrite.analysis.brands.length + rewrite.analysis.models.length +
      rewrite.analysis.identifiers.length + rewrite.analysis.audience.length > 0;
  const sections = [
    `Shopper query: ${clean(originalQuery, 500)}`,
    rewrite.analysis.productType
      ? `Interpreted product type: ${rewrite.analysis.productType}`
      : null,
    rewrite.analysis.shopLanguageProductType
      ? `Product type in shop language: ${rewrite.analysis.shopLanguageProductType}`
      : null,
    rewrite.analysis.category
      ? `Product category: ${rewrite.analysis.category}`
      : null,
    rewrite.analysis.brands.length
      ? `Required brands: ${rewrite.analysis.brands.join(", ")}`
      : null,
    rewrite.analysis.models.length
      ? `Required models: ${rewrite.analysis.models.join(", ")}`
      : null,
    rewrite.analysis.identifiers.length
      ? `Exact identifiers: ${rewrite.analysis.identifiers.join(", ")}`
      : null,
    rewrite.analysis.compatibility.length
      ? `Must be compatible with: ${rewrite.analysis.compatibility.join(", ")}`
      : null,
    rewrite.analysis.audience.length
      ? `Intended audience: ${rewrite.analysis.audience.join(", ")}`
      : null,
    rewrite.analysis.useCases.length
      ? `Use cases: ${rewrite.analysis.useCases.join(", ")}`
      : null,
    rewrite.analysis.intent !== "unknown"
      ? `Shopping intent: ${rewrite.analysis.intent}`
      : null,
    !hasStructuredEntities && rewrite.analysis.entities.length
      ? `Preserved entities: ${rewrite.analysis.entities.join(", ")}`
      : null,
    semanticAttributes.length
      ? `Required product attributes: ${semanticAttributes.join(", ")}`
      : null,
    rewrite.analysis.semanticExpansions.length
      ? `Equivalent product meanings: ${rewrite.analysis.semanticExpansions.join(" | ")}`
      : null,
    rewrite.analysis.shopLanguageTerms.length
      ? `Shop-language forms (${rewrite.analysis.shopLanguage}): ${rewrite.analysis.shopLanguageTerms.join(" | ")}`
      : null,
    rewrite.analysis.negativeTerms.length
      ? `Explicit exclusions: ${rewrite.analysis.negativeTerms.join(", ")}`
      : null,
    selectedTerms.length
      ? `Relevant catalog vocabulary: ${selectedTerms.map((term) => `${term.kind}=${term.value}`).join(" | ")}`
      : null,
  ];
  return sections.filter((value): value is string => Boolean(value)).join("\n");
}

/**
 * Deterministically selects relevant terms from the sync-time ShopContextIndex.
 * No product/catalog data is sent back to GPT and selected terms are semantic
 * hints only; they are never converted directly into hard database filters.
 */
export async function applyShopContextToQuery({
  shop,
  originalQuery,
  rewrite,
}: {
  shop: string;
  originalQuery: string;
  rewrite: QueryRewriteResult;
}): Promise<ContextualQueryResult> {
  const totalStartedAt = Date.now();
  const loadStartedAt = Date.now();
  const loaded = await loadShopContext(shop);
  const terms = loaded.terms;
  const loadMs = Date.now() - loadStartedAt;
  const signalBuildStartedAt = Date.now();
  const filterStartedAt = Date.now();
  const identitySignals = buildProductIdentitySignals(originalQuery, rewrite);
  const hasAnalyzedProductType = Boolean(rewrite.analysis.productType.trim());
  const allContextProductIds = new Set(
    terms.flatMap((term) => [...term.productIds]),
  );
  const canonicalContextProductIds = new Set(
    terms
      .filter((term) => term.kind === "CANONICAL_PRODUCT_TYPE")
      .flatMap((term) => [...term.productIds]),
  );
  const canonicalTypeCoverageComplete =
    allContextProductIds.size > 0 &&
    canonicalContextProductIds.size === allContextProductIds.size;
  const matchingProductIds = new Set<string>();
  const matchingIdentityTerms = new Set<ContextTerm>();
  for (const term of terms) {
    if (!PRODUCT_IDENTITY_KINDS.has(term.kind)) continue;
    if (!identitySignals.some((signal) => strongIdentityMatch(term, signal) > 0)) {
      continue;
    }
    matchingIdentityTerms.add(term);
    for (const productId of term.productIds) matchingProductIds.add(productId);
  }
  const signals = [
    { text: originalQuery, weight: 1.2 },
    { text: rewrite.analysis.intent, weight: 1.25 },
    { text: rewrite.analysis.productType, weight: 1.5 },
    { text: rewrite.analysis.category, weight: 1.1 },
    ...rewrite.analysis.brands.map((text) => ({ text, weight: 1.8 })),
    ...rewrite.analysis.models.map((text) => ({ text, weight: 1.9 })),
    ...rewrite.analysis.identifiers.map((text) => ({ text, weight: 2 })),
    ...rewrite.analysis.audience.map((text) => ({ text, weight: 1.5 })),
    ...rewrite.analysis.requiredAttributes.map((text) => ({ text, weight: 1.5 })),
    ...rewrite.analysis.optionalPreferences.map((text) => ({ text, weight: 0.8 })),
    ...rewrite.analysis.useCases.map((text) => ({ text, weight: 1.25 })),
    ...rewrite.analysis.compatibility.map((text) => ({ text, weight: 1.8 })),
    ...rewrite.analysis.semanticExpansions.map((text) => ({ text, weight: 1 })),
    ...rewrite.analysis.shopLanguageTerms.map((text) => ({ text, weight: 1 })),
  ]
    .filter((signal) => signal.text.trim())
    .map((signal) => {
      const normalized = normalizeContextTerm(signal.text);
      const tokens = meaningfulTokens(normalized);
      return { ...signal, normalized, tokens, tokenSet: new Set(tokens) };
    });
  const negativeValues = rewrite.analysis.negativeTerms.map(normalizeContextTerm);
  const originalTokens = new Set(meaningfulTokens(originalQuery));
  const productTypeTokens = new Set(
    meaningfulTokens(rewrite.analysis.productType),
  );
  const hasMaleRequest = originalTokens.has("nam");
  const hasFemaleRequest = originalTokens.has("nu");
  const signalBuildCodeMs = Date.now() - signalBuildStartedAt;

  const scoreStartedAt = Date.now();
  const scoredTerms = terms
    .filter(
      (term) =>
        // Establish product identity before considering attributes. A catalog
        // adjective such as "long" or "premium" must never prove that the
        // requested product type exists in the shop.
        (!hasAnalyzedProductType || terms.length === 0 ||
          (matchingProductIds.size > 0 &&
            [...term.productIds].some((productId) => matchingProductIds.has(productId)))) &&
        (!PRODUCT_IDENTITY_KINDS.has(term.kind) ||
          !hasAnalyzedProductType || matchingIdentityTerms.has(term)) &&
        // A product title matching only a color/audience is not useful catalog
        // context. Require it to share the interpreted product identity, while
        // an exact full-title query remains eligible.
        !(
          term.kind === "PRODUCT_TITLE" &&
          normalizeContextTerm(originalQuery) !== term.normalizedValue &&
          !term.tokens.some((token) => productTypeTokens.has(token))
        ) &&
        !(
          (hasMaleRequest && term.tokens.includes("nu") &&
            !term.tokens.includes("nam")) ||
          (hasFemaleRequest && term.tokens.includes("nam") &&
            !term.tokens.includes("nu"))
        ) &&
        !negativeValues.some(
          (negative) =>
            negative &&
            (term.normalizedValue.includes(negative) ||
              negative.includes(term.normalizedValue)),
        ),
    )
    .map((term) => ({ ...term, score: scoreTerm(term, signals) }))
    .filter((term) => term.score >= 8);
  const scoreCodeMs = Date.now() - scoreStartedAt;
  const sortStartedAt = Date.now();
  const selectedTerms: SelectedShopContext[] = [];
  const seenValues = new Set<string>();
  const contextLimit = rewrite.analysis.complexity === "COMPLEX" ? 8 : 4;
  for (const term of scoredTerms.sort(
    (left, right) => right.score - left.score || right.productCount - left.productCount,
  )) {
    if (seenValues.has(term.normalizedValue)) continue;
    seenValues.add(term.normalizedValue);
    selectedTerms.push({
      kind: term.kind,
      value: term.value,
      score: Number(term.score.toFixed(3)),
      productCount: term.productCount,
    });
    if (selectedTerms.length >= contextLimit) break;
  }
  const sortSelectCodeMs = Date.now() - sortStartedAt;
  const filterMs = Date.now() - filterStartedAt;
  const composeStartedAt = Date.now();
  const query = composeContextualEmbeddingInput(originalQuery, rewrite, selectedTerms);
  const catalogRelevant =
    rewrite.catalogRelevant &&
    (terms.length === 0 || !hasAnalyzedProductType ||
      !canonicalTypeCoverageComplete || matchingProductIds.size > 0);
  const composeCodeMs = Date.now() - composeStartedAt;
  const totalMs = Date.now() - totalStartedAt;

  console.log("[AI Search] Shop context selected by code", {
    shop,
    availableTerms: terms.length,
    identitySignals: identitySignals.map((signal) => signal.value),
    matchedIdentityProducts: matchingProductIds.size,
    canonicalTypeProducts: canonicalContextProductIds.size,
    contextProducts: allContextProductIds.size,
    canonicalTypeCoverageComplete,
    selectedTerms,
    contextLimit,
    catalogRelevant,
    loadMs,
    filterMs,
    timing: {
      totalMs,
      cacheStatus: loaded.cacheStatus,
      dbReadMs: loaded.dbReadMs,
      aggregateCodeMs: loaded.aggregateCodeMs,
      signalBuildCodeMs,
      scoreCodeMs,
      sortSelectCodeMs,
      composeCodeMs,
    },
  });

  return {
    ...rewrite,
    query,
    catalogRelevant,
    rewritten: rewrite.rewritten || query !== originalQuery.trim(),
    analysis: {
      ...rewrite.analysis,
      matchedCatalogTerms: selectedTerms.map((term) => term.value),
      decisionReason:
        terms.length === 0
          ? "Shop context is not built yet; vector retrieval remains enabled."
          : !canonicalTypeCoverageComplete
            ? "Canonical product-type context is rebuilding; hard catalog rejection is deferred."
          : hasAnalyzedProductType && matchingProductIds.size === 0
            ? "The analyzed product type is not present in the sync-time shop context."
          : selectedTerms.length > 0
            ? "Code matched the analyzed query against the sync-time shop context."
            : "Code found no matching term in the sync-time shop context.",
    },
    context: {
      selectedTerms,
      loadMs,
      filterMs,
      totalMs,
      cacheStatus: loaded.cacheStatus,
      dbReadMs: loaded.dbReadMs,
      aggregateCodeMs: loaded.aggregateCodeMs,
      signalBuildCodeMs,
      scoreCodeMs,
      sortSelectCodeMs,
      composeCodeMs,
      canonicalTypeCoverageComplete,
      identityCandidateProductIds: [...matchingProductIds],
    },
  };
}

function detectExplicitGender(
  originalQuery: string,
  rewrite: QueryRewriteResult,
): "MALE" | "FEMALE" | null {
  const negative = readGenderFlags(rewrite.analysis.negativeTerms.join(" "));
  const positive = readGenderFlags(
    [
      originalQuery,
      rewrite.analysis.productType,
      ...rewrite.analysis.entities,
      ...rewrite.analysis.attributes,
      ...rewrite.analysis.shopLanguageTerms,
    ].join(" "),
  );
  const male = (positive.male && !negative.male) || negative.female;
  const female = (positive.female && !negative.female) || negative.male;
  return male === female ? null : male ? "MALE" : "FEMALE";
}

function readGenderFlags(value: string) {
  const normalized = normalizeContextTerm(value);
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  return {
    male:
      tokens.has("nam") || tokens.has("male") || tokens.has("man") ||
      tokens.has("men") || normalized.includes("男"),
    female:
      tokens.has("nu") || tokens.has("female") || tokens.has("woman") ||
      tokens.has("women") || normalized.includes("女"),
  };
}

const COLOR_PATTERNS: Array<[string, RegExp]> = [
  ["red", /\b(?:do|red)\b|红/u],
  ["yellow", /\b(?:vang|yellow)\b|黄/u],
  ["blue", /\b(?:xanh(?! la)|xanh duong|blue|navy)\b|蓝/u],
  ["green", /\b(?:xanh la|green)\b|绿/u],
  ["black", /\b(?:den|black)\b|黑/u],
  ["white", /\b(?:trang|white)\b|白/u],
  ["pink", /\b(?:hong|pink)\b|粉/u],
  ["purple", /\b(?:tim|purple)\b|紫/u],
  ["brown", /\b(?:nau|brown)\b|棕/u],
  ["gray", /\b(?:xam|gray|grey)\b|灰/u],
  ["beige", /\b(?:mau be|beige)\b/],
  ["orange", /\b(?:cam|orange)\b|橙/u],
];

function readColors(value: string) {
  const normalized = normalizeContextTerm(value);
  return new Set(
    COLOR_PATTERNS
      .filter(([, pattern]) => pattern.test(normalized))
      .map(([color]) => color),
  );
}

function isCommerceOnlyValue(value: string) {
  const normalized = normalizeContextTerm(value);
  return /\d|\b(?:gia|re|dat|price|budget|cheap|expensive|premium|luxury)\b/.test(
    normalized,
  );
}

function matchSemanticSignal(
  normalizedValues: string[],
  productTokens: Set<string>,
  rawSignal: string,
) {
  const signal = normalizeContextTerm(rawSignal);
  const tokens = meaningfulTokens(signal);
  if (!signal || tokens.length === 0) return 0;
  if (
    normalizedValues.some(
      (value) =>
        value === signal ||
        (value.length >= 4 && signal.length >= 4 &&
          (value.includes(signal) || signal.includes(value))),
    )
  ) return 1;
  const common = tokens.filter((token) => productTokens.has(token)).length;
  return common / tokens.length;
}

function bestSignalMatch(
  values: string[],
  tokens: Set<string>,
  signals: string[],
) {
  return Math.max(
    0,
    ...signals.map((signal) => matchSemanticSignal(values, tokens, signal)),
  );
}

/**
 * Generic commerce reranker over sync-time facts. Vector similarity supplies
 * recall; this pass enforces only constraints for which the catalog has strong
 * evidence (identity, brand/model/code, compatibility, audience, numeric spec,
 * color, gender and exclusions). Missing metadata never becomes an automatic
 * rejection unless another candidate proves the requested value is indexed.
 */
export async function filterResultsByExplicitGender<
  T extends { productId: string; score: number },
>({
  shop,
  originalQuery,
  rewrite,
  results,
  onDiagnostics,
}: {
  shop: string;
  originalQuery: string;
  rewrite: QueryRewriteResult;
  results: T[];
  onDiagnostics?: (diagnostics: ExplicitGenderFilterDiagnostics) => void;
}): Promise<T[]> {
  const totalStartedAt = Date.now();
  const requestedGender = detectExplicitGender(originalQuery, rewrite);
  if (!requestedGender || results.length === 0) {
    if (results.length === 0) {
      onDiagnostics?.({
        requestedGender,
        dbReadMs: 0,
        filterCodeMs: 0,
        removedCount: 0,
        totalMs: Date.now() - totalStartedAt,
        identityFilteredCount: 0,
        colorFilteredCount: 0,
        negativeFilteredCount: 0,
        rerankedCount: 0,
        genderFilteredCount: 0,
        exactConstraintFilteredCount: 0,
      });
      return results;
    }
  }

  const dbStartedAt = Date.now();
  const rows = await db.aiSearchShopContextTerm.findMany({
    where: {
      shop,
      productId: { in: results.map((result) => result.productId) },
      kind: {
        in: [
          "PRODUCT_TITLE", "PRODUCT_TYPE", "VENDOR", "TAG", "VARIANT",
          "SKU", "ATTRIBUTE", "USE_CASE", "ALIAS", "CATEGORY", "BRAND",
          "MODEL", "IDENTIFIER", "AUDIENCE", "COMPATIBILITY",
          "CANONICAL_PRODUCT_TYPE",
        ],
      },
    },
    select: { productId: true, kind: true, normalizedValue: true },
  });
  const dbReadMs = Date.now() - dbStartedAt;
  const filterStartedAt = Date.now();
  const genders = new Map<string, { male: boolean; female: boolean }>();
  const valuesByProduct = new Map<string, string[]>();
  const tokensByProduct = new Map<string, Set<string>>();
  const valuesByProductAndKind = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const state = genders.get(row.productId) ?? { male: false, female: false };
    const flags = readGenderFlags(row.normalizedValue);
    if (flags.male) state.male = true;
    if (flags.female) state.female = true;
    genders.set(row.productId, state);
    const values = valuesByProduct.get(row.productId) ?? [];
    values.push(row.normalizedValue);
    valuesByProduct.set(row.productId, values);
    const tokens = tokensByProduct.get(row.productId) ?? new Set<string>();
    for (const token of meaningfulTokens(row.normalizedValue)) tokens.add(token);
    tokensByProduct.set(row.productId, tokens);
    const byKind = valuesByProductAndKind.get(row.productId) ?? new Map();
    const kindValues = byKind.get(row.kind) ?? [];
    kindValues.push(row.normalizedValue);
    byKind.set(row.kind, kindValues);
    valuesByProductAndKind.set(row.productId, byKind);
  }

  const identitySignals = buildProductIdentitySignals(originalQuery, rewrite)
    .filter((signal) => !isCommerceOnlyValue(signal.value));
  const negativeSignals = rewrite.analysis.negativeTerms
    .map(normalizeContextTerm)
    .filter(Boolean);
  const excludedColors = readColors(rewrite.analysis.negativeTerms.join(" "));
  const structuredColorSource = [
    ...rewrite.analysis.requiredAttributes,
    ...rewrite.analysis.optionalPreferences,
  ].join(" ");
  const structuredColors = readColors(structuredColorSource);
  const requestedColors = new Set(
    [...(structuredColors.size > 0 ? structuredColors : readColors(originalQuery))]
      .filter((color) => !excludedColors.has(color)),
  );
  const attributeSignals = [
    ...rewrite.analysis.requiredAttributes,
    ...rewrite.analysis.optionalPreferences,
    ...rewrite.analysis.useCases,
  ].filter((value) => !isCommerceOnlyValue(value) && readColors(value).size === 0);
  const brandSignals = rewrite.analysis.brands;
  const modelSignals = rewrite.analysis.models;
  const identifierSignals = rewrite.analysis.identifiers;
  const compatibilitySignals = rewrite.analysis.compatibility;
  const audienceSignals = rewrite.analysis.audience;
  const numericRequiredSignals = rewrite.analysis.requiredAttributes.filter(
    (value) => /\d/.test(value),
  );

  const scored = results.map((result) => {
    const values = valuesByProduct.get(result.productId) ?? [];
    const tokens = tokensByProduct.get(result.productId) ?? new Set<string>();
    const byKind = valuesByProductAndKind.get(result.productId) ?? new Map();
    const valuesForKinds = (kinds: string[]) =>
      kinds.flatMap((kind) => byKind.get(kind) ?? []);
    const tokensForValues = (selectedValues: string[]) =>
      new Set(selectedValues.flatMap((value) => meaningfulTokens(value)));
    const identityValues = valuesForKinds(["CANONICAL_PRODUCT_TYPE"]);
    const identityMatch = Math.max(
      0,
      ...identitySignals.map((signal) =>
        Math.max(
          0,
          ...identityValues.map((value) =>
            strongIdentityMatch(
              { normalizedValue: value, tokens: meaningfulTokens(value) },
              signal,
            ),
          ),
        ),
      ),
    );
    const attributeMatch = Math.max(
      0,
      ...attributeSignals.map((signal) => matchSemanticSignal(values, tokens, signal)),
    );
    const brandValues = valuesForKinds(["BRAND", "VENDOR", "PRODUCT_TITLE", "ALIAS"]);
    const brandMatch = bestSignalMatch(
      brandValues,
      tokensForValues(brandValues),
      brandSignals,
    );
    const modelValues = valuesForKinds(["MODEL", "VARIANT", "PRODUCT_TITLE", "ALIAS"]);
    const modelMatch = bestSignalMatch(
      modelValues,
      tokensForValues(modelValues),
      modelSignals,
    );
    const identifierValues = valuesForKinds(["IDENTIFIER", "SKU", "VARIANT", "PRODUCT_TITLE"]);
    const identifierMatch = bestSignalMatch(
      identifierValues,
      tokensForValues(identifierValues),
      identifierSignals,
    );
    const compatibilityValues = valuesForKinds(["COMPATIBILITY", "ATTRIBUTE", "PRODUCT_TITLE", "ALIAS"]);
    const compatibilityMatch = bestSignalMatch(
      compatibilityValues,
      tokensForValues(compatibilityValues),
      compatibilitySignals,
    );
    const audienceValues = valuesForKinds(["AUDIENCE", "ATTRIBUTE", "TAG", "PRODUCT_TITLE"]);
    const audienceMatch = bestSignalMatch(
      audienceValues,
      tokensForValues(audienceValues),
      audienceSignals,
    );
    const numericRequiredMatch = bestSignalMatch(
      values,
      tokens,
      numericRequiredSignals,
    );
    const productColors = readColors(values.join(" "));
    const colorMatch = requestedColors.size === 0
      ? true
      : [...requestedColors].some((color) => productColors.has(color));
    const excluded = negativeSignals.some((negative) =>
      values.some((value) => value.includes(negative)),
    );
    return {
      result,
      identityMatch,
      attributeMatch,
      colorMatch,
      hasKnownColor: productColors.size > 0,
      excluded,
      brandMatch,
      modelMatch,
      identifierMatch,
      compatibilityMatch,
      audienceMatch,
      numericRequiredMatch,
    };
  });
  const hasIdentityMatch = scored.some((item) => item.identityMatch >= 0.5);
  const hasRequestedColorMatch =
    requestedColors.size > 0 && scored.some((item) => item.colorMatch);
  const hardGroups = [
    { active: brandSignals.length > 0, key: "brandMatch" as const },
    { active: modelSignals.length > 0, key: "modelMatch" as const },
    { active: identifierSignals.length > 0, key: "identifierMatch" as const },
    { active: compatibilitySignals.length > 0, key: "compatibilityMatch" as const },
    { active: audienceSignals.length > 0, key: "audienceMatch" as const },
    { active: numericRequiredSignals.length > 0, key: "numericRequiredMatch" as const },
  ].filter(
    (group) => group.active && scored.some((item) => item[group.key] >= 0.75),
  );
  let identityFilteredCount = 0;
  let colorFilteredCount = 0;
  let negativeFilteredCount = 0;
  let genderFilteredCount = 0;
  let exactConstraintFilteredCount = 0;
  const filtered = scored.flatMap((item) => {
    const { result } = item;
    const gender = genders.get(result.productId);
    const genderMismatch = Boolean(
      requestedGender && gender && gender.male !== gender.female &&
      (requestedGender === "MALE" ? gender.female : gender.male),
    );
    if (genderMismatch) {
      genderFilteredCount += 1;
      return [];
    }
    const canonicalCoverageComplete = rewrite.context?.canonicalTypeCoverageComplete === true;
    if (canonicalCoverageComplete && hasIdentityMatch && item.identityMatch < 0.34) {
      identityFilteredCount += 1;
      return [];
    }
    if (
      requestedColors.size > 0 &&
      !item.colorMatch &&
      (item.hasKnownColor || hasRequestedColorMatch)
    ) {
      colorFilteredCount += 1;
      return [];
    }
    if (item.excluded) {
      negativeFilteredCount += 1;
      return [];
    }
    if (hardGroups.some((group) => item[group.key] < 0.5)) {
      exactConstraintFilteredCount += 1;
      return [];
    }

    const lexicalBonus =
      Math.min(canonicalCoverageComplete ? 0.24 : 0.14, item.identityMatch * (canonicalCoverageComplete ? 0.22 : 0.12)) +
      Math.min(0.03, item.attributeMatch * 0.03) +
      Math.min(
        0.08,
        (item.brandMatch + item.modelMatch + item.identifierMatch +
          item.compatibilityMatch + item.audienceMatch +
          item.numericRequiredMatch) * 0.02,
      ) +
      (requestedColors.size > 0 && item.colorMatch ? 0.04 : 0);
    return [{ ...result, score: Math.min(1, result.score + lexicalBonus) }];
  });
  filtered.sort((left, right) => right.score - left.score);
  const filterCodeMs = Date.now() - filterStartedAt;
  onDiagnostics?.({
    requestedGender,
    dbReadMs,
    filterCodeMs,
    removedCount: results.length - filtered.length,
    totalMs: Date.now() - totalStartedAt,
    identityFilteredCount,
    colorFilteredCount,
    negativeFilteredCount,
    rerankedCount: filtered.length,
    genderFilteredCount,
    exactConstraintFilteredCount,
  });
  return filtered;
}
