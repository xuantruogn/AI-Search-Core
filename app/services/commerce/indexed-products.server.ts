import db from "../../db.server";

export const INDEXED_PRODUCT_STATUS = {
  indexed: "INDEXED",
  productSlotReserved: "PRODUCT_SLOT_RESERVED",
  productLimitBlocked: "PRODUCT_LIMIT_BLOCKED",
  vectorQuotaBlocked: "VECTOR_QUOTA_BLOCKED",
  subscriptionBlocked: "SUBSCRIPTION_BLOCKED",
} as const;

export type IndexedProductRow = {
  id: number;
  shop: string;
  productId: string;
  handle: string;
  title: string;
  status: string;
  hasVector: boolean | number;
  documentHash: string | null;
  lastIndexedAt: Date | string | null;
  lastSeenAt: Date | string;
  lastCatalogSeenAt: Date | string | null;
  updatedAt: Date | string;
};

export async function getIndexedProductStats(shop: string) {
  const rows = await db.$queryRaw<
    Array<{
      indexedProducts: bigint | number;
      productSlotsUsed: bigint | number;
      vectorQuotaBlockedProducts: bigint | number;
      productLimitBlockedProducts: bigint | number;
      subscriptionBlockedProducts: bigint | number;
    }>
  >`
    SELECT
      SUM(CASE WHEN "hasVector" = true THEN 1 ELSE 0 END) AS "indexedProducts",
      SUM(
        CASE
          WHEN "hasVector" = true OR "status" = 'PRODUCT_SLOT_RESERVED' THEN 1
          ELSE 0
        END
      ) AS "productSlotsUsed",
      SUM(CASE WHEN "status" = 'VECTOR_QUOTA_BLOCKED' THEN 1 ELSE 0 END) AS "vectorQuotaBlockedProducts",
      SUM(CASE WHEN "status" = 'PRODUCT_LIMIT_BLOCKED' THEN 1 ELSE 0 END) AS "productLimitBlockedProducts",
      SUM(CASE WHEN "status" = 'SUBSCRIPTION_BLOCKED' THEN 1 ELSE 0 END) AS "subscriptionBlockedProducts"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop}
  `;

  const row = rows[0];
  return {
    indexedProducts: Number(row?.indexedProducts ?? 0),
    productSlotsUsed: Number(row?.productSlotsUsed ?? 0),
    vectorQuotaBlockedProducts: Number(row?.vectorQuotaBlockedProducts ?? 0),
    productLimitBlockedProducts: Number(row?.productLimitBlockedProducts ?? 0),
    subscriptionBlockedProducts: Number(row?.subscriptionBlockedProducts ?? 0),
  };
}

export async function countIndexedProducts(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS "count"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop} AND "hasVector" = true
  `;

  return Number(rows[0]?.count ?? 0);
}

// A slot is either a product that already owns a vector or a product whose
// worker has atomically reserved capacity before calling OpenAI.
export async function countProductSlotsUsed(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS "count"
    FROM "AiSearchIndexedProduct"
    WHERE
      "shop" = ${shop}
      AND (
        "hasVector" = true
        OR "status" = 'PRODUCT_SLOT_RESERVED'
      )
  `;

  return Number(rows[0]?.count ?? 0);
}

export async function countVectorQuotaBlockedProducts(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS "count"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop} AND "status" = 'VECTOR_QUOTA_BLOCKED'
  `;

  return Number(rows[0]?.count ?? 0);
}

export async function countProductLimitBlockedProducts(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS "count"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop} AND "status" = 'PRODUCT_LIMIT_BLOCKED'
  `;

  return Number(rows[0]?.count ?? 0);
}

export async function countSubscriptionBlockedProducts(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS "count"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop} AND "status" = 'SUBSCRIPTION_BLOCKED'
  `;

  return Number(rows[0]?.count ?? 0);
}

export async function getIndexedProduct(shop: string, productId: string) {
  const rows = await db.$queryRaw<IndexedProductRow[]>`
    SELECT
      "id", "shop", "productId", "handle", "title", "status", "hasVector",
      "documentHash", "lastIndexedAt", "lastSeenAt", "lastCatalogSeenAt", "updatedAt"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop} AND "productId" = ${productId}
    LIMIT 1
  `;

  return rows[0] ?? null;
}

export async function reserveProductSlot({
  shop,
  productId,
  handle,
  title,
  documentHash,
  productLimit,
}: {
  shop: string;
  productId: string;
  handle: string;
  title: string;
  documentHash: string;
  productLimit: number | null;
}) {
  if (productLimit === null) {
    return { allowed: true, reserved: false } as const;
  }

  return db.$transaction(async (tx) => {
    // Serialize slot decisions per shop. This is a no-op data-wise, but forces
    // competing writers for the same shop through one DB write lock/row lock.
    await tx.$executeRaw`
      UPDATE "AiSearchShopSettings"
      SET "updatedAt" = "updatedAt"
      WHERE "shop" = ${shop}
    `;

    const existing = await tx.$queryRaw<
      Array<{ status: string; hasVector: boolean | number }>
    >`
      SELECT "status", "hasVector"
      FROM "AiSearchIndexedProduct"
      WHERE "shop" = ${shop} AND "productId" = ${productId}
      LIMIT 1
    `;

    if (
      Boolean(existing[0]?.hasVector) ||
      existing[0]?.status === INDEXED_PRODUCT_STATUS.productSlotReserved
    ) {
      return { allowed: true, reserved: false } as const;
    }

    const usedRows = await tx.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*) AS "count"
      FROM "AiSearchIndexedProduct"
      WHERE
        "shop" = ${shop}
        AND (
          "hasVector" = true
          OR "status" = 'PRODUCT_SLOT_RESERVED'
        )
    `;

    const used = Number(usedRows[0]?.count ?? 0);

    if (used >= productLimit) {
      return { allowed: false, reserved: false } as const;
    }

    await tx.$executeRaw`
      INSERT INTO "AiSearchIndexedProduct" (
        "shop", "productId", "handle", "title", "status", "hasVector",
        "documentHash", "lastSeenAt", "createdAt", "updatedAt"
      ) VALUES (
        ${shop}, ${productId}, ${handle}, ${title}, 'PRODUCT_SLOT_RESERVED', false,
        ${documentHash}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT("shop", "productId") DO UPDATE SET
        "handle" = excluded."handle",
        "title" = excluded."title",
        "status" = 'PRODUCT_SLOT_RESERVED',
        "hasVector" = false,
        "documentHash" = excluded."documentHash",
        "lastSeenAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    `;

    return { allowed: true, reserved: true } as const;
  });
}

export async function releaseProductSlotReservation(
  shop: string,
  productId: string,
) {
  await db.$executeRaw`
    DELETE FROM "AiSearchIndexedProduct"
    WHERE
      "shop" = ${shop}
      AND "productId" = ${productId}
      AND "status" = 'PRODUCT_SLOT_RESERVED'
      AND "hasVector" = false
  `;
}

export async function upsertIndexedProduct({
  shop,
  productId,
  handle,
  title,
  documentHash,
}: {
  shop: string;
  productId: string;
  handle: string;
  title: string;
  documentHash: string;
}) {
  await db.$executeRaw`
    INSERT INTO "AiSearchIndexedProduct" (
      "shop", "productId", "handle", "title", "status", "hasVector", "documentHash",
      "lastIndexedAt", "lastSeenAt", "createdAt", "updatedAt"
    ) VALUES (
      ${shop}, ${productId}, ${handle}, ${title}, 'INDEXED', true, ${documentHash},
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT("shop", "productId") DO UPDATE SET
      "handle" = excluded."handle",
      "title" = excluded."title",
      "status" = 'INDEXED',
      "hasVector" = true,
      "documentHash" = excluded."documentHash",
      "lastIndexedAt" = CURRENT_TIMESTAMP,
      "lastSeenAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

export async function markIndexedProductBlocked({
  shop,
  productId,
  handle,
  title,
  documentHash,
  reason,
  hasVector,
}: {
  shop: string;
  productId: string;
  handle: string;
  title: string;
  documentHash: string;
  reason: "PRODUCT_LIMIT" | "VECTOR_UPDATE_LIMIT" | "SUBSCRIPTION_INACTIVE";
  hasVector: boolean;
}) {
  const status =
    reason === "PRODUCT_LIMIT"
      ? INDEXED_PRODUCT_STATUS.productLimitBlocked
      : reason === "SUBSCRIPTION_INACTIVE"
        ? INDEXED_PRODUCT_STATUS.subscriptionBlocked
        : INDEXED_PRODUCT_STATUS.vectorQuotaBlocked;

  await db.$executeRaw`
    INSERT INTO "AiSearchIndexedProduct" (
      "shop", "productId", "handle", "title", "status", "hasVector", "documentHash",
      "lastSeenAt", "createdAt", "updatedAt"
    ) VALUES (
      ${shop}, ${productId}, ${handle}, ${title}, ${status}, ${hasVector}, ${documentHash},
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT("shop", "productId") DO UPDATE SET
      "handle" = excluded."handle",
      "title" = excluded."title",
      "status" = ${status},
      "hasVector" = ${hasVector},
      "documentHash" = excluded."documentHash",
      "lastSeenAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

async function listBlockedByStatus(
  shop: string,
  status: string,
  limit: number,
) {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));

  return db.$queryRaw<IndexedProductRow[]>`
    SELECT
      "id", "shop", "productId", "handle", "title", "status", "hasVector",
      "documentHash", "lastIndexedAt", "lastSeenAt", "lastCatalogSeenAt", "updatedAt"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop} AND "status" = ${status}
    ORDER BY "updatedAt" ASC, "id" ASC
    LIMIT ${safeLimit}
  `;
}

export function listVectorQuotaBlockedProducts(shop: string, limit = 50) {
  return listBlockedByStatus(
    shop,
    INDEXED_PRODUCT_STATUS.vectorQuotaBlocked,
    limit,
  );
}

export function listProductLimitBlockedProducts(shop: string, limit = 50) {
  return listBlockedByStatus(
    shop,
    INDEXED_PRODUCT_STATUS.productLimitBlocked,
    limit,
  );
}

export function listSubscriptionBlockedProducts(shop: string, limit = 50) {
  return listBlockedByStatus(
    shop,
    INDEXED_PRODUCT_STATUS.subscriptionBlocked,
    limit,
  );
}

export async function listIndexedProductsBeyondLimit(
  shop: string,
  keepCount: number,
  limit = 100,
) {
  const safeKeep = Math.max(0, Math.trunc(keepCount));
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));

  return db.$queryRaw<IndexedProductRow[]>`
    SELECT
      "id", "shop", "productId", "handle", "title", "status", "hasVector",
      "documentHash", "lastIndexedAt", "lastSeenAt", "lastCatalogSeenAt", "updatedAt"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop} AND "hasVector" = true
    ORDER BY "lastIndexedAt" DESC, "updatedAt" DESC, "id" DESC
    LIMIT ${safeLimit} OFFSET ${safeKeep}
  `;
}

export async function markIndexedProductCatalogSeen({
  shop,
  productId,
}: {
  shop: string;
  productId: string;
}) {
  // Revalidation paths may only know that Shopify still considers the product
  // ACTIVE. Do not overwrite handle/title with stale registry values while a
  // concurrent webhook may have just written fresher product metadata.
  return db.$executeRaw`
    UPDATE "AiSearchIndexedProduct"
    SET
      "lastSeenAt" = CURRENT_TIMESTAMP,
      "lastCatalogSeenAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "shop" = ${shop} AND "productId" = ${productId}
  `;
}

export async function touchIndexedProductCatalogSeen({
  shop,
  productId,
  handle,
  title,
}: {
  shop: string;
  productId: string;
  handle: string;
  title: string;
}) {
  // Update only an existing registry row. Creating a new row here would
  // accidentally reserve/count a product before quota/indexing decisions.
  return db.$executeRaw`
    UPDATE "AiSearchIndexedProduct"
    SET
      "handle" = ${handle},
      "title" = ${title},
      "lastSeenAt" = CURRENT_TIMESTAMP,
      "lastCatalogSeenAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "shop" = ${shop} AND "productId" = ${productId}
  `;
}


export async function touchIndexedProductLiveSeen({
  shop,
  productId,
  handle,
  title,
}: {
  shop: string;
  productId: string;
  handle: string;
  title: string;
}) {
  // Search-time validation proves the product is live now, but it is not part
  // of a full catalog scan. Never advance lastCatalogSeenAt here: doing so can
  // mask a stale row from the scan that is responsible for authoritative
  // catalog reconciliation.
  return db.$executeRaw`
    UPDATE "AiSearchIndexedProduct"
    SET
      "handle" = ${handle},
      "title" = ${title},
      "lastSeenAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "shop" = ${shop} AND "productId" = ${productId}
  `;
}

export async function removeIndexedProduct(shop: string, productId: string) {
  await db.$executeRaw`
    DELETE FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop} AND "productId" = ${productId}
  `;
}

export async function listIndexedProducts(shop: string, limit = 20) {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));

  return db.$queryRaw<IndexedProductRow[]>`
    SELECT
      "id", "shop", "productId", "handle", "title", "status", "hasVector",
      "documentHash", "lastIndexedAt", "lastSeenAt", "lastCatalogSeenAt", "updatedAt"
    FROM "AiSearchIndexedProduct"
    WHERE "shop" = ${shop}
    ORDER BY "updatedAt" DESC
    LIMIT ${safeLimit}
  `;
}

export async function listStaleIndexedProducts(
  shop: string,
  seenBefore: Date,
  limit = 100,
) {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));

  return db.$queryRaw<IndexedProductRow[]>`
    SELECT
      "id", "shop", "productId", "handle", "title", "status", "hasVector",
      "documentHash", "lastIndexedAt", "lastSeenAt", "lastCatalogSeenAt", "updatedAt"
    FROM "AiSearchIndexedProduct"
    WHERE
      "shop" = ${shop}
      AND ("lastCatalogSeenAt" IS NULL OR "lastCatalogSeenAt" < ${seenBefore})
    ORDER BY "lastCatalogSeenAt" ASC, "id" ASC
    LIMIT ${safeLimit}
  `;
}
