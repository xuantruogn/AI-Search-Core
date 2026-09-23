import db from "../../db.server";

import {
  ensureProductCollection,
  getQdrantClient,
  QDRANT_COLLECTION,
} from "./qdrant.server";
import { getTenantProductVectorPointId } from "./vector-id.server";

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
};

export type UpsertProductVectorInput = {
  pointId: number | string;
  vector: number[];
  payload: ProductVectorPayload;
};

export type SearchProductVectorsInput = {
  shop: string;
  vector: number[];
  limit?: number;
  scoreThreshold?: number;
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
  payload,
}: UpsertProductVectorInput) {
  const qdrant = getQdrantClient();
  await qdrant.upsert(QDRANT_COLLECTION, {
    wait: true,

    points: [
      {
        id: pointId,
        vector,
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

    const vector =
      withVector && Array.isArray(point.vector)
        ? point.vector.filter(
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

export async function updateProductVectorPayloadForShop({
  shop,
  productId,
  payload,
}: {
  shop: string;
  productId: string;
  payload: Record<string, string | number>;
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
// AiSearchIndexedProduct(status=INDEXED, hasVector=true)
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
              status: "INDEXED",
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
                status: "INDEXED",
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
  onDiagnostics,
}: SearchProductVectorsInput): Promise<ProductVectorSearchResult[]> {
  const totalStartedAt = Date.now();
  const qdrant = getQdrantClient();
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.trunc(limit), 1000)) : 20;

  // During the one-time Phase-1 -> V2 point-ID migration, a product can
  // temporarily have both a legacy numeric point and the new tenant UUID.
  // Ask Qdrant for a small amount of headroom and deduplicate by productId so
  // customers never see duplicate cards and the requested result count is
  // preserved as much as possible.
  // Earlier expanding passes replaced, rather than unioned, each response.
  // Query the identical final horizon once to remove redundant ANN RTTs.
  const candidateLimit = Math.min(1000, Math.max(safeLimit, safeLimit * 3));
  const startedAt = Date.now();
  const passCount = 1;
  const response = await qdrant.query(QDRANT_COLLECTION, {
      query: vector,
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
      score_threshold: scoreThreshold,
      limit: candidateLimit,
      with_payload: [
        "shop", "productId", "handle", "title",
        "minVariantPrice", "maxVariantPrice", "currencyCode",
      ],
      with_vector: false,
    });
  const requestMs = Date.now() - startedAt;

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

    if (!productId || !handle || !title || seenProducts.has(productId)) {
      continue;
    }

    seenProducts.add(productId);
    results.push({
      score: point.score,
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
