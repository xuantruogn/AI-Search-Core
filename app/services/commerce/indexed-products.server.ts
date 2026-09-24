import { Prisma } from "@prisma/client";
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
  vectorStatus: string;
  searchable: boolean | number;
  blockedReason: string | null;
  documentHash: string | null;
  sourceDocumentHash: string | null;
  embeddingPipelineVersion: string | null;
  enrichmentVersion: string | null;
  enrichmentStatus: string;
  enrichmentLastError: string | null;
  enrichmentRetryAt: Date | string | null;
  enrichmentUpdatedAt: Date | string | null;
  lastIndexedAt: Date | string | null;
  lastSeenAt: Date | string;
  lastCatalogSeenAt: Date | string | null;
  updatedAt: Date | string;
};

export type SearchableIndexedProduct = Pick<
  IndexedProductRow,
  "productId" | "handle" | "title"
>;

export async function listSearchableIndexedProducts(
  shop: string,
  productIds: string[],
): Promise<SearchableIndexedProduct[]> {
  const ids = [...new Set(productIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  return db.$queryRaw<SearchableIndexedProduct[]>(Prisma.sql`
    SELECT \`productId\`, \`handle\`, \`title\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop}
      AND \`productId\` IN (${Prisma.join(ids)})
      AND \`searchable\` = true
      AND \`hasVector\` = true
  `);
}

export type ProductEligibilityInput = {
  productId: string;
  searchable: boolean;
  hasVector: boolean;
  vectorStatus: string;
  blockedReason: string | null;
  status: string;
  createdAt: Date;
};

export function planProductEligibility(
  input: ProductEligibilityInput[],
  policyActive: boolean,
  productLimit: number | null,
) {
  const rows = [...input].sort((left, right) =>
    Number(right.searchable) - Number(left.searchable) ||
    Number(right.vectorStatus === "READY") - Number(left.vectorStatus === "READY") ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.productId.localeCompare(right.productId),
  );
  const eligible = rows.filter((row) => row.blockedReason !== "UNPUBLISHED");
  const capacity = !policyActive ? 0 : productLimit === null ? eligible.length : Math.max(0, productLimit);
  const selected = new Set(eligible.slice(0, capacity).map((row) => row.productId));
  return rows.map((row) => {
    const unpublished = row.blockedReason === "UNPUBLISHED";
    const chosen = selected.has(row.productId);
    const ready = row.hasVector && row.vectorStatus === "READY";
    const searchable = chosen && ready;
    return {
      ...row, chosen, searchable,
      blockedReason: unpublished ? "UNPUBLISHED" : chosen ? null : policyActive ? "PRODUCT_LIMIT" : "SUBSCRIPTION",
      status: unpublished ? "UNPUBLISHED" : searchable ? "INDEXED" : chosen ? "VECTOR_QUOTA_BLOCKED" : policyActive ? "PRODUCT_LIMIT_BLOCKED" : "SUBSCRIPTION_BLOCKED",
      requiresReindex: chosen && !ready,
    };
  });
}

export async function getIndexedProductStats(shop: string) {
  const rows = await db.$queryRaw<
    Array<{
      indexedProducts: bigint | number;
      productSlotsUsed: bigint | number;
      vectorQuotaBlockedProducts: bigint | number;
      productLimitBlockedProducts: bigint | number;
      subscriptionBlockedProducts: bigint | number;
      cachedVectorCount: bigint | number;
      blockedProductCount: bigint | number;
      staleVectorCount: bigint | number;
      catalogProductCount: bigint | number;
    }>
  >`
    SELECT
      COUNT(*) AS \`catalogProductCount\`,
      SUM(CASE WHEN \`hasVector\` = true THEN 1 ELSE 0 END) AS \`indexedProducts\`,
      SUM(
        CASE
          WHEN \`blockedReason\` IS NULL OR \`status\` = 'PRODUCT_SLOT_RESERVED' THEN 1
          ELSE 0
        END
      ) AS \`productSlotsUsed\`,
      SUM(CASE WHEN \`status\` = 'VECTOR_QUOTA_BLOCKED' THEN 1 ELSE 0 END) AS \`vectorQuotaBlockedProducts\`,
      SUM(CASE WHEN \`status\` = 'PRODUCT_LIMIT_BLOCKED' THEN 1 ELSE 0 END) AS \`productLimitBlockedProducts\`,
      SUM(CASE WHEN \`status\` = 'SUBSCRIPTION_BLOCKED' THEN 1 ELSE 0 END) AS \`subscriptionBlockedProducts\`,
      SUM(CASE WHEN \`hasVector\` = true THEN 1 ELSE 0 END) AS \`cachedVectorCount\`,
      SUM(CASE WHEN \`searchable\` = false THEN 1 ELSE 0 END) AS \`blockedProductCount\`,
      SUM(CASE WHEN \`vectorStatus\` = 'STALE' THEN 1 ELSE 0 END) AS \`staleVectorCount\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop}
  `;

  const row = rows[0];
  return {
    indexedProducts: Number(row?.indexedProducts ?? 0),
    productSlotsUsed: Number(row?.productSlotsUsed ?? 0),
    vectorQuotaBlockedProducts: Number(row?.vectorQuotaBlockedProducts ?? 0),
    productLimitBlockedProducts: Number(row?.productLimitBlockedProducts ?? 0),
    subscriptionBlockedProducts: Number(row?.subscriptionBlockedProducts ?? 0),
    cachedVectorCount: Number(row?.cachedVectorCount ?? 0),
    activeProductSlotsUsed: Number(row?.productSlotsUsed ?? 0),
    blockedProductCount: Number(row?.blockedProductCount ?? 0),
    staleVectorCount: Number(row?.staleVectorCount ?? 0),
    catalogProductCount: Number(row?.catalogProductCount ?? 0),
  };
}

export async function countIndexedProducts(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS \`count\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`hasVector\` = true
  `;

  return Number(rows[0]?.count ?? 0);
}

// A slot is either a product that already owns a vector or a product whose
// worker has atomically reserved capacity before calling OpenAI.
export async function countProductSlotsUsed(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS \`count\`
    FROM \`AiSearchIndexedProduct\`
    WHERE
      \`shop\` = ${shop}
      AND (
        \`blockedReason\` IS NULL
        OR \`status\` = 'PRODUCT_SLOT_RESERVED'
      )
  `;

  return Number(rows[0]?.count ?? 0);
}

export async function countVectorQuotaBlockedProducts(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS \`count\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`status\` = 'VECTOR_QUOTA_BLOCKED'
  `;

  return Number(rows[0]?.count ?? 0);
}

export async function countProductLimitBlockedProducts(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS \`count\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`status\` = 'PRODUCT_LIMIT_BLOCKED'
  `;

  return Number(rows[0]?.count ?? 0);
}

export async function countSubscriptionBlockedProducts(shop: string) {
  const rows = await db.$queryRaw<Array<{ count: bigint | number }>>`
    SELECT COUNT(*) AS \`count\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`status\` = 'SUBSCRIPTION_BLOCKED'
  `;

  return Number(rows[0]?.count ?? 0);
}

export async function getIndexedProduct(shop: string, productId: string) {
  const rows = await db.$queryRaw<IndexedProductRow[]>`
    SELECT
      \`id\`, \`shop\`, \`productId\`, \`handle\`, \`title\`, \`status\`, \`hasVector\`,
      \`vectorStatus\`, \`searchable\`, \`blockedReason\`,
      \`documentHash\`, \`sourceDocumentHash\`, \`embeddingPipelineVersion\`,
      \`enrichmentVersion\`, \`enrichmentStatus\`, \`enrichmentLastError\`,
      \`enrichmentRetryAt\`, \`enrichmentUpdatedAt\`,
      \`lastIndexedAt\`, \`lastSeenAt\`, \`lastCatalogSeenAt\`, \`updatedAt\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
    LIMIT 1
  `;

  return rows[0] ?? null;
}

export async function updateIndexedProductEnrichmentState({
  shop,
  productId,
  sourceDocumentHash,
  embeddingPipelineVersion,
  enrichmentVersion,
  enrichmentStatus,
  enrichmentLastError,
  enrichmentRetryAt,
}: {
  shop: string;
  productId: string;
  sourceDocumentHash: string;
  embeddingPipelineVersion: string;
  enrichmentVersion: string;
  enrichmentStatus: "ENRICHED" | "FALLBACK" | "PENDING" | "FAILED" | "BASE_ONLY";
  enrichmentLastError: string | null;
  enrichmentRetryAt: Date | null;
}) {
  return db.$executeRaw`
    UPDATE \`AiSearchIndexedProduct\`
    SET
      \`sourceDocumentHash\` = ${sourceDocumentHash},
      \`embeddingPipelineVersion\` = ${embeddingPipelineVersion},
      \`enrichmentVersion\` = ${enrichmentVersion},
      \`enrichmentStatus\` = ${enrichmentStatus},
      \`enrichmentLastError\` = ${enrichmentLastError},
      \`enrichmentRetryAt\` = ${enrichmentRetryAt},
      \`enrichmentUpdatedAt\` = UTC_TIMESTAMP(3),
      \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
  `;
}

export async function getEnrichmentCoverageStats(shop: string) {
  const rows = await db.$queryRaw<Array<{
    fallbackProducts: bigint | number;
    awaitingRetryProducts: bigint | number;
  }>>`
    SELECT
      SUM(CASE WHEN \`enrichmentStatus\` = 'FALLBACK' THEN 1 ELSE 0 END) AS \`fallbackProducts\`,
      SUM(CASE WHEN \`enrichmentStatus\` IN ('PENDING', 'FAILED', 'FALLBACK')
        AND (\`enrichmentRetryAt\` IS NULL OR \`enrichmentRetryAt\` <= UTC_TIMESTAMP(3))
        THEN 1 ELSE 0 END) AS \`awaitingRetryProducts\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`hasVector\` = true
  `;
  return {
    fallbackProducts: Number(rows[0]?.fallbackProducts ?? 0),
    awaitingRetryProducts: Number(rows[0]?.awaitingRetryProducts ?? 0),
  };
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
      UPDATE \`AiSearchShopSettings\`
      SET \`updatedAt\` = \`updatedAt\`
      WHERE \`shop\` = ${shop}
    `;

    const existing = await tx.$queryRaw<
      Array<{ status: string; hasVector: boolean | number; blockedReason: string | null }>
    >`
      SELECT \`status\`, \`hasVector\`, \`blockedReason\`
      FROM \`AiSearchIndexedProduct\`
      WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
      LIMIT 1
    `;

    if (
      existing[0]?.blockedReason === null ||
      existing[0]?.status === INDEXED_PRODUCT_STATUS.productSlotReserved
    ) {
      return { allowed: true, reserved: false } as const;
    }

    const usedRows = await tx.$queryRaw<Array<{ count: bigint | number }>>`
      SELECT COUNT(*) AS \`count\`
      FROM \`AiSearchIndexedProduct\`
      WHERE
        \`shop\` = ${shop}
        AND (
          \`hasVector\` = true
          OR \`status\` = 'PRODUCT_SLOT_RESERVED'
        )
    `;

    const used = Number(usedRows[0]?.count ?? 0);

    if (used >= productLimit) {
      return { allowed: false, reserved: false } as const;
    }

    await tx.$executeRaw`
      INSERT INTO \`AiSearchIndexedProduct\` (
        \`shop\`, \`productId\`, \`handle\`, \`title\`, \`status\`, \`hasVector\`,
        \`documentHash\`, \`lastSeenAt\`, \`createdAt\`, \`updatedAt\`
      ) VALUES (
        ${shop}, ${productId}, ${handle}, ${title}, 'PRODUCT_SLOT_RESERVED', false,
        ${documentHash}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
      )
      ON DUPLICATE KEY UPDATE
        \`handle\` = ${handle},
        \`title\` = ${title},
        \`status\` = 'PRODUCT_SLOT_RESERVED',
        \`hasVector\` = \`hasVector\`,
        \`blockedReason\` = NULL,
        \`documentHash\` = ${documentHash},
        \`lastSeenAt\` = UTC_TIMESTAMP(3),
        \`updatedAt\` = UTC_TIMESTAMP(3)
    `;

    return { allowed: true, reserved: true } as const;
  });
}

export async function releaseProductSlotReservation(
  shop: string,
  productId: string,
) {
  await db.$executeRaw`
    DELETE FROM \`AiSearchIndexedProduct\`
    WHERE
      \`shop\` = ${shop}
      AND \`productId\` = ${productId}
      AND \`status\` = 'PRODUCT_SLOT_RESERVED'
      AND \`hasVector\` = false
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
    INSERT INTO \`AiSearchIndexedProduct\` (
      \`shop\`, \`productId\`, \`handle\`, \`title\`, \`status\`, \`hasVector\`, \`documentHash\`,
      \`vectorStatus\`, \`searchable\`, \`blockedReason\`,
      \`lastIndexedAt\`, \`lastSeenAt\`, \`createdAt\`, \`updatedAt\`
    ) VALUES (
      ${shop}, ${productId}, ${handle}, ${title}, 'INDEXED', true, ${documentHash},
      'READY', true, NULL,
      UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
    )
    ON DUPLICATE KEY UPDATE
      \`handle\` = ${handle},
      \`title\` = ${title},
      \`status\` = 'INDEXED',
      \`hasVector\` = true,
      \`vectorStatus\` = 'READY',
      \`searchable\` = true,
      \`blockedReason\` = NULL,
      \`documentHash\` = ${documentHash},
      \`lastIndexedAt\` = UTC_TIMESTAMP(3),
      \`lastSeenAt\` = UTC_TIMESTAMP(3),
      \`updatedAt\` = UTC_TIMESTAMP(3)
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
    INSERT INTO \`AiSearchIndexedProduct\` (
      \`shop\`, \`productId\`, \`handle\`, \`title\`, \`status\`, \`hasVector\`, \`documentHash\`,
      \`vectorStatus\`, \`searchable\`, \`blockedReason\`,
      \`lastSeenAt\`, \`createdAt\`, \`updatedAt\`
    ) VALUES (
      ${shop}, ${productId}, ${handle}, ${title}, ${status}, ${hasVector}, ${documentHash},
      ${hasVector ? (reason === "VECTOR_UPDATE_LIMIT" ? "STALE" : "READY") : "MISSING"},
      ${reason === "VECTOR_UPDATE_LIMIT" && hasVector},
      ${reason === "VECTOR_UPDATE_LIMIT" ? null : reason === "SUBSCRIPTION_INACTIVE" ? "SUBSCRIPTION" : reason},
      UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
    )
    ON DUPLICATE KEY UPDATE
      \`handle\` = ${handle},
      \`title\` = ${title},
      \`status\` = ${status},
      \`hasVector\` = (\`hasVector\` OR ${hasVector}),
      \`searchable\` = CASE WHEN ${reason === "VECTOR_UPDATE_LIMIT"} AND (\`hasVector\` OR ${hasVector}) THEN \`searchable\` ELSE false END,
      \`blockedReason\` = ${reason === "VECTOR_UPDATE_LIMIT" ? null : reason === "SUBSCRIPTION_INACTIVE" ? "SUBSCRIPTION" : reason},
      \`vectorStatus\` = CASE
        WHEN (\`hasVector\` OR ${hasVector}) = false THEN 'MISSING'
        WHEN ${reason === "VECTOR_UPDATE_LIMIT"} THEN 'STALE'
        WHEN \`documentHash\` IS NOT NULL AND \`documentHash\` <> ${documentHash} THEN 'STALE'
        ELSE \`vectorStatus\`
      END,
      \`documentHash\` = ${documentHash},
      \`lastSeenAt\` = UTC_TIMESTAMP(3),
      \`updatedAt\` = UTC_TIMESTAMP(3)
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
      \`id\`, \`shop\`, \`productId\`, \`handle\`, \`title\`, \`status\`, \`hasVector\`,
      \`documentHash\`, \`lastIndexedAt\`, \`lastSeenAt\`, \`lastCatalogSeenAt\`, \`updatedAt\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`status\` = ${status}
    ORDER BY \`updatedAt\` ASC, \`id\` ASC
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
      \`id\`, \`shop\`, \`productId\`, \`handle\`, \`title\`, \`status\`, \`hasVector\`,
      \`documentHash\`, \`lastIndexedAt\`, \`lastSeenAt\`, \`lastCatalogSeenAt\`, \`updatedAt\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`hasVector\` = true
    ORDER BY \`lastIndexedAt\` DESC, \`updatedAt\` DESC, \`id\` DESC
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
    UPDATE \`AiSearchIndexedProduct\`
    SET
      \`lastSeenAt\` = UTC_TIMESTAMP(3),
      \`lastCatalogSeenAt\` = UTC_TIMESTAMP(3),
      \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
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
    UPDATE \`AiSearchIndexedProduct\`
    SET
      \`handle\` = ${handle},
      \`title\` = ${title},
      \`lastSeenAt\` = UTC_TIMESTAMP(3),
      \`lastCatalogSeenAt\` = UTC_TIMESTAMP(3),
      \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
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
    UPDATE \`AiSearchIndexedProduct\`
    SET
      \`handle\` = ${handle},
      \`title\` = ${title},
      \`lastSeenAt\` = UTC_TIMESTAMP(3),
      \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
  `;
}

export async function removeIndexedProduct(shop: string, productId: string) {
  await db.$executeRaw`
    DELETE FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
  `;
}

export async function markIndexedProductUnpublished(shop: string, productId: string) {
  return db.$executeRaw`
    UPDATE \`AiSearchIndexedProduct\`
    SET \`searchable\` = false, \`blockedReason\` = 'UNPUBLISHED',
        \`status\` = 'UNPUBLISHED', \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
  `;
}

export async function markIneligibleProductMetadata({
  shop, productId, handle, title, documentHash,
}: {
  shop: string; productId: string; handle: string; title: string; documentHash: string;
}) {
  return db.$executeRaw`
    UPDATE \`AiSearchIndexedProduct\`
    SET \`handle\` = ${handle}, \`title\` = ${title},
        \`vectorStatus\` = CASE
          WHEN \`hasVector\` = false THEN 'MISSING'
          WHEN \`documentHash\` <> ${documentHash} THEN 'STALE'
          ELSE \`vectorStatus\` END,
        \`documentHash\` = ${documentHash}, \`searchable\` = false,
        \`lastSeenAt\` = UTC_TIMESTAMP(3), \`updatedAt\` = UTC_TIMESTAMP(3)
    WHERE \`shop\` = ${shop} AND \`productId\` = ${productId}
  `;
}

export async function reconcileIndexedProductEligibility({
  shop, policyActive, productLimit,
}: {
  shop: string; policyActive: boolean; productLimit: number | null;
}) {
  return db.$transaction(async (tx) => {
    const versionRows = await tx.$queryRaw<Array<{ productPolicyVersion: number }>>`
      SELECT \`productPolicyVersion\` FROM \`AiSearchShopSettings\`
      WHERE \`shop\` = ${shop} FOR UPDATE
    `;
    const rows = await tx.$queryRaw<Array<{
      productId: string; searchable: boolean | number; hasVector: boolean | number;
      vectorStatus: string; blockedReason: string | null; status: string; createdAt: Date;
    }>>`
      SELECT \`productId\`, \`searchable\`, \`hasVector\`, \`vectorStatus\`, \`blockedReason\`, \`status\`, \`createdAt\`
      FROM \`AiSearchIndexedProduct\` WHERE \`shop\` = ${shop}
      ORDER BY \`searchable\` DESC, (\`vectorStatus\` = 'READY') DESC, \`createdAt\` ASC, \`productId\` ASC
      FOR UPDATE
    `;
    const decisions = planProductEligibility(rows.map((row) => ({
      ...row, searchable: Boolean(row.searchable), hasVector: Boolean(row.hasVector),
    })), policyActive, productLimit);
    const requiresReindex: string[] = [];
    const reactivateReady: string[] = [];
    const deactivate: string[] = [];
    let policyChanged = false;
    for (const decision of decisions) {
      const original = rows.find((row) => row.productId === decision.productId)!;
      if (decision.searchable && !Boolean(original.searchable)) reactivateReady.push(decision.productId);
      if (!decision.searchable && Boolean(original.searchable)) deactivate.push(decision.productId);
      if (decision.requiresReindex) requiresReindex.push(decision.productId);
      if (Boolean(original.searchable) !== decision.searchable || original.blockedReason !== decision.blockedReason || original.status !== decision.status) {
        policyChanged = true;
      }
      await tx.$executeRaw`
        UPDATE \`AiSearchIndexedProduct\`
        SET \`searchable\` = ${decision.searchable},
            \`blockedReason\` = ${decision.blockedReason},
            \`status\` = ${decision.status},
            \`updatedAt\` = UTC_TIMESTAMP(3)
        WHERE \`shop\` = ${shop} AND \`productId\` = ${decision.productId}
      `;
    }
    if (policyChanged) {
      await tx.$executeRaw`
        UPDATE \`AiSearchShopSettings\`
        SET \`productPolicyVersion\` = \`productPolicyVersion\` + 1
        WHERE \`shop\` = ${shop}
      `;
    }
    const policyVersion = Number(versionRows[0]?.productPolicyVersion ?? 0) + (policyChanged ? 1 : 0);
    return {
      policyVersion,
      catalogCount: rows.length,
      cachedVectorCount: rows.filter((row) => Boolean(row.hasVector)).length,
      activeBefore: rows.filter((row) => Boolean(row.searchable)).length,
      activeAfter: decisions.filter((row) => row.searchable).length,
      reactivateReady, deactivate, requiresReindex,
    };
  });
}

export async function listIndexedProducts(shop: string, limit = 20) {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));

  return db.$queryRaw<IndexedProductRow[]>`
    SELECT
      \`id\`, \`shop\`, \`productId\`, \`handle\`, \`title\`, \`status\`, \`hasVector\`,
      \`documentHash\`, \`lastIndexedAt\`, \`lastSeenAt\`, \`lastCatalogSeenAt\`, \`updatedAt\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${shop}
    ORDER BY \`updatedAt\` DESC
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
      \`id\`, \`shop\`, \`productId\`, \`handle\`, \`title\`, \`status\`, \`hasVector\`,
      \`documentHash\`, \`lastIndexedAt\`, \`lastSeenAt\`, \`lastCatalogSeenAt\`, \`updatedAt\`
    FROM \`AiSearchIndexedProduct\`
    WHERE
      \`shop\` = ${shop}
      AND (\`lastCatalogSeenAt\` IS NULL OR \`lastCatalogSeenAt\` < ${seenBefore})
    ORDER BY \`lastCatalogSeenAt\` ASC, \`id\` ASC
    LIMIT ${safeLimit}
  `;
}
