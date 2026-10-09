import { normalizeQueryText } from "./deterministic-query-parser.server";
import { createHash } from "node:crypto";
import { getSearchCatalogRevisionCached } from "./search-catalog-revision.server";

export type DictionaryField =
  | "PRODUCT_TYPE"
  | "CATEGORY"
  | "BRAND"
  | "MODEL"
  | "IDENTIFIER"
  | "ATTRIBUTE"
  | "MEASUREMENT"
  | "AUDIENCE"
  | "CONTEXT"
  | "COMPATIBILITY"
  | "ALIAS";

export type DictionaryEntry = {
  normalized: string;
  canonical: string;
  aliases: string[];
  field: DictionaryField;
  productCount: number;
  conceptId?: string;
  aliasLanguage?: string | null;
  source?: "SHOPIFY" | "ENRICHMENT";
  confidence?: number;
};

export type ShopSearchDictionary = {
  shop: string;
  entries: DictionaryEntry[];
  version: string;
  loadedAt: number;
  matchIndex: {
    byFirstToken: Map<string, DictionaryEntry[]>;
    rank: Map<DictionaryEntry, number>;
    fuzzySingleTokenByLength: Map<number, DictionaryEntry[]>;
  };
};

const CACHE_SAFETY_TTL_MS = (() => {
  const value = Number.parseInt(
    process.env.AI_SEARCH_DICTIONARY_CACHE_TTL_MS || "",
    10,
  );
  return Number.isSafeInteger(value) && value >= 60_000
    ? Math.min(value, 24 * 60 * 60_000)
    : 6 * 60 * 60_000;
})();
const MAX_CACHED_DICTIONARY_SHOPS = 50;
const MAX_TOTAL_DICTIONARY_ENTRIES = 250_000;
type DictionaryCacheEntry = {
  expiresAt: number;
  catalogRevision: string;
  value: ShopSearchDictionary;
};
const cache = new Map<string, DictionaryCacheEntry>();
const pendingLoads = new Map<string, Promise<ShopSearchDictionary>>();
const dictionaryGeneration = new Map<string, number>();

function identityTokenVariants(token: string) {
  const variants = new Set([token]);
  if (token.length < 4) return variants;
  if (token.endsWith("ies") && token.length > 4) variants.add(token.slice(0, -3) + "y");
  if (token.endsWith("es") && token.length > 4) variants.add(token.slice(0, -2));
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    variants.add(token.slice(0, -1));
  }
  return variants;
}

const FIELD_PRIORITY: Record<DictionaryField, number> = {
  IDENTIFIER: 100,
  MODEL: 90,
  BRAND: 85,
  PRODUCT_TYPE: 80,
  CATEGORY: 70,
  AUDIENCE: 60,
  MEASUREMENT: 55,
  ATTRIBUTE: 50,
  COMPATIBILITY: 45,
  CONTEXT: 30,
  ALIAS: 20,
};

function orderDictionaryEntries(entries: DictionaryEntry[]) {
  const identityFields = new Set<DictionaryField>([
    "IDENTIFIER", "MODEL", "BRAND", "PRODUCT_TYPE",
  ]);
  return [...entries].sort((a, b) => {
    const identityTierDelta =
      Number(identityFields.has(b.field)) - Number(identityFields.has(a.field));
    const tokenDelta =
      b.normalized.split(" ").length - a.normalized.split(" ").length;
    const confidenceDelta = (b.confidence ?? 1) - (a.confidence ?? 1);
    const priorityDelta =
      (FIELD_PRIORITY[b.field] ?? 0) - (FIELD_PRIORITY[a.field] ?? 0);
    return identityTierDelta || tokenDelta || confidenceDelta || priorityDelta;
  });
}

export function buildMatchIndex(entries: DictionaryEntry[]) {
  const ordered = orderDictionaryEntries(entries);
  const byFirstToken = new Map<string, DictionaryEntry[]>();
  const fuzzySingleTokenByLength = new Map<number, DictionaryEntry[]>();
  const rank = new Map<DictionaryEntry, number>();

  ordered.forEach((entry, index) => {
    rank.set(entry, index);
    const first = entry.normalized.split(" ").filter(Boolean)[0];
    if (first) {
      const keys = ["PRODUCT_TYPE", "CATEGORY"].includes(entry.field)
        ? identityTokenVariants(first)
        : new Set([first]);
      for (const key of keys) {
        const list = byFirstToken.get(key) ?? [];
        list.push(entry);
        byFirstToken.set(key, list);
      }
    }
    if (
      ["BRAND", "MODEL"].includes(entry.field) &&
      !entry.normalized.includes(" ")
    ) {
      const list = fuzzySingleTokenByLength.get(entry.normalized.length) ?? [];
      list.push(entry);
      fuzzySingleTokenByLength.set(entry.normalized.length, list);
    }
  });

  return { byFirstToken, rank, fuzzySingleTokenByLength };
}

function touchCache(shop: string, entry: DictionaryCacheEntry) {
  cache.delete(shop);
  cache.set(shop, entry);
}

function enforceCacheBudget() {
  let totalEntries = [...cache.values()].reduce(
    (sum, item) => sum + item.value.entries.length,
    0,
  );
  while (
    cache.size > MAX_CACHED_DICTIONARY_SHOPS ||
    totalEntries > MAX_TOTAL_DICTIONARY_ENTRIES
  ) {
    const oldest = cache.entries().next().value as
      | [string, { expiresAt: number; value: ShopSearchDictionary }]
      | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    totalEntries -= oldest[1].value.entries.length;
  }
}

function mapKind(kind: string): DictionaryField | null {
  if (["PRODUCT_TYPE", "CANONICAL_PRODUCT_TYPE"].includes(kind)) return "PRODUCT_TYPE";
  if (kind === "CATEGORY") return "CATEGORY";
  if (["VENDOR", "BRAND"].includes(kind)) return "BRAND";
  if (kind === "MODEL") return "MODEL";
  if (["SKU", "BARCODE", "IDENTIFIER"].includes(kind)) return "IDENTIFIER";
  if (kind === "MEASUREMENT") return "MEASUREMENT";
  if (["ATTRIBUTE", "VARIANT", "VARIANT_OPTION", "TAG"].includes(kind)) {
    return "ATTRIBUTE";
  }
  if (["AUDIENCE", "INFERRED_AUDIENCE"].includes(kind)) return "AUDIENCE";
  if (["USE_CASE", "SOFT_CONTEXT"].includes(kind)) return "CONTEXT";
  if (kind === "COMPATIBILITY") return "COMPATIBILITY";
  if (kind === "ALIAS") return "PRODUCT_TYPE";
  return null;
}

function confidenceForKind(kind: string, normalized: string) {
  if (kind === "TAG") return 0.55;
  if (kind === "SOFT_CONTEXT" || kind === "INFERRED_AUDIENCE") return 0.72;
  if (kind === "ALIAS") return 0.9;
  if (kind === "VARIANT") return 0.78;
  if (kind === "VARIANT_OPTION") return /^\d+(?:[.,]\d+)?$/.test(normalized) ? 0.58 : 0.92;
  if (kind === "MEASUREMENT") return /^\d+(?:[.,]\d+)?$/.test(normalized) ? 0.62 : 0.95;
  if (kind === "PRODUCT_TYPE") return 0.86;
  return 1;
}

async function loadShopSearchDictionaryUncached(
  shop: string,
  catalogRevision: string,
): Promise<ShopSearchDictionary> {
  const cached = cache.get(shop);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.catalogRevision === catalogRevision
  ) {
    touchCache(shop, cached);
    return cached.value;
  }

  const generation = dictionaryGeneration.get(shop) ?? 0;
  const grouped = new Map<string, DictionaryEntry & { productIds: Set<string> }>();

  // Shop Context already aggregates the same searchable semantic profiles by
  // (kind, normalizedValue), including source-owned product ID postings. Build
  // the dictionary from that revision-keyed snapshot instead of starting a
  // second full catalog scan. Dynamic import avoids the invalidation cycle
  // between the dictionary and Shop Context modules.
  const { getShopContextCatalogTerms } = await import("./shop-context-index.server");
  const catalogSnapshot = await getShopContextCatalogTerms(shop);
  for (const row of catalogSnapshot.terms) {
    const field = mapKind(row.kind);
    if (!field) continue;
    const normalized = normalizeQueryText(row.normalizedValue || row.value);
    if (!normalized) continue;

    const canonical = row.value;
    const canonicalNormalized = normalizeQueryText(canonical);
    const key = `${field}\u0000${normalized}\u0000${canonicalNormalized}`;
    const existing = grouped.get(key);
    if (existing) {
      for (const productId of row.productIds) existing.productIds.add(productId);
      continue;
    }

    grouped.set(key, {
      normalized,
      canonical,
      aliases: [],
      field,
      productCount: row.productCount,
      productIds: new Set(row.productIds),
      conceptId: createHash("sha256")
        .update(`${shop}\u0000${field}\u0000${canonicalNormalized}`, "utf8")
        .digest("hex")
        .slice(0, 24),
      aliasLanguage: null,
      source: [
        "PRODUCT_TYPE",
        "VENDOR",
        "SKU",
        "BARCODE",
        "TAG",
        "VARIANT",
        "VARIANT_OPTION",
      ].includes(row.kind)
        ? "SHOPIFY"
        : "ENRICHMENT",
      confidence: confidenceForKind(row.kind, normalized),
    });
  }

  const entries = [...grouped.values()].map(({ productIds, ...entry }) => ({
    ...entry,
    productCount: productIds.size,
  }));
  const value: ShopSearchDictionary = {
    shop,
    entries,
    version: `context-v4-shared-revision:${catalogSnapshot.catalogRevision}:${entries.length}`,
    loadedAt: Date.now(),
    matchIndex: buildMatchIndex(entries),
  };
  const cacheEntry: DictionaryCacheEntry = {
    expiresAt: Date.now() + CACHE_SAFETY_TTL_MS,
    catalogRevision: catalogSnapshot.catalogRevision,
    value,
  };
  // An indexing webhook can invalidate the dictionary while its full
  // catalog aggregation is still running. Do not resurrect that stale result.
  if (generation === (dictionaryGeneration.get(shop) ?? 0)) {
    touchCache(shop, cacheEntry);
    enforceCacheBudget();
  }
  return value;
}

export async function getShopSearchDictionary(
  shop: string,
): Promise<ShopSearchDictionary> {
  const normalizedShop = shop.trim().toLowerCase();
  const revisionSnapshot = await getSearchCatalogRevisionCached(normalizedShop);
  const catalogRevision = revisionSnapshot?.semanticRevision ?? "0";

  const cached = cache.get(normalizedShop);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.catalogRevision === catalogRevision
  ) {
    touchCache(normalizedShop, cached);
    return cached.value;
  }

  const pendingKey = `${normalizedShop}\u0000${catalogRevision}`;
  const pending = pendingLoads.get(pendingKey);
  if (pending) return pending;

  const task = loadShopSearchDictionaryUncached(
    normalizedShop,
    catalogRevision,
  );
  pendingLoads.set(pendingKey, task);

  try {
    return await task;
  } finally {
    if (pendingLoads.get(pendingKey) === task) {
      pendingLoads.delete(pendingKey);
    }
  }
}

export function invalidateShopSearchDictionary(shop: string) {
  const normalizedShop = shop.trim().toLowerCase();
  cache.delete(normalizedShop);
  dictionaryGeneration.set(
    normalizedShop, (dictionaryGeneration.get(normalizedShop) ?? 0) + 1,
  );
  for (const key of pendingLoads.keys()) {
    if (key.startsWith(normalizedShop + "\u0000")) pendingLoads.delete(key);
  }
}
