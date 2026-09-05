import { getQdrantClient, QDRANT_COLLECTION } from "./qdrant.server";
import { getTenantProductVectorPointId } from "./vector-id.server";

export type ProductVectorPayload = {
  shop: string;
  productId: string;
  handle: string;
  title: string;

  documentHash?: string;
  indexedAt?: string;
  usageReservationId?: string;
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
};

export type ProductVectorSearchResult = {
  score: number;
  productId: string;
  handle: string;
  title: string;
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
  payload: Record<string, string>;
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
// SEMANTIC SEARCH
// =====================================================

export async function searchProductVectors({
  shop,
  vector,
  limit = 20,
}: SearchProductVectorsInput): Promise<ProductVectorSearchResult[]> {
  const qdrant = getQdrantClient();
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 60));

  // During the one-time Phase-1 -> V2 point-ID migration, a product can
  // temporarily have both a legacy numeric point and the new tenant UUID.
  // Ask Qdrant for a small amount of headroom and deduplicate by productId so
  // customers never see duplicate cards and the requested result count is
  // preserved as much as possible.
  const candidateLimit = Math.min(100, Math.max(safeLimit, safeLimit * 3));
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
    limit: candidateLimit,
    with_payload: true,
    with_vector: false,
  });

  const seenProducts = new Set<string>();
  const results: ProductVectorSearchResult[] = [];

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
    });

    if (results.length >= safeLimit) break;
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
