import db from "../../db.server";
import type { ProductForIndex } from "../products/product-document.server";
import type { ProductSemanticAnalysis } from "../products/product-embedding-input.server";
import type { QueryRewriteResult } from "./query-rewriter.server";
import { parseDeterministicQuery } from "./deterministic-query-parser.server";
import { invalidateShopSearchDictionary } from "./shop-search-dictionary.server";

type ContextKind =
  | "PRODUCT_TITLE"
  | "PRODUCT_TYPE"
  | "CANONICAL_PRODUCT_TYPE"
  | "VENDOR"
  | "TAG"
  | "VARIANT"
  | "SKU"
  | "BARCODE"
  | "ATTRIBUTE"
  | "MEASUREMENT"
  | "VARIANT_OPTION"
  | "USE_CASE"
  | "SOFT_CONTEXT"
  | "ALIAS"
  | "CATEGORY"
  | "BRAND"
  | "MODEL"
  | "IDENTIFIER"
  | "AUDIENCE"
  | "INFERRED_AUDIENCE"
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
  strictFacets?: string[];
  preferredFacets?: string[];
  typedFacetMatchCount?: number;
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
    discoverySourceGroundedProductIds: string[];
    discoveryExpansionGroundedProductIds: string[];
  };
};

type LoadedShopContext = {
  terms: ContextTerm[];
  cacheStatus: "HIT" | "MISS";
  dbReadMs: number;
  aggregateCodeMs: number;
  totalMs: number;
};

const contextCache = new Map<string, { expiresAt: number; terms: ContextTerm[] }>();
const pendingContextLoads = new Map<string, Promise<LoadedShopContext>>();
const SHOP_CONTEXT_CACHE_TTL_MS = (() => {
  const value = Number.parseInt(
    process.env.AI_SEARCH_SHOP_CONTEXT_CACHE_TTL_MS || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 30_000
    ? Math.min(value, 60 * 60_000)
    : 5 * 60_000;
})();
const VI_STOP_WORDS = new Set([
  "a", "an", "and", "buy", "cho", "cua", "cùng", "do", "find", "for",
  "gia", "giá", "in", "la", "là", "loai", "mau", "màu", "mot", "một",
  "mua", "need", "of", "phù", "san", "sản", "the", "tim", "tìm", "to",
  "tu", "từ", "va", "và", "voi", "với", "with", "want",
]);

const IDENTITY_AUDIENCE_TOKENS = new Set([
  "man", "men", "male", "woman", "women", "female",
  "boy", "boys", "girl", "girls", "kid", "kids",
  "child", "children", "baby", "toddler", "youth",
  "adult", "adults", "unisex", "nam", "nu",
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

const GENERIC_DISCOVERY_LEAF_TOKENS = new Set([
  "apparel", "clothing", "accessories", "accessory", "gear", "equipment",
  "essentials", "essential", "product", "products", "item", "items",
  "goods", "outfit", "outfits", "fashion", "style",
]);

const GENERIC_SOURCE_CONTEXT_TOKENS = new Set([
  "something", "someone", "thing", "things", "item", "items", "product",
  "products", "wear", "wearing", "use", "using", "day", "days", "all",
  "good", "best", "like", "likes", "need", "want", "fashion", "style",
  "weather", "outfit", "outfits", "occasion", "occasions", "activity",
  "activities", "context", "clothing", "apparel", "gear", "equipment",
  "accessory", "accessories",
]);

export function readDiscoveryLeafTypeHints(values: string[]) {
  const hints = new Set<string>();
  for (const value of values) {
    const tokens = meaningfulTokens(value);
    if (tokens.length < 2 || tokens.length > 8) continue;
    const leaf = tokens[tokens.length - 1];
    if (
      leaf.length >= 4 &&
      !GENERIC_DISCOVERY_LEAF_TOKENS.has(leaf)
    ) {
      hints.add(leaf);
    }
  }
  return hints;
}

function isDefaultVariantPlaceholder(value: string) {
  const normalized = normalizeContextTerm(value);
  return normalized === "default title" || normalized === "title default title";
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
  // Keep Shopify's merchant-defined productType in its own field. It can be
  // broad taxonomy such as "Womens", "Outdoor" or "Tools" and must not be
  // promoted to the exact canonical identity of the item.
  add("PRODUCT_TYPE", product.productType);
  add("VENDOR", product.vendor);

  // LLM-derived semantic facets are inserted before high-cardinality tags and
  // variants so aliases/contexts cannot be crowded out by a product with many
  // variant combinations.
  if (analysis) {
    add("CANONICAL_PRODUCT_TYPE", analysis.canonicalProductType);
    add("CANONICAL_PRODUCT_TYPE", analysis.shopLanguageProductType);
    add("CATEGORY", analysis.category);
    for (const value of analysis.brandTerms) add("BRAND", value);
    for (const value of analysis.modelTerms) add("MODEL", value);
    for (const value of analysis.identifiers) add("IDENTIFIER", value);
    for (const value of analysis.audiences) add("AUDIENCE", value);
    for (const value of analysis.inferredAudiences) add("INFERRED_AUDIENCE", value);
    for (const value of analysis.compatibility) add("COMPATIBILITY", value);
    for (const value of analysis.exactAttributes) add("ATTRIBUTE", value);
    for (const value of analysis.measurements) add("MEASUREMENT", value);
    for (const value of analysis.explicitContexts) add("USE_CASE", value);
    for (const value of analysis.compatibleContexts) add("SOFT_CONTEXT", value);
    for (const value of analysis.aliases) add("ALIAS", value);
    for (const value of analysis.variantAttributes) {
      if (!isDefaultVariantPlaceholder(value)) add("VARIANT_OPTION", value);
    }
    // sourceLanguageTerms/shopLanguageTerms intentionally stay in the embedding
    // document only. They mix identity, attributes, measurements and contexts,
    // so storing them as ALIAS corrupts the typed shop dictionary.
  }

  for (const tag of product.tags ?? []) add("TAG", tag);
  for (const variant of product.variants ?? []) {
    if (variant.title !== "Default Title") add("VARIANT", variant.title);
    add("SKU", variant.sku);
    add("BARCODE", variant.barcode);
    for (const option of variant.selectedOptions ?? []) {
      const name = clean(option.name, 80);
      const value = clean(option.value, 120);
      if (!name || !value) continue;
      if (
        normalizeContextTerm(name) === "title" &&
        isDefaultVariantPlaceholder(value)
      ) {
        continue;
      }

      add("VARIANT_OPTION", value);
      add("VARIANT_OPTION", `${name}=${value}`);

      if (
        /(?:size|capacity|weight|length|width|height|dimension|volume|quantity|count|pack|waist|inseam|shoe)/i.test(
          name,
        )
      ) {
        add("MEASUREMENT", value);
        add("MEASUREMENT", `${name}=${value}`);
      }

      if (
        /(?:color|colour|material|fabric|style|fit|pattern|finish|flavor|flavour|scent|condition|format)/i.test(
          name,
        )
      ) {
        add("ATTRIBUTE", value);
        add("ATTRIBUTE", `${name}=${value}`);
      }

      if (/(?:gender|audience|age group|age_group|recipient)/i.test(name)) {
        add("AUDIENCE", value);
      }

      if (/(?:model|series)/i.test(name)) {
        add("MODEL", value);
      }

      if (/(?:compatibility|compatible with|device)/i.test(name)) {
        add("COMPATIBILITY", value);
      }
    }
  }

  return [...terms.values()].slice(0, 240);
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
  invalidateShopSearchDictionary(shop);
  return terms.length;
}

export async function ensureProductShopContext({
  shop,
  product,
}: {
  shop: string;
  product: ProductForIndex;
}) {
  const deterministicTerms = collectProductContextTerms(product, null);
  if (deterministicTerms.length > 0) {
    // Repair missing base terms without deleting LLM-derived augmentation.
    // The old count-only check allowed partially populated products to remain
    // permanently incomplete.
    await db.aiSearchShopContextTerm.createMany({
      data: deterministicTerms.map((term) => ({
        shop,
        productId: product.id,
        ...term,
      })),
      skipDuplicates: true,
    });
    contextCache.delete(shop);
    invalidateShopSearchDictionary(shop);
  }
  return db.aiSearchShopContextTerm.count({
    where: { shop, productId: product.id },
  });
}

export async function getShopContextCoverage(shop: string) {
  const [coverageRows, missingBaseRows] = await Promise.all([
    db.$queryRaw<Array<{
      contextProducts: bigint | number;
      canonicalTypeProducts: bigint | number;
    }>>`
      SELECT
        COUNT(DISTINCT c.\`productId\`) AS \`contextProducts\`,
        COUNT(DISTINCT CASE
          WHEN c.\`kind\` = 'CANONICAL_PRODUCT_TYPE' THEN c.\`productId\`
          ELSE NULL
        END) AS \`canonicalTypeProducts\`
      FROM \`AiSearchShopContextTerm\` c
      INNER JOIN \`AiSearchIndexedProduct\` p
        ON p.\`shop\` = c.\`shop\`
       AND p.\`productId\` = c.\`productId\`
      WHERE c.\`shop\` = ${shop}
        AND p.\`searchable\` = true
        AND p.\`hasVector\` = true
    `,
    db.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*) AS \`count\`
      FROM \`AiSearchIndexedProduct\` p
      WHERE p.\`shop\` = ${shop}
        AND p.\`searchable\` = true
        AND p.\`hasVector\` = true
        AND NOT EXISTS (
          SELECT 1 FROM \`AiSearchShopContextTerm\` c
          WHERE c.\`shop\` = p.\`shop\`
            AND c.\`productId\` = p.\`productId\`
            AND c.\`kind\` IN ('PRODUCT_TITLE', 'PRODUCT_TYPE', 'CANONICAL_PRODUCT_TYPE')
        )
    `,
  ]);
  const total = Number(coverageRows[0]?.contextProducts ?? 0);
  const canonical = Number(coverageRows[0]?.canonicalTypeProducts ?? 0);
  return {
    contextProducts: total,
    canonicalTypeProducts: canonical,
    coverageRatio: total > 0 ? canonical / total : 0,
    productsMissingDeterministicBaseContext: Number(missingBaseRows[0]?.count ?? 0),
  };
}

async function loadShopContextUncached(
  shop: string,
): Promise<LoadedShopContext> {
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
    where: {
      shop,
      productRecord: {
        is: {
          searchable: true,
          hasVector: true,
        },
      },
    },
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
  contextCache.set(shop, {
    expiresAt: Date.now() + SHOP_CONTEXT_CACHE_TTL_MS,
    terms,
  });
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

async function loadShopContext(shop: string): Promise<LoadedShopContext> {
  const cached = contextCache.get(shop);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      terms: cached.terms,
      cacheStatus: "HIT",
      dbReadMs: 0,
      aggregateCodeMs: 0,
      totalMs: 0,
    };
  }

  const pending = pendingContextLoads.get(shop);
  if (pending) return pending;

  const task = loadShopContextUncached(shop);
  pendingContextLoads.set(shop, task);

  try {
    return await task;
  } finally {
    if (pendingContextLoads.get(shop) === task) {
      pendingContextLoads.delete(shop);
    }
  }
}

export async function warmShopContext(shop: string) {
  await loadShopContext(shop);
}

const PRODUCT_IDENTITY_KINDS = new Set([
  "CANONICAL_PRODUCT_TYPE",
]);

const FALLBACK_PRODUCT_IDENTITY_KINDS = new Set([
  "PRODUCT_TYPE",
  "ALIAS",
  "CATEGORY",
]);

function isComplementaryRelationText(value: string) {
  return /\b(?:pair(?:s|ed|ing)?(?: well)? with|go(?:es|ing)?(?: well)? with|match(?:es|ed|ing)? with|wear with|style with|mac(?: gi)? voi|phoi(?: do)? voi|ket hop voi|hop voi|di cung voi)\b/.test(
    normalizeContextTerm(value),
  );
}

function retrievalModeOf(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  if (isComplementaryRelationText(originalQuery)) return "COMPLEMENT";
  return rewrite.planning?.retrievalMode ?? "DIRECT";
}

export function readComplementReferenceOnlyFacetTokens(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  const result = new Set<string>();
  if (retrievalModeOf(originalQuery, rewrite) !== "COMPLEMENT") return result;

  const sourceTokens = normalizeContextTerm(originalQuery).split(" ").filter(Boolean);
  const relationIndex = sourceTokens.findIndex(
    (token, index) =>
      token === "with" ||
      token === "voi" ||
      (token === "cung" && sourceTokens[index + 1] === "voi"),
  );
  if (relationIndex < 0) return result;

  const referenceStart =
    sourceTokens[relationIndex] === "cung" &&
    sourceTokens[relationIndex + 1] === "voi"
      ? relationIndex + 2
      : relationIndex + 1;
  const targetTokens = new Set(
    meaningfulTokens(sourceTokens.slice(0, relationIndex).join(" ")),
  );
  const referenceIdentityTokens = new Set(
    (rewrite.analysis.referenceTerms ?? []).flatMap((value) =>
      meaningfulTokens(value),
    ),
  );

  for (const token of meaningfulTokens(
    sourceTokens.slice(referenceStart).join(" "),
  )) {
    if (referenceIdentityTokens.has(token) || targetTokens.has(token)) continue;
    result.add(token);
  }
  return result;
}

const COMPLEMENT_TARGET_GENERIC_TOKENS = new Set([
  "what", "which", "should", "can", "could", "would", "something", "anything",
  "go", "goes", "going", "well", "pair", "pairs", "paired", "match", "matches",
  "wear", "wearing", "style", "find", "need", "want",
]);

export function readComplementTargetFacetTokens(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  const result = new Set<string>();
  if (retrievalModeOf(originalQuery, rewrite) !== "COMPLEMENT") return result;
  const sourceTokens = normalizeContextTerm(originalQuery).split(" ").filter(Boolean);
  const relationIndex = sourceTokens.findIndex(
    (token, index) =>
      token === "with" ||
      token === "voi" ||
      (token === "cung" && sourceTokens[index + 1] === "voi"),
  );
  if (relationIndex < 0) return result;
  for (const token of meaningfulTokens(sourceTokens.slice(0, relationIndex).join(" "))) {
    if (COMPLEMENT_TARGET_GENERIC_TOKENS.has(token)) continue;
    result.add(token);
  }
  return result;
}

export function normalizeIdentitySignalTokens(value: string) {
  return meaningfulTokens(value).filter(
    (token) => !IDENTITY_AUDIENCE_TOKENS.has(token),
  );
}

function buildProductIdentitySignals(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  const explicitIdentityValues = [
    rewrite.analysis.productType,
    ...(rewrite.analysis.productTypes ?? []),
    rewrite.analysis.shopLanguageProductType,
  ].filter((value) => value?.trim());

  return [
    ...explicitIdentityValues.map((value) => ({ value, fallback: false })),
    // Semantic expansions are recall hints, not proof of exact product
    // identity. Only fall back to the raw query when analysis produced no
    // product identity at all.
    ...(explicitIdentityValues.length === 0 &&
    retrievalModeOf(originalQuery, rewrite) === "DIRECT"
      ? [{ value: originalQuery, fallback: true }]
      : []),
  ]
    .map(({ value, fallback }) => {
      // Audience/gender is a separate facet. Letting "men"/"women" remain in
      // product identity made any men's/women's product look like an identity
      // match for queries such as "men's grey sneakers".
      const tokens = normalizeIdentitySignalTokens(value);
      return {
        value,
        fallback,
        normalized: tokens.join(" "),
        tokens,
      };
    })
    .filter((signal) => signal.normalized && signal.tokens.length > 0);
}

function strongIdentityMatch(
  term: Pick<ContextTerm, "normalizedValue" | "tokens">,
  signal: { normalized: string; tokens: string[]; fallback?: boolean },
) {
  if (term.normalizedValue === signal.normalized) return 1;

  const termTokenSet = new Set(term.tokens);
  const common = [...new Set(signal.tokens)].filter((token) => termTokenSet.has(token));
  if (common.length === 0) return 0;

  const signalCoverage = common.length / new Set(signal.tokens).size;
  const termCoverage = common.length / Math.max(1, new Set(term.tokens).size);
  if (signal.tokens.length === 1) return 1;
  // A one-token canonical identity may match a longer raw-query fallback
  // such as "charcoal cardigan size XL", but it must not collapse an exact
  // multi-token identity such as "polo shirt" into the sibling class "shirt".
  if (
    signal.fallback === true &&
    term.tokens.length === 1 &&
    common.length === 1 &&
    term.normalizedValue.length >= 3
  ) {
    return 0.9;
  }
  if (common.length >= 2 && signalCoverage >= 0.5) {
    return Math.max(signalCoverage, termCoverage);
  }
  return 0;
}

function containsTokenSequence(
  haystack: string[],
  needle: string[],
) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function referenceIdentityContainmentMatch(
  identityValues: string[],
  referenceSignals: string[],
) {
  let best = 0;
  for (const identityValue of identityValues) {
    const identityTokens = meaningfulTokens(identityValue);
    if (identityTokens.length === 0) continue;
    for (const referenceSignal of referenceSignals) {
      const referenceTokens = meaningfulTokens(referenceSignal);
      if (referenceTokens.length === 0) continue;
      if (containsTokenSequence(referenceTokens, identityTokens)) {
        return 1;
      }
      if (containsTokenSequence(identityTokens, referenceTokens)) {
        best = Math.max(best, referenceTokens.length === 1 ? 0.9 : 0.8);
      }
    }
  }
  return best;
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
  const uniqueTermTokens = [...new Set(termTokens)];
  if (uniqueTermTokens.length === 0) return 0;

  for (const signal of signals) {
    const normalizedSignal = signal.normalized;
    if (!normalizedSignal) continue;
    const signalTokens = signal.tokens;
    const exact = normalizedSignal === term.normalizedValue;
    const tokenContained =
      containsTokenSequence(signalTokens, termTokens) ||
      containsTokenSequence(termTokens, signalTokens);
    const contained =
      !exact &&
      tokenContained &&
      termTokens.length > 1 &&
      signalTokens.length > 1;
    const common = uniqueTermTokens.filter((token) => signal.tokenSet.has(token));
    const coverageTerm = common.length / uniqueTermTokens.length;
    const coverageSignal = common.length / Math.max(1, new Set(signalTokens).size);
    let score = exact
      ? 30
      : contained
        ? 15
        : common.length > 0
          ? common.length * 2 + coverageTerm * 6 + coverageSignal * 5
          : 0;

    if (!exact && !contained && common.length < 2) score = 0;
    if (
      !exact &&
      !contained &&
      ["ATTRIBUTE", "VARIANT", "VARIANT_OPTION", "MEASUREMENT", "TAG"].includes(term.kind)
    ) {
      score = 0;
    }

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

export function composeContextualEmbeddingInput(
  originalQuery: string,
  rewrite: QueryRewriteResult,
  selectedTerms: SelectedShopContext[],
) {
  if (rewrite.planning) {
    const coreClauses = clean(rewrite.planning.semanticQuery, 500)
      .split(/\s*;\s*/)
      .filter(Boolean);
    const core: string[] = [];
    for (const clause of coreClauses) {
      if (core.length >= 3 || [...core, clause].join(" ; ").length > 260) break;
      core.push(clause);
    }
    const base = core.length ? core.join(" ; ") : clean(coreClauses[0], 260);
    const foldedBase = normalizeContextTerm(base);
    const retrievalMode = rewrite.planning.retrievalMode;
    // DISCOVERY already has an explicit need-first semanticQuery plus separate
    // class+context vector branches. Catalog vocabulary must stay out of the
    // primary vector; it remains available for grounding and reranking only.
    if (retrievalMode === "DISCOVERY") {
      return base;
    }
    const additions = selectedTerms
      .filter(
        (term) =>
          [
            "CANONICAL_PRODUCT_TYPE",
            "PRODUCT_TYPE",
            "CATEGORY",
            "ALIAS",
            "ATTRIBUTE",
            "USE_CASE",
          ].includes(term.kind) && term.score >= 18,
      )
      .map((term) => clean(term.value, 220))
      .filter((term) => term && !foldedBase.includes(normalizeContextTerm(term)));
    const selected: string[] = [];
    for (const term of additions) {
      const normalized = normalizeContextTerm(term);
      if (selected.some((value) => normalizeContextTerm(value).includes(normalized) || normalized.includes(normalizeContextTerm(value)))) continue;
      if (selected.length >= 2 || [base, ...selected, term].join(" ; ").length > 300) break;
      selected.push(term);
    }
    return [base, ...selected].filter(Boolean).join(" ; ");
  }
  // Only shopper-required attributes belong in the embedding fallback.
  // LLM-inferred optional preferences are soft ranking evidence and must not
  // mutate Shop Context vocabulary or the vector query.
  const semanticAttributes = [
    ...rewrite.analysis.requiredAttributes,
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
  const hasAnalyzedProductType = Boolean(
    rewrite.analysis.productType.trim() ||
    (rewrite.analysis.productTypes ?? []).some((value) => value.trim()) ||
    rewrite.analysis.shopLanguageProductType.trim(),
  );
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

  // Broad family identities such as "Apparel" or "Clothing" may exist only
  // as merchant product type/category while every product still has a more
  // specific canonical leaf type. If canonical identity has no exact hit,
  // allow an exact family fallback instead of falsely rejecting the catalog.
  if (matchingProductIds.size === 0 && hasAnalyzedProductType) {
    for (const term of terms) {
      if (!FALLBACK_PRODUCT_IDENTITY_KINDS.has(term.kind)) continue;
      if (!identitySignals.some((signal) => term.normalizedValue === signal.normalized)) {
        continue;
      }
      matchingIdentityTerms.add(term);
      for (const productId of term.productIds) matchingProductIds.add(productId);
    }
  }

  const signals = [
    { text: originalQuery, weight: 1.2 },
    { text: rewrite.analysis.intent, weight: 1.25 },
    { text: rewrite.analysis.productType, weight: 1.5 },
    ...(rewrite.analysis.productTypes ?? []).map((text) => ({ text, weight: 1.5 })),
    { text: rewrite.analysis.shopLanguageProductType, weight: 1.5 },
    { text: rewrite.analysis.category, weight: 1.1 },
    ...rewrite.analysis.brands.map((text) => ({ text, weight: 1.8 })),
    ...rewrite.analysis.models.map((text) => ({ text, weight: 1.9 })),
    ...rewrite.analysis.identifiers.map((text) => ({ text, weight: 2 })),
    ...rewrite.analysis.audience.map((text) => ({ text, weight: 1.5 })),
    ...rewrite.analysis.requiredAttributes.map((text) => ({ text, weight: 1.5 })),
    // Optional preferences are often discovered from LLM expansions (for
    // example "blue" from "blue light glasses" or "portable" from
    // "portable lantern"). They may rerank later, but must not inject new
    // catalog vocabulary into the embedding input.
    ...rewrite.analysis.useCases.map((text) => ({ text, weight: 1.25 })),
    ...rewrite.analysis.compatibility.map((text) => ({ text, weight: 1.8 })),
    ...(rewrite.analysis.referenceTerms ?? []).map((text) => ({ text, weight: 1.7 })),
    ...(rewrite.analysis.semanticMustTerms ?? []).map((text) => ({ text, weight: 1.6 })),
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
  const normalizedOriginalQuery = normalizeContextTerm(originalQuery);
  const ambiguousSizeValues = new Set(["small", "medium", "large"]);
  const hasExplicitSizeCue =
    /\b(?:size|sizing|kich co|co ao|co quan|waist|inseam|shoe size)\b/.test(
      normalizedOriginalQuery,
    );
  const originalTokens = new Set(meaningfulTokens(originalQuery));
  const complementReferenceOnlyFacetTokens =
    readComplementReferenceOnlyFacetTokens(originalQuery, rewrite);
  const complementTargetFacetTokens =
    readComplementTargetFacetTokens(originalQuery, rewrite);
  const currentContextRetrievalMode = retrievalModeOf(originalQuery, rewrite);
  const discoveryLeafTypeHints =
    retrievalModeOf(originalQuery, rewrite) === "DISCOVERY"
      ? readDiscoveryLeafTypeHints(rewrite.analysis.semanticExpansions ?? [])
      : new Set<string>();
  const semanticMustFacetTokens = new Set(
    [
      ...(rewrite.analysis.semanticMustTerms ?? []),
      ...(rewrite.analysis.semanticSourceMustTerms ?? []),
    ]
      .flatMap((value) => {
        const tokens = meaningfulTokens(value);
        return tokens.length === 1 && !isCommerceOnlyValue(value)
          ? tokens
          : [];
      })
      .filter((token) => token.length >= 3),
  );
  const semanticMustFacetKinds = new Set([
    "ATTRIBUTE",
    "USE_CASE",
    "SOFT_CONTEXT",
    "PRODUCT_TITLE",
  ]);
  const hasExplicitSemanticMustFacet =
    semanticMustFacetTokens.size > 0 &&
    terms.some(
      (term) =>
        semanticMustFacetKinds.has(term.kind) &&
        term.tokens.some((token) => semanticMustFacetTokens.has(token)),
    );
  const productTypeTokens = new Set(
    meaningfulTokens(rewrite.analysis.productType),
  );
  const hasMaleRequest = originalTokens.has("nam");
  const hasFemaleRequest = originalTokens.has("nu");
  const signalBuildCodeMs = Date.now() - signalBuildStartedAt;

  const skipContextEnrichment =
    rewrite.analysis.decisionReason.includes("LLM_DEFERRED_BACKGROUND");
  const scoreStartedAt = Date.now();
  const scoredTerms = skipContextEnrichment
    ? []
    : terms
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
        !(
          hasExplicitSemanticMustFacet &&
          term.kind === "CATEGORY" &&
          !term.tokens.some((token) => semanticMustFacetTokens.has(token))
        ) &&
        // A product title matching only a color/audience is not useful catalog
        // context. Require it to share the interpreted product identity, while
        // an exact full-title query remains eligible.
        !(
          term.kind === "PRODUCT_TITLE" &&
          normalizeContextTerm(originalQuery) !== term.normalizedValue &&
          !term.tokens.some((token) => productTypeTokens.has(token))
        ) &&
        !(
          ["MEASUREMENT", "VARIANT_OPTION"].includes(term.kind) &&
          ambiguousSizeValues.has(term.normalizedValue) &&
          !hasExplicitSizeCue
        ) &&
        !(
          (hasMaleRequest && term.tokens.includes("nu") &&
            !term.tokens.includes("nam")) ||
          (hasFemaleRequest && term.tokens.includes("nam") &&
            !term.tokens.includes("nu"))
        ) &&
        !(
          complementReferenceOnlyFacetTokens.size > 0 &&
          ["ATTRIBUTE", "MEASUREMENT", "VARIANT_OPTION", "USE_CASE", "SOFT_CONTEXT"]
            .includes(term.kind) &&
          term.tokens.some((token) =>
            complementReferenceOnlyFacetTokens.has(token),
          )
        ) &&
        !(
          currentContextRetrievalMode === "COMPLEMENT" &&
          ["ATTRIBUTE", "MEASUREMENT", "VARIANT_OPTION", "USE_CASE", "SOFT_CONTEXT"]
            .includes(term.kind) &&
          (
            complementTargetFacetTokens.size === 0 ||
            !term.tokens.some((token) => complementTargetFacetTokens.has(token))
          )
        ) &&
        !negativeValues.some(
          (negative) =>
            negative &&
            (term.normalizedValue.includes(negative) ||
              negative.includes(term.normalizedValue)),
        ),
    )
    .map((term) => {
      const baseScore = scoreTerm(term, signals);
      const explicitSemanticMustScore =
        semanticMustFacetKinds.has(term.kind) &&
        term.tokens.some((token) => semanticMustFacetTokens.has(token))
          ? 28 + Math.min(2, Math.log2(term.productCount + 1) * 0.35)
          : 0;
      const sourceContextOverlap = term.tokens.filter(
        (token) =>
          originalTokens.has(token) &&
          token.length >= 4 &&
          !GENERIC_SOURCE_CONTEXT_TOKENS.has(token),
      );
      const explicitSourceUseCaseScore =
        ["ATTRIBUTE", "USE_CASE", "SOFT_CONTEXT"].includes(term.kind) &&
        sourceContextOverlap.length > 0
          ? 36 + Math.min(2, Math.log2(term.productCount + 1) * 0.35)
          : 0;
      const discoveryLeafTypeScore =
        term.kind === "CANONICAL_PRODUCT_TYPE" &&
        term.tokens.length >= 1 &&
        discoveryLeafTypeHints.has(term.tokens[term.tokens.length - 1])
          ? 18 + Math.min(2, Math.log2(term.productCount + 1) * 0.35)
          : 0;
      return {
        ...term,
        score: Math.max(
          baseScore,
          explicitSemanticMustScore,
          explicitSourceUseCaseScore,
          discoveryLeafTypeScore,
        ),
      };
    })
    .filter((term) => term.score >= 8);
  // Open-world use cases are only useful grounding when they match the
  // shopper's need, not merely the product family mentioned by the LLM.
  const shopperNeedTokens = new Set(meaningfulTokens([
    originalQuery,
    ...rewrite.analysis.requiredAttributes,
    ...(rewrite.analysis.semanticMustTerms ?? []),
  ].join(" ")));
  const sourceNeedTokens = new Set(meaningfulTokens(originalQuery));
  const familyTokens = new Set(meaningfulTokens([
    rewrite.analysis.productType,
    rewrite.analysis.shopLanguageProductType,
    rewrite.analysis.category,
  ].join(" ")));
  const groundedTerms = scoredTerms.filter((term) => {
    const sourceOverlap = term.tokens.filter((token) => sourceNeedTokens.has(token));
    if (term.kind === "ATTRIBUTE" && term.tokens.length >= 3) {
      return sourceOverlap.length >= 2;
    }
    if (term.kind !== "USE_CASE" && term.kind !== "SOFT_CONTEXT") return true;

    // Open-world contexts must share a discriminative shopper concept, not
    // merely a generic carrier word such as "weather", "wear" or "outfit".
    // This prevents "warm weather" from grounding "cold-weather wear" or
    // "rainy weather" simply because the generic context noun overlaps.
    const discriminativeSourceOverlap = sourceOverlap.filter(
      (token) =>
        token.length >= 3 &&
        !GENERIC_SOURCE_CONTEXT_TOKENS.has(token) &&
        !familyTokens.has(token),
    );
    const discriminativeNeedOverlap = term.tokens.filter(
      (token) =>
        shopperNeedTokens.has(token) &&
        token.length >= 3 &&
        !GENERIC_SOURCE_CONTEXT_TOKENS.has(token) &&
        !familyTokens.has(token),
    );
    return (
      term.score >= 25 &&
      discriminativeSourceOverlap.length > 0 &&
      discriminativeNeedOverlap.length > 0
    );
  });
  const scoreCodeMs = Date.now() - scoreStartedAt;
  const sortStartedAt = Date.now();
  const selectedTerms: SelectedShopContext[] = [];
  const selectedContextTerms: Array<ContextTerm & { score: number }> = [];
  const seenValues = new Set<string>();
  const contextLimit = skipContextEnrichment
    ? 0
    : rewrite.analysis.complexity === "COMPLEX"
      ? 8
      : 4;
  for (const term of groundedTerms.sort(
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
    selectedContextTerms.push(term);
    if (selectedTerms.length >= contextLimit) break;
  }
  const discoverySourceGroundedProductIds =
    retrievalModeOf(originalQuery, rewrite) === "DISCOVERY"
      ? [
          ...new Set(
            selectedContextTerms
              .filter((term) => {
                if (term.score < 25) return false;
                const sourceOverlap = term.tokens.filter(
                  (token) => sourceNeedTokens.has(token),
                );
                if (term.kind === "USE_CASE" || term.kind === "SOFT_CONTEXT") {
                  return sourceOverlap.some(
                    (token) =>
                      token.length >= 4 &&
                      !GENERIC_SOURCE_CONTEXT_TOKENS.has(token),
                  );
                }
                // A single adjective (for example "comfortable") may be a
                // useful embedding hint, but is not enough to prove that a
                // product itself satisfies an open-world need. Require a
                // multi-token attribute overlap before granting the stronger
                // source-grounding rerank bonus.
                return term.kind === "ATTRIBUTE" && sourceOverlap.length >= 2;
              })
              .flatMap((term) => [...term.productIds]),
          ),
        ].slice(0, 1_000)
      : [];
  const discoveryExpansionGroundedProductIds =
    retrievalModeOf(originalQuery, rewrite) === "DISCOVERY"
      ? [
          ...new Set(
            // Expansion classes are an independent recall branch. Do not make
            // them compete with high-scoring source contexts for the small
            // selectedTerms display/embedding budget.
            scoredTerms
              .filter(
                (term) =>
                  term.kind === "CANONICAL_PRODUCT_TYPE" &&
                  term.tokens.length >= 1 &&
                  discoveryLeafTypeHints.has(term.tokens[term.tokens.length - 1]),
              )
              .flatMap((term) => [...term.productIds]),
          ),
        ].slice(0, 1_000)
      : [];
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
      discoverySourceGroundedProductIds,
      discoveryExpansionGroundedProductIds,
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

function sourceTargetText(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  if (retrievalModeOf(originalQuery, rewrite) !== "COMPLEMENT") {
    return normalizeContextTerm(originalQuery);
  }
  const sourceTokens = normalizeContextTerm(originalQuery).split(" ").filter(Boolean);
  const relation = sourceTokens.findIndex((token, index) =>
    token === "with" || token === "voi" ||
    (token === "cung" && sourceTokens[index + 1] === "voi"),
  );
  return relation < 0 ? "" : sourceTokens.slice(0, relation).join(" ");
}

function sourceContainsFacet(source: string, facet: string) {
  const fold = (value: string) => normalizeContextTerm(value).replace(/đ/g, "d");
  const value = fold(facet);
  if (!value) return false;
  return ` ${fold(source)} `.includes(` ${value} `);
}

function sourceGroundedAttributeFacets(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  const source = sourceTargetText(originalQuery, rewrite);
  const facets = new Set<string>();
  for (const segment of rewrite.planning?.resolvedSegments ?? []) {
    if (segment.field !== "ATTRIBUTE") continue;
    if (sourceContainsFacet(source, segment.text)) {
      facets.add(normalizeContextTerm(segment.canonicalValue));
    }
  }
  for (const value of [
    ...(rewrite.analysis.requiredAttributes ?? []),
    ...(rewrite.analysis.optionalPreferences ?? []),
    ...(rewrite.analysis.attributes ?? []),
  ]) {
    if (sourceContainsFacet(source, value)) facets.add(normalizeContextTerm(value));
  }
  return [...facets].filter(Boolean);
}

/** Strictness is owned by the shopper's words, never by LLM MUST prose. */
export function readStrictTargetAttributes(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  const source = sourceTargetText(originalQuery, rewrite);
  if (!source) {
    return [];
  }
  const marker = /\b(?:only|must|requires?|exclusively|chi|bat buoc|phai co)\b/;
  const strictNear = (phrase: string) => {
    const normalized = normalizeContextTerm(phrase);
    const at = ` ${source} `.indexOf(` ${normalized} `);
    if (at < 0) return false;
    const prefix = source.slice(0, at).split(" ").filter(Boolean).slice(-3).join(" ");
    return marker.test(prefix);
  };
  const strict = new Set<string>();
  for (const segment of rewrite.planning?.resolvedSegments ?? []) {
    if (segment.field === "ATTRIBUTE" && strictNear(segment.text)) {
      strict.add(normalizeContextTerm(segment.canonicalValue));
    }
  }
  for (const value of [
    ...(rewrite.analysis.requiredAttributes ?? []),
    ...(rewrite.analysis.optionalPreferences ?? []),
    ...(rewrite.analysis.attributes ?? []),
  ]) {
    if (strictNear(value)) strict.add(normalizeContextTerm(value));
  }
  return [...strict].filter(Boolean);
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

function exactMeasurementMatch(values: string[], signal: string) {
  const normalizeMeasurement = (value: string) =>
    normalizeContextTerm(value).replace(/(\d)[x×](?=\d)/g, "$1 ");
  const required = normalizeMeasurement(signal);
  const requiredNumbers = required.match(/\d+(?:[.,]\d+)?[a-z]*/g) ?? [];
  const requiredWords = required.split(" ").filter((token) =>
    token.length > 1 && !/\d/.test(token) && token !== "of",
  );
  return values.some((raw) => {
    const actual = normalizeMeasurement(raw);
    const actualTokens = new Set(actual.split(" ").filter(Boolean));
    const actualNumbers = new Set(actual.match(/\d+(?:[.,]\d+)?[a-z]*/g) ?? []);
    return requiredNumbers.every((value) => actualNumbers.has(value)) &&
      requiredWords.every((word) => actualTokens.has(word)) &&
      (requiredNumbers.length > 0 || requiredWords.length > 0);
  }) ? 1 : 0;
}

function exactCatalogSignalMatch(values: string[], signals: string[]) {
  if (signals.length === 0) return 0;
  return Math.max(...signals.map((signal) =>
    values.some((value) => sourceContainsFacet(value, signal)) ? 1 : 0,
  ));
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
          "SKU", "BARCODE", "ATTRIBUTE", "MEASUREMENT", "VARIANT_OPTION",
          "USE_CASE", "SOFT_CONTEXT", "ALIAS", "CATEGORY", "BRAND",
          "MODEL", "IDENTIFIER", "AUDIENCE", "INFERRED_AUDIENCE",
          "COMPATIBILITY", "CANONICAL_PRODUCT_TYPE",
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
  const sourceNegatives = parseDeterministicQuery(originalQuery)
    .negatives.map((item) => normalizeContextTerm(item.value));
  const canonicalNegatives = (rewrite.planning?.resolvedSegments ?? [])
    .filter((segment) => sourceNegatives.some((negative) =>
      sourceContainsFacet(negative, segment.text),
    ))
    .map((segment) => segment.canonicalValue);
  const negativeSignals = [...new Set([
    ...(rewrite.analysis.negativeTerms ?? []),
    ...sourceNegatives,
    ...canonicalNegatives,
  ].map(normalizeContextTerm).filter(Boolean))];
  const currentRetrievalMode =
    retrievalModeOf(originalQuery, rewrite);
  const strictAttributes = readStrictTargetAttributes(originalQuery, rewrite);
  const attributeSignals = [
    ...(rewrite.analysis.requiredAttributes ?? []),
    ...(rewrite.analysis.optionalPreferences ?? []),
    ...(rewrite.analysis.attributes ?? []),
    ...(rewrite.analysis.useCases ?? []),
  ].filter((value) => !isCommerceOnlyValue(value));
  const preferredAttributes = sourceGroundedAttributeFacets(originalQuery, rewrite)
    .filter((value) => !strictAttributes.includes(value))
    .filter((value) => !negativeSignals.includes(value));
  const genericSemanticFacetTokens = new Set([
    "product", "products", "item", "items", "thing", "things",
    "goods", "merchandise",
  ]);
  const semanticMustFacetSignals =
    retrievalModeOf(originalQuery, rewrite) === "COMPLEMENT"
      ? []
      : [
          ...new Set([
            ...(rewrite.analysis.semanticMustTerms ?? []),
            ...(rewrite.analysis.semanticSourceMustTerms ?? []),
          ]),
        ].filter((value) => {
          if (isCommerceOnlyValue(value)) return false;
          const tokens = meaningfulTokens(value);
          return (
            tokens.length > 0 &&
            !tokens.every((token) => genericSemanticFacetTokens.has(token))
          );
        });
  const brandSignals = rewrite.analysis.brands;
  const modelSignals = rewrite.analysis.models;
  const identifierSignals = rewrite.analysis.identifiers;
  const compatibilitySignals = rewrite.analysis.compatibility;
  const audienceSignals = rewrite.analysis.audience;
  const sourceGroundedSignals = (signals: string[]) => signals.filter((signal) =>
    sourceContainsFacet(originalQuery, signal) ||
    (rewrite.planning?.resolvedSegments ?? []).some((segment) =>
      normalizeContextTerm(segment.canonicalValue) === normalizeContextTerm(signal) &&
      sourceContainsFacet(originalQuery, segment.text),
    ),
  );
  const exactBrandSignals = sourceGroundedSignals(brandSignals);
  const exactModelSignals = sourceGroundedSignals(modelSignals);
  const exactIdentifierSignals = sourceGroundedSignals(identifierSignals);
  const exactCompatibilitySignals = sourceGroundedSignals(compatibilitySignals);
  const numericRequiredSignals = parseDeterministicQuery(originalQuery)
    .measurements.map((item) => item.value);
  const familyCategorySignals =
    currentRetrievalMode === "DIRECT"
      ? [
          ...new Set(
            (rewrite.planning?.resolvedSegments ?? [])
              .filter(
                (segment) =>
                  segment.field === "CATEGORY" &&
                  segment.confidence >= 0.95,
              )
              .map((segment) => segment.canonicalValue)
              .filter(Boolean),
          ),
        ]
      : [];
  const complementaryRelation =
    currentRetrievalMode === "COMPLEMENT";
  const complementaryReferenceSignals =
    complementaryRelation
      ? [...new Set(rewrite.analysis.referenceTerms ?? [])]
      : [];
  const complementaryPreferenceSignals =
    complementaryRelation
      ? [
          ...new Set(
            (rewrite.context?.selectedTerms ?? [])
              .filter((term) =>
                [
                  "CANONICAL_PRODUCT_TYPE",
                  "PRODUCT_TYPE",
                  "ALIAS",
                  "TAG",
                  "CATEGORY",
                ].includes(term.kind),
              )
              .map((term) => term.value)
              .filter(
                (value) =>
                  !complementaryReferenceSignals.some(
                    (reference) =>
                      normalizeContextTerm(reference) ===
                      normalizeContextTerm(value),
                  ),
              )
              .filter(Boolean),
          ),
        ]
      : [];
  const discoveryGroundingSignals =
    currentRetrievalMode === "DISCOVERY"
      ? (rewrite.context?.selectedTerms ?? [])
          .filter((term) =>
            ["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "CATEGORY"].includes(term.kind) &&
            term.score >= 25,
          )
          .slice(0, 2)
          .map((term) => term.value)
      : [];
  const sourceGroundedDiscoveryProductIds =
    currentRetrievalMode === "DISCOVERY"
      ? new Set(rewrite.context?.discoverySourceGroundedProductIds ?? [])
      : new Set<string>();
  const expansionGroundedDiscoveryProductIds =
    currentRetrievalMode === "DISCOVERY"
      ? new Set(rewrite.context?.discoveryExpansionGroundedProductIds ?? [])
      : new Set<string>();

  const scored = results.map((result) => {
    const values = valuesByProduct.get(result.productId) ?? [];
    const tokens = tokensByProduct.get(result.productId) ?? new Set<string>();
    const byKind = valuesByProductAndKind.get(result.productId) ?? new Map();
    const valuesForKinds = (kinds: string[]) =>
      kinds.flatMap((kind) => byKind.get(kind) ?? []);
    const tokensForValues = (selectedValues: string[]) =>
      new Set(selectedValues.flatMap((value) => meaningfulTokens(value)));
    const identityValues = valuesForKinds([
      "CANONICAL_PRODUCT_TYPE",
      "PRODUCT_TYPE",
      "ALIAS",
      "CATEGORY",
    ]);
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
    const complementaryIdentityValues = valuesForKinds([
      "CANONICAL_PRODUCT_TYPE",
      "PRODUCT_TYPE",
      "ALIAS",
      "CATEGORY",
    ]);
    const complementaryReferenceIdentityValues = valuesForKinds([
      "CANONICAL_PRODUCT_TYPE",
      "PRODUCT_TYPE",
      "ALIAS",
    ]);
    const complementaryReferenceMatch = Math.max(
      bestSignalMatch(
        complementaryIdentityValues,
        tokensForValues(complementaryIdentityValues),
        complementaryReferenceSignals,
      ),
      referenceIdentityContainmentMatch(
        complementaryReferenceIdentityValues,
        complementaryReferenceSignals,
      ),
    );
    const complementaryPreferenceMatch = bestSignalMatch(
      complementaryIdentityValues,
      tokensForValues(complementaryIdentityValues),
      complementaryPreferenceSignals,
    );
    const discoveryGroundingMatch = bestSignalMatch(
      complementaryIdentityValues,
      tokensForValues(complementaryIdentityValues),
      discoveryGroundingSignals,
    );
    const softRecallValues = valuesForKinds([
      "SOFT_CONTEXT",
      "INFERRED_AUDIENCE",
      "ALIAS",
      "USE_CASE",
      "ATTRIBUTE",
      "MEASUREMENT",
      "VARIANT_OPTION",
      "CATEGORY",
      "PRODUCT_TITLE",
      "PRODUCT_TYPE",
    ]);
    const softRecallTokens = tokensForValues(softRecallValues);
    const attributeMatch = Math.max(
      0,
      ...attributeSignals.map((signal) =>
        matchSemanticSignal(softRecallValues, softRecallTokens, signal),
      ),
    );
    const semanticMustFacetValues = valuesForKinds([
      "ATTRIBUTE",
      "USE_CASE",
      "SOFT_CONTEXT",
      "PRODUCT_TITLE",
    ]);
    const semanticMustFacetMatch = bestSignalMatch(
      semanticMustFacetValues,
      tokensForValues(semanticMustFacetValues),
      semanticMustFacetSignals,
    );
    const brandValues = valuesForKinds(["BRAND", "VENDOR", "PRODUCT_TITLE"]);
    const brandMatch = exactCatalogSignalMatch(brandValues, exactBrandSignals);
    const modelValues = valuesForKinds(["MODEL", "VARIANT", "PRODUCT_TITLE"]);
    const modelMatch = exactCatalogSignalMatch(modelValues, exactModelSignals);
    const identifierValues = valuesForKinds([
      "IDENTIFIER",
      "SKU",
      "BARCODE",
      "VARIANT",
      "PRODUCT_TITLE",
    ]);
    const identifierMatch = exactCatalogSignalMatch(
      identifierValues,
      exactIdentifierSignals,
    );
    const compatibilityValues = valuesForKinds([
      "COMPATIBILITY",
      "ATTRIBUTE",
      "VARIANT_OPTION",
      "PRODUCT_TITLE",
    ]);
    const compatibilityMatch = exactCatalogSignalMatch(
      compatibilityValues,
      exactCompatibilitySignals,
    );
    const audienceValues = valuesForKinds(["AUDIENCE", "ATTRIBUTE", "PRODUCT_TITLE"]);
    const audienceMatch = bestSignalMatch(
      audienceValues,
      tokensForValues(audienceValues),
      audienceSignals,
    );
    const exactNumericValues = valuesForKinds([
      "MEASUREMENT",
      "VARIANT_OPTION",
      "ATTRIBUTE",
      "SKU",
      "BARCODE",
      "PRODUCT_TITLE",
    ]);
    const numericRequiredMatch = numericRequiredSignals.length === 0
      ? 0
      : Math.min(...numericRequiredSignals.map((signal) =>
          exactMeasurementMatch(exactNumericValues, signal),
        ));
    const categoryValues = valuesForKinds(["CATEGORY"]);
    const categoryMatch = bestSignalMatch(
      categoryValues,
      tokensForValues(categoryValues),
      familyCategorySignals,
    );

    // Exact shopper-owned facets use catalog facts; soft/inferred context does
    // not establish strict attribute presence.
    // Inferred audiences and soft compatible contexts must never exclude an
    // otherwise valid result.
    const explicitFilterValues = valuesForKinds([
      "PRODUCT_TITLE",
      "PRODUCT_TYPE",
      "VENDOR",
      "VARIANT",
      "VARIANT_OPTION",
      "SKU",
      "BARCODE",
      "ATTRIBUTE",
      "MEASUREMENT",
      "USE_CASE",
      "CATEGORY",
      "BRAND",
      "MODEL",
      "IDENTIFIER",
      "AUDIENCE",
      "COMPATIBILITY",
      "CANONICAL_PRODUCT_TYPE",
    ]);
    const exactFacetValues = valuesForKinds([
      "ATTRIBUTE", "VARIANT_OPTION", "VARIANT", "PRODUCT_TITLE",
    ]);
    const exactFacetMatch = (signal: string) =>
      exactFacetValues.some((value) => sourceContainsFacet(value, signal));
    const preferredFacetMatches = preferredAttributes.filter(exactFacetMatch).length;
    const strictFacetMatch = strictAttributes.every(exactFacetMatch);
    const explicitTokens = new Set(explicitFilterValues.flatMap((value) =>
      normalizeContextTerm(value).replace(/đ/g, "d").split(" ").filter(Boolean),
    ));
    const excluded = negativeSignals.some((negative) => {
      const forbiddenTokens = negative.replace(/đ/g, "d").split(" ").filter(Boolean);
      return forbiddenTokens.length > 0 &&
        forbiddenTokens.every((token) => explicitTokens.has(token));
    });
    return {
      result,
      identityMatch,
      hasKnownIdentity: identityValues.length > 0,
      complementaryReferenceMatch,
      complementaryPreferenceMatch,
      discoveryGroundingMatch,
      sourceDiscoveryGrounding:
        sourceGroundedDiscoveryProductIds.has(result.productId),
      expansionDiscoveryGrounding:
        expansionGroundedDiscoveryProductIds.has(result.productId),
      attributeMatch,
      semanticMustFacetMatch,
      preferredFacetMatches,
      strictFacetMatch,
      excluded,
      brandMatch,
      modelMatch,
      identifierMatch,
      compatibilityMatch,
      audienceMatch,
      numericRequiredMatch,
      categoryMatch,
      hasKnownCategory: categoryValues.length > 0,
    };
  });
  const hasIdentityMatch = scored.some((item) => item.identityMatch >= 0.5);
  const directIdentityGrounded =
    currentRetrievalMode === "DIRECT" &&
    identitySignals.length > 0 &&
    hasIdentityMatch;
  const hasFamilyCategoryMatch =
    familyCategorySignals.length > 0 &&
    scored.some((item) => item.categoryMatch >= 0.75);
  const hardGroups = [
    { active: exactBrandSignals.length > 0, key: "brandMatch" as const },
    { active: exactModelSignals.length > 0, key: "modelMatch" as const },
    { active: exactIdentifierSignals.length > 0, key: "identifierMatch" as const },
    { active: exactCompatibilitySignals.length > 0, key: "compatibilityMatch" as const },
    { active: audienceSignals.length > 0, key: "audienceMatch" as const },
    { active: numericRequiredSignals.length > 0, key: "numericRequiredMatch" as const },
  ].filter((group) =>
    group.active &&
    ([
      "brandMatch", "modelMatch", "identifierMatch",
      "compatibilityMatch", "numericRequiredMatch",
    ].includes(group.key) || scored.some((item) => item[group.key] >= 0.75)),
  );
  let identityFilteredCount = 0;
  let colorFilteredCount = 0;
  let negativeFilteredCount = 0;
  let genderFilteredCount = 0;
  let exactConstraintFilteredCount = 0;
  let typedFacetMatchCount = 0;
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
    if (
      complementaryReferenceSignals.length > 0 &&
      item.complementaryReferenceMatch >= 0.75
    ) {
      identityFilteredCount += 1;
      return [];
    }
    if (
      directIdentityGrounded &&
      item.hasKnownIdentity &&
      item.identityMatch < 0.34
    ) {
      identityFilteredCount += 1;
      return [];
    }
    if (!item.strictFacetMatch) {
      exactConstraintFilteredCount += 1;
      return [];
    }
    if (item.excluded) {
      negativeFilteredCount += 1;
      return [];
    }
    if (
      hasFamilyCategoryMatch &&
      item.hasKnownCategory &&
      item.categoryMatch < 0.5
    ) {
      exactConstraintFilteredCount += 1;
      return [];
    }
    if (hardGroups.some((group) => item[group.key] < 0.5)) {
      exactConstraintFilteredCount += 1;
      return [];
    }

    const lexicalBonus =
      Math.min(
        directIdentityGrounded ? 0.24 : 0.14,
        item.identityMatch * (directIdentityGrounded ? 0.22 : 0.12),
      ) +
      Math.min(0.03, item.attributeMatch * 0.03) +
      // Exact typed/merchant facet evidence outranks nearby vector shades,
      // but never outweighs a grounded product identity.
      Math.min(0.08, item.preferredFacetMatches * 0.08) +
      // Semantic MUST terms from LLM are evidence/ranking signals unless
      // they were independently resolved into a closed-world typed facet.
      // This prevents open-world concepts such as style/use-case from
      // becoming accidental hard filters.
      Math.min(0.10, item.semanticMustFacetMatch * 0.10) +
      Math.min(0.12, item.complementaryPreferenceMatch * 0.12) +
      // Catalog-grounded category/type evidence is a soft ranking signal for
      // discovery, never a closed-world filter from expansion prose.
      Math.min(0.16, item.discoveryGroundingMatch * 0.16) +
      // Source-overlap evidence is stronger than LLM-expanded subtype hints.
      // Both are soft only: source evidence gets +0.10, while expansion-derived
      // product classes get +0.04 so they improve recall without overtaking the
      // shopper's actual need.
      (item.sourceDiscoveryGrounding ? 0.10 : 0) +
      (item.expansionDiscoveryGrounding ? 0.04 : 0) +
      Math.min(
        0.08,
        (item.brandMatch + item.modelMatch + item.identifierMatch +
          item.compatibilityMatch + item.audienceMatch +
          item.numericRequiredMatch) * 0.02,
      ) +
      0;
    typedFacetMatchCount += item.preferredFacetMatches;
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
    strictFacets: strictAttributes,
    preferredFacets: preferredAttributes,
    typedFacetMatchCount,
  });
  return filtered;
}
