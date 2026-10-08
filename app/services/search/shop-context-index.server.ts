import db from "../../db.server";
import type { ProductForIndex } from "../products/product-document.server";
import type { ProductSemanticAnalysis } from "../products/product-embedding-input.server";
import type { QueryRewriteResult } from "./query-rewriter.server";
import { applyFinalRelevanceCutoff } from "./final-relevance-cutoff.server";
import {
  normalizeUnicodeQueryText,
  parseDeterministicQuery,
} from "./deterministic-query-parser.server";
import { invalidateShopSearchDictionary } from "./shop-search-dictionary.server";
import {
  ensureProductSemanticTerms,
  loadProductSemanticRows,
  loadShopSemanticRows,
  replaceProductSemanticProfile,
  scanShopSemanticProfiles,
} from "./product-semantic-profile.server";
import { normalizeSemanticValue } from "./semantic-normalization.server";
import { getSearchCatalogRevisionCached } from "./search-catalog-revision.server";

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
    /** Source-owned target family scope for exact-authority validation only. */
    targetFamilyProductIds: string[];
    directExpansionGroundedProductIds: string[];
    directSourceFacetGroundedProductIds: string[];
    directSourceFacetConsensusProductIds: string[];
    discoverySourceIdentityProductIds: string[];
    ungroundedSourceProductClass: boolean;
    ungroundedExplicitFeature: boolean;
    discoverySourceGroundedProductIds: string[];
    discoveryExpansionGroundedProductIds: string[];
    /** Typed color vocabulary built once with the shop-context index. */
    typedColorVocabulary: string[];
  };
};

type ShopContextLookupIndex = {
  byToken: Map<string, ContextTerm[]>;
  byKind: Map<string, ContextTerm[]>;
  byNormalized: Map<string, ContextTerm[]>;
  contextProductIds: Set<string>;
  canonicalProductIds: Set<string>;
  typedColorVocabulary: Set<string>;
};

type LoadedShopContext = {
  terms: ContextTerm[];
  index: ShopContextLookupIndex;
  cacheStatus: "HIT" | "MISS";
  dbReadMs: number;
  aggregateCodeMs: number;
  totalMs: number;
};

type ShopContextCacheEntry = {
  expiresAt: number;
  catalogRevision: string;
  terms: ContextTerm[];
  index: ShopContextLookupIndex;
};

const contextCache = new Map<string, ShopContextCacheEntry>();
const pendingContextLoads = new Map<string, Promise<LoadedShopContext>>();
const MAX_TOTAL_SHOP_CONTEXT_TERMS = (() => {
  const value = Number.parseInt(
    process.env.AI_SEARCH_SHOP_CONTEXT_CACHE_MAX_TOTAL_TERMS || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 10_000
    ? Math.min(value, 1_000_000)
    : 250_000;
})();

function touchContextCache(shop: string, entry: ShopContextCacheEntry) {
  contextCache.delete(shop);
  contextCache.set(shop, entry);
}

function enforceContextCacheBudget() {
  let totalTerms = [...contextCache.values()].reduce(
    (sum, entry) => sum + entry.terms.length,
    0,
  );
  while (contextCache.size > 50 || totalTerms > MAX_TOTAL_SHOP_CONTEXT_TERMS) {
    const oldest = contextCache.entries().next().value as
      | [string, ShopContextCacheEntry]
      | undefined;
    if (!oldest) break;
    contextCache.delete(oldest[0]);
    totalTerms -= oldest[1].terms.length;
  }
}

const SHOP_CONTEXT_CACHE_TTL_MS = (() => {
  const value = Number.parseInt(
    process.env.AI_SEARCH_SHOP_CONTEXT_CACHE_TTL_MS || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 60_000
    ? Math.min(value, 24 * 60 * 60_000)
    : 6 * 60 * 60_000;
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

export const normalizeContextTerm = normalizeSemanticValue;

function meaningfulTokens(value: string) {
  return normalizeContextTerm(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !VI_STOP_WORDS.has(token));
}

export function buildShopContextLookupIndex(terms: ContextTerm[]): ShopContextLookupIndex {
  const byToken = new Map<string, ContextTerm[]>();
  const byKind = new Map<string, ContextTerm[]>();
  const byNormalized = new Map<string, ContextTerm[]>();
  const contextProductIds = new Set<string>();
  const canonicalProductIds = new Set<string>();
  const typedColorVocabulary = new Set<string>();

  for (const term of terms) {
    if (term.kind === "ATTRIBUTE" || term.kind === "VARIANT_OPTION") {
      const typedColor = term.value.match(/^\s*colou?r\s*[=:]\s*(.+?)\s*$/i);
      if (typedColor) typedColorVocabulary.add(normalizeContextTerm(typedColor[1]));
    }
    const kindList = byKind.get(term.kind) ?? [];
    kindList.push(term);
    byKind.set(term.kind, kindList);

    const normalizedList = byNormalized.get(term.normalizedValue) ?? [];
    normalizedList.push(term);
    byNormalized.set(term.normalizedValue, normalizedList);

    for (const token of new Set(term.tokens)) {
      const tokenList = byToken.get(token) ?? [];
      tokenList.push(term);
      byToken.set(token, tokenList);
    }

    for (const productId of term.productIds) contextProductIds.add(productId);
    if (term.kind === "CANONICAL_PRODUCT_TYPE") {
      for (const productId of term.productIds) canonicalProductIds.add(productId);
    }
  }

  return {
    byToken,
    byKind,
    byNormalized,
    contextProductIds,
    canonicalProductIds,
    typedColorVocabulary,
  };
}

function candidateContextTerms(
  index: ShopContextLookupIndex,
  values: Iterable<string>,
) {
  const candidates = new Set<ContextTerm>();
  for (const value of values) {
    const normalized = normalizeContextTerm(value);
    if (!normalized) continue;
    for (const term of index.byNormalized.get(normalized) ?? []) {
      candidates.add(term);
    }
    for (const token of meaningfulTokens(normalized)) {
      for (const term of index.byToken.get(token) ?? []) {
        candidates.add(term);
      }
    }
  }
  return [...candidates];
}

export function identityLookupTokenVariants(token: string) {
  const variants = new Set([token]);
  if (token.length < 3) return variants;

  // Generate both directions because an English token ending in "s" can be
  // either plural ("sneakers" -> "sneaker") or a singular noun whose plural
  // takes -es ("dress" -> "dresses").
  variants.add(`${token}s`);
  variants.add(`${token}es`);

  if (token.endsWith("ies") && token.length > 4) {
    variants.add(`${token.slice(0, -3)}y`);
  }
  if (token.endsWith("es") && token.length > 4) {
    variants.add(token.slice(0, -2));
  }
  if (token.endsWith("s") && token.length > 3) {
    variants.add(token.slice(0, -1));
  }
  if (token.endsWith("y") && token.length > 3) {
    variants.add(`${token.slice(0, -1)}ies`);
  }
  return variants;
}

function candidateIdentityContextTerms(
  index: ShopContextLookupIndex,
  values: Iterable<string>,
) {
  const candidates = new Set(candidateContextTerms(index, values));
  for (const value of values) {
    for (const token of meaningfulTokens(value)) {
      for (const variant of identityLookupTokenVariants(token)) {
        for (const term of index.byToken.get(variant) ?? []) {
          candidates.add(term);
        }
      }
    }
  }
  return [...candidates];
}

/**
 * All terms capable of scoring in the shop-context pass. Exact matches,
 * direct source/signal token overlap, source-owned semantic MUST values and
 * expansion leaf morphology are captured by the prebuilt inverted index.
 * Unrelated terms have score zero and need no per-query scoring/filter work.
 */
export function selectContextScoreCandidates(
  index: ShopContextLookupIndex,
  signalValues: string[],
  semanticMustFacetTokens: Iterable<string>,
  discoveryExpansionValues: string[],
) {
  return [...new Set([
    ...candidateContextTerms(index, signalValues),
    ...[...semanticMustFacetTokens].flatMap((token) =>
      index.byNormalized.get(token) ?? [],
    ),
    ...(discoveryExpansionValues.length > 0
      ? candidateIdentityContextTerms(index, discoveryExpansionValues)
      : []),
  ])];
}

const GENERIC_DISCOVERY_LEAF_TOKENS = new Set([
  "apparel", "clothing", "accessories", "accessory", "gear", "equipment",
  "essentials", "essential", "product", "products", "item", "items",
  "goods", "outfit", "outfits", "fashion", "style",
]);

const WEAK_EXPANSION_CLASS_TOKENS = new Set([
  "a", "an", "and", "all", "for", "in", "of", "one", "the", "to", "with",
]);

const GENERIC_SOURCE_CONTEXT_TOKENS = new Set([
  "something", "someone", "thing", "things", "item", "items", "product",
  "products", "wear", "wearing", "use", "using", "day", "days", "all",
  "good", "best", "like", "likes", "need", "want", "fashion", "style",
  "weather", "outfit", "outfits", "occasion", "occasions", "activity",
  "activities", "context", "clothing", "apparel", "gear", "equipment",
  "accessory", "accessories",
  // Function words must never prove semantic catalog relevance. They are
  // common across unrelated use-case prose and were previously enough to
  // connect queries such as "... from my computer" to "repelling water from
  // leather".
  "at", "by", "from", "into", "off", "on", "onto", "over", "through",
  "under", "via", "within",
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

const DISCOVERY_SOURCE_IDENTITY_KINDS = new Set([
  "CANONICAL_PRODUCT_TYPE",
  "PRODUCT_TYPE",
  "ALIAS",
]);

export function discoverySourceIdentityCatalogMatch(args: {
  kind: string;
  catalogValue: string;
  semanticTarget: string;
  expansionValues: string[];
}) {
  const target = normalizeContextTerm(args.semanticTarget);
  const catalog = normalizeContextTerm(args.catalogValue);
  if (!target || !catalog) return false;

  const targetTokens = meaningfulTokens(target);
  const catalogTokens = meaningfulTokens(catalog);
  if (targetTokens.length === 0 || catalogTokens.length === 0) return false;
  if (targetTokens.every((token) => GENERIC_DISCOVERY_LEAF_TOKENS.has(token))) {
    return false;
  }

  if (DISCOVERY_SOURCE_IDENTITY_KINDS.has(args.kind)) {
    if (
      !discoveryIdentityTargetLooksLikeProductClass(
        target,
        args.expansionValues,
      )
    ) {
      return false;
    }
    if (target === catalog) return true;
    if (targetTokens.length === 1 && catalogTokens.length === 1) {
      return identityTokenEquivalent(targetTokens[0], catalogTokens[0]);
    }
    return false;
  }

  // CATEGORY is typed catalog taxonomy. The caller only passes targets that
  // are proven to come from the shopper source, so an exact source-owned
  // category is stronger evidence than LLM expansion order (e.g. "jewelry"
  // must not disappear because the model suggested jewelry boxes first).
  if (args.kind === "CATEGORY") return target === catalog;
  if (args.kind !== "TAG" || target !== catalog) return false;

  const leafHints = readDiscoveryLeafTypeHints(args.expansionValues);
  const targetLeaf = targetTokens[targetTokens.length - 1];
  return leafHints.has(targetLeaf);
}

function compactDiscoveryClassTokens(tokens: string[]) {
  return tokens.filter(
    (token) =>
      !GENERIC_DISCOVERY_LEAF_TOKENS.has(token) &&
      !WEAK_EXPANSION_CLASS_TOKENS.has(token),
  );
}

export function discoveryExpansionTypeMatch(
  typeTokens: string[],
  expansionValues: string[],
) {
  const normalizedTypeTokens = compactDiscoveryClassTokens(typeTokens);
  if (normalizedTypeTokens.length === 0) return false;
  const typeSet = new Set(normalizedTypeTokens);
  const typeLeaf = normalizedTypeTokens[normalizedTypeTokens.length - 1];

  return expansionValues.some((value) => {
    const expansionTokens = compactDiscoveryClassTokens(
      meaningfulTokens(value),
    );
    if (expansionTokens.length === 0) return false;
    const expansionLeaf = expansionTokens[expansionTokens.length - 1];

    if (
      expansionTokens.length === normalizedTypeTokens.length &&
      expansionTokens.every(
        (token, index) => token === normalizedTypeTokens[index],
      )
    ) {
      return true;
    }

    // A product-class expansion must agree on the leaf noun. This keeps
    // useful mappings such as "hiking boots" -> "boots" while preventing
    // structural filler such as "all in one" from proving
    // "all-in-one printer" == "all-in-one track tool".
    if (normalizedTypeTokens.length === 1) {
      return expansionLeaf === typeLeaf;
    }
    if (expansionTokens.length === 1) {
      return typeLeaf === expansionLeaf;
    }
    if (typeLeaf !== expansionLeaf) return false;

    const overlap = new Set(
      expansionTokens.filter((token) => typeSet.has(token)),
    ).size;
    return overlap >= 2;
  });
}

function discoveryIdentityTargetLooksLikeProductClass(
  target: string,
  expansionValues: string[],
) {
  const targetTokens = compactDiscoveryClassTokens(meaningfulTokens(target));
  if (targetTokens.length === 0) return false;
  const targetLeaf = targetTokens[targetTokens.length - 1];
  let leafClassMatches = 0;

  for (const value of expansionValues) {
    const expansionTokens = compactDiscoveryClassTokens(
      meaningfulTokens(value),
    );
    if (expansionTokens.length === 0 || expansionTokens.length > 4) continue;
    const expansionLeaf = expansionTokens[expansionTokens.length - 1];

    const exact =
      expansionTokens.length === targetTokens.length &&
      expansionTokens.every(
        (token, index) => token === targetTokens[index],
      );
    if (exact) return true;

    let classLike = false;
    if (targetTokens.length === 1) {
      classLike = expansionLeaf === targetLeaf;
    } else if (expansionTokens.length === 1) {
      classLike = targetLeaf === expansionLeaf;
    } else if (targetLeaf === expansionLeaf) {
      const targetSet = new Set(targetTokens);
      const overlap = new Set(
        expansionTokens.filter((token) => targetSet.has(token)),
      ).size;
      classLike = overlap >= 2;
    }
    if (classLike) leafClassMatches += 1;
  }

  // One incidental sentence ending in a context token ("printer for home") is
  // not enough to promote that token into a product identity. A non-exact
  // target must recur as a product-class leaf across independent expansions.
  return leafClassMatches >= 2;
}

export function discoveryContextProvesSemanticNeed(
  termTokens: string[],
  semanticMustTerms: string[],
) {
  if (semanticMustTerms.length === 0) return false;
  const termSet = new Set(
    termTokens.filter(
      (token) =>
        token.length >= 2 &&
        !GENERIC_SOURCE_CONTEXT_TOKENS.has(token),
    ),
  );
  if (termSet.size === 0) return false;

  const needGroups = semanticMustTerms
    .map((value) => {
      const rawNeedTokens = meaningfulTokens(value);
      const needTokens = rawNeedTokens.filter(
        (token) => !GENERIC_SOURCE_CONTEXT_TOKENS.has(token),
      );
      return { rawNeedTokens, needTokens };
    })
    .filter((group) => group.needTokens.length > 0);

  const matchedGroups = needGroups.filter(({ rawNeedTokens, needTokens }) => {
    // A single bare adjective/context token is too weak to prove an
    // open-world need when the catalog term merely contains it ("indoor
    // ambience" does not prove "indoor cat litter box"). If the shopper's
    // source need was a real phrase and only generic filler was removed
    // ("rainy day" -> "rainy"), preserving that discriminative token is enough.
    if (needTokens.length === 1) {
      return rawNeedTokens.length >= 2
        ? termSet.has(needTokens[0])
        : termSet.size === 1 && termSet.has(needTokens[0]);
    }
    return needTokens.every((token) => termSet.has(token));
  });

  if (matchedGroups.length === 0) return false;
  if (needGroups.length === 1) return true;

  // When the semantic need has several independent MUST concepts, one generic
  // adjunct must not prove the whole need. "home use" cannot prove
  // "espresso + home"; require either one matched multi-token concept or two
  // separately matched MUST groups.
  return (
    matchedGroups.some((group) => group.rawNeedTokens.length >= 2) ||
    matchedGroups.length >= 2
  );
}

function isDefaultVariantPlaceholder(value: string) {
  const normalized = normalizeContextTerm(value);
  return normalized === "default title" || normalized === "title default title";
}

export function collectProductContextTerms(
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

function invalidateShopContextCaches(shop: string) {
  const normalizedShop = shop.trim().toLowerCase();
  contextCache.delete(normalizedShop);
  invalidateShopSearchDictionary(normalizedShop);
}

/**
 * Persist a product semantic profile from terms that have already been
 * computed for the same sync operation. Reusing one canonical term set keeps
 * the JSON profile and Qdrant semantic payload bit-for-bit aligned.
 */
export async function replaceProductShopContextWithTerms({
  shop,
  productId,
  analysis,
  terms,
}: {
  shop: string;
  productId: string;
  analysis: ProductSemanticAnalysis | null;
  terms: ReturnType<typeof collectProductContextTerms>;
}) {
  const count = await replaceProductSemanticProfile({
    shop,
    productId,
    analysis,
    terms,
  });

  invalidateShopContextCaches(shop);
  return count;
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
  return replaceProductShopContextWithTerms({
    shop,
    productId: product.id,
    analysis,
    terms,
  });
}

export async function ensureProductShopContext({
  shop,
  product,
}: {
  shop: string;
  product: ProductForIndex;
}) {
  const deterministicTerms = collectProductContextTerms(product, null);
  const count = await ensureProductSemanticTerms({
    shop,
    productId: product.id,
    terms: deterministicTerms,
  });
  invalidateShopContextCaches(shop);
  return count;
}

export async function replaceProductWithDeterministicShopContext({
  shop,
  product,
}: {
  shop: string;
  product: ProductForIndex;
}) {
  const deterministicTerms = collectProductContextTerms(product, null);
  const count = await replaceProductSemanticProfile({
    shop,
    productId: product.id,
    analysis: null,
    terms: deterministicTerms,
  });
  invalidateShopContextCaches(shop);
  return count;
}

export async function getShopContextCoverage(shop: string) {
  const indexedProductCount = await db.aiSearchIndexedProduct.count({
    where: { shop, searchable: true, hasVector: true },
  });

  const contextProducts = new Set<string>();
  const canonicalProducts = new Set<string>();
  const baseProducts = new Set<string>();

  await scanShopSemanticProfiles(shop, ({ productId, terms }) => {
    if (terms.length > 0) contextProducts.add(productId);
    if (terms.some((term) => term.kind === "CANONICAL_PRODUCT_TYPE")) {
      canonicalProducts.add(productId);
    }
    if (
      terms.some((term) =>
        ["PRODUCT_TITLE", "PRODUCT_TYPE", "CANONICAL_PRODUCT_TYPE"].includes(
          term.kind,
        ),
      )
    ) {
      baseProducts.add(productId);
    }
  });

  return {
    contextProducts: contextProducts.size,
    canonicalTypeProducts: canonicalProducts.size,
    coverageRatio:
      contextProducts.size > 0
        ? canonicalProducts.size / contextProducts.size
        : 0,
    productsMissingDeterministicBaseContext: Math.max(
      0,
      indexedProductCount - baseProducts.size,
    ),
  };
}

async function loadShopContextUncached(
  shop: string,
  catalogRevision: string,
): Promise<LoadedShopContext> {
  const startedAt = Date.now();
  const cached = contextCache.get(shop);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.catalogRevision === catalogRevision
  ) {
    touchContextCache(shop, cached);
    return {
      terms: cached.terms,
      index: cached.index,
      cacheStatus: "HIT" as const,
      dbReadMs: 0,
      aggregateCodeMs: 0,
      totalMs: Date.now() - startedAt,
    };
  }

  const dbStartedAt = Date.now();
  const aggregated = new Map<string, ContextTerm>();

  await scanShopSemanticProfiles(
    shop,
    ({ productId, terms: profileTerms }) => {
      for (const row of profileTerms) {
        const key = `${row.kind}\u0000${row.normalizedValue}`;
        const existing = aggregated.get(key);
        if (existing) {
          if (!existing.productIds.has(productId)) {
            existing.productIds.add(productId);
            existing.productCount += 1;
          }
          continue;
        }

        aggregated.set(key, {
          kind: row.kind,
          value: row.value,
          normalizedValue: row.normalizedValue,
          productCount: 1,
          productIds: new Set([productId]),
          tokens: meaningfulTokens(row.normalizedValue),
        });
      }
    },
  );

  const dbReadMs = Date.now() - dbStartedAt;
  const aggregateStartedAt = Date.now();
  const terms = [...aggregated.values()];
  const index = buildShopContextLookupIndex(terms);
  const aggregateCodeMs = Date.now() - aggregateStartedAt;
  touchContextCache(shop, {
    expiresAt: Date.now() + SHOP_CONTEXT_CACHE_TTL_MS,
    catalogRevision,
    terms,
    index,
  });
  enforceContextCacheBudget();
  return {
    terms,
    index,
    cacheStatus: "MISS" as const,
    dbReadMs,
    aggregateCodeMs,
    totalMs: Date.now() - startedAt,
  };
}

async function loadShopContext(shop: string): Promise<LoadedShopContext> {
  const normalizedShop = shop.trim().toLowerCase();
  const revisionSnapshot =
    await getSearchCatalogRevisionCached(normalizedShop);
  const catalogRevision = revisionSnapshot?.semanticRevision ?? "0";

  const cached = contextCache.get(normalizedShop);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.catalogRevision === catalogRevision
  ) {
    touchContextCache(normalizedShop, cached);
    return {
      terms: cached.terms,
      index: cached.index,
      cacheStatus: "HIT",
      dbReadMs: 0,
      aggregateCodeMs: 0,
      totalMs: 0,
    };
  }

  const pendingKey = `${normalizedShop}\u0000${catalogRevision}`;
  const pending = pendingContextLoads.get(pendingKey);
  if (pending) return pending;

  const task = loadShopContextUncached(
    normalizedShop,
    catalogRevision,
  );
  pendingContextLoads.set(pendingKey, task);

  try {
    return await task;
  } finally {
    if (pendingContextLoads.get(pendingKey) === task) {
      pendingContextLoads.delete(pendingKey);
    }
  }
}

export async function warmShopContext(shop: string) {
  await loadShopContext(shop);
}

const PRODUCT_IDENTITY_KINDS = new Set([
  "CANONICAL_PRODUCT_TYPE",
]);

export function preferTypedContextEvidence<T extends { kind: string; normalizedValue: string }>(terms: T[]): T[] {
  const identities = new Set(terms.filter(term => PRODUCT_IDENTITY_KINDS.has(term.kind)).map(term => term.normalizedValue));
  return terms.filter(term => !identities.has(term.normalizedValue) || PRODUCT_IDENTITY_KINDS.has(term.kind));
}

export function matchesExplicitNegativeFacet(values: string[], negative: string): boolean {
  const normalize = (value: string) => normalizeContextTerm(value).replace(/đ/g, "d").replace(/\bhooded\b/g, "hood");
  const tokens = normalize(negative).split(" ").filter(Boolean);
  if (!tokens.length) return false;
  return values.some(value => {
    const text = normalize(value);
    // Absence declarations are not positive evidence of the forbidden feature.
    if (tokens.length === 1 && text.split(" ").some((token, index, all) =>
      token === tokens[0] && ["no", "without", "non"].includes(all[index - 1]))) return false;
    const present = new Set(text.split(" "));
    return tokens.every(token => present.has(token));
  });
}

export function shouldEnforceDirectIdentity(args: {
  retrievalMode: string;
  signals: Array<{ fallback?: boolean }>;
  hasIdentityMatch: boolean;
  hasSourceOwnedTargetIdentity?: boolean;
}): boolean {
  // Raw-query fallback is a recall hint when the planner found no typed
  // identity. It must not turn broad terms such as "clothing" into a leaf
  // product-type hard filter.
  return (args.retrievalMode === "DIRECT" ||
      (args.retrievalMode === "COMPLEMENT" && args.hasSourceOwnedTargetIdentity === true)) &&
    args.hasIdentityMatch &&
    args.signals.some((signal) => signal.fallback !== true);
}

const FALLBACK_PRODUCT_IDENTITY_KINDS = new Set([
  "PRODUCT_TYPE",
  "ALIAS",
  "CATEGORY",
]);

function isComplementaryRelationText(value: string) {
  return /\b(?:pair(?:s|ed|ing)?(?: well)? with|go(?:es|ing)?(?: well)? with|match(?:es|ed|ing)?(?: with)?|wear with|style with|mac(?: gi)? voi|phoi(?: do)? voi|ket hop voi|hop voi|di cung voi)\b/.test(
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
      /^(?:matches|matching|matched)$/.test(token) ||
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

const IDENTITY_SINGLE_LETTER_MARKERS = new Set(["t", "v", "u", "x"]);

export function normalizeIdentitySignalTokens(value: string) {
  return normalizeContextTerm(value)
    .split(" ")
    .filter(Boolean)
    .filter(
      (token) =>
        (
          token.length >= 2 && !VI_STOP_WORDS.has(token)
        ) ||
        IDENTITY_SINGLE_LETTER_MARKERS.has(token),
    )
    .filter((token) => !IDENTITY_AUDIENCE_TOKENS.has(token));
}

function buildProductIdentitySignals(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  const explicitCategoryValues = (rewrite.planning?.resolvedSegments ?? [])
    .filter((segment) => segment.field === "CATEGORY" && segment.confidence >= 0.9)
    .map((segment) => segment.canonicalValue)
    .filter(Boolean);
  const explicitIdentityValues = [
    rewrite.analysis.productType,
    ...(rewrite.analysis.productTypes ?? []),
    rewrite.analysis.shopLanguageProductType,
    ...explicitCategoryValues,
  ].filter((value) => value?.trim());
  const sourceIdentities = rewrite.analysis.sourceOwnedTargetIdentities ?? [];
  const targetIdentityValues =
    sourceIdentities.length > 0 ? sourceIdentities : explicitIdentityValues;

  return [
    ...targetIdentityValues.map((value) => ({ value, fallback: false })),
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

function identityTokenEquivalent(left: string, right: string) {
  if (left === right) return true;
  if (left.length < 3 || right.length < 3) return false;

  const singularPluralPair = (singular: string, plural: string) =>
    plural === `${singular}s` ||
    plural === `${singular}es` ||
    (
      singular.endsWith("y") &&
      singular.length > 3 &&
      plural === `${singular.slice(0, -1)}ies`
    );

  return singularPluralPair(left, right) || singularPluralPair(right, left);
}

function strongIdentityMatch(
  term: Pick<ContextTerm, "normalizedValue" | "tokens">,
  signal: { normalized: string; tokens: string[]; fallback?: boolean },
) {
  if (term.normalizedValue === signal.normalized) return 1;

  const termTokens = [...new Set(term.tokens)];
  const signalTokens = [...new Set(signal.tokens)];
  const common = signalTokens.filter((token) =>
    termTokens.some((termToken) => identityTokenEquivalent(token, termToken)),
  );
  if (common.length === 0) return 0;

  if (
    signalTokens.length >= 2 &&
    !termTokens.some((termToken) =>
      identityTokenEquivalent(signalTokens.at(-1) ?? "", termToken),
    )
  ) {
    return 0;
  }

  // For direct identity matching, a catalog type that appends another head
  // noun after the requested identity is usually a different product class,
  // not a more specific version of the same product. Examples: "bicycle
  // frameset", "phone case", or "shoe laces". Prefix modifiers such as
  // "waterproof jacket" remain valid because the requested identity is still
  // the final head noun. This prevents components/accessories from inheriting
  // a perfect identity score merely because they contain every query token.
  if (signal.tokens.length > 0 && term.tokens.length > signal.tokens.length) {
    let sequenceStart = -1;
    for (let start = 0; start <= term.tokens.length - signal.tokens.length; start += 1) {
      const matchesSequence = signal.tokens.every((token, index) =>
        identityTokenEquivalent(token, term.tokens[start + index] ?? ""),
      );
      if (matchesSequence) {
        sequenceStart = start;
        break;
      }
    }
    if (
      sequenceStart >= 0 &&
      sequenceStart + signal.tokens.length < term.tokens.length
    ) {
      return 0;
    }
  }

  const signalCoverage = common.length / signalTokens.length;
  const termCoverage = common.length / Math.max(1, termTokens.length);
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

export function referenceIdentityContainmentMatch(
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

      // Reference qualifiers describe the item already owned/worn, not a
      // requirement for the target recommendation. "with a black skirt"
      // must exclude every skirt subtype (pleated skirt, midi skirt, etc.),
      // not only products whose identity also contains "black". Use the
      // reference head noun as a class-level exclusion signal.
      const referenceHead = referenceTokens.at(-1);
      const identityHead = identityTokens.at(-1);
      if (
        referenceHead &&
        identityHead &&
        referenceHead === identityHead
      ) {
        best = Math.max(best, 0.95);
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
  // Catalog facts enrich grounding/reranking, never the primary dense text.
  const natural = rewrite.query || rewrite.planning?.semanticQuery ||
    (rewrite.analysis.intent !== "unknown" ? rewrite.analysis.intent : originalQuery);
  return clean(natural.split(/\s*;\s*/)[0], 500);

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
  const contextIndex = loaded.index;
  const loadMs = Date.now() - loadStartedAt;
  const signalBuildStartedAt = Date.now();
  const filterStartedAt = Date.now();
  const identitySignals = buildProductIdentitySignals(originalQuery, rewrite);
  const hasAnalyzedProductType = identitySignals.some((signal) => !signal.fallback);
  const allContextProductIds = contextIndex.contextProductIds;
  const canonicalContextProductIds = contextIndex.canonicalProductIds;
  const canonicalTypeCoverageComplete =
    allContextProductIds.size > 0 &&
    canonicalContextProductIds.size === allContextProductIds.size;
  const matchingProductIds = new Set<string>();
  const matchingIdentityTerms = new Set<ContextTerm>();
  const identityCandidateTerms = candidateIdentityContextTerms(
    contextIndex,
    identitySignals.map((signal) => signal.value),
  );
  for (const term of identityCandidateTerms) {
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
    for (const term of identityCandidateTerms) {
      if (!FALLBACK_PRODUCT_IDENTITY_KINDS.has(term.kind)) continue;
      if (!identitySignals.some((signal) => term.normalizedValue === signal.normalized)) {
        continue;
      }
      matchingIdentityTerms.add(term);
      for (const productId of term.productIds) matchingProductIds.add(productId);
    }
  }

  // Family scope is intentionally broader than exact canonical identity.
  // Merchant PRODUCT_TYPE/CATEGORY/ALIAS may express a parent family such as
  // "Shoes" while CANONICAL_PRODUCT_TYPE stores leaf types such as loafer or
  // oxford. Use this scope for facet grounding only; exact identity gating
  // continues to use matchingProductIds.
  const familyProductIds = new Set(matchingProductIds);
  if (hasAnalyzedProductType) {
    for (const term of identityCandidateTerms) {
      if (!FALLBACK_PRODUCT_IDENTITY_KINDS.has(term.kind)) continue;
      if (
        !identitySignals.some(
          (signal) => strongIdentityMatch(term, signal) > 0,
        )
      ) {
        continue;
      }
      for (const productId of term.productIds) familyProductIds.add(productId);
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
  const semanticExpansionValues = rewrite.analysis.semanticExpansions ?? [];
  const discoveryExpansionValues =
    currentContextRetrievalMode === "DISCOVERY"
      ? semanticExpansionValues
      : [];
  const softDiscoveryEvidenceTerms = new Set(
    (rewrite.analysis.optionalPreferences ?? [])
      .map(normalizeContextTerm)
      .filter(Boolean),
  );
  const discoveryEvidenceMustTerms =
    currentContextRetrievalMode === "DISCOVERY"
      ? rewrite.fallbackReason
        ? (rewrite.analysis.semanticMustTerms ?? [])
        : (rewrite.analysis.semanticMustTerms ?? []).filter(
            (term) => !softDiscoveryEvidenceTerms.has(normalizeContextTerm(term)),
          )
      : [];
  const rawSourceOwnedDiscoveryIdentityTargets =
    currentContextRetrievalMode === "DISCOVERY"
      ? discoveryEvidenceMustTerms.filter((target) =>
          Boolean(sourceSemanticTermForCanonical(originalQuery, rewrite, target)) ||
          sourceContainsFacet(originalQuery, target),
        )
      : [];
  // The primary translated query can resolve a compound catalog category.
  // Keep that complete class instead of independently grounding its parts:
  // "bicycle accessories" must not become the class "bicycle" when MUST
  // terms are split or source/translation term arrays have different order.
  const resolvedPrimaryCategories = (rewrite.planning?.resolvedSegments ?? [])
    .filter((segment) => segment.field === "CATEGORY" && segment.confidence >= 0.95)
    .filter((segment) =>
      normalizeContextTerm(segment.text) ===
        normalizeContextTerm(rewrite.planning?.semanticQuery ?? rewrite.analysis.intent),
    )
    .map((segment) => segment.canonicalValue)
    .filter((value) =>
      (contextIndex.byNormalized.get(normalizeContextTerm(value)) ?? [])
        .some((term) => term.kind === "CATEGORY"),
    );
  const sourceOwnedDiscoveryIdentityTargets = currentContextRetrievalMode === "DISCOVERY"
    ? [...new Set([
        ...resolvedPrimaryCategories,
        ...rawSourceOwnedDiscoveryIdentityTargets.filter((target) =>
          !resolvedPrimaryCategories.some((category) => sourceContainsFacet(category, target)),
        ),
      ])]
    : [];
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
    [...semanticMustFacetTokens].some((token) =>
      (contextIndex.byNormalized.get(token) ?? [])
        .some((term) => semanticMustFacetKinds.has(term.kind)),
    );
  const productTypeTokens = new Set(
    meaningfulTokens(rewrite.analysis.productType),
  );
  const hasMaleRequest = originalTokens.has("nam");
  const hasFemaleRequest = originalTokens.has("nu");
  const signalBuildCodeMs = Date.now() - signalBuildStartedAt;

  const sourceIdentityOwnsTerm = (term: ContextTerm) =>
    identitySignals.some(
      (signal) =>
        signal.fallback !== true &&
        strongIdentityMatch(term, signal) > 0,
    );

  const skipContextEnrichment =
    rewrite.analysis.decisionReason.includes("LLM_DEFERRED_BACKGROUND");
  const scoreStartedAt = Date.now();
  // The index already maps normalized values and tokens to relevant terms.
  // Only these can score: ordinary signal overlap, an explicit semantic MUST,
  // or an expansion-grounded discovery leaf (including plural morphology).
  // Scanning every catalog term here was O(shop vocabulary × query signals)
  // even on warm cache hits.
  const contextTermCandidates = skipContextEnrichment
    ? []
    : selectContextScoreCandidates(
        contextIndex,
        signals.map((signal) => signal.normalized),
        semanticMustFacetTokens,
        currentContextRetrievalMode === "DISCOVERY" ? discoveryExpansionValues : [],
      );
  const scoredTerms = skipContextEnrichment
    ? []
    : contextTermCandidates
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
          !matchingIdentityTerms.has(term) &&
          !sourceIdentityOwnsTerm(term) &&
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
        semanticMustFacetTokens.has(term.normalizedValue)
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
        discoveryExpansionTypeMatch(term.tokens, discoveryExpansionValues)
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
  const climateContextPolarity = (value: string) => {
    const normalized = normalizeContextTerm(value);
    const cold =
      /\b(?:cold weather|cold climate|freezing|winter|snowy|chilly)\b/.test(
        normalized,
      );
    const hot =
      /\b(?:hot weather|warm weather|hot climate|warm climate|summer|heat)\b/.test(
        normalized,
      );
    return { cold, hot };
  };
  const sourceClimate = climateContextPolarity(originalQuery);

  const groundedTerms = scoredTerms.filter((term) => {
    const termClimate = climateContextPolarity(term.normalizedValue);
    if (
      (sourceClimate.cold && termClimate.hot) ||
      (sourceClimate.hot && termClimate.cold)
    ) {
      return false;
    }

    if (
      currentContextRetrievalMode === "DISCOVERY" &&
      ["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "ALIAS", "CATEGORY"].includes(
        term.kind,
      )
    ) {
      const expansionGrounded =
        term.kind === "CANONICAL_PRODUCT_TYPE" &&
        discoveryExpansionTypeMatch(term.tokens, discoveryExpansionValues);
      const sourceGrounded =
        sourceIdentityOwnsTerm(term) ||
        sourceOwnedDiscoveryIdentityTargets.some((target) =>
          discoverySourceIdentityCatalogMatch({
            kind: term.kind,
            catalogValue: term.value,
            semanticTarget: target,
            expansionValues: semanticExpansionValues,
          }),
        );
      if (!expansionGrounded && !sourceGrounded) return false;
    }

    const sourceOverlap = term.tokens.filter((token) => sourceNeedTokens.has(token));
    if (
      currentContextRetrievalMode === "DISCOVERY" &&
      term.kind === "ATTRIBUTE"
    ) {
      const exactSemanticMust =
        term.tokens.length === 1 &&
        term.tokens.some((token) => semanticMustFacetTokens.has(token));
      if (!exactSemanticMust && sourceOverlap.length < 2) return false;
    }
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
  // A merchant tag can outscore the identical typed identity. Deduplicating
  // by text alone must not discard that identity's provenance: downstream
  // semantic guards intentionally do not treat arbitrary tags as proof.
  for (const term of preferTypedContextEvidence(groundedTerms).sort(
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
  const directIdentityTokens = new Set(
    identitySignals.flatMap((signal) =>
      signal.tokens.flatMap((token) => [...identityLookupTokenVariants(token)]),
    ),
  );
  const directNeedTokens = new Set(
    (rewrite.analysis.semanticMustTerms ?? [])
      .flatMap((value) =>
        normalizeContextTerm(value).split(" ").filter(Boolean),
      )
      .filter((token) => !directIdentityTokens.has(token)),
  );
  const directEvidenceExpansionValues =
    directNeedTokens.size > 0
      ? semanticExpansionValues.filter((value) => {
          const tokens = normalizeContextTerm(value).split(" ").filter(Boolean);
          return tokens.some((token) => directNeedTokens.has(token));
        })
      : [];
  const allowDirectExpansionEvidence =
    currentContextRetrievalMode === "DIRECT" &&
    matchingProductIds.size > 0 &&
    directEvidenceExpansionValues.length > 0;
  const exactDirectExpansionGroundedProductIds =
    allowDirectExpansionEvidence
      ? [
          ...new Set(
            directEvidenceExpansionValues
              .flatMap((value) =>
                contextIndex.byNormalized.get(normalizeContextTerm(value)) ?? [],
              )
              .filter((term) => {
                if (term.kind !== "CANONICAL_PRODUCT_TYPE") return false;
                // DIRECT expansion evidence must name a concrete catalog leaf,
                // not merely contain the broad source identity. Otherwise
                // hallucinated phrases such as "bag for boiling water" make
                // CANONICAL_PRODUCT_TYPE=bag look like proof that the need
                // exists. Require an exact normalized subtype phrase and do not
                // count the source identity itself.
                if (
                  identitySignals.some(
                    (signal) => signal.normalized === term.normalizedValue,
                  )
                ) {
                  return false;
                }
                return directEvidenceExpansionValues.some(
                  (value) =>
                    normalizeContextTerm(value) === term.normalizedValue,
                );
              })
              .flatMap((term) =>
                [...term.productIds].filter((productId) =>
                  matchingProductIds.has(productId),
                ),
              ),
          ),
        ].slice(0, 1_000)
      : [];

  const directExpansionSupportByProduct = new Map<string, Set<string>>();
  if (
    currentContextRetrievalMode === "DIRECT" &&
    familyProductIds.size > 0 &&
    semanticExpansionValues.length > 0
  ) {
    for (const term of candidateContextTerms(contextIndex, semanticExpansionValues)) {
      if (
        ![
          "CANONICAL_PRODUCT_TYPE",
          "PRODUCT_TYPE",
          "ALIAS",
          "USE_CASE",
          "SOFT_CONTEXT",
          "ATTRIBUTE",
          "COMPATIBILITY",
        ].includes(term.kind)
      ) {
        continue;
      }
      const supportingExpansions = semanticExpansionValues
        .filter((expansion) =>
          directExpansionFactMatch(
            expansion,
            term.value,
            directIdentityTokens,
          ),
        )
        .map(normalizeContextTerm)
        .filter(Boolean);
      if (supportingExpansions.length === 0) continue;
      for (const productId of term.productIds) {
        if (!familyProductIds.has(productId)) continue;
        const support =
          directExpansionSupportByProduct.get(productId) ?? new Set<string>();
        supportingExpansions.forEach((value) => support.add(value));
        directExpansionSupportByProduct.set(productId, support);
      }
    }
  }
  const multiExpansionGroundedProductIds = [
    ...directExpansionSupportByProduct.entries(),
  ]
    .filter(([, support]) => support.size >= 2)
    .map(([productId]) => productId);
  const directExpansionGroundedProductIds = [
    ...new Set([
      ...exactDirectExpansionGroundedProductIds,
      ...multiExpansionGroundedProductIds,
    ]),
  ].slice(0, 1_000);
  const directSourceFacetSignals =
    currentContextRetrievalMode === "DIRECT"
      ? sourceGroundedAttributeFacets(originalQuery, rewrite)
      : [];
  const directSourceFacetEvidenceSignals =
    directSourceFacetSignals.filter((signal) => !isCommerceOnlyValue(signal));
  const collectDirectFacetProducts = (facet: string) => {
    const productIds = new Set<string>();
    for (const term of candidateContextTerms(contextIndex, [facet])) {
      if (
        ![
          "ATTRIBUTE",
          "VARIANT_OPTION",
          "USE_CASE",
          "SOFT_CONTEXT",
          "COMPATIBILITY",
        ].includes(term.kind) ||
        !sourceContextCatalogValueMatch(term.kind, term.value, facet)
      ) {
        continue;
      }
      for (const productId of term.productIds) {
        if (
          familyProductIds.size === 0 ||
          familyProductIds.has(productId)
        ) {
          productIds.add(productId);
        }
      }
    }
    return productIds;
  };
  const directSourceFacetProductSets =
    directSourceFacetEvidenceSignals.map(collectDirectFacetProducts);
  const directSourceFacetGroundedProductIds = [
    ...new Set(
      directSourceFacetProductSets.flatMap((set) => [...set]),
    ),
  ].slice(0, 1_000);

  // Consensus is reserved for source-owned high-confidence objective/capability
  // facets. Soft contexts such as "everyday wear" continue to rerank, but do
  // not become an AND gate with an explicit attribute such as "comfortable".
  const directConsensusFacetSignals = [
    ...new Set(
      (rewrite.planning?.resolvedSegments ?? [])
        .filter(
          (segment) =>
            ["ATTRIBUTE", "COMPATIBILITY"].includes(segment.field) &&
            segment.confidence >= 0.8 &&
            sourceContainsFacet(originalQuery, segment.text),
        )
        .map((segment) => normalizeContextTerm(segment.canonicalValue))
        .filter(Boolean)
        .filter((signal) => directSourceFacetEvidenceSignals.includes(signal))
        .filter((signal) => !isCommerceOnlyValue(signal)),
    ),
  ];
  const directConsensusFacetProductSets =
    directConsensusFacetSignals.map(collectDirectFacetProducts);
  const allDirectConsensusFacetsGrounded =
    directConsensusFacetProductSets.length > 0 &&
    directConsensusFacetProductSets.every((set) => set.size > 0);
  const directSourceFacetConsensusProductIds =
    allDirectConsensusFacetsGrounded
      ? [
          ...directConsensusFacetProductSets
            .slice(1)
            .reduce(
              (intersection, set) =>
                new Set(
                  [...intersection].filter((productId) => set.has(productId)),
                ),
              new Set(directConsensusFacetProductSets[0]),
            ),
        ].slice(0, 1_000)
      : [];
  const discoverySourceIdentityProductIds =
    sourceOwnedDiscoveryIdentityTargets.length > 0
      ? [
          ...new Set(
            candidateIdentityContextTerms(contextIndex, sourceOwnedDiscoveryIdentityTargets)
              .filter((term) =>
                sourceOwnedDiscoveryIdentityTargets.some((target) =>
                  discoverySourceIdentityCatalogMatch({
                    kind: term.kind,
                    catalogValue: term.value,
                    semanticTarget: target,
                    expansionValues: semanticExpansionValues,
                  }),
                ),
              )
              .flatMap((term) => [...term.productIds]),
          ),
        ].slice(0, 2_000)
      : [];
  // A shopper-owned product class needs typed identity evidence. An attribute
  // shared by another family cannot establish that class, regardless of cosine.
  const ungroundedSourceProductClass = canonicalTypeCoverageComplete &&
    sourceOwnedDiscoveryIdentityTargets.some((target) =>
      discoveryIdentityTargetLooksLikeProductClass(target, semanticExpansionValues) &&
      !candidateIdentityContextTerms(contextIndex, [target]).some((term) =>
        (term.kind === "CATEGORY" && term.normalizedValue === normalizeContextTerm(target)) ||
        (["USE_CASE", "SOFT_CONTEXT"].includes(term.kind) &&
          sourceContextCatalogValueMatch(term.kind, term.value, target)) ||
        discoverySourceIdentityCatalogMatch({
          kind: term.kind, catalogValue: term.value, semanticTarget: target,
          expansionValues: semanticExpansionValues,
        }),
      ),
    );
  // Explicit "with X" denotes a requested feature. If the planner left X
  // unresolved, neighboring family/context facts do not prove that feature.
  const explicitFeature = originalQuery.match(/\bwith\s+([^,.;!?]+)$/iu)?.[1]?.trim();
  const unresolvedFeature = explicitFeature &&
    !(rewrite.planning?.resolvedSegments ?? []).some((segment) =>
      normalizeContextTerm(segment.text).includes(normalizeContextTerm(explicitFeature)) ||
      normalizeContextTerm(segment.canonicalValue).includes(normalizeContextTerm(explicitFeature)),
    );
  const ungroundedExplicitFeature = Boolean(unresolvedFeature &&
    !candidateContextTerms(contextIndex, [explicitFeature!]).some((term) =>
      ["ATTRIBUTE", "VARIANT_OPTION", "USE_CASE", "COMPATIBILITY"].includes(term.kind) &&
      sourceContextCatalogValueMatch(term.kind, term.value, explicitFeature!),
    ));
  const resolvedDiscoverySourceFacetSignals =
    currentContextRetrievalMode === "DISCOVERY"
      ? [
          ...new Set(
            (rewrite.planning?.resolvedSegments ?? [])
              .filter(
                (segment) =>
                  ["CONTEXT", "ATTRIBUTE", "COMPATIBILITY"].includes(
                    segment.field,
                  ) &&
                  segment.confidence >= 0.7,
              )
              .map((segment) =>
                normalizeContextTerm(segment.canonicalValue),
              )
              .filter(Boolean),
          ),
        ]
      : [];
  const sourceOwnedTranslatedFacetSignals =
    currentContextRetrievalMode === "DISCOVERY"
      ? (() => {
          const source = sourceTargetText(originalQuery, rewrite);
          const targetTerms = rewrite.analysis.semanticMustTerms ?? [];
          const sourceTerms = rewrite.analysis.semanticSourceMustTerms ?? [];
          const length = Math.min(targetTerms.length, sourceTerms.length);
          const signals = new Set<string>();
          for (let index = 0; index < length; index += 1) {
            const target = normalizeContextTerm(targetTerms[index] ?? "");
            const sourceTerm = sourceTerms[index] ?? "";
            if (
              !target ||
              !sourceTerm ||
              !sourceContainsFacet(source, sourceTerm) ||
              isCommerceOnlyValue(target)
            ) {
              continue;
            }
            const tokens = meaningfulTokens(target);
            if (
              tokens.length === 0 ||
              tokens.every((token) => GENERIC_SOURCE_CONTEXT_TOKENS.has(token))
            ) {
              continue;
            }
            // If the translated target itself looks like a product class
            // ("tai nghe" -> "headphones"), it must be proven by identity/
            // taxonomy evidence. Do not let an accessory COMPATIBILITY or
            // incidental ATTRIBUTE mentioning that class establish existence.
            if (
              discoveryIdentityTargetLooksLikeProductClass(
                target,
                semanticExpansionValues,
              )
            ) {
              continue;
            }
            signals.add(target);
          }
          return [...signals];
        })()
      : [];
  const translatedFacetSignalSet = new Set(sourceOwnedTranslatedFacetSignals);
  const resolvedFacetSignalSet = new Set(resolvedDiscoverySourceFacetSignals);
  const discoverySourceFacetSignals =
    currentContextRetrievalMode === "DISCOVERY"
      ? [
          ...new Set([
            ...resolvedDiscoverySourceFacetSignals,
            ...sourceOwnedTranslatedFacetSignals,
          ]),
        ]
      : [];
  const discoverySourceFacetProductIds =
    discoverySourceFacetSignals.length > 0
      ? [
          ...new Set(
            candidateContextTerms(contextIndex, discoverySourceFacetSignals)
              .filter(
                (term) =>
                  [
                    "ATTRIBUTE",
                    "VARIANT_OPTION",
                    "USE_CASE",
                    "SOFT_CONTEXT",
                    "COMPATIBILITY",
                  ].includes(term.kind) &&
                  discoverySourceFacetSignals.some((signal) => {
                    const translatedOnly =
                      translatedFacetSignalSet.has(signal) &&
                      !resolvedFacetSignalSet.has(signal);
                    if (
                      translatedOnly &&
                      meaningfulTokens(signal).length === 1 &&
                      ["ATTRIBUTE", "VARIANT_OPTION", "COMPATIBILITY"].includes(
                        term.kind,
                      )
                    ) {
                      // A translated one-word open-world need ("print",
                      // "weekend", "hiking") may ground through explicit
                      // use-case/context facts, but not through an incidental
                      // attribute or compatibility mention.
                      return false;
                    }
                    return sourceContextCatalogValueMatch(
                      term.kind,
                      term.value,
                      signal,
                    );
                  }),
              )
              .flatMap((term) => [...term.productIds]),
          ),
        ].slice(0, 2_000)
      : [];
  // A context adjunct alone cannot establish a multi-part functional need.
  // Validate source evidence on each product, independent of display budgets.
  const discriminativeDiscoveryNeeds = (rewrite.analysis.semanticMustTerms ?? []).filter(
    (value) => meaningfulTokens(value).some(
      (token) => !GENERIC_SOURCE_CONTEXT_TOKENS.has(token),
    ),
  );
  const sourceNeedSupport = new Map<string, Set<number>>();
  if (discriminativeDiscoveryNeeds.length >= 3) {
    for (const term of candidateContextTerms(contextIndex, discriminativeDiscoveryNeeds)) {
      if (!["USE_CASE", "SOFT_CONTEXT", "COMPATIBILITY"].includes(term.kind)) continue;
      discriminativeDiscoveryNeeds.forEach((need, index) => {
        if (!sourceContextCatalogValueMatch(term.kind, term.value, need)) return;
        for (const id of term.productIds) {
          const support = sourceNeedSupport.get(id) ?? new Set<number>();
          support.add(index);
          sourceNeedSupport.set(id, support);
        }
      });
    }
  }
  const discoverySourceGroundedProductIds =
    currentContextRetrievalMode === "DISCOVERY"
      ? [
          ...new Set([
            ...discoverySourceIdentityProductIds,
            ...discoverySourceFacetProductIds,
            ...selectedContextTerms
              .filter((term) => {
                if (term.score < 25) return false;
                const fallbackExactSourceFacet = Boolean(
                  rewrite.fallbackReason &&
                  discoveryEvidenceMustTerms.some(
                    (must) =>
                      normalizeContextTerm(must) === term.normalizedValue,
                  ),
                );
                if (fallbackExactSourceFacet) return true;
                const sourceOverlap = term.tokens.filter(
                  (token) => sourceNeedTokens.has(token),
                );
                if (term.kind === "USE_CASE" || term.kind === "SOFT_CONTEXT") {
                  const hasDiscriminativeSourceOverlap = sourceOverlap.some(
                    (token) =>
                      token.length >= 4 &&
                      !GENERIC_SOURCE_CONTEXT_TOKENS.has(token),
                  );
                  return (
                    hasDiscriminativeSourceOverlap &&
                    discoveryContextProvesSemanticNeed(
                      term.tokens,
                      discoveryEvidenceMustTerms,
                    )
                  );
                }
                // A single adjective (for example "comfortable") may be a
                // useful embedding hint, but is not enough to prove that a
                // product itself satisfies an open-world need. Require a
                // multi-token attribute overlap before granting the stronger
                // source-grounding rerank bonus.
                return (
                  term.kind === "ATTRIBUTE" &&
                  sourceOverlap.length >= 2 &&
                  discoveryContextProvesSemanticNeed(
                    term.tokens,
                    discoveryEvidenceMustTerms,
                  )
                );
              })
              .flatMap((term) => [...term.productIds]),
          ]),
        ].filter((id) =>
          discriminativeDiscoveryNeeds.length < 3 ||
          discoverySourceIdentityProductIds.includes(id) ||
          (sourceNeedSupport.get(id)?.size ?? 0) >=
            Math.ceil(discriminativeDiscoveryNeeds.length / 2),
        ).slice(0, 1_000)
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
                  discoveryExpansionTypeMatch(
                    term.tokens,
                    discoveryExpansionValues,
                  ),
              )
              .flatMap((term) => [...term.productIds]),
          ),
        ].slice(0, 1_000)
      : [];
  const sortSelectCodeMs = Date.now() - sortStartedAt;
  const filterMs = Date.now() - filterStartedAt;
  const composeStartedAt = Date.now();
  const query = composeContextualEmbeddingInput(originalQuery, rewrite, selectedTerms);
  // Shop context is open-world grounding, not absence proof. A translated
  // shopper target may be semantically equivalent to catalog leaf types without
  // sharing a literal taxonomy term (for example bicycle light vs headlight /
  // taillight). Keep retrieval enabled; absence-proof.server is the only layer
  // allowed to turn complete closed-world evidence into certain no-result.
  const catalogRelevant = rewrite.catalogRelevant;
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
            ? "The shopper-owned target is not literally grounded in shop context; semantic retrieval remains enabled and absence proof owns certainty."
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
      targetFamilyProductIds:
        (rewrite.analysis.sourceOwnedTargetIdentities?.length ?? 0) > 0
          ? [...familyProductIds]
          : [],
      directExpansionGroundedProductIds,
      directSourceFacetGroundedProductIds,
      directSourceFacetConsensusProductIds,
      discoverySourceIdentityProductIds,
      ungroundedSourceProductClass,
      ungroundedExplicitFeature,
      discoverySourceGroundedProductIds,
      discoveryExpansionGroundedProductIds,
      typedColorVocabulary: [...contextIndex.typedColorVocabulary],
    },
  };
}

export function detectExplicitGender(
  originalQuery: string,
  rewrite: QueryRewriteResult,
): "MALE" | "FEMALE" | null {
  const negative = readGenderFlags(rewrite.analysis.negativeTerms.join(" "));
  const source = readSourceGenderFlags(originalQuery);
  const interpreted = readGenderFlags(
    (rewrite.planning?.resolvedSegments ?? [])
      .filter(
        (segment) =>
          segment.field === "AUDIENCE" &&
          sourceContainsFacet(originalQuery, segment.text),
      )
      .map((segment) => segment.canonicalValue)
      .join(" "),
  );
  const positive = {
    male: source.male || interpreted.male,
    female: source.female || interpreted.female,
  };
  const male = (positive.male && !negative.male) || negative.female;
  const female = (positive.female && !negative.female) || negative.male;
  return male === female ? null : male ? "MALE" : "FEMALE";
}

function readSourceGenderFlags(value: string) {
  const normalized = normalizeUnicodeQueryText(value);
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  return {
    male:
      tokens.has("nam") || tokens.has("male") || tokens.has("man") ||
      tokens.has("men") || tokens.has("homme") || tokens.has("hommes") ||
      normalized.includes("男"),
    female:
      tokens.has("nữ") || tokens.has("nu") || tokens.has("female") ||
      tokens.has("woman") || tokens.has("women") ||
      tokens.has("femme") || tokens.has("femmes") || normalized.includes("女"),
  };
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
    token === "with" ||
    token === "voi" ||
    /^(?:matches|matching|matched)$/.test(token) ||
    (token === "for" && (rewrite.analysis.referenceTerms ?? []).length > 0) ||
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

function sourceSemanticTermForCanonical(
  source: string,
  rewrite: QueryRewriteResult,
  canonicalValue: string,
) {
  const canonical = normalizeContextTerm(canonicalValue);
  if (!canonical) return null;
  const targetTerms = rewrite.analysis.semanticMustTerms ?? [];
  const sourceTerms = rewrite.analysis.semanticSourceMustTerms ?? [];
  const length = Math.min(targetTerms.length, sourceTerms.length);
  for (let index = 0; index < length; index += 1) {
    const target = normalizeContextTerm(targetTerms[index] ?? "");
    const sourceTerm = sourceTerms[index] ?? "";
    if (!target || !sourceTerm || !sourceContainsFacet(source, sourceTerm)) continue;
    if (
      sourceContainsFacet(target, canonical) ||
      sourceContainsFacet(canonical, target)
    ) {
      return sourceTerm;
    }
  }
  return null;
}

function objectiveFacetAssignmentValue(value: string) {
  const match = value.match(
    /^\s*(?:color|colour|material|fabric|finish|pattern)\s*=\s*(.+?)\s*$/i,
  );
  return match?.[1] ? normalizeContextTerm(match[1]) : null;
}

function directExpansionFactMatch(
  expansion: string,
  catalogValue: string,
  identityTokens: Set<string>,
) {
  const expansionTokens = meaningfulTokens(expansion).filter(
    (token) =>
      !identityTokens.has(token) &&
      !GENERIC_SOURCE_CONTEXT_TOKENS.has(token),
  );
  const catalogTokens = new Set(meaningfulTokens(catalogValue));
  const overlap = [
    ...new Set(expansionTokens.filter((token) => catalogTokens.has(token))),
  ];
  if (overlap.length >= 2) return true;
  if (overlap.length !== 1) return false;
  const token = overlap[0];
  return token.length >= 5 && !GENERIC_DISCOVERY_LEAF_TOKENS.has(token);
}

export function sourceContextCatalogValueMatch(
  kind: string,
  catalogValue: string,
  sourceSignal: string,
) {
  const normalizedValue = normalizeContextTerm(catalogValue);
  const normalizedSignal = normalizeContextTerm(sourceSignal);
  if (!normalizedValue || !normalizedSignal) return false;

  const signalTokens = meaningfulTokens(normalizedSignal);
  const valueTokens = meaningfulTokens(normalizedValue);

  if (kind === "ATTRIBUTE") {
    const assigned = objectiveFacetAssignmentValue(catalogValue);
    if (assigned) {
      const assignedTokens = meaningfulTokens(assigned);
      return (
        assignedTokens.length === signalTokens.length &&
        signalTokens.every((token) => assignedTokens.includes(token))
      );
    }
    // Shopper-owned multi-token attributes are specific facts. A broader
    // catalog value must not prove a narrower request: "100% cotton" does not
    // prove "100% cotton lining". Token order may differ ("lining: 100% cotton").
    if (signalTokens.length > 1) {
      return signalTokens.every((token) => valueTokens.includes(token));
    }
    // A one-token catalog attribute can be elaborated by the merchant/profile
    // with its affected component ("waterproof synthetic sole"). Treat the
    // shopper-owned token as factual evidence when it appears as a standalone
    // token; family scoping is enforced separately so "waterproof jacket"
    // cannot prove "waterproof shoes".
    return valueTokens.includes(signalTokens[0]);
  }

  if (
    ["USE_CASE", "SOFT_CONTEXT"].includes(kind) &&
    signalTokens.length === 1 &&
    valueTokens.length > 1
  ) {
    // For a one-word need, prefer contexts where that word is the semantic
    // head ("road running", "carrying a laptop"), not an unrelated phrase
    // that merely starts with it ("running errands").
    const discriminativeValueTokens = valueTokens.filter(
      (token) => !GENERIC_SOURCE_CONTEXT_TOKENS.has(token),
    );
    return (
      valueTokens[valueTokens.length - 1] === signalTokens[0] ||
      (discriminativeValueTokens.length === 1 &&
        discriminativeValueTokens[0] === signalTokens[0])
    );
  }

  return (
    sourceContainsFacet(normalizedValue, normalizedSignal) ||
    sourceContainsFacet(normalizedSignal, normalizedValue)
  );
}

function sourceGroundedAttributeFacets(
  originalQuery: string,
  rewrite: QueryRewriteResult,
) {
  const source = sourceTargetText(originalQuery, rewrite);
  const facets = new Set<string>();
  const negativeFacetSignals = [
    ...(rewrite.analysis.negativeTerms ?? []),
    ...(rewrite.analysis.negativeAttributes ?? []),
  ]
    .map(normalizeContextTerm)
    .filter(Boolean);
  const isNegativeFacet = (value: string) => {
    const normalized = normalizeContextTerm(value);
    return negativeFacetSignals.some(
      (negative) =>
        normalized === negative ||
        sourceContainsFacet(normalized, negative) ||
        sourceContainsFacet(negative, normalized),
    );
  };
  const resolvedSegments = rewrite.planning?.resolvedSegments ?? [];
  for (const segment of resolvedSegments) {
    if (!["ATTRIBUTE", "CONTEXT", "COMPATIBILITY"].includes(segment.field)) continue;
    const nestedInsideIdentity =
      segment.field !== "CONTEXT" &&
      segment.confidence < 0.8 &&
      typeof segment.start === "number" &&
      typeof segment.end === "number" &&
      resolvedSegments.some(
        (identity) =>
          identity.field === "PRODUCT_TYPE" &&
          typeof identity.start === "number" &&
          typeof identity.end === "number" &&
          identity.start <= segment.start! &&
          identity.end >= segment.end! &&
          (identity.start < segment.start! || identity.end > segment.end!),
      );
    if (nestedInsideIdentity) continue;
    if (isNegativeFacet(segment.canonicalValue)) continue;
    if (sourceContainsFacet(source, segment.text)) {
      facets.add(normalizeContextTerm(segment.canonicalValue));
    }
  }
  const identityInternalLowConfidenceSignals = new Set(
    resolvedSegments
      .filter(
        (segment) =>
          segment.field !== "CONTEXT" &&
          segment.confidence < 0.8 &&
          typeof segment.start === "number" &&
          typeof segment.end === "number" &&
          resolvedSegments.some(
            (identity) =>
              identity.field === "PRODUCT_TYPE" &&
              typeof identity.start === "number" &&
              typeof identity.end === "number" &&
              identity.start <= segment.start! &&
              identity.end >= segment.end! &&
              (identity.start < segment.start! || identity.end > segment.end!),
          ),
      )
      .map((segment) => normalizeContextTerm(segment.canonicalValue)),
  );
  for (const value of [
    ...(rewrite.analysis.requiredAttributes ?? []),
    ...(rewrite.analysis.optionalPreferences ?? []),
    ...(rewrite.analysis.attributes ?? []),
    ...(rewrite.analysis.compatibility ?? []),
    ...(rewrite.analysis.sourceOwnedExactConstraints ?? []),
  ]) {
    if (identityInternalLowConfidenceSignals.has(normalizeContextTerm(value))) {
      continue;
    }
    if (isNegativeFacet(value)) {
      continue;
    }
    if (
      sourceContainsFacet(source, value) ||
      sourceSemanticTermForCanonical(source, rewrite, value)
    ) {
      facets.add(normalizeContextTerm(value));
    }
  }
  return [...facets].filter(Boolean);
}

export function currentTargetColors(
  originalQuery: string,
  rewrite: QueryRewriteResult,
  vocabulary: Set<string>,
) {
  const source = sourceTargetText(originalQuery, rewrite);
  const owned = new Set(
    (rewrite.analysis.sourceOwnedExactConstraints ?? []).map(normalizeContextTerm),
  );
  return [...new Set([
    ...owned,
    ...sourceGroundedAttributeFacets(originalQuery, rewrite),
  ])].filter(
    (value) =>
      vocabulary.has(value) &&
      (owned.has(value) || sourceContainsFacet(source, value)),
  );
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
    const translatedSourcePhrase =
      sourceSemanticTermForCanonical(source, rewrite, phrase);
    const normalized = normalizeContextTerm(translatedSourcePhrase ?? phrase);
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

function applyBoundedRerankBoost(baseScore: number, bonus: number) {
  const ceiling = 0.995;
  const base = Math.max(0, Math.min(ceiling, baseScore));
  const strength = Math.max(0, Math.min(0.7, bonus));
  return Math.min(ceiling, base + (ceiling - base) * strength);
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

function discoveryExpansionSignalMatch(
  values: string[],
  productTokens: Set<string>,
  rawSignal: string,
) {
  const signal = normalizeContextTerm(rawSignal);
  const signalTokens = meaningfulTokens(signal);
  if (!signal || signalTokens.length === 0) return 0;

  if (signalTokens.length === 1) {
    return values.some((value) => normalizeContextTerm(value) === signal)
      ? 1
      : 0;
  }

  const common = signalTokens.filter((token) => productTokens.has(token)).length;
  return common / signalTokens.length;
}

function bestDiscoveryExpansionMatch(
  values: string[],
  tokens: Set<string>,
  signals: string[],
) {
  return Math.max(
    0,
    ...signals.map((signal) =>
      discoveryExpansionSignalMatch(values, tokens, signal),
    ),
  );
}

export function semanticMustSignalMatch(
  values: string[],
  tokens: Set<string>,
  rawSignal: string,
) {
  const signal = normalizeContextTerm(rawSignal);
  const signalTokens = meaningfulTokens(signal);
  if (!signal || signalTokens.length === 0) return 0;

  // A single semantic word must match a complete typed value, not merely a
  // token inside another facet. This prevents "cool" (temperature) from being
  // proven by "Cool Grey" (color), "light" by "light blue", etc.
  if (signalTokens.length === 1) {
    return values.some((value) => normalizeContextTerm(value) === signal)
      ? 1
      : 0;
  }

  return matchSemanticSignal(values, tokens, signal);
}

function semanticSignalCoverage(
  values: string[],
  tokens: Set<string>,
  signals: string[],
) {
  const uniqueSignals = [
    ...new Set(
      signals
        .map(normalizeContextTerm)
        .filter(Boolean),
    ),
  ];
  if (uniqueSignals.length === 0) return 0;
  const total = uniqueSignals.reduce(
    (sum, signal) => sum + semanticMustSignalMatch(values, tokens, signal),
    0,
  );
  return total / uniqueSignals.length;
}

function versionedEntitySignal(value: string) {
  const normalized = normalizeContextTerm(value);
  const tokens = meaningfulTokens(normalized);
  if (
    tokens.length < 2 ||
    tokens.length > 8 ||
    !tokens.some((token) => /\d/.test(token)) ||
    !/^[a-z][a-z0-9-]*$/i.test(tokens[0])
  ) {
    return null;
  }
  // Measurements/specs such as 700x35C, 16GB and size 42 are owned by the
  // deterministic measurement layer, not named-entity version matching.
  if (
    tokens.every((token) => /\d|^(?:x|gb|tb|cm|mm|ml|kg|mah|inch|size)$/i.test(token))
  ) {
    return null;
  }
  return {
    normalized: tokens.join(" "),
    family: tokens[0],
  };
}

function exactVersionedEntityMatch(values: string[], signal: string) {
  const parsed = versionedEntitySignal(signal);
  if (!parsed) return 0;
  return values.some((value) => {
    const normalized = normalizeContextTerm(value);
    return (
      normalized === parsed.normalized ||
      normalized.includes(parsed.normalized)
    );
  }) ? 1 : 0;
}

function versionedEntityFamilyMatch(values: string[], signal: string) {
  const parsed = versionedEntitySignal(signal);
  if (!parsed) return 0;
  return values.some((value) => {
    const tokens = meaningfulTokens(value);
    return tokens.includes(parsed.family) && tokens.some((token) => /\d/.test(token));
  }) ? 1 : 0;
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
  const rows = await loadProductSemanticRows(
    shop,
    results.map((result) => result.productId),
  );
  const dbReadMs = Date.now() - dbStartedAt;
  const filterStartedAt = Date.now();

  // Validate explicit target colors only when typed color coverage is high.
  // Missing product color remains unknown rather than becoming a contradiction.
  const requestedExact = rewrite.analysis.sourceOwnedExactConstraints ?? [];
  const indexedColors = (rewrite as ContextualQueryResult).context?.typedColorVocabulary;
  // Normal storefront queries already loaded the shop-context index. Reuse its
  // typed palette instead of materializing every product's semantic rows again.
  // Standalone/fixture callers retain the previous safe catalog fallback.
  const catalogRows = requestedExact.length > 0 && !indexedColors
    ? await loadShopSemanticRows(shop)
    : rows;
  const colorVocabulary = indexedColors
    ? new Set(indexedColors)
    : new Set(
        catalogRows.flatMap((row) => {
          const match = row.value.match(/^\s*colou?r\s*[=:]\s*(.+?)\s*$/i);
          return match ? [normalizeContextTerm(match[1])] : [];
        }),
      );
  const requestedColors = currentTargetColors(
    originalQuery,
    rewrite,
    colorVocabulary,
  );
  const colorsByProduct = new Map<string, string[]>();
  for (const row of rows) {
    if (!["ATTRIBUTE", "VARIANT_OPTION"].includes(row.kind)) continue;
    const match = row.value.match(/^\s*colou?r\s*[=:]\s*(.+?)\s*$/i);
    if (!match) continue;
    colorsByProduct.set(row.productId, [
      ...(colorsByProduct.get(row.productId) ?? []),
      normalizeContextTerm(match[1]),
    ]);
  }
  const typedColorCoverage =
    results.length > 0 ? colorsByProduct.size / results.length : 0;

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
  const shopperStrictAttributes = readStrictTargetAttributes(originalQuery, rewrite);
  const sourceFacetPreferences = sourceGroundedAttributeFacets(originalQuery, rewrite);
  const sourceOwnedExactDemandAttributes = [
    ...new Set(
      (rewrite.analysis.sourceOwnedExactConstraints ?? [])
        .map((value) => value.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        // Exact provenance is not exact authority yet. Promote only values
        // that the catalog can type as an ATTRIBUTE/VARIANT fact.
        .filter((value) =>
          rows.some((row) =>
            ["ATTRIBUTE", "VARIANT_OPTION"].includes(row.kind) &&
            sourceContextCatalogValueMatch(row.kind, row.value, value),
          ),
        ),
    ),
  ];
  const objectiveClosedWorldAttributes = [
    ...new Set([
      ...sourceFacetPreferences,
      ...sourceOwnedExactDemandAttributes,
    ]),
  ].filter((signal) =>
    rows.some((row) => {
      if (!["ATTRIBUTE", "VARIANT_OPTION"].includes(row.kind)) return false;
      const assigned = objectiveFacetAssignmentValue(row.value);
      return Boolean(
        assigned &&
        (
          sourceContainsFacet(assigned, signal) ||
          sourceContainsFacet(signal, assigned)
        ),
      );
    }),
  );
  const strictAttributes = [
    ...new Set([
      ...shopperStrictAttributes,
    ]),
  ].filter(
    (value) =>
      !negativeSignals.some(
        (negative) =>
          normalizeContextTerm(negative) === normalizeContextTerm(value),
      ),
  );
  const planningContextSignals = (rewrite.planning?.resolvedSegments ?? [])
    .filter((segment) => segment.field === "CONTEXT")
    .map((segment) => segment.canonicalValue);
  const attributeSignals = [
    ...(rewrite.analysis.requiredAttributes ?? []),
    ...(rewrite.analysis.optionalPreferences ?? []),
    ...(rewrite.analysis.attributes ?? []),
    ...(rewrite.analysis.useCases ?? []),
    ...(rewrite.analysis.sourceOwnedExactConstraints ?? []),
    ...planningContextSignals,
  ].filter((value) => !isCommerceOnlyValue(value));
  const preferredAttributes = [
    ...new Set([
      ...sourceFacetPreferences,
      // Source-owned translated exact values (for example xanh -> blue) are
      // strong typed preferences unless code independently marks them strict.
      // Size/measurement MUSTs remain owned by the deterministic parser.
      ...sourceOwnedExactDemandAttributes,
    ]),
  ]
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
  const normalizedRelationTail =
    normalizeContextTerm(originalQuery).match(
      /\b(?:for|during|when|while|using)\b\s+(.+)$/,
    )?.[1] ?? "";
  const sourceContextNeedSignals = [
    ...new Set([
      ...planningContextSignals,
      ...preferredAttributes.filter(
        (value) =>
          normalizedRelationTail &&
          sourceContainsFacet(normalizedRelationTail, value),
      ),
      ...semanticMustFacetSignals.filter(
        (value) =>
          normalizedRelationTail &&
          sourceContainsFacet(normalizedRelationTail, value),
      ),
    ]),
  ]
    .map(normalizeContextTerm)
    .filter(Boolean)
    .filter((value) => !isCommerceOnlyValue(value))
    .filter(
      (value) =>
        !audienceSignals.some(
          (audience) =>
            sourceContainsFacet(audience, value) ||
            sourceContainsFacet(value, audience),
        ),
    );
  // Deduplicate overlapping source needs so "office" and "office use"
  // cannot count twice. Identity and commerce signals are handled separately.
  const sourceCoverageSignals = [...new Set([
    ...sourceContextNeedSignals,
    ...sourceFacetPreferences,
  ].map(normalizeContextTerm))].filter((signal, _, all) =>
    meaningfulTokens(signal).some((token) => !GENERIC_SOURCE_CONTEXT_TOKENS.has(token)) &&
    !identitySignals.some((identity) => normalizeContextTerm(identity.value) === signal) &&
    !all.some((other) => other !== signal && sourceContainsFacet(other, signal)),
  );
  const sourceGroundedSignals = (signals: string[]) => signals.filter((signal) =>
    sourceContainsFacet(originalQuery, signal) ||
    (rewrite.planning?.resolvedSegments ?? []).some((segment) =>
      normalizeContextTerm(segment.canonicalValue) === normalizeContextTerm(signal) &&
      sourceContainsFacet(originalQuery, segment.text),
    ),
  );
  const exactBrandSignals = sourceGroundedSignals(brandSignals);
  // A model term found inside a DISCOVERY/recommendation sentence may be an
  // ordinary adjective that happens to equal a catalog model name. Treat model
  // as closed-world only in DIRECT lookup flows; identifiers remain exact.
  const exactModelSignals =
    currentRetrievalMode === "DIRECT"
      ? sourceGroundedSignals(modelSignals)
      : [];
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
  const expansionGroundedDirectProductIds =
    currentRetrievalMode === "DIRECT"
      ? new Set(rewrite.context?.directExpansionGroundedProductIds ?? [])
      : new Set<string>();
  const sourceGroundedDirectProductIds =
    currentRetrievalMode === "DIRECT"
      ? new Set(rewrite.context?.directSourceFacetGroundedProductIds ?? [])
      : new Set<string>();
  const sourceGroundedDirectConsensusProductIds =
    currentRetrievalMode === "DIRECT"
      ? new Set(rewrite.context?.directSourceFacetConsensusProductIds ?? [])
      : new Set<string>();
  const sourceGroundedDiscoveryIdentityProductIds =
    currentRetrievalMode === "DISCOVERY"
      ? new Set(rewrite.context?.discoverySourceIdentityProductIds ?? [])
      : new Set<string>();
  const sourceGroundedDiscoveryProductIds =
    currentRetrievalMode === "DISCOVERY"
      ? new Set(rewrite.context?.discoverySourceGroundedProductIds ?? [])
      : new Set<string>();
  const expansionGroundedDiscoveryProductIds =
    currentRetrievalMode === "DISCOVERY"
      ? new Set(rewrite.context?.discoveryExpansionGroundedProductIds ?? [])
      : new Set<string>();
  const normalizedSourceQuery = normalizeContextTerm(originalQuery);
  const versionedEntitySignals =
    currentRetrievalMode !== "COMPLEMENT"
      ? [
          ...new Set([
            ...(rewrite.analysis.semanticSourceMustTerms ?? []),
            ...(rewrite.analysis.semanticMustTerms ?? []),
          ]),
        ].filter((signal) => {
          const parsed = versionedEntitySignal(signal);
          return Boolean(
            parsed &&
            (
              normalizedSourceQuery.includes(parsed.normalized) ||
              parsed.normalized.includes(normalizedSourceQuery)
            ),
          );
        })
      : [];

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
      "ALIAS",
      "CANONICAL_PRODUCT_TYPE",
      "PRODUCT_TYPE",
      "CATEGORY",
      "COMPATIBILITY",
    ]);
    const semanticMustFacetTokens = tokensForValues(
      semanticMustFacetValues,
    );
    const semanticMustFacetMatch = semanticSignalCoverage(
      semanticMustFacetValues,
      semanticMustFacetTokens,
      semanticMustFacetSignals,
    );
    const directContextNeedMatch =
      sourceContextNeedSignals.length === 0
        ? 0
        : sourceContextNeedSignals.reduce((sum, signal) => {
            let best = 0;
            for (const kind of [
              "USE_CASE",
              "SOFT_CONTEXT",
              "PRODUCT_TITLE",
              "CANONICAL_PRODUCT_TYPE",
              "PRODUCT_TYPE",
              "ALIAS",
              "ATTRIBUTE",
              "COMPATIBILITY",
            ]) {
              for (const value of byKind.get(kind) ?? []) {
                if (sourceContextCatalogValueMatch(kind, value, signal)) {
                  best = 1;
                  break;
                }
              }
              if (best >= 1) break;
            }
            return sum + best;
          }, 0) / sourceContextNeedSignals.length;
    const sourceNeedCoverage = sourceCoverageSignals.length === 0 ? 0 :
      sourceCoverageSignals.filter((signal) =>
        ["ATTRIBUTE", "VARIANT_OPTION", "USE_CASE", "SOFT_CONTEXT", "COMPATIBILITY"]
          .some((kind) => (byKind.get(kind) ?? []).some((value: string) =>
            sourceContextCatalogValueMatch(kind, value, signal),
          )),
      ).length / sourceCoverageSignals.length;
    const rawVectorSimilarity = Number(
      (result as T & { vectorSimilarity?: number }).vectorSimilarity,
    );
    const rawPrimaryVectorSimilarity = Number(
      (result as T & { primaryVectorSimilarity?: number }).primaryVectorSimilarity,
    );
    const branchInput = (result as T & { semanticBranchInput?: string }).semanticBranchInput;
    const identityOnlyBranch = Boolean(branchInput && identitySignals.some((signal) =>
      normalizeIdentitySignalTokens(branchInput).join(" ") === signal.normalized,
    ));
    const semanticBranchLift =
      !identityOnlyBranch &&
      Number.isFinite(rawVectorSimilarity) &&
      Number.isFinite(rawPrimaryVectorSimilarity)
        ? Math.max(0, rawVectorSimilarity - rawPrimaryVectorSimilarity)
        : 0;
    const discoveryExpansionPreferenceMatch =
      currentRetrievalMode === "DISCOVERY"
        ? bestDiscoveryExpansionMatch(
            semanticMustFacetValues,
            semanticMustFacetTokens,
            rewrite.analysis.semanticExpansions ?? [],
          )
        : 0;
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
    const versionedEntityValues = valuesForKinds([
      "MODEL",
      "COMPATIBILITY",
      "IDENTIFIER",
      "SKU",
      "BARCODE",
      "VARIANT_OPTION",
      "PRODUCT_TITLE",
    ]);
    const versionedEntityMatch =
      versionedEntitySignals.length === 0
        ? 0
        : Math.min(
            ...versionedEntitySignals.map((signal) =>
              exactVersionedEntityMatch(versionedEntityValues, signal),
            ),
          );
    const versionedEntityFamilyMatchScore =
      versionedEntitySignals.length === 0
        ? 0
        : Math.max(
            ...versionedEntitySignals.map((signal) =>
              versionedEntityFamilyMatch(versionedEntityValues, signal),
            ),
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
    const objectiveClosedWorldSet = new Set(
      objectiveClosedWorldAttributes.map(normalizeContextTerm),
    );
    const exactObjectiveFacetMatch = (signal: string) => {
      const normalizedSignal = normalizeContextTerm(signal);
      return exactFacetValues.some((value) => {
        const assigned = objectiveFacetAssignmentValue(value);
        if (assigned) {
          return normalizeContextTerm(assigned) === normalizedSignal;
        }
        return normalizeContextTerm(value) === normalizedSignal;
      });
    };
    const exactFacetMatch = (signal: string) =>
      objectiveClosedWorldSet.has(normalizeContextTerm(signal))
        ? exactObjectiveFacetMatch(signal)
        : exactFacetValues.some((value) =>
            sourceContextCatalogValueMatch("ATTRIBUTE", value, signal),
          );
    const preferredFacetMatches = preferredAttributes.reduce((score, signal) => {
      const normalizedSignal = normalizeContextTerm(signal);
      if (!normalizedSignal) return score;
      const exactValue = objectiveClosedWorldSet.has(normalizedSignal)
        ? exactObjectiveFacetMatch(signal)
        : exactFacetValues.some(
            (value) => normalizeContextTerm(value) === normalizedSignal,
          );
      if (exactValue) return score + 1;
      const compoundValue =
        !objectiveClosedWorldSet.has(normalizedSignal) &&
        exactFacetValues.some((value) =>
          sourceContextCatalogValueMatch("ATTRIBUTE", value, signal),
        );
      // Exact merchant/source facet values should outrank compound variants
      // such as Black over Navy/Black, while compound values remain useful
      // recall rather than being discarded.
      return score + (compoundValue ? 0.35 : 0);
    }, 0);
    const strictFacetMatch = strictAttributes.every(exactFacetMatch);
    const excluded = negativeSignals.some(negative => matchesExplicitNegativeFacet(explicitFilterValues, negative));
    const primaryDemandVectorSimilarity = Number(
      (result as T & { primaryVectorSimilarity?: number })
        .primaryVectorSimilarity,
    );
    const targetIdentityVectorSimilarity = Number(
      (result as T & { targetIdentityVectorSimilarity?: number })
        .targetIdentityVectorSimilarity,
    );
    const targetIdentityRelativeScore = Number(
      (result as T & { targetIdentityRelativeScore?: number })
        .targetIdentityRelativeScore,
    );
    const configuredSemanticThreshold = (() => {
      const parsed = Number.parseFloat(
        process.env.AI_SEARCH_VECTOR_SCORE_THRESHOLD || "",
      );
      return Number.isFinite(parsed) && parsed >= -1 && parsed <= 1
        ? parsed
        : 0.35;
    })();
    const targetIdentitySemanticEvidence =
      Number.isFinite(targetIdentityVectorSimilarity) &&
      targetIdentityVectorSimilarity >= configuredSemanticThreshold &&
      Number.isFinite(targetIdentityRelativeScore) &&
      targetIdentityRelativeScore >= 0.8;
    const compoundIdentityContradiction = identitySignals.some((signal) => {
      if (signal.tokens.length < 2 || identityMatch > 0) return false;
      const head = signal.tokens.at(-1)!;
      return valuesForKinds(["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE"]).some(
        (value) => {
          const actual = normalizeIdentitySignalTokens(value);
          return (
            actual.length > 0 &&
            !actual.some((token) => identityTokenEquivalent(token, head)) &&
            actual.some((token) =>
              signal.tokens
                .slice(0, -1)
                .some((modifier) => identityTokenEquivalent(token, modifier)),
            )
          );
        },
      );
    });
    return {
      result,
      identityMatch,
      hasKnownIdentity: identityValues.length > 0,
      primaryDemandVectorSimilarity:
        Number.isFinite(primaryDemandVectorSimilarity)
          ? primaryDemandVectorSimilarity
          : 0,
      targetIdentitySemanticEvidence,
      compoundIdentityContradiction,
      complementaryReferenceMatch,
      complementaryPreferenceMatch,
      discoveryGroundingMatch,
      directExpansionGrounding:
        expansionGroundedDirectProductIds.has(result.productId),
      directSourceFacetGrounding:
        sourceGroundedDirectProductIds.has(result.productId),
      directSourceFacetConsensusGrounding:
        sourceGroundedDirectConsensusProductIds.has(result.productId),
      sourceDiscoveryIdentityGrounding:
        sourceGroundedDiscoveryIdentityProductIds.has(result.productId),
      sourceDiscoveryGrounding:
        sourceGroundedDiscoveryProductIds.has(result.productId),
      expansionDiscoveryGrounding:
        expansionGroundedDiscoveryProductIds.has(result.productId),
      attributeMatch,
      semanticMustFacetMatch,
      directContextNeedMatch,
      sourceNeedCoverage,
      semanticBranchLift,
      discoveryExpansionPreferenceMatch,
      preferredFacetMatches,
      strictFacetMatch,
      excluded,
      brandMatch,
      modelMatch,
      identifierMatch,
      compatibilityMatch,
      versionedEntityMatch,
      versionedEntityFamilyMatch: versionedEntityFamilyMatchScore,
      audienceMatch,
      numericRequiredMatch,
      categoryMatch,
      hasKnownCategory: categoryValues.length > 0,
    };
  });
  const hasDirectSourceFacetConsensus =
    sourceGroundedDirectConsensusProductIds.size > 0;
  // Source facets and use-case/context grounding are open-world evidence.
  // They improve ranking but never become eligibility gates. Strict source
  // markers, target identity, negatives and closed-world typed facts own hard
  // filtering below.
  // LLM semantic expansions are retrieval probes and ranking hints only.
  // They must never become a hard eligibility filter: a product may satisfy
  // the shopper need without storing every word from an expansion phrase.
  const hasIdentityMatch = scored.some((item) => item.identityMatch >= 0.5);
  const hasSourceOwnedTargetIdentity =
    (currentRetrievalMode === "DIRECT" || currentRetrievalMode === "COMPLEMENT") &&
    (rewrite.analysis.sourceOwnedTargetIdentities?.length ?? 0) > 0;
  const directIdentityGrounded = shouldEnforceDirectIdentity({
    retrievalMode: currentRetrievalMode,
    signals: identitySignals,
    hasIdentityMatch,
    hasSourceOwnedTargetIdentity,
  });
  const hasFamilyCategoryMatch =
    familyCategorySignals.length > 0 &&
    scored.some((item) => item.categoryMatch >= 0.75);
  const hasVersionedEntityFamilyEvidence =
    versionedEntitySignals.length > 0 &&
    (
      scored.some((item) => item.versionedEntityFamilyMatch >= 1) ||
      (rewrite.context?.selectedTerms ?? []).some((term) =>
        versionedEntitySignals.some((signal) =>
          versionedEntityFamilyMatch([term.value], signal) >= 1,
        ),
      )
    );
  const hardGroups = [
    { active: exactBrandSignals.length > 0, key: "brandMatch" as const },
    { active: exactModelSignals.length > 0, key: "modelMatch" as const },
    { active: exactIdentifierSignals.length > 0, key: "identifierMatch" as const },
    { active: exactCompatibilitySignals.length > 0, key: "compatibilityMatch" as const },
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
    const knownColors = colorsByProduct.get(result.productId) ?? [];
    if (
      requestedExact.length > 0 &&
      typedColorCoverage >= 0.9 &&
      requestedColors.length > 0 &&
      knownColors.length > 0 &&
      !requestedColors.some((color) =>
        knownColors.some((actual) =>
          sourceContainsFacet(actual.replace(/[/_-]/g, " "), color),
        ),
      )
    ) {
      colorFilteredCount += 1;
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
      hasSourceOwnedTargetIdentity &&
      (!item.hasKnownIdentity || item.identityMatch < 0.34) &&
      !item.targetIdentitySemanticEvidence
    ) {
      // Shopper-owned target identity scopes the whole query. Missing PSF
      // identity is uncertainty, not permission for an exact size/model fact
      // to admit another family; dedicated target-identity dense evidence may
      // still rescue cross-taxonomy synonyms or incompletely profiled items.
      identityFilteredCount += 1;
      return [];
    }
    if (
      hasSourceOwnedTargetIdentity &&
      item.compoundIdentityContradiction
    ) {
      identityFilteredCount += 1;
      return [];
    }
    if (
      directIdentityGrounded &&
      item.hasKnownIdentity &&
      item.identityMatch < 0.34 &&
      !item.targetIdentitySemanticEvidence
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
    if (
      hasVersionedEntityFamilyEvidence &&
      item.versionedEntityMatch < 1
    ) {
      exactConstraintFilteredCount += 1;
      return [];
    }

    const lexicalBonus =
      Math.min(
        directIdentityGrounded ? 0.24 : 0.14,
        item.identityMatch * (directIdentityGrounded ? 0.22 : 0.12),
      ) +
      Math.min(0.03, item.attributeMatch * 0.03) +
      (sourceCoverageSignals.length >= 2 ? Math.min(0.08, item.sourceNeedCoverage * 0.08) : 0) +
      // Exact typed/merchant facet evidence outranks nearby vector shades,
      // but never outweighs a grounded product identity.
      Math.min(0.08, item.preferredFacetMatches * 0.08) +
      // Semantic MUST terms from LLM are evidence/ranking signals unless
      // they were independently resolved into a closed-world typed facet.
      // This prevents open-world concepts such as style/use-case from
      // becoming accidental hard filters.
      (currentRetrievalMode === "DISCOVERY"
        ? 0
        : Math.min(0.10, item.semanticMustFacetMatch * 0.10)) +
      Math.min(0.08, item.discoveryExpansionPreferenceMatch * 0.08) +
      Math.min(0.12, item.complementaryPreferenceMatch * 0.12) +
      // For long DIRECT need-style queries, an LLM expansion may resolve the
      // broad source family to a canonical leaf that actually exists in the
      // catalog (for example bag + wear on back + travel -> travel backpack).
      // The source still owns the broad identity; the grounded leaf is a strong
      // rerank signal, not a hard filter.
      (item.directExpansionGrounding ? 0.14 : 0) +
      // A facet/use-case explicitly owned by the shopper and grounded to a
      // product in the same DIRECT identity family is stronger than generic
      // vector similarity, but remains a ranking signal rather than a hard
      // filter. This keeps color/material soft while allowing relational needs
      // such as "bag for laptop" to outrank grooming/lunch bags.
      (item.directSourceFacetConsensusGrounding
        ? 0.14
        : item.directSourceFacetGrounding
          ? 0.06
          : 0) +
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
    const typedRerankScore = applyBoundedRerankBoost(
      result.score,
      lexicalBonus,
    );
    return [{
      ...result,
      score: typedRerankScore,
      // Named target identity owns the first tier, including COMPLEMENT.
      // Primary full Demand then precedes soft source facets and lane boosts;
      // reference ownership and exact exclusions were validated above.
      _identityTier:
        directIdentityGrounded && item.identityMatch >= 0.75
          ? 2
          : hasSourceOwnedTargetIdentity && item.targetIdentitySemanticEvidence
            ? 1
            : 0,
      _directExpansionTier:
        currentRetrievalMode === "DIRECT" && item.directExpansionGrounding
          ? 1
          : 0,
      _directSourceFacetTier:
        currentRetrievalMode === "DIRECT" &&
        (
          item.directSourceFacetConsensusGrounding ||
          (!hasDirectSourceFacetConsensus && item.directSourceFacetGrounding)
        )
          ? 1
          : 0,
      _sourceNeedCoverage: item.sourceNeedCoverage,
      // The primary vector is the full Supply↔Demand semantic assessment.
      // Keep it distinct from branch recall and PSF lexical overlap.
      _jointDemandEvidence:
        Number.isFinite(item.primaryDemandVectorSimilarity)
          ? item.primaryDemandVectorSimilarity
          : -1,
      _preferredFacetMatches: item.preferredFacetMatches,
      _sourceDiscoveryTier:
        currentRetrievalMode === "DISCOVERY" && item.sourceDiscoveryGrounding
          ? 1
          : 0,
      _semanticNeedTier:
        currentRetrievalMode === "DISCOVERY" &&
        item.semanticMustFacetMatch >= 0.75
          ? 1
          : 0,
      _semanticNeedCoverage:
        currentRetrievalMode === "DISCOVERY"
          ? item.semanticMustFacetMatch
          : 0,
      _discoveryExpansionPreference:
        currentRetrievalMode === "DISCOVERY"
          ? item.discoveryExpansionPreferenceMatch
          : 0,
      _expansionDiscoveryTier:
        currentRetrievalMode === "DISCOVERY" &&
        item.expansionDiscoveryGrounding
          ? 1
          : 0,
      _typedRerankScore: typedRerankScore,
    }];
  });
  filtered.sort((left, right) =>
    right._identityTier - left._identityTier ||
    right._jointDemandEvidence - left._jointDemandEvidence ||
    right._directSourceFacetTier - left._directSourceFacetTier ||
    (currentRetrievalMode === "DISCOVERY" && sourceCoverageSignals.length >= 2
      ? Number(right._sourceNeedCoverage === 1) - Number(left._sourceNeedCoverage === 1)
      : 0) ||
    (
      directIdentityGrounded || hasSourceOwnedTargetIdentity
        ? right._preferredFacetMatches - left._preferredFacetMatches
        : 0
    ) ||
    (
      currentRetrievalMode === "DISCOVERY"
        ? right._sourceDiscoveryTier - left._sourceDiscoveryTier
        : 0
    ) ||
    (
      currentRetrievalMode === "DISCOVERY"
        ? right._discoveryExpansionPreference -
          left._discoveryExpansionPreference
        : 0
    ) ||
    (
      currentRetrievalMode === "DISCOVERY"
        ? right._expansionDiscoveryTier - left._expansionDiscoveryTier
        : 0
    ) ||
    right._typedRerankScore - left._typedRerankScore ||
    right.score - left.score,
  );

  const semanticThreshold = (() => {
    const parsed = Number.parseFloat(
      process.env.AI_SEARCH_VECTOR_SCORE_THRESHOLD || "",
    );
    return Number.isFinite(parsed) && parsed >= -1 && parsed <= 1
      ? parsed
      : 0.35;
  })();
  const relevanceFiltered = applyFinalRelevanceCutoff({
    results: filtered,
    retrievalMode: currentRetrievalMode,
    semanticThreshold,
  });
  filtered.splice(0, filtered.length, ...relevanceFiltered);

  // Broad DISCOVERY should represent several independently grounded semantic
  // branches near the top instead of letting one high-cosine family monopolize
  // the first page. Keep the original #1, promote at most one strong champion
  // per secondary branch, then preserve the existing typed-rerank order.
  if (
    currentRetrievalMode === "DISCOVERY" &&
    sourceGroundedDiscoveryIdentityProductIds.size === 0 &&
    (rewrite.analysis.semanticExpansions ?? []).length >= 3 &&
    filtered.length >= 4
  ) {
    type DiscoveryBranchResult = T & {
      semanticBranchIndex?: number;
      semanticBranchRelativeScore?: number;
    };
    const topRankScore = filtered[0]?._typedRerankScore ?? filtered[0]?.score ?? 0;
    const branchChampions = new Map<
      number,
      { item: (typeof filtered)[number]; index: number }
    >();

    filtered.slice(0, 50).forEach((item, index) => {
      const result = item as DiscoveryBranchResult;
      const branch = Number(result.semanticBranchIndex);
      const relative = Number(result.semanticBranchRelativeScore);
      const primaryDemandSimilarity = Number(
        (result as DiscoveryBranchResult & { primaryVectorSimilarity?: number })
          .primaryVectorSimilarity,
      );
      if (
        !Number.isSafeInteger(branch) ||
        branch <= 0 ||
        !Number.isFinite(relative) ||
        relative < 0.9 ||
        !Number.isFinite(primaryDemandSimilarity) ||
        primaryDemandSimilarity < semanticThreshold ||
        (sourceCoverageSignals.length >= 2 &&
          item._sourceNeedCoverage < filtered[0]._sourceNeedCoverage) ||
        item._typedRerankScore < topRankScore * 0.72
      ) {
        return;
      }
      if (!branchChampions.has(branch)) {
        branchChampions.set(branch, { item, index });
      }
    });

    if (branchChampions.size >= 2) {
      const diversified: typeof filtered = [];
      const used = new Set<string>();
      const push = (item: (typeof filtered)[number]) => {
        if (used.has(item.productId)) return;
        used.add(item.productId);
        diversified.push(item);
      };

      push(filtered[0]);
      [...branchChampions.values()]
        .sort((left, right) => left.index - right.index)
        .forEach(({ item }) => {
          if (diversified.length < 4) push(item);
        });
      filtered.forEach(push);
      filtered.splice(0, filtered.length, ...diversified);
    }
  }

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
  return filtered.map(({
    _identityTier: _identityTierIgnored,
    _directExpansionTier: _directExpansionTierIgnored,
    _directSourceFacetTier: _directSourceFacetTierIgnored,
    _sourceNeedCoverage: _sourceNeedCoverageIgnored,
    _jointDemandEvidence: _jointDemandEvidenceIgnored,
    _preferredFacetMatches: _preferredFacetMatchesIgnored,
    _sourceDiscoveryTier: _sourceDiscoveryTierIgnored,
    _semanticNeedTier: _semanticNeedTierIgnored,
    _semanticNeedCoverage: _semanticNeedCoverageIgnored,
    _discoveryExpansionPreference: _discoveryExpansionPreferenceIgnored,
    _expansionDiscoveryTier: _expansionDiscoveryTierIgnored,
    _typedRerankScore: _typedRerankScoreIgnored,
    ...result
  }) => result as T);
}
