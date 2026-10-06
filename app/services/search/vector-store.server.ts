import db from "../../db.server";

import {
  BM25_MODEL,
  BM25_OPTIONS,
  BM25_VECTOR_NAME,
  DENSE_VECTOR_NAME,
  ensureProductCollection,
  getQdrantClient,
  QDRANT_COLLECTION,
} from "./qdrant.server";
import { getTenantProductVectorPointId } from "./vector-id.server";
import {
  buildProductVectorSemanticPayload,
  parseStoredSemanticProfile,
  PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION,
} from "./product-semantic-profile.server";
import { getSearchCatalogRevisionCached } from "./search-catalog-revision.server";

type SemanticPayloadCoverage = {
  registryCount: number;
  indexedCount: number;
  complete: boolean;
};

type SemanticCoverageCacheEntry = {
  expiresAt: number;
  revision: string;
  coverage: SemanticPayloadCoverage;
  kindCounts: Map<string, number>;
};

const SEMANTIC_COVERAGE_CACHE_TTL_MS = 60_000;
const semanticCoverageCache = new Map<string, SemanticCoverageCacheEntry>();

function cacheSemanticCoverage(
  shop: string,
  entry: SemanticCoverageCacheEntry,
) {
  semanticCoverageCache.delete(shop);
  semanticCoverageCache.set(shop, entry);
  while (semanticCoverageCache.size > 100) {
    const oldest = semanticCoverageCache.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    semanticCoverageCache.delete(oldest);
  }
}

export type ProductVectorPayload = {
  shop: string;
  productId: string;
  handle: string;
  title: string;

  documentHash?: string;
  indexedAt?: string;
  usageReservationId?: string;
  minVariantPrice?: number;
  maxVariantPrice?: number;
  currencyCode?: string;
  searchable?: boolean;
  semanticPayloadVersion?: number;
  semanticPayloadHash?: string;
  semanticPayloadComplete?: boolean;
  semanticKinds?: string[];
  semanticTerms?: string[];
};

export type UpsertProductVectorInput = {
  pointId: number | string;
  vector: number[];
  sparseDocument?: string;
  payload: ProductVectorPayload;
};

export type SearchProductVectorsInput = {
  shop: string;
  vector: number[];
  limit?: number;
  scoreThreshold?: number;
  productIds?: string[];
  onDiagnostics?: (diagnostics: {
    requestMs: number;
    responseMappingCodeMs: number;
    totalMs: number;
    passCount: number;
    finalCandidateWindow: number;
  }) => void;
};

export type ProductVectorSearchResult = {
  score: number;
  sparseScore?: number;
  sparseRank?: number;
  /** Raw Qdrant cosine similarity before any branch weighting or reranking. */
  vectorSimilarity?: number;
  /** Raw cosine to the primary query vector when this candidate hit that branch. */
  primaryVectorSimilarity?: number;
  /** Relative support within a secondary semantic branch (0..1). */
  semanticBranchRelativeScore?: number;
  /** One-based secondary branch index providing the strongest support. */
  semanticBranchIndex?: number;
  productId: string;
  handle: string;
  title: string;
  minVariantPrice?: number;
  maxVariantPrice?: number;
  currencyCode?: string;
};

// =====================================================
// UPSERT VECTOR
// =====================================================

export async function upsertProductVector({
  pointId,
  vector,
  sparseDocument,
  payload,
}: UpsertProductVectorInput) {
  const qdrant = getQdrantClient();
  const vectors: Record<string, unknown> = {
    [DENSE_VECTOR_NAME]: vector,
  };
  if (sparseDocument?.trim()) {
    vectors[BM25_VECTOR_NAME] = {
      text: sparseDocument.trim(),
      model: BM25_MODEL,
      options: BM25_OPTIONS,
    };
  }
  await qdrant.upsert(QDRANT_COLLECTION, {
    wait: true,
    points: [
      {
        id: pointId,
        vector: vectors as any,
        payload,
      },
    ],
  });
}

// =====================================================
// GET EXISTING PRODUCT VECTOR FOR ONE TENANT
//
// Lookup uses payload.shop + payload.productId instead of the Qdrant point ID
// so Phase-1 numeric points remain readable during migration.
// =====================================================

export type ProductVectorRecord = {
  pointId: number | string;
  payload: ProductVectorPayload;
  vector: number[] | null;
  duplicatePointIds: Array<number | string>;
};

function parseProductVectorPayload(
  payload: Record<string, unknown> | null | undefined,
) {
  if (!payload) return null;

  const shop = typeof payload.shop === "string" ? payload.shop : null;
  const productId =
    typeof payload.productId === "string" ? payload.productId : null;
  const handle = typeof payload.handle === "string" ? payload.handle : null;
  const title = typeof payload.title === "string" ? payload.title : null;

  if (!shop || !productId || !handle || !title) return null;

  return {
    shop,
    productId,
    handle,
    title,
    documentHash:
      typeof payload.documentHash === "string"
        ? payload.documentHash
        : undefined,
    indexedAt:
      typeof payload.indexedAt === "string" ? payload.indexedAt : undefined,
    usageReservationId:
      typeof payload.usageReservationId === "string"
        ? payload.usageReservationId
        : undefined,
    minVariantPrice:
      typeof payload.minVariantPrice === "number" && Number.isFinite(payload.minVariantPrice)
        ? payload.minVariantPrice
        : undefined,
    maxVariantPrice:
      typeof payload.maxVariantPrice === "number" && Number.isFinite(payload.maxVariantPrice)
        ? payload.maxVariantPrice
        : undefined,
    currencyCode:
      typeof payload.currencyCode === "string" && payload.currencyCode
        ? payload.currencyCode.toUpperCase()
        : undefined,
    searchable:
      typeof payload.searchable === "boolean"
        ? payload.searchable
        : undefined,
    semanticPayloadVersion:
      typeof payload.semanticPayloadVersion === "number" &&
      Number.isFinite(payload.semanticPayloadVersion)
        ? payload.semanticPayloadVersion
        : undefined,
    semanticPayloadHash:
      typeof payload.semanticPayloadHash === "string"
        ? payload.semanticPayloadHash
        : undefined,
    semanticPayloadComplete:
      typeof payload.semanticPayloadComplete === "boolean"
        ? payload.semanticPayloadComplete
        : undefined,
    semanticKinds:
      Array.isArray(payload.semanticKinds)
        ? payload.semanticKinds.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined,
    semanticTerms:
      Array.isArray(payload.semanticTerms)
        ? payload.semanticTerms.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined,
  } satisfies ProductVectorPayload;
}

export async function getProductVectorForShop({
  shop,
  productId,
  withVector = false,
}: {
  shop: string;
  productId: string;
  withVector?: boolean;
}): Promise<ProductVectorRecord | null> {
  const qdrant = getQdrantClient();
  const result = await qdrant.scroll(QDRANT_COLLECTION, {
    filter: {
      must: [
        { key: "shop", match: { value: shop } },
        { key: "productId", match: { value: productId } },
      ],
    },
    // Normal state has exactly one point. A little headroom lets V2 clean up
    // temporary Phase-1/new-ID duplicates deterministically.
    limit: 10,
    with_payload: true,
    with_vector: withVector,
  });

  const records: ProductVectorRecord[] = [];

  for (const point of result.points) {
    const payload = parseProductVectorPayload(
      point.payload as Record<string, unknown> | null | undefined,
    );
    if (!payload || payload.shop !== shop || payload.productId !== productId) {
      continue;
    }

    const rawVector = point.vector as unknown;
    const denseVector =
      rawVector && typeof rawVector === "object" && !Array.isArray(rawVector)
        ? (rawVector as Record<string, unknown>)[DENSE_VECTOR_NAME]
        : rawVector;
    const vector =
      withVector && Array.isArray(denseVector)
        ? denseVector.filter(
            (value): value is number => typeof value === "number",
          )
        : null;

    records.push({
      pointId: point.id,
      payload,
      vector,
      duplicatePointIds: [],
    });
  }

  if (records.length === 0) return null;

  const expectedId = getTenantProductVectorPointId(shop, productId);
  const preferred =
    records.find((record) => String(record.pointId) === expectedId) ??
    records[0];

  return {
    ...preferred,
    duplicatePointIds: records
      .filter((record) => String(record.pointId) !== String(preferred.pointId))
      .map((record) => record.pointId),
  };
}

export async function migrateProductVectorPointIdIfNeeded({
  shop,
  productId,
  record,
}: {
  shop: string;
  productId: string;
  record: ProductVectorRecord | null;
}) {
  if (!record) return null;

  const expectedId = getTenantProductVectorPointId(shop, productId);
  const qdrant = getQdrantClient();

  if (String(record.pointId) === expectedId) {
    if (record.duplicatePointIds.length > 0) {
      await qdrant.delete(QDRANT_COLLECTION, {
        wait: true,
        points: record.duplicatePointIds,
      });

      console.log("[AI Search] Removed duplicate legacy Qdrant points:", {
        shop,
        productId,
        removed: record.duplicatePointIds.length,
      });
    }

    return { ...record, duplicatePointIds: [] };
  }

  // We can migrate a Phase-1 numeric point without paying OpenAI again when
  // its vector was requested. If vector data is unavailable, leave it in place
  // and the normal index path can refresh it later.
  if (!record.vector || record.vector.length === 0) return record;

  await upsertProductVector({
    pointId: expectedId,
    vector: record.vector,
    payload: record.payload,
  });

  const obsoleteIds = [record.pointId, ...record.duplicatePointIds].filter(
    (id) => String(id) !== expectedId,
  );

  if (obsoleteIds.length > 0) {
    await qdrant.delete(QDRANT_COLLECTION, {
      wait: true,
      points: obsoleteIds,
    });
  }

  console.log("[AI Search] Migrated legacy Qdrant product point ID:", {
    shop,
    productId,
    from: record.pointId,
    to: expectedId,
    duplicatesRemoved: Math.max(0, obsoleteIds.length - 1),
  });

  return {
    ...record,
    pointId: expectedId,
    duplicatePointIds: [],
  };
}

export async function updateProductVectorPayloadByPointId({
  pointId,
  payload,
}: {
  pointId: number | string;
  payload: Record<string, unknown>;
}) {
  const qdrant = getQdrantClient();
  await qdrant.setPayload(QDRANT_COLLECTION, {
    payload,
    points: [pointId],
    wait: true,
  });
}

export async function updateProductVectorPayloadForShop({
  shop,
  productId,
  payload,
}: {
  shop: string;
  productId: string;
  payload: Record<string, unknown>;
}) {
  const record = await getProductVectorForShop({ shop, productId });
  if (!record) return false;

  const qdrant = getQdrantClient();
  // Update the preferred point and any temporary legacy/new-ID duplicates so
  // a stale duplicate cannot keep an old handle/title until the next migration
  // cleanup pass. getProductVectorForShop already tenant-filters these IDs.
  await qdrant.setPayload(QDRANT_COLLECTION, {
    payload,
    points: [record.pointId, ...record.duplicatePointIds],
    wait: true,
  });
  return true;
}

export async function updateProductVectorSearchabilityForShop({
  shop,
  productIds,
  searchable,
}: {
  shop: string;
  productIds: string[];
  searchable: boolean;
}) {
  const ids = [...new Set(productIds.map((value) => value.trim()).filter(Boolean))];
  if (ids.length === 0) return 0;

  const qdrant = getQdrantClient();
  let updatedBatches = 0;
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    await qdrant.setPayload(QDRANT_COLLECTION, {
      payload: { searchable },
      filter: {
        must: [
          { key: "shop", match: { value: shop } },
          { key: "productId", match: { any: batch } },
        ],
      },
      wait: true,
    });
    updatedBatches += 1;
  }
  return updatedBatches;
}

export type SemanticPayloadCandidate = {
  productId: string;
  handle: string;
  title: string;
};

export async function findProductsBySemanticPayload({
  shop,
  semanticTerms,
  requiredGroups = [],
  limit = 2_000,
}: {
  shop: string;
  semanticTerms: string[];
  requiredGroups?: string[][];
  limit?: number;
}): Promise<SemanticPayloadCandidate[]> {
  const terms = [...new Set(
    semanticTerms.map((value) => value.trim()).filter(Boolean),
  )];
  const groups = requiredGroups
    .map((group) => [
      ...new Set(group.map((value) => value.trim()).filter(Boolean)),
    ])
    .filter((group) => group.length > 0);
  if (!shop.trim() || (terms.length === 0 && groups.length === 0)) return [];

  await ensureProductCollection();

  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5_000));
  const qdrant = getQdrantClient();
  const results: SemanticPayloadCandidate[] = [];
  const seen = new Set<string>();
  let offset: number | string | undefined;

  while (results.length < safeLimit) {
    const pageLimit = Math.min(500, safeLimit - results.length);
    const page = await qdrant.scroll(QDRANT_COLLECTION, {
      filter: {
        must: [
          { key: "shop", match: { value: shop } },
          { key: "searchable", match: { value: true } },
          {
            key: "semanticPayloadVersion",
            match: { value: PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION },
          },
          { key: "semanticPayloadComplete", match: { value: true } },
          ...groups.map((group) => ({
            key: "semanticTerms",
            match: { any: group },
          })),
          ...(groups.length === 0 && terms.length > 0
            ? [{ key: "semanticTerms", match: { any: terms } }]
            : []),
        ],
      },
      limit: pageLimit,
      ...(offset !== undefined ? { offset } : {}),
      with_payload: [
        "shop",
        "productId",
        "handle",
        "title",
        "semanticPayloadVersion",
      ],
      with_vector: false,
    });

    for (const point of page.points) {
      const payload = parseProductVectorPayload(
        point.payload as Record<string, unknown> | null | undefined,
      );
      if (
        !payload ||
        payload.shop !== shop ||
        payload.searchable === false ||
        payload.semanticPayloadVersion !==
          PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION ||
        seen.has(payload.productId)
      ) {
        continue;
      }
      seen.add(payload.productId);
      results.push({
        productId: payload.productId,
        handle: payload.handle,
        title: payload.title,
      });
      if (results.length >= safeLimit) break;
    }

    const nextOffset = page.next_page_offset;
    if (nextOffset == null || page.points.length === 0) break;
    if (offset !== undefined && String(nextOffset) === String(offset)) break;
    offset = nextOffset as number | string;
  }

  return results;
}

export async function getSemanticPayloadCoverage(shop: string) {
  const normalizedShop = shop.trim().toLowerCase();
  if (!normalizedShop) {
    return { registryCount: 0, indexedCount: 0, complete: false };
  }

  const revisionSnapshot =
    await getSearchCatalogRevisionCached(normalizedShop);
  const revision = revisionSnapshot?.catalogRevision ?? "0";
  const cached = semanticCoverageCache.get(normalizedShop);
  if (
    cached &&
    cached.revision === revision &&
    cached.expiresAt > Date.now()
  ) {
    cacheSemanticCoverage(normalizedShop, cached);
    return cached.coverage;
  }

  await ensureProductCollection();
  const qdrant = getQdrantClient();
  const [registryCount, indexed] = await Promise.all([
    db.aiSearchIndexedProduct.count({
      where: {
        shop: normalizedShop,
        searchable: true,
        hasVector: true,
      },
    }),
    qdrant.count(QDRANT_COLLECTION, {
      filter: {
        must: [
          { key: "shop", match: { value: normalizedShop } },
          { key: "searchable", match: { value: true } },
          {
            key: "semanticPayloadVersion",
            match: { value: PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION },
          },
          { key: "semanticPayloadComplete", match: { value: true } },
        ],
      },
      exact: true,
    }),
  ]);

  const indexedCount = Number(indexed.count ?? 0);
  const coverage = {
    registryCount,
    indexedCount,
    complete: registryCount > 0 && indexedCount === registryCount,
  };
  cacheSemanticCoverage(normalizedShop, {
    expiresAt: Date.now() + SEMANTIC_COVERAGE_CACHE_TTL_MS,
    revision,
    coverage,
    kindCounts: new Map(),
  });
  return coverage;
}

export async function countProductsMatchingSemanticGroups({
  shop,
  groups,
}: {
  shop: string;
  groups: string[][];
}) {
  const normalizedShop = shop.trim().toLowerCase();
  const normalizedGroups = groups
    .map((group) => [...new Set(group.map((value) => value.trim()).filter(Boolean))])
    .filter((group) => group.length > 0);
  if (!normalizedShop || normalizedGroups.length === 0) return 0;

  await ensureProductCollection();
  const qdrant = getQdrantClient();
  const result = await qdrant.count(QDRANT_COLLECTION, {
    filter: {
      must: [
        { key: "shop", match: { value: normalizedShop } },
        { key: "searchable", match: { value: true } },
        {
          key: "semanticPayloadVersion",
          match: { value: PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION },
        },
        { key: "semanticPayloadComplete", match: { value: true } },
        ...normalizedGroups.map((group) => ({
          key: "semanticTerms",
          match: { any: group },
        })),
      ],
    },
    exact: true,
  });
  return Number(result.count ?? 0);
}

export async function countProductsBySemanticKind({
  shop,
  kind,
}: {
  shop: string;
  kind: string;
}) {
  const normalizedShop = shop.trim().toLowerCase();
  const normalizedKind = kind.trim().toUpperCase();
  if (!normalizedShop || !normalizedKind) return 0;

  await getSemanticPayloadCoverage(normalizedShop);
  const cached = semanticCoverageCache.get(normalizedShop);
  const cachedCount = cached?.kindCounts.get(normalizedKind);
  if (cachedCount !== undefined) return cachedCount;

  await ensureProductCollection();
  const qdrant = getQdrantClient();
  const result = await qdrant.count(QDRANT_COLLECTION, {
    filter: {
      must: [
        { key: "shop", match: { value: normalizedShop } },
        { key: "searchable", match: { value: true } },
        {
          key: "semanticPayloadVersion",
          match: { value: PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION },
        },
        { key: "semanticPayloadComplete", match: { value: true } },
        { key: "semanticKinds", match: { value: normalizedKind } },
      ],
    },
    exact: true,
  });
  const count = Number(result.count ?? 0);
  if (cached) {
    cached.kindCounts.set(normalizedKind, count);
    cacheSemanticCoverage(normalizedShop, cached);
  }
  return count;
}

export async function backfillSemanticVectorPayloads({
  limit = 1_000,
  concurrency = 10,
}: {
  limit?: number;
  concurrency?: number;
} = {}) {
  await ensureProductCollection();

  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5_000));
  const safeConcurrency = Math.max(1, Math.min(Math.trunc(concurrency), 25));
  const qdrant = getQdrantClient();

  // Drive the backfill from the authoritative registry instead of scanning the
  // shared Qdrant collection globally. Old vectors from a deleted/redacted
  // shop can otherwise occupy every backfill page and starve live shops.
  const shops = await db.aiSearchIndexedProduct.groupBy({
    by: ["shop"],
    where: { searchable: true, hasVector: true },
    orderBy: { shop: "asc" },
  });

  let scanned = 0;
  let updated = 0;
  let missingProfiles = 0;

  for (const { shop } of shops) {
    if (scanned >= safeLimit) break;

    const page = await qdrant.scroll(QDRANT_COLLECTION, {
      filter: {
        must: [
          { key: "shop", match: { value: shop } },
          { key: "searchable", match: { value: true } },
        ],
        must_not: [
          {
            key: "semanticPayloadVersion",
            match: { value: PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION },
          },
        ],
      },
      limit: Math.min(500, safeLimit - scanned),
      with_payload: [
        "shop",
        "productId",
        "handle",
        "title",
        "searchable",
        "semanticPayloadVersion",
      ],
      with_vector: false,
    });

    const candidates = page.points
      .map((point) => {
        const payload = parseProductVectorPayload(
          point.payload as Record<string, unknown> | null | undefined,
        );
        return payload && payload.shop === shop
          ? {
              pointId: point.id,
              productId: payload.productId,
            }
          : null;
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    scanned += page.points.length;
    if (candidates.length === 0) continue;

    const profiles = await db.aiSearchProductSemanticProfile.findMany({
      where: {
        shop,
        productId: { in: candidates.map((candidate) => candidate.productId) },
        productRecord: {
          is: { searchable: true, hasVector: true },
        },
      },
      select: {
        productId: true,
        profile: true,
      },
    });

    const profileByProduct = new Map(
      profiles.map((profile) => [
        profile.productId,
        buildProductVectorSemanticPayload(
          parseStoredSemanticProfile(profile.profile).terms,
        ),
      ]),
    );

    for (
      let offset = 0;
      offset < candidates.length;
      offset += safeConcurrency
    ) {
      const batch = candidates.slice(offset, offset + safeConcurrency);
      const outcomes = await Promise.all(
        batch.map(async (candidate) => {
          const semanticPayload = profileByProduct.get(candidate.productId);
          if (!semanticPayload) return false;
          await updateProductVectorPayloadByPointId({
            pointId: candidate.pointId,
            payload: semanticPayload,
          });
          return true;
        }),
      );
      const updatedInBatch = outcomes.filter(Boolean).length;
      updated += updatedInBatch;
      missingProfiles += outcomes.filter((value) => !value).length;
      if (updatedInBatch > 0) {
        // Coverage is revision-keyed because semantic changes bump the catalog
        // revision, but a payload-only backfill intentionally does not. Drop
        // the local coverage cache so the new optimization becomes usable
        // immediately instead of waiting for its TTL.
        semanticCoverageCache.delete(shop);
      }
    }
  }

  return { scanned, updated, missingProfiles };
}

// =====================================================
// DELETE PRODUCT VECTOR
//
// Dùng khi:
//
// products/delete
//
// hoặc:
//
// ACTIVE
//   ↓
// DRAFT / ARCHIVED
//
// Xóa Qdrant point không gọi OpenAI.
// =====================================================

// Prefer this tenant-scoped deletion in multi-shop workflows. The shared
// collection must never rely on a provider product ID being globally unique
// across stores; the payload filter also removes legacy/alternate point IDs.
export async function deleteProductVectorForShop({
  shop,
  productId,
}: {
  shop: string;
  productId: string;
}) {
  const qdrant = getQdrantClient();
  await qdrant.delete(QDRANT_COLLECTION, {
    wait: true,
    filter: {
      must: [
        { key: "shop", match: { value: shop } },
        { key: "productId", match: { value: productId } },
      ],
    },
  });
}

// =====================================================
// BACKGROUND ORPHAN VECTOR RECONCILIATION
//
// Source of truth:
// AiSearchIndexedProduct(hasVector=true)
//
// Search eligibility is intentionally not part of orphan detection. A vector
// retained for a temporarily ineligible product is still owned by the
// registry and must not be deleted here.
//
// Qdrant can contain an orphan when a process crashes after the vector write
// but before the registry write, or when old data predates the registry.
//
// Important race rule:
// - search-time guard only FILTERS invalid vectors;
// - background reconciliation is allowed to DELETE them;
// - a short grace window protects a freshly written Qdrant point while the
//   matching DB registry row is still being committed.
// =====================================================

export type ReconcileOrphanProductVectorsResult = {
  shop: string;
  scannedPoints: number;
  validPoints: number;
  removedPoints: number;
  malformedPointsRemoved: number;
  recentPointsSkipped: number;
  removedProductIds: string[];
};

type OrphanVectorScanCandidate = {
  pointId: number | string;
  payload: Record<string, unknown>;
  productId: string;
  recent: boolean;
};

function clampPositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
) {
  if (!Number.isFinite(value)) return fallback;

  const parsed = Math.trunc(value as number);
  return parsed > 0 ? Math.min(parsed, max) : fallback;
}

function readOrphanGraceMs() {
  const raw = Number.parseInt(
    process.env.AI_SEARCH_QDRANT_ORPHAN_GRACE_MS || "",
    10,
  );

  return Number.isSafeInteger(raw) && raw >= 0
    ? raw
    : 5 * 60_000;
}

function pointIsInsideOrphanGraceWindow(
  payload: Record<string, unknown> | null | undefined,
  now: number,
  graceMs: number,
) {
  if (graceMs <= 0) return false;

  const indexedAt =
    typeof payload?.indexedAt === "string"
      ? payload.indexedAt
      : null;

  if (!indexedAt) return false;

  const timestamp = Date.parse(indexedAt);
  if (!Number.isFinite(timestamp)) return false;

  return now - timestamp < graceMs;
}

export async function reconcileOrphanProductVectorsForShop({
  shop,
  batchSize = 100,
  graceMs = readOrphanGraceMs(),
}: {
  shop: string;
  batchSize?: number;
  graceMs?: number;
}): Promise<ReconcileOrphanProductVectorsResult> {
  const normalizedShop = shop.trim().toLowerCase();

  if (!normalizedShop) {
    throw new Error("Shop is required for Qdrant orphan reconciliation");
  }

  const safeBatchSize = clampPositiveInteger(batchSize, 100, 256);
  const safeGraceMs =
    Number.isFinite(graceMs) && graceMs >= 0
      ? Math.trunc(graceMs)
      : readOrphanGraceMs();

  await ensureProductCollection();

  const qdrant = getQdrantClient();
  const now = Date.now();

  let offset: number | string | Record<string, unknown> | undefined;
  let scannedPoints = 0;
  let validPoints = 0;
  let removedPoints = 0;
  let malformedPointsRemoved = 0;
  let recentPointsSkipped = 0;

  const removedProductIds = new Set<string>();

  for (;;) {
    const page = await qdrant.scroll(QDRANT_COLLECTION, {
      filter: {
        must: [
          {
            key: "shop",
            match: {
              value: normalizedShop,
            },
          },
        ],
      },
      limit: safeBatchSize,
      offset,
      with_payload: ["shop", "productId", "indexedAt"],
      with_vector: false,
    });

    const nextOffset = page.next_page_offset ?? undefined;
    scannedPoints += page.points.length;

    const candidates = page.points
      .map((point) => {
        const payload = point.payload as
          | Record<string, unknown>
          | null
          | undefined;

        // Defense in depth. The Qdrant filter should already guarantee this,
        // but never delete a point whose tenant payload cannot be proven.
        if (
          typeof payload?.shop !== "string" ||
          payload.shop !== normalizedShop
        ) {
          return null;
        }

        const productId =
          typeof payload.productId === "string"
            ? payload.productId.trim()
            : "";

        return {
          pointId: point.id,
          payload,
          productId,
          recent: pointIsInsideOrphanGraceWindow(
            payload,
            now,
            safeGraceMs,
          ),
        };
      })
      .filter(
        (value): value is OrphanVectorScanCandidate => value !== null,
      );

    const candidateProductIds = [
      ...new Set(
        candidates
          .map((candidate) => candidate.productId)
          .filter(Boolean),
      ),
    ];

    const validRegistryRows =
      candidateProductIds.length > 0
        ? await db.aiSearchIndexedProduct.findMany({
            where: {
              shop: normalizedShop,
              productId: {
                in: candidateProductIds,
              },
              hasVector: true,
            },
            select: {
              productId: true,
            },
          })
        : [];

    const validProductIds = new Set(
      validRegistryRows.map((row) => row.productId),
    );

    validPoints += candidates.filter(
      (candidate) =>
        candidate.productId && validProductIds.has(candidate.productId),
    ).length;

    const deletionCandidates = candidates.filter((candidate) => {
      if (
        candidate.productId &&
        validProductIds.has(candidate.productId)
      ) {
        return false;
      }

      if (candidate.recent) {
        recentPointsSkipped += 1;
        return false;
      }

      return true;
    });

    if (deletionCandidates.length > 0) {
      // Narrow the write-race window one more time. A product can become valid
      // after the first DB lookup while this reconciliation page is being
      // evaluated. Re-read only the IDs we are about to delete.
      const recheckProductIds = [
        ...new Set(
          deletionCandidates
            .map((candidate) => candidate.productId)
            .filter(Boolean),
        ),
      ];

      const rowsNowValid =
        recheckProductIds.length > 0
          ? await db.aiSearchIndexedProduct.findMany({
              where: {
                shop: normalizedShop,
                productId: {
                  in: recheckProductIds,
                },
                hasVector: true,
              },
              select: {
                productId: true,
              },
            })
          : [];

      const nowValidIds = new Set(
        rowsNowValid.map((row) => row.productId),
      );

      const confirmedOrphans = deletionCandidates.filter(
        (candidate) =>
          !candidate.productId ||
          !nowValidIds.has(candidate.productId),
      );

      if (confirmedOrphans.length > 0) {
        await qdrant.delete(QDRANT_COLLECTION, {
          wait: true,
          points: confirmedOrphans.map((candidate) => candidate.pointId),
        });

        removedPoints += confirmedOrphans.length;

        for (const candidate of confirmedOrphans) {
          if (candidate.productId) {
            removedProductIds.add(candidate.productId);
          } else {
            malformedPointsRemoved += 1;
          }
        }
      }

      // Rows that became valid during the recheck are valid points too.
      validPoints += deletionCandidates.length - confirmedOrphans.length;
    }

    if (nextOffset == null) {
      break;
    }

    if (
      offset != null &&
      String(nextOffset) === String(offset)
    ) {
      throw new Error(
        "Qdrant scroll returned the same next_page_offset during orphan reconciliation",
      );
    }

    offset = nextOffset;
  }

  const result: ReconcileOrphanProductVectorsResult = {
    shop: normalizedShop,
    scannedPoints,
    validPoints,
    removedPoints,
    malformedPointsRemoved,
    recentPointsSkipped,
    removedProductIds: [...removedProductIds],
  };

  console.log("[AI Search] Qdrant orphan reconciliation complete:", result);

  return result;
}

// =====================================================
// SEMANTIC SEARCH
// =====================================================

export async function searchProductVectors({
  shop,
  vector,
  limit = 20,
  scoreThreshold,
  productIds,
  onDiagnostics,
}: SearchProductVectorsInput): Promise<ProductVectorSearchResult[]> {
  const totalStartedAt = Date.now();
  const qdrant = getQdrantClient();
  const requestedProductIds = productIds?.length
    ? [...new Set(productIds.map((value) => value.trim()).filter(Boolean))]
    : null;
  if (productIds && requestedProductIds?.length === 0) {
    onDiagnostics?.({
      requestMs: 0, responseMappingCodeMs: 0,
      totalMs: Date.now() - totalStartedAt, passCount: 0, finalCandidateWindow: 0,
    });
    return [];
  }
  const requestedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.trunc(limit), 1000))
    : 20;
  const safeLimit = requestedLimit;

  // During the one-time Phase-1 -> V2 point-ID migration, a product can
  // temporarily have both a legacy numeric point and the new tenant UUID.
  // Keep only modest headroom for duplicate points. The old 3x window made
  // broad searches return far more payload than the reranker can use.
  const configuredHeadroom = Number.parseFloat(
    process.env.AI_SEARCH_QDRANT_HEADROOM_RATIO || "",
  );
  const headroomRatio =
    Number.isFinite(configuredHeadroom) &&
    configuredHeadroom >= 1 &&
    configuredHeadroom <= 2
      ? configuredHeadroom
      : 1;
  const candidateLimit = Math.min(
    1000,
    Math.max(safeLimit, Math.ceil(safeLimit * headroomRatio)),
  );
  const startedAt = Date.now();
  const passCount = 1;
  const response = await qdrant.query(QDRANT_COLLECTION, {
      query: vector,
      using: DENSE_VECTOR_NAME,
      filter: {
        must: [
          {
            key: "shop",
            match: {
              value: shop,
            },
          },
          {
            key: "searchable",
            match: {
              value: true,
            },
          },
          ...(requestedProductIds
            ? [{
                key: "productId",
                match: { any: requestedProductIds },
              }]
            : []),
        ],
      },
      score_threshold: scoreThreshold,
      limit: candidateLimit,
      with_payload: [
        "shop", "productId", "handle", "title",
        "minVariantPrice", "maxVariantPrice", "currencyCode",
      ],
      with_vector: false,
    });
  const requestMs = Date.now() - startedAt;
  const candidateProductIds = [
    ...new Set(
      response.points
        .map((point) =>
          typeof point.payload?.productId === "string"
            ? point.payload.productId
            : "",
        )
        .filter(Boolean),
    ),
  ];
  const registryRows = candidateProductIds.length
    ? await db.aiSearchIndexedProduct.findMany({
        where: {
          shop,
          productId: { in: candidateProductIds },
          searchable: true,
          hasVector: true,
        },
        select: { productId: true },
      })
    : [];
  const validRegistryIds = new Set(
    registryRows.map((row) => row.productId),
  );

  console.log("[AI Search][PERF] Qdrant query", {
    shop, durationMs: requestMs,
    requestedLimit: safeLimit, fetchedPoints: response.points.length,
    candidateLimitReached: response.points.length >= candidateLimit,
    passCount,
    topScore: response.points[0]?.score ?? null,
    lastScore: response.points.at(-1)?.score ?? null,
    minimumScoreThresholdSent: scoreThreshold ?? null,
    withVector: false,
    payloadFieldCount: 7,
    expansionReason: "FINAL_SEMANTIC_HORIZON_SINGLE_PASS",
    qdrantServerTimeMs: null,
    qdrantNetworkAndClientMs: null,
  });

  const seenProducts = new Set<string>();
  const results: ProductVectorSearchResult[] = [];
  const mappingStartedAt = Date.now();

  for (const point of response.points) {
    const payload = point.payload;
    if (!payload) continue;

    // Defense in depth: Qdrant already filters by shop, but never trust a
    // malformed/legacy payload from the shared collection as another tenant.
    if (typeof payload.shop !== "string" || payload.shop !== shop) continue;

    const productId =
      typeof payload.productId === "string" ? payload.productId : null;
    const handle = typeof payload.handle === "string" ? payload.handle : null;
    const title = typeof payload.title === "string" ? payload.title : null;

    if (
      !productId ||
      !handle ||
      !title ||
      !validRegistryIds.has(productId) ||
      seenProducts.has(productId)
    ) {
      continue;
    }

    seenProducts.add(productId);
    results.push({
      score: point.score,
      vectorSimilarity: point.score,
      productId,
      handle,
      title,
      minVariantPrice:
        typeof payload.minVariantPrice === "number" && Number.isFinite(payload.minVariantPrice)
          ? payload.minVariantPrice
          : undefined,
      maxVariantPrice:
        typeof payload.maxVariantPrice === "number" && Number.isFinite(payload.maxVariantPrice)
          ? payload.maxVariantPrice
          : undefined,
      currencyCode:
        typeof payload.currencyCode === "string" && payload.currencyCode
          ? payload.currencyCode.toUpperCase()
          : undefined,
    });

    if (results.length >= safeLimit) break;
  }

  onDiagnostics?.({
    requestMs,
    responseMappingCodeMs: Date.now() - mappingStartedAt,
    totalMs: Date.now() - totalStartedAt,
    passCount,
    finalCandidateWindow: candidateLimit,
  });

  return results;
}

export async function searchProductVectorsBatch({
  shop,
  vectors,
  limits,
  scoreThreshold,
  productIds,
  onDiagnostics,
}: {
  shop: string;
  vectors: number[][];
  limits?: number[];
  scoreThreshold?: number;
  productIds?: string[];
  onDiagnostics?: (diagnostics: {
    requestMs: number;
    responseMappingCodeMs: number;
    totalMs: number;
    passCount: number;
    finalCandidateWindow: number;
  }) => void;
}): Promise<ProductVectorSearchResult[][]> {
  const totalStartedAt = Date.now();
  if (vectors.length === 0) return [];

  const qdrant = getQdrantClient();
  const requestedProductIds = productIds?.length
    ? [...new Set(productIds.map((value) => value.trim()).filter(Boolean))]
    : null;
  if (productIds && requestedProductIds?.length === 0) {
    onDiagnostics?.({
      requestMs: 0,
      responseMappingCodeMs: 0,
      totalMs: Date.now() - totalStartedAt,
      passCount: 0,
      finalCandidateWindow: 0,
    });
    return vectors.map(() => []);
  }

  const configuredHeadroom = Number.parseFloat(
    process.env.AI_SEARCH_QDRANT_HEADROOM_RATIO || "",
  );
  const headroomRatio =
    Number.isFinite(configuredHeadroom) &&
    configuredHeadroom >= 1 &&
    configuredHeadroom <= 2
      ? configuredHeadroom
      : 1;
  const safeLimits = vectors.map((_, index) => {
    const requested = limits?.[index] ?? 20;
    const normalizedRequested = Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.trunc(requested), 1000))
      : 20;
    return normalizedRequested;
  });
  const candidateLimits = safeLimits.map((safeLimit) =>
    Math.min(
      1000,
      Math.max(safeLimit, Math.ceil(safeLimit * headroomRatio)),
    ),
  );
  const filter = {
    must: [
      { key: "shop", match: { value: shop } },
      { key: "searchable", match: { value: true } },
      ...(requestedProductIds
        ? [{ key: "productId", match: { any: requestedProductIds } }]
        : []),
    ],
  };

  const startedAt = Date.now();
  const responses = await qdrant.queryBatch(QDRANT_COLLECTION, {
    searches: vectors.map((vector, index) => ({
      query: vector,
      using: DENSE_VECTOR_NAME,
      filter,
      score_threshold: scoreThreshold,
      limit: candidateLimits[index],
      with_payload: [
        "shop", "productId", "handle", "title",
        "minVariantPrice", "maxVariantPrice", "currencyCode",
      ],
      with_vector: false,
    })),
  });
  const requestMs = Date.now() - startedAt;
  const candidateProductIds = [
    ...new Set(
      responses.flatMap((response) =>
        response.points
          .map((point) =>
            typeof point.payload?.productId === "string"
              ? point.payload.productId
              : "",
          )
          .filter(Boolean),
      ),
    ),
  ];
  const registryRows = candidateProductIds.length
    ? await db.aiSearchIndexedProduct.findMany({
        where: {
          shop,
          productId: { in: candidateProductIds },
          searchable: true,
          hasVector: true,
        },
        select: { productId: true },
      })
    : [];
  const validRegistryIds = new Set(
    registryRows.map((row) => row.productId),
  );
  const mappingStartedAt = Date.now();

  const resultSets = responses.map((response, responseIndex) => {
    const seenProducts = new Set<string>();
    const results: ProductVectorSearchResult[] = [];
    for (const point of response.points) {
      const payload = point.payload;
      if (!payload || payload.shop !== shop) continue;
      const productId =
        typeof payload.productId === "string" ? payload.productId : null;
      const handle = typeof payload.handle === "string" ? payload.handle : null;
      const title = typeof payload.title === "string" ? payload.title : null;
      if (
        !productId ||
        !handle ||
        !title ||
        !validRegistryIds.has(productId) ||
        seenProducts.has(productId)
      ) {
        continue;
      }
      seenProducts.add(productId);
      results.push({
        score: point.score,
        vectorSimilarity: point.score,
        productId,
        handle,
        title,
        minVariantPrice:
          typeof payload.minVariantPrice === "number" &&
          Number.isFinite(payload.minVariantPrice)
            ? payload.minVariantPrice
            : undefined,
        maxVariantPrice:
          typeof payload.maxVariantPrice === "number" &&
          Number.isFinite(payload.maxVariantPrice)
            ? payload.maxVariantPrice
            : undefined,
        currencyCode:
          typeof payload.currencyCode === "string" && payload.currencyCode
            ? payload.currencyCode.toUpperCase()
            : undefined,
      });
      if (results.length >= safeLimits[responseIndex]) break;
    }
    return results;
  });
  const responseMappingCodeMs = Date.now() - mappingStartedAt;

  console.log("[AI Search][PERF] Qdrant batch query", {
    shop,
    queryCount: vectors.length,
    durationMs: requestMs,
    requestedLimits: safeLimits,
    fetchedPoints: responses.map((response) => response.points.length),
    scoreThreshold: scoreThreshold ?? null,
  });
  onDiagnostics?.({
    requestMs,
    responseMappingCodeMs,
    totalMs: Date.now() - totalStartedAt,
    passCount: vectors.length,
    finalCandidateWindow: candidateLimits.reduce((sum, value) => sum + value, 0),
  });
  return resultSets;
}

export async function searchProductSparse({
  shop,
  query,
  limit = 100,
  productIds,
}: {
  shop: string;
  query: string;
  limit?: number;
  productIds?: string[];
}): Promise<ProductVectorSearchResult[]> {
  const cleanQuery = query.replace(/\s+/g, " ").trim();
  if (!cleanQuery) return [];
  await ensureProductCollection();

  const requestedProductIds = productIds?.length
    ? [...new Set(productIds.map((value) => value.trim()).filter(Boolean))]
    : null;
  if (productIds && requestedProductIds?.length === 0) return [];

  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
  const qdrant = getQdrantClient();
  const response = await qdrant.query(QDRANT_COLLECTION, {
    query: {
      text: cleanQuery,
      model: BM25_MODEL,
      options: BM25_OPTIONS,
    },
    using: BM25_VECTOR_NAME,
    filter: {
      must: [
        { key: "shop", match: { value: shop } },
        { key: "searchable", match: { value: true } },
        ...(requestedProductIds
          ? [{ key: "productId", match: { any: requestedProductIds } }]
          : []),
      ],
    },
    limit: safeLimit,
    with_payload: [
      "shop", "productId", "handle", "title",
      "minVariantPrice", "maxVariantPrice", "currencyCode",
    ],
    with_vector: false,
  });

  const candidateIds = [
    ...new Set(
      response.points
        .map((point) =>
          typeof point.payload?.productId === "string"
            ? point.payload.productId
            : "",
        )
        .filter(Boolean),
    ),
  ];
  const registryRows = candidateIds.length
    ? await db.aiSearchIndexedProduct.findMany({
        where: {
          shop,
          productId: { in: candidateIds },
          searchable: true,
          hasVector: true,
        },
        select: { productId: true },
      })
    : [];
  const validIds = new Set(registryRows.map((row) => row.productId));

  const seen = new Set<string>();
  const results: ProductVectorSearchResult[] = [];
  for (const [index, point] of response.points.entries()) {
    const payload = point.payload;
    if (!payload || payload.shop !== shop) continue;
    const productId =
      typeof payload.productId === "string" ? payload.productId : null;
    const handle = typeof payload.handle === "string" ? payload.handle : null;
    const title = typeof payload.title === "string" ? payload.title : null;
    if (
      !productId ||
      !handle ||
      !title ||
      !validIds.has(productId) ||
      seen.has(productId)
    ) continue;
    seen.add(productId);
    results.push({
      score: point.score,
      sparseScore: point.score,
      sparseRank: index + 1,
      productId,
      handle,
      title,
      minVariantPrice:
        typeof payload.minVariantPrice === "number" &&
        Number.isFinite(payload.minVariantPrice)
          ? payload.minVariantPrice
          : undefined,
      maxVariantPrice:
        typeof payload.maxVariantPrice === "number" &&
        Number.isFinite(payload.maxVariantPrice)
          ? payload.maxVariantPrice
          : undefined,
      currencyCode:
        typeof payload.currencyCode === "string" && payload.currencyCode
          ? payload.currencyCode.toUpperCase()
          : undefined,
    });
  }
  return results;
}

// =====================================================
// DELETE ALL VECTORS FOR A SHOP
// Used by privacy shop/redact cleanup.
// =====================================================

export async function deleteShopProductVectors(shop: string) {
  const qdrant = getQdrantClient();
  await qdrant.delete(QDRANT_COLLECTION, {
    wait: true,
    filter: {
      must: [
        {
          key: "shop",
          match: {
            value: shop,
          },
        },
      ],
    },
  });
}
