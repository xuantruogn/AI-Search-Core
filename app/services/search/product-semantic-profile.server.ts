import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import db from "../../db.server";
import type { ProductSemanticAnalysis } from "../products/product-embedding-input.server";
import { normalizeSemanticValue } from "./semantic-normalization.server";
import { getSearchCatalogRevisionCached } from "./search-catalog-revision.server";

export type StoredSemanticTerm = {
  kind: string;
  value: string;
  normalizedValue: string;
};

type SemanticAnalysisMeta = {
  sourceLanguage?: string;
  canonicalProductType?: string;
  shopLanguageProductType?: string;
  sourceLanguageTerms?: string[];
  shopLanguageTerms?: string[];
  factualSummary?: string;
};

export type StoredProductSemanticProfile = {
  schemaVersion: 1 | 2;
  analysisMeta: SemanticAnalysisMeta | null;
  terms: StoredSemanticTerm[];
};

export type FlatSemanticRow = StoredSemanticTerm & {
  productId: string;
  updatedAt: Date;
};

export const PRODUCT_SEMANTIC_PROFILE_SCHEMA_VERSION = 2;
const PROFILE_SCHEMA_VERSION = PRODUCT_SEMANTIC_PROFILE_SCHEMA_VERSION;
const MAX_STORED_SEMANTIC_TERMS = 320;
const MAX_STORED_TERM_LENGTH = 255;
const MAX_ANALYSIS_TERM_COUNT = 64;
const MAX_FACTUAL_SUMMARY_LENGTH = 4_000;

// Refresh payload-only metadata built from the previous truncated JSON reader;
// the embedding vector/model/dimensions do not change.
export const PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION = 5;

const VECTOR_INDEXED_SEMANTIC_KINDS = new Set([
  "CANONICAL_PRODUCT_TYPE",
  "PRODUCT_TYPE",
  "CATEGORY",
  "ALIAS",
  "BRAND",
  "VENDOR",
  "MODEL",
  "IDENTIFIER",
  "SKU",
  "BARCODE",
  "COMPATIBILITY",
  "MEASUREMENT",
  "VARIANT_OPTION",
  "ATTRIBUTE",
  "AUDIENCE",
]);

// Profile storage itself is capped at 320 unique terms. Qdrant keeps opaque
// fixed-width hashes instead of duplicating the original strings, so retaining
// the full retrieval-critical set is both compact and safe for absence proofs.
const MAX_VECTOR_INDEXED_SEMANTIC_TERMS = 320;

const VECTOR_SEMANTIC_KIND_PRIORITY: Record<string, number> = {
  IDENTIFIER: 10,
  SKU: 10,
  BARCODE: 10,
  MODEL: 20,
  BRAND: 30,
  VENDOR: 30,
  CANONICAL_PRODUCT_TYPE: 40,
  PRODUCT_TYPE: 50,
  CATEGORY: 60,
  ALIAS: 70,
  COMPATIBILITY: 80,
  MEASUREMENT: 90,
  VARIANT_OPTION: 100,
  ATTRIBUTE: 110,
  AUDIENCE: 120,
};

export type ProductVectorSemanticPayload = {
  semanticPayloadVersion: number;
  semanticPayloadHash: string;
  semanticPayloadComplete: boolean;
  semanticKinds: string[];
  semanticTerms: string[];
};

export function semanticPayloadToken(kind: string, normalizedValue: string) {
  const cleanKind = kind.trim().toUpperCase().slice(0, 64);
  const cleanValue = normalizeSemanticValue(normalizedValue);
  if (!cleanKind || !cleanValue) return "";

  // Qdrant only needs equality, not the human-readable term. A 132-bit token
  // keeps payloads bounded even for long attributes/compatibility strings while
  // retaining effectively collision-free exact matching.
  return createHash("sha256")
    .update(cleanKind + "\u0000" + cleanValue, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

export function buildProductVectorSemanticPayload(
  terms: StoredSemanticTerm[],
): ProductVectorSemanticPayload {
  const indexedByToken = new Map<string, { kind: string; token: string }>();
  for (const term of terms) {
    const kind = term.kind.trim().toUpperCase();
    if (!VECTOR_INDEXED_SEMANTIC_KINDS.has(kind)) continue;
    const token = semanticPayloadToken(
      kind,
      term.normalizedValue || term.value,
    );
    if (token && !indexedByToken.has(token)) {
      indexedByToken.set(token, { kind, token });
    }
  }

  const allEntries = [...indexedByToken.values()].sort(
    (left, right) =>
      (VECTOR_SEMANTIC_KIND_PRIORITY[left.kind] ?? 999) -
        (VECTOR_SEMANTIC_KIND_PRIORITY[right.kind] ?? 999) ||
      left.token.localeCompare(right.token),
  );

  const semanticPayloadComplete =
    allEntries.length <= MAX_VECTOR_INDEXED_SEMANTIC_TERMS;
  const selectedEntries = allEntries.slice(
    0,
    MAX_VECTOR_INDEXED_SEMANTIC_TERMS,
  );
  const semanticTerms = selectedEntries.map((entry) => entry.token);
  const semanticKinds = [
    ...new Set(selectedEntries.map((entry) => entry.kind)),
  ].sort();

  const semanticPayloadHash = createHash("sha256")
    .update(
      [
        semanticPayloadComplete ? "complete" : "truncated",
        ...semanticTerms,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");

  return {
    semanticPayloadVersion: PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION,
    semanticPayloadHash,
    semanticPayloadComplete,
    semanticKinds,
    semanticTerms,
  };
}

const CACHE_TTL_MS = (() => {
  const raw = Number.parseInt(
    process.env.AI_SEARCH_SEMANTIC_PROFILE_CACHE_TTL_MS || "",
    10,
  );
  return Number.isSafeInteger(raw) && raw >= 60_000
    ? Math.min(raw, 24 * 60 * 60_000)
    : 6 * 60 * 60_000;
})();

type ShopSemanticCacheEntry = {
  expiresAt: number;
  catalogRevision: string;
  rows: FlatSemanticRow[] | null;
  rowsByProduct: Map<string, FlatSemanticRow[]>;
  byKindNormalized: Map<string, FlatSemanticRow[]>;
  byNormalized: Map<string, FlatSemanticRow[]>;
  productIdsByKind: Map<string, Set<string>>;
  rowCount: number;
};

const PROFILE_LOAD_BATCH_SIZE = (() => {
  const raw = Number.parseInt(
    process.env.AI_SEARCH_SEMANTIC_PROFILE_LOAD_BATCH_SIZE || "",
    10,
  );
  return Number.isSafeInteger(raw) && raw > 0
    ? Math.min(raw, 2_000)
    : 500;
})();

const MAX_CACHED_SEMANTIC_ROWS = (() => {
  const raw = Number.parseInt(
    process.env.AI_SEARCH_SEMANTIC_CACHE_MAX_ROWS || "",
    10,
  );
  return Number.isSafeInteger(raw) && raw >= 10_000
    ? Math.min(raw, 1_000_000)
    : 250_000;
})();

const MAX_TOTAL_CACHED_SEMANTIC_ROWS = (() => {
  const raw = Number.parseInt(
    process.env.AI_SEARCH_SEMANTIC_CACHE_MAX_TOTAL_ROWS || "",
    10,
  );
  return Number.isSafeInteger(raw) && raw >= 10_000
    ? Math.min(raw, 2_000_000)
    : 500_000;
})();

const cache = new Map<string, ShopSemanticCacheEntry>();
const pendingLoads = new Map<string, Promise<FlatSemanticRow[]>>();

function touchCacheEntry(shop: string, entry: ShopSemanticCacheEntry) {
  cache.delete(shop);
  cache.set(shop, entry);
}

function enforceSemanticCacheBudget() {
  let totalRows = [...cache.values()].reduce(
    (sum, entry) => sum + entry.rowCount,
    0,
  );
  while (
    cache.size > 100 ||
    totalRows > MAX_TOTAL_CACHED_SEMANTIC_ROWS
  ) {
    const oldest = cache.entries().next().value as
      | [string, ShopSemanticCacheEntry]
      | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    totalRows -= oldest[1].rowCount;
  }
}

function semanticIndexKey(kind: string, normalizedValue: string) {
  return `${kind}\u0000${normalizedValue}`;
}

function buildSemanticIndexes(rows: FlatSemanticRow[]) {
  const byKindNormalized = new Map<string, FlatSemanticRow[]>();
  const byNormalized = new Map<string, FlatSemanticRow[]>();
  for (const row of rows) {
    const key = semanticIndexKey(row.kind, row.normalizedValue);
    const typedList = byKindNormalized.get(key) ?? [];
    typedList.push(row);
    byKindNormalized.set(key, typedList);

    const normalizedList = byNormalized.get(row.normalizedValue) ?? [];
    normalizedList.push(row);
    byNormalized.set(row.normalizedValue, normalizedList);
  }
  return { byKindNormalized, byNormalized };
}

function buildRowsByProduct(rows: FlatSemanticRow[]) {
  const rowsByProduct = new Map<string, FlatSemanticRow[]>();
  for (const row of rows) {
    const list = rowsByProduct.get(row.productId) ?? [];
    list.push(row);
    rowsByProduct.set(row.productId, list);
  }
  return rowsByProduct;
}

function buildProductIdsByKind(rows: FlatSemanticRow[]) {
  const productIdsByKind = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = productIdsByKind.get(row.kind) ?? new Set<string>();
    ids.add(row.productId);
    productIdsByKind.set(row.kind, ids);
  }
  return productIdsByKind;
}

function materializeCachedRows(entry: ShopSemanticCacheEntry) {
  if (entry.rows) return entry.rows;
  entry.rows = [...entry.rowsByProduct.values()].flat();
  return entry.rows;
}

function replaceCachedProductRows(args: {
  shop: string;
  productId: string;
  terms: StoredSemanticTerm[];
  updatedAt: Date;
  active: boolean;
}) {
  const entry = cache.get(args.shop);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) cache.delete(args.shop);
    return;
  }

  const previousRows = entry.rowsByProduct.get(args.productId) ?? [];
  for (const row of previousRows) {
    const key = semanticIndexKey(row.kind, row.normalizedValue);
    const typedList = entry.byKindNormalized.get(key);
    if (typedList) {
      const next = typedList.filter(
        (candidate) => candidate.productId !== args.productId,
      );
      if (next.length > 0) entry.byKindNormalized.set(key, next);
      else entry.byKindNormalized.delete(key);
    }

    const normalizedList = entry.byNormalized.get(row.normalizedValue);
    if (normalizedList) {
      const next = normalizedList.filter(
        (candidate) => candidate.productId !== args.productId,
      );
      if (next.length > 0) entry.byNormalized.set(row.normalizedValue, next);
      else entry.byNormalized.delete(row.normalizedValue);
    }

    const kindProductIds = entry.productIdsByKind.get(row.kind);
    if (kindProductIds) {
      kindProductIds.delete(args.productId);
      if (kindProductIds.size === 0) entry.productIdsByKind.delete(row.kind);
    }
  }

  entry.rowCount -= previousRows.length;
  entry.rowsByProduct.delete(args.productId);

  if (args.active) {
    const nextRows = args.terms.map((term) => ({
      productId: args.productId,
      updatedAt: args.updatedAt,
      ...term,
    }));
    entry.rowsByProduct.set(args.productId, nextRows);
    entry.rowCount += nextRows.length;

    for (const row of nextRows) {
      const key = semanticIndexKey(row.kind, row.normalizedValue);
      const typedList = entry.byKindNormalized.get(key) ?? [];
      typedList.push(row);
      entry.byKindNormalized.set(key, typedList);

      const normalizedList = entry.byNormalized.get(row.normalizedValue) ?? [];
      normalizedList.push(row);
      entry.byNormalized.set(row.normalizedValue, normalizedList);

      const kindProductIds =
        entry.productIdsByKind.get(row.kind) ?? new Set<string>();
      kindProductIds.add(row.productId);
      entry.productIdsByKind.set(row.kind, kindProductIds);
    }
  }

  entry.rows = null;
  entry.expiresAt = Date.now() + CACHE_TTL_MS;
  touchCacheEntry(args.shop, entry);
  enforceSemanticCacheBudget();
}

export function removeProductSemanticProfileFromCache(
  shop: string,
  productId: string,
) {
  replaceCachedProductRows({
    shop,
    productId,
    terms: [],
    updatedAt: new Date(0),
    active: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanTermString(value: unknown) {
  return cleanString(value).slice(0, MAX_STORED_TERM_LENGTH);
}

function cleanStringArray(value: unknown, limit = MAX_ANALYSIS_TERM_COUNT) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const cleaned = cleanTermString(item);
    if (!cleaned) continue;
    const normalized = normalizeSemanticValue(cleaned);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}
function analysisMetaFromAnalysis(
  analysis: ProductSemanticAnalysis | null,
): SemanticAnalysisMeta | null {
  if (!analysis) return null;
  const meta: SemanticAnalysisMeta = {};
  const sourceLanguage = cleanString(analysis.sourceLanguage);
  const canonicalProductType = cleanString(analysis.canonicalProductType);
  const shopLanguageProductType = cleanString(analysis.shopLanguageProductType);
  const factualSummary = cleanString(analysis.factualSummary).slice(
    0,
    MAX_FACTUAL_SUMMARY_LENGTH,
  );
  const sourceLanguageTerms = cleanStringArray(analysis.sourceLanguageTerms);
  const shopLanguageTerms = cleanStringArray(analysis.shopLanguageTerms);

  if (sourceLanguage) meta.sourceLanguage = sourceLanguage;
  if (canonicalProductType) meta.canonicalProductType = canonicalProductType;
  if (shopLanguageProductType) meta.shopLanguageProductType = shopLanguageProductType;
  if (sourceLanguageTerms.length > 0) meta.sourceLanguageTerms = sourceLanguageTerms;
  if (shopLanguageTerms.length > 0) meta.shopLanguageTerms = shopLanguageTerms;
  if (factualSummary) meta.factualSummary = factualSummary;
  return Object.keys(meta).length > 0 ? meta : null;
}

function parseAnalysisMeta(value: unknown): SemanticAnalysisMeta | null {
  if (!isRecord(value)) return null;
  const meta: SemanticAnalysisMeta = {};
  const sourceLanguage = cleanString(value.sourceLanguage);
  const canonicalProductType = cleanString(value.canonicalProductType);
  const shopLanguageProductType = cleanString(value.shopLanguageProductType);
  const factualSummary = cleanString(value.factualSummary).slice(
    0,
    MAX_FACTUAL_SUMMARY_LENGTH,
  );
  const sourceLanguageTerms = cleanStringArray(value.sourceLanguageTerms);
  const shopLanguageTerms = cleanStringArray(value.shopLanguageTerms);

  if (sourceLanguage) meta.sourceLanguage = sourceLanguage;
  if (canonicalProductType) meta.canonicalProductType = canonicalProductType;
  if (shopLanguageProductType) meta.shopLanguageProductType = shopLanguageProductType;
  if (sourceLanguageTerms.length > 0) meta.sourceLanguageTerms = sourceLanguageTerms;
  if (shopLanguageTerms.length > 0) meta.shopLanguageTerms = shopLanguageTerms;
  if (factualSummary) meta.factualSummary = factualSummary;
  return Object.keys(meta).length > 0 ? meta : null;
}

function parseLegacyTerm(value: unknown): StoredSemanticTerm | null {
  if (!isRecord(value)) return null;
  const kind = cleanString(value.kind).slice(0, 64);
  const termValue = cleanTermString(value.value);
  if (!kind || !termValue) return null;
  const normalizedValue =
    cleanString(value.normalizedValue) || normalizeSemanticValue(termValue);
  if (!normalizedValue) return null;
  return { kind, value: termValue, normalizedValue };
}

function dedupeTerms(terms: StoredSemanticTerm[]) {
  const result = new Map<string, StoredSemanticTerm>();
  for (const term of terms) {
    const kind = cleanString(term.kind).slice(0, 64);
    const value = cleanTermString(term.value);
    const normalizedValue =
      normalizeSemanticValue(value) || cleanString(term.normalizedValue);
    if (!kind || !value || !normalizedValue) continue;
    const key = `${kind}\u0000${normalizedValue}`;
    if (!result.has(key)) result.set(key, { kind, value, normalizedValue });
  }
  return [...result.values()].slice(0, MAX_STORED_SEMANTIC_TERMS);
}
function valuesToTerms(value: unknown) {
  if (!isRecord(value)) return [];
  const terms: StoredSemanticTerm[] = [];
  for (const [kind, rawValues] of Object.entries(value)) {
    // Profile values are retrieval data, not the smaller LLM metadata arrays.
    // Reading with the metadata cap silently dropped SKU/attribute terms that
    // the writer and Qdrant payload had retained.
    for (const item of cleanStringArray(rawValues, MAX_STORED_SEMANTIC_TERMS)) {
      const normalizedValue = normalizeSemanticValue(item);
      if (!normalizedValue) continue;
      terms.push({ kind, value: item, normalizedValue });
    }
  }
  return dedupeTerms(terms);
}

function termsToValues(terms: StoredSemanticTerm[]) {
  const grouped = new Map<string, string[]>();
  for (const term of dedupeTerms(terms)) {
    const list = grouped.get(term.kind) ?? [];
    list.push(term.value);
    grouped.set(term.kind, list);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, values]) => [kind, values]),
  );
}

export function parseStoredSemanticProfile(
  value: Prisma.JsonValue | null | undefined,
): StoredProductSemanticProfile {
  if (!isRecord(value)) {
    return { schemaVersion: 2, analysisMeta: null, terms: [] };
  }

  if (Number(value.schemaVersion) >= 2 && isRecord(value.values)) {
    return {
      schemaVersion: 2,
      analysisMeta: parseAnalysisMeta(value.meta),
      terms: valuesToTerms(value.values),
    };
  }

  const terms = Array.isArray(value.terms)
    ? value.terms
        .map(parseLegacyTerm)
        .filter((term): term is StoredSemanticTerm => Boolean(term))
    : [];

  return {
    schemaVersion: 1,
    analysisMeta:
      parseAnalysisMeta(value.meta) ??
      parseAnalysisMeta(value.analysis),
    terms: dedupeTerms(terms),
  };
}

function profileJson(
  analysisMeta: SemanticAnalysisMeta | null,
  terms: StoredSemanticTerm[],
): Prisma.InputJsonValue {
  const payload: Record<string, unknown> = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    values: termsToValues(terms),
  };
  if (analysisMeta) payload.meta = analysisMeta;
  return payload as Prisma.InputJsonObject;
}

export function invalidateProductSemanticProfileCache(shop: string) {
  cache.delete(shop);
}
export async function replaceProductSemanticProfile(args: {
  shop: string;
  productId: string;
  analysis: ProductSemanticAnalysis | null;
  terms: StoredSemanticTerm[];
}) {
  const terms = dedupeTerms(args.terms);
  const profile = profileJson(analysisMetaFromAnalysis(args.analysis), terms);
  const record = await db.aiSearchProductSemanticProfile.upsert({
    where: {
      shop_productId: {
        shop: args.shop,
        productId: args.productId,
      },
    },
    create: {
      shop: args.shop,
      productId: args.productId,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile,
    },
    update: {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile,
    },
    select: {
      updatedAt: true,
      productRecord: {
        select: { searchable: true, hasVector: true },
      },
    },
  });
  replaceCachedProductRows({
    shop: args.shop,
    productId: args.productId,
    terms,
    updatedAt: record.updatedAt,
    active:
      record.productRecord.searchable &&
      record.productRecord.hasVector,
  });
  return terms.length;
}

export async function ensureProductSemanticTerms(args: {
  shop: string;
  productId: string;
  terms: StoredSemanticTerm[];
}) {
  const existing = await db.aiSearchProductSemanticProfile.findUnique({
    where: {
      shop_productId: {
        shop: args.shop,
        productId: args.productId,
      },
    },
    select: { profile: true, schemaVersion: true },
  });
  const parsed = parseStoredSemanticProfile(existing?.profile);
  const merged = dedupeTerms([...parsed.terms, ...args.terms]);

  const shouldRewrite =
    !existing ||
    existing.schemaVersion < PROFILE_SCHEMA_VERSION ||
    merged.length !== parsed.terms.length;

  if (shouldRewrite) {
    const profile = profileJson(parsed.analysisMeta, merged);
    const record = await db.aiSearchProductSemanticProfile.upsert({
      where: {
        shop_productId: {
          shop: args.shop,
          productId: args.productId,
        },
      },
      create: {
        shop: args.shop,
        productId: args.productId,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profile,
      },
      update: {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profile,
      },
      select: {
        updatedAt: true,
        productRecord: {
          select: { searchable: true, hasVector: true },
        },
      },
    });
    replaceCachedProductRows({
      shop: args.shop,
      productId: args.productId,
      terms: merged,
      updatedAt: record.updatedAt,
      active:
        record.productRecord.searchable &&
        record.productRecord.hasVector,
    });
  }

  return merged.length;
}

export async function compactLegacySemanticProfiles(
  batchSize = 500,
) {
  const safeBatchSize = Math.max(1, Math.min(Math.trunc(batchSize), 2_000));
  const rows = await db.aiSearchProductSemanticProfile.findMany({
    where: { schemaVersion: { lt: PROFILE_SCHEMA_VERSION } },
    orderBy: { id: "asc" },
    take: safeBatchSize,
    select: { id: true, shop: true, profile: true },
  });
  if (rows.length === 0) return { rewritten: 0, remaining: 0 };

  const updates = rows.map((row) => {
    const parsed = parseStoredSemanticProfile(row.profile);
    return db.aiSearchProductSemanticProfile.update({
      where: { id: row.id },
      data: {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profile: profileJson(parsed.analysisMeta, parsed.terms),
      },
    });
  });
  await db.$transaction(updates);
  for (const shop of new Set(rows.map((row) => row.shop))) {
    invalidateProductSemanticProfileCache(shop);
  }
  const remaining = await db.aiSearchProductSemanticProfile.count({
    where: { schemaVersion: { lt: PROFILE_SCHEMA_VERSION } },
  });
  return { rewritten: rows.length, remaining };
}
async function loadShopSemanticRowsUncached(
  shop: string,
  catalogRevision: string,
) {
  const rows: FlatSemanticRow[] = [];
  let cursorId = 0;

  for (;;) {
    const profiles = await db.aiSearchProductSemanticProfile.findMany({
      where: {
        shop,
        id: { gt: cursorId },
        productRecord: {
          is: {
            searchable: true,
            hasVector: true,
          },
        },
      },
      orderBy: { id: "asc" },
      take: PROFILE_LOAD_BATCH_SIZE,
      select: {
        id: true,
        productId: true,
        profile: true,
        updatedAt: true,
      },
    });

    if (profiles.length === 0) break;

    for (const record of profiles) {
      const parsed = parseStoredSemanticProfile(record.profile);
      for (const term of parsed.terms) {
        rows.push({
          productId: record.productId,
          updatedAt: record.updatedAt,
          ...term,
        });
      }
    }

    cursorId = profiles[profiles.length - 1].id;
    if (profiles.length < PROFILE_LOAD_BATCH_SIZE) break;
  }

  if (rows.length <= MAX_CACHED_SEMANTIC_ROWS) {
    const indexes = buildSemanticIndexes(rows);
    cache.set(shop, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      catalogRevision,
      rows,
      rowsByProduct: buildRowsByProduct(rows),
      byKindNormalized: indexes.byKindNormalized,
      byNormalized: indexes.byNormalized,
      productIdsByKind: buildProductIdsByKind(rows),
      rowCount: rows.length,
    });
    enforceSemanticCacheBudget();
  } else {
    cache.delete(shop);
  }

  return rows;
}

export async function loadShopSemanticRows(shop: string) {
  const normalizedShop = shop.trim().toLowerCase();
  const revisionSnapshot =
    await getSearchCatalogRevisionCached(normalizedShop);
  const catalogRevision = revisionSnapshot?.semanticRevision ?? "0";

  const cached = cache.get(normalizedShop);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.catalogRevision === catalogRevision
  ) {
    touchCacheEntry(normalizedShop, cached);
    return materializeCachedRows(cached);
  }

  const pendingKey = `${normalizedShop}\u0000${catalogRevision}`;
  const pending = pendingLoads.get(pendingKey);
  if (pending) return pending;

  const task = loadShopSemanticRowsUncached(
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

export async function countSemanticProductsForKind(
  shop: string,
  kind: string,
) {
  const normalizedShop = shop.trim().toLowerCase();
  await loadShopSemanticRows(normalizedShop);
  const loaded = cache.get(normalizedShop);
  if (loaded && loaded.expiresAt > Date.now()) {
    touchCacheEntry(normalizedShop, loaded);
    return loaded.productIdsByKind.get(kind)?.size ?? 0;
  }

  // Very large shops may intentionally exceed the in-memory cache budget.
  // Fall back to a bounded profile scan rather than expanding one-row-per-term
  // data back into SQL.
  const ids = new Set<string>();
  await scanShopSemanticProfiles(shop, ({ productId, terms }) => {
    if (terms.some((term) => term.kind === kind)) ids.add(productId);
  });
  return ids.size;
}

export async function findSemanticRowsByNormalizedValues(
  shop: string,
  values: Iterable<string>,
) {
  const normalizedValues = [...new Set(
    [...values]
      .map((value) => normalizeSemanticValue(value))
      .filter(Boolean),
  )];
  if (normalizedValues.length === 0) return [];

  const normalizedShop = shop.trim().toLowerCase();
  const rows = await loadShopSemanticRows(normalizedShop);
  const loaded = cache.get(normalizedShop);
  if (loaded && loaded.expiresAt > Date.now()) {
    touchCacheEntry(normalizedShop, loaded);
    return normalizedValues.flatMap(
      (value) => loaded.byNormalized.get(value) ?? [],
    );
  }

  const wanted = new Set(normalizedValues);
  return rows.filter((row) => wanted.has(row.normalizedValue));
}

export async function scanShopSemanticProfiles(
  shop: string,
  visitor: (profile: {
    productId: string;
    terms: StoredSemanticTerm[];
    updatedAt: Date;
  }) => void | Promise<void>,
) {
  let cursorId = 0;
  let scanned = 0;

  for (;;) {
    const profiles = await db.aiSearchProductSemanticProfile.findMany({
      where: {
        shop,
        id: { gt: cursorId },
        productRecord: {
          is: {
            searchable: true,
            hasVector: true,
          },
        },
      },
      orderBy: { id: "asc" },
      take: PROFILE_LOAD_BATCH_SIZE,
      select: {
        id: true,
        productId: true,
        profile: true,
        updatedAt: true,
      },
    });

    if (profiles.length === 0) break;

    for (const record of profiles) {
      const parsed = parseStoredSemanticProfile(record.profile);
      await visitor({
        productId: record.productId,
        terms: parsed.terms,
        updatedAt: record.updatedAt,
      });
      scanned += 1;
    }

    cursorId = profiles[profiles.length - 1].id;
    if (profiles.length < PROFILE_LOAD_BATCH_SIZE) break;
  }

  return scanned;
}

export async function loadProductSemanticRows(
  shop: string,
  productIds: string[],
) {
  const uniqueIds = [...new Set(productIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const rows: FlatSemanticRow[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += 500) {
    const batchIds = uniqueIds.slice(offset, offset + 500);
    const profiles = await db.aiSearchProductSemanticProfile.findMany({
      where: {
        shop,
        productId: { in: batchIds },
        productRecord: {
          is: {
            searchable: true,
            hasVector: true,
          },
        },
      },
      select: {
        productId: true,
        profile: true,
        updatedAt: true,
      },
    });

    for (const record of profiles) {
      const parsed = parseStoredSemanticProfile(record.profile);
      for (const term of parsed.terms) {
        rows.push({
          productId: record.productId,
          updatedAt: record.updatedAt,
          ...term,
        });
      }
    }
  }

  return rows;
}

export async function findSemanticProductIds(args: {
  shop: string;
  kinds: string[];
  normalizedValue: string;
}) {
  const normalizedValue = normalizeSemanticValue(args.normalizedValue);
  if (!normalizedValue || args.kinds.length === 0) return new Set<string>();

  const normalizedShop = args.shop.trim().toLowerCase();
  const rows = await loadShopSemanticRows(normalizedShop);
  const loaded = cache.get(normalizedShop);
  if (loaded && loaded.expiresAt > Date.now()) {
    touchCacheEntry(normalizedShop, loaded);
    const ids = new Set<string>();
    for (const kind of args.kinds) {
      for (const row of loaded.byKindNormalized.get(
        semanticIndexKey(kind, normalizedValue),
      ) ?? []) {
        ids.add(row.productId);
      }
    }
    return ids;
  }

  const kinds = new Set(args.kinds);
  return new Set(
    rows
      .filter(
        (row) =>
          kinds.has(row.kind) &&
          row.normalizedValue === normalizedValue,
      )
      .map((row) => row.productId),
  );
}

export async function getSemanticProfileState(
  shop: string,
  productId: string,
) {
  return db.aiSearchProductSemanticProfile.findUnique({
    where: { shop_productId: { shop, productId } },
    select: {
      schemaVersion: true,
      updatedAt: true,
    },
  });
}

export async function getSemanticProfileForProduct(
  shop: string,
  productId: string,
) {
  const record = await db.aiSearchProductSemanticProfile.findUnique({
    where: { shop_productId: { shop, productId } },
    select: {
      productId: true,
      profile: true,
      schemaVersion: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!record) return null;
  return {
    ...record,
    parsed: parseStoredSemanticProfile(record.profile),
  };
}
