import assert from "node:assert/strict";

import db from "../app/db.server";
import { resolveUniqueThemeSearchTransportKeys } from "../app/services/theme/theme-search-transport-key.server";

type TableRow = { TABLE_NAME: string };
type ColumnRow = { COLUMN_NAME: string };
type IndexRow = { Key_name: string };
type ScalarRow = { value: bigint | number | null };

const forbiddenTables = [
  "AiSearchShopContextTerm",
  "AiSearchRenderTransportKey",
  "AiSearchRenderTransportProfile",
];

for (const table of forbiddenTables) {
  const rows = await db.$queryRawUnsafe<TableRow[]>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?)",
    table,
  );
  assert.equal(rows.length, 0, table + " must not exist");
}

const legacyIndexedProductColumns = [
  "isIndexed",
  "isSearchable",
  "excludedReason",
  "embeddingModel",
  "embeddingVersion",
  "contentHash",
  "lastEmbeddedAt",
  "lastSyncedAt",
];

const placeholders = legacyIndexedProductColumns.map(() => "?").join(",");
const legacyColumns = await db.$queryRawUnsafe<ColumnRow[]>(
  "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiSearchIndexedProduct' AND COLUMN_NAME IN (" + placeholders + ")",
  ...legacyIndexedProductColumns,
);
assert.deepEqual(
  legacyColumns.map((row) => row.COLUMN_NAME),
  [],
  "legacy indexed-product compatibility columns must be removed",
);

const legacyProfiles = await db.aiSearchProductSemanticProfile.count({
  where: { schemaVersion: { lt: 2 } },
});
assert.equal(legacyProfiles, 0, "all semantic profiles must use schemaVersion >= 2");

const [profileStats] = await db.$queryRawUnsafe<
  Array<{
    profileCount: bigint | number;
    maxProfileBytes: bigint | number | null;
    avgProfileBytes: number | string | null;
  }>
>(`
  SELECT
    COUNT(*) AS profileCount,
    MAX(OCTET_LENGTH(profile)) AS maxProfileBytes,
    AVG(OCTET_LENGTH(profile)) AS avgProfileBytes
  FROM AiSearchProductSemanticProfile
`);
assert.ok(
  Number(profileStats?.maxProfileBytes ?? 0) <= 128 * 1024,
  "a semantic profile exceeded the 128 KiB safety ceiling",
);

const [missingActiveProfiles] = await db.$queryRawUnsafe<ScalarRow[]>(`
  SELECT COUNT(*) AS value
  FROM AiSearchIndexedProduct p
  LEFT JOIN AiSearchProductSemanticProfile s
    ON s.shop = p.shop AND s.productId = p.productId
  WHERE p.searchable = TRUE
    AND p.hasVector = TRUE
    AND s.id IS NULL
`);
assert.equal(
  Number(missingActiveProfiles?.value ?? 0),
  0,
  "every active indexed product must have a semantic profile",
);

const requiredIndexes: Array<[string, string]> = [
  ["AiSearchUsageEvent", "idx_usage_event_created_at"],
  ["AiSearchQueryLog", "idx_query_log_created_at"],
  ["AiSearchApiUsageEvent", "idx_api_usage_created_at"],
  ["AiSearchSyncJob", "idx_sync_job_status_updated"],
  ["AiSearchSyncJob", "idx_sync_job_status_processed"],
  ["AiSearchCatalogSyncJob", "idx_catalog_job_status_processed"],
  ["AiSearchProductSemanticProfile", "idx_semantic_profile_version_id"],
  ["AiSearchIndexedProduct", "idx_indexed_product_active"],
  ["AiSearchIndexedProduct", "idx_indexed_product_catalog_page"],
  ["AiSearchIndexedProduct", "idx_enrich_due_global"],
  ["AiSearchIndexedProduct", "idx_enrich_version_global"],
  ["AiSearchAdminAuditLog", "idx_admin_audit_created_at"],
];

for (const [table, index] of requiredIndexes) {
  const rows = await db.$queryRawUnsafe<IndexRow[]>(
    "SELECT DISTINCT INDEX_NAME AS Key_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
    table,
    index,
  );
  assert.equal(rows.length, 1, "missing required index " + table + "." + index);
}

const apiDailyExists = await db.$queryRawUnsafe<TableRow[]>(
  "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiSearchApiUsageDaily'",
);
assert.equal(apiDailyExists.length, 1, "AiSearchApiUsageDaily must exist");

const [queryPayloadStats] = await db.$queryRawUnsafe<Array<{
  maxAnalysis: bigint | number | null;
  maxContext: bigint | number | null;
  maxRanked: bigint | number | null;
}>>(`
  SELECT
    MAX(COALESCE(OCTET_LENGTH(llmAnalysisJson), 0)) AS maxAnalysis,
    MAX(COALESCE(OCTET_LENGTH(selectedContextJson), 0)) AS maxContext,
    MAX(OCTET_LENGTH(rankedProductsJson)) AS maxRanked
  FROM AiSearchQueryLog
`);
assert.ok(
  Number(queryPayloadStats?.maxAnalysis ?? 0) <= 64 * 1024,
  "query analytics llmAnalysisJson exceeded 64 KiB",
);
assert.ok(
  Number(queryPayloadStats?.maxContext ?? 0) <= 32 * 1024,
  "query analytics selectedContextJson exceeded 32 KiB",
);
assert.ok(
  Number(queryPayloadStats?.maxRanked ?? 0) <= 64 * 1024,
  "query analytics rankedProductsJson exceeded 64 KiB",
);

const settingsColumns = await db.$queryRawUnsafe<ColumnRow[]>(
  "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AiSearchShopSettings' AND COLUMN_NAME IN ('catalogRevision','catalogUpdatedAt')",
);
assert.deepEqual(
  new Set(settingsColumns.map((row) => row.COLUMN_NAME)),
  new Set(["catalogRevision", "catalogUpdatedAt"]),
  "shop settings must expose O(1) catalog revision fields for search-cache invalidation",
);

const sampleProducts = await db.aiSearchIndexedProduct.findMany({
  where: { searchable: true, hasVector: true },
  take: 10,
  orderBy: { id: "asc" },
  select: { shop: true, productId: true },
});

const byShop = new Map<string, string[]>();
for (const row of sampleProducts) {
  const ids = byShop.get(row.shop) ?? [];
  ids.push(row.productId);
  byShop.set(row.shop, ids);
}

for (const [shop, productIds] of byShop) {
  const result = await resolveUniqueThemeSearchTransportKeys({ shop, productIds });
  assert.equal(
    result.resolved.length + result.unresolved.length,
    productIds.length,
    "transport resolution must account for every requested product",
  );
}

console.log(
  JSON.stringify(
    {
      status: "PASS",
      semanticProfiles: Number(profileStats?.profileCount ?? 0),
      maxSemanticProfileBytes: Number(profileStats?.maxProfileBytes ?? 0),
      avgSemanticProfileBytes: Number(profileStats?.avgProfileBytes ?? 0),
      sampledTransportProducts: sampleProducts.length,
    },
    null,
    2,
  ),
);

await db.$disconnect();
