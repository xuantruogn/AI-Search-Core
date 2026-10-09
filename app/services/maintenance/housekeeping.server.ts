import { createHash } from "node:crypto";

import db from "../../db.server";
import { deleteExpiredLeaseLocks } from "../commerce/lease-lock.server";
import {
  deleteResolvedUsageReservations,
  reconcileStaleUsageReservations,
} from "../commerce/usage.server";
import { enqueueCatalogRefresh } from "../catalog/catalog-sync-job.server";
import { kickCatalogSyncQueue } from "../catalog/catalog-sync-queue.server";
import { enqueueProductSyncJob } from "../products/product-sync-job.server";
import { kickProductSyncQueue } from "../products/product-sync-queue.server";
import {
  isProductEnrichmentEnabled,
  PRODUCT_ENRICHMENT_VERSION,
} from "../products/product-embedding-input.server";
import { clearExpiredSearchResults } from "../search/search-result-cache.server";
import { backfillSemanticVectorPayloads } from "../search/vector-store.server";
import { compactLegacySemanticProfiles } from "../search/product-semantic-profile.server";
import { compactApiUsageEvents } from "./api-usage-retention.server";
import {
  backgroundJobsEnabledInThisProcess,
  jitterInterval,
} from "./background-runtime.server";

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function utcDayStartDaysAgo(days: number) {
  const cutoff = daysAgo(days);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff;
}

async function deleteInBatches(
  deleteBatch: (limit: number) => Promise<number>,
  options?: { batchSize?: number; maxBatches?: number },
) {
  const batchSize = Math.max(
    100,
    Math.min(options?.batchSize ?? 5_000, 50_000),
  );
  const maxBatches = Math.max(
    1,
    Math.min(options?.maxBatches ?? 20, 100),
  );
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const count = await deleteBatch(batchSize);
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

async function enqueueDueStorefrontCatalogReconciliations() {
  const intervalHours = readPositiveInteger(
    "AI_SEARCH_STOREFRONT_RECONCILE_HOURS",
    24,
  );
  const batchSize = Math.max(1, Math.min(
    readPositiveInteger("AI_SEARCH_STOREFRONT_RECONCILE_SHOPS_PER_RUN", 25),
    100,
  ));
  const cutoff = new Date(Date.now() - intervalHours * 60 * 60 * 1000);

  const shops = await db.$queryRaw<Array<{ shop: string }>>`
    SELECT s.\`shop\`
    FROM \`AiSearchShop\` s
    WHERE
      s.\`status\` = 'ACTIVE'
      AND EXISTS (
        SELECT 1
        FROM \`billing_subscriptions\` sub
        WHERE sub.\`shop\` = s.\`shop\`
          AND sub.\`status\` = 'ACTIVE'
      )
      AND NOT EXISTS (
        SELECT 1 FROM \`AiSearchCatalogSyncJob\` activeJob
        WHERE activeJob.\`shop\` = s.\`shop\`
          AND activeJob.\`status\` IN ('PENDING', 'PROCESSING')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM \`AiSearchCatalogSyncJob\` authBlockedJob
        WHERE
          authBlockedJob.\`shop\` = s.\`shop\`
          AND authBlockedJob.\`status\` = 'FAILED'
          AND authBlockedJob.\`lastError\` LIKE 'AUTH_REQUIRED:%'
          AND NOT EXISTS (
            SELECT 1
            FROM \`AiSearchCatalogSyncJob\` recoveredJob
            WHERE
              recoveredJob.\`shop\` = s.\`shop\`
              AND recoveredJob.\`status\` = 'DONE'
              AND recoveredJob.\`processedAt\` IS NOT NULL
              AND authBlockedJob.\`processedAt\` IS NOT NULL
              AND recoveredJob.\`processedAt\` > authBlockedJob.\`processedAt\`
          )
      )
      AND COALESCE((
        SELECT MAX(doneJob.\`processedAt\`)
        FROM \`AiSearchCatalogSyncJob\` doneJob
        WHERE doneJob.\`shop\` = s.\`shop\` AND doneJob.\`status\` = 'DONE'
      ), '1970-01-01 00:00:00') < ${cutoff}
    ORDER BY s.\`updatedAt\` ASC
    LIMIT ${batchSize}
  `;

  let queued = 0;
  for (const row of shops) {
    try {
      const jobId = await enqueueCatalogRefresh(
        row.shop,
        "STOREFRONT_RECONCILE",
      );
      if (jobId) queued += 1;
    } catch (error) {
      console.error("[AI Search] Storefront catalog reconciliation enqueue failed:", {
        shop: row.shop,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (queued > 0) kickCatalogSyncQueue();
  return { checked: shops.length, queued };
}

async function enqueueDueProductEnrichmentRetries() {
  if (!isProductEnrichmentEnabled()) {
    return { checked: 0, queued: 0 };
  }

  const batchSize = Math.max(
    1,
    Math.min(
      readPositiveInteger("AI_SEARCH_ENRICHMENT_RETRY_BATCH_SIZE", 100),
      500,
    ),
  );
  const rows = await db.$queryRaw<Array<{
    shop: string;
    productId: string;
  }>>`
    SELECT p.shop, p.productId
    FROM AiSearchIndexedProduct p
    JOIN AiSearchShop s ON s.shop = p.shop
    JOIN AiSearchShopSettings settings ON settings.shop = p.shop
    WHERE
      s.status = 'ACTIVE'
      AND p.hasVector = TRUE
      AND p.searchable = TRUE
      AND settings.searchLanguage IS NOT NULL
      AND settings.searchLanguage <> ''
      AND (
        p.enrichmentVersion IS NULL
        OR p.enrichmentVersion <> ${PRODUCT_ENRICHMENT_VERSION}
        OR p.enrichmentStatus = 'BASE_ONLY'
        OR (
          p.enrichmentStatus IN ('PENDING', 'FAILED', 'FALLBACK')
          AND (
            p.enrichmentRetryAt IS NULL
            OR p.enrichmentRetryAt <= UTC_TIMESTAMP(3)
          )
        )
      )
    ORDER BY
      COALESCE(p.enrichmentRetryAt, p.enrichmentUpdatedAt, p.createdAt) ASC,
      p.id ASC
    LIMIT ${batchSize}
  `;

  let queued = 0;
  const retryBucket = Math.floor(Date.now() / (6 * 60 * 60_000));
  for (const row of rows) {
    const token = createHash("sha256")
      .update(
        [
          PRODUCT_ENRICHMENT_VERSION,
          row.shop,
          row.productId,
          String(retryBucket),
        ].join("\u0000"),
      )
      .digest("hex")
      .slice(0, 32);
    const result = await enqueueProductSyncJob({
      shop: row.shop,
      webhookId: `enrichment:${token}`,
      topic: "REINDEX_PRODUCT_ENRICHMENT",
      productId: row.productId,
    });
    if (result.created) queued += 1;
  }

  if (queued > 0) kickProductSyncQueue();
  return { checked: rows.length, queued };
}

export async function runAiSearchHousekeeping() {
  const usageRetentionDays = readPositiveInteger(
    "AI_SEARCH_USAGE_EVENT_RETENTION_DAYS",
    90,
  );
  const queryLogRetentionDays = readPositiveInteger(
    "AI_SEARCH_QUERY_LOG_RETENTION_DAYS",
    90,
  );
  const productJobRetentionDays = readPositiveInteger(
    "AI_SEARCH_SYNC_JOB_RETENTION_DAYS",
    30,
  );
  const catalogJobRetentionDays = readPositiveInteger(
    "AI_SEARCH_CATALOG_JOB_RETENTION_DAYS",
    90,
  );
  const failedProductJobRetentionDays = readPositiveInteger(
    "AI_SEARCH_FAILED_SYNC_JOB_RETENTION_DAYS",
    90,
  );
  const failedCatalogJobRetentionDays = readPositiveInteger(
    "AI_SEARCH_FAILED_CATALOG_JOB_RETENTION_DAYS",
    180,
  );
  const apiUsageRawRetentionDays = readPositiveInteger(
    "AI_SEARCH_API_USAGE_EVENT_RETENTION_DAYS",
    7,
  );
  const apiUsageDailyRetentionDays = readPositiveInteger(
    "AI_SEARCH_API_USAGE_DAILY_RETENTION_DAYS",
    730,
  );
  const devAuthRetentionDays = readPositiveInteger(
    "AI_SEARCH_DEV_AUTH_RETENTION_DAYS",
    7,
  );
  const auditRetentionDays = readPositiveInteger(
    "AI_SEARCH_AUDIT_RETENTION_DAYS",
    365,
  );

  const usageCutoff = daysAgo(usageRetentionDays);
  const queryLogCutoff = daysAgo(queryLogRetentionDays);
  const productJobCutoff = daysAgo(productJobRetentionDays);
  const catalogJobCutoff = daysAgo(catalogJobRetentionDays);
  const failedProductJobCutoff = daysAgo(failedProductJobRetentionDays);
  const failedCatalogJobCutoff = daysAgo(failedCatalogJobRetentionDays);
  // Compact only complete UTC days so raw + daily reporting never overlaps
  // within the same calendar day.
  const apiUsageRawCutoff = utcDayStartDaysAgo(apiUsageRawRetentionDays);
  const apiUsageDailyCutoff = daysAgo(apiUsageDailyRetentionDays);
  const devAuthCutoff = daysAgo(devAuthRetentionDays);
  const auditCutoff = daysAgo(auditRetentionDays);

  const retentionBatchSize = Math.max(
    100,
    Math.min(
      readPositiveInteger("AI_SEARCH_HOUSEKEEPING_DELETE_BATCH_SIZE", 5_000),
      50_000,
    ),
  );
  const retentionMaxBatches = Math.max(
    1,
    Math.min(
      readPositiveInteger("AI_SEARCH_HOUSEKEEPING_MAX_DELETE_BATCHES", 20),
      100,
    ),
  );
  const batchOptions = {
    batchSize: retentionBatchSize,
    maxBatches: retentionMaxBatches,
  };

  const usageEventsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`AiSearchUsageEvent\`
      WHERE \`createdAt\` < ${usageCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const queryLogsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`AiSearchQueryLog\`
      WHERE \`createdAt\` < ${queryLogCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const productJobsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`AiSearchSyncJob\`
      WHERE
        \`status\` IN ('DONE', 'CANCELLED')
        AND \`processedAt\` IS NOT NULL
        AND \`processedAt\` < ${productJobCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const catalogJobsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`AiSearchCatalogSyncJob\`
      WHERE
        \`status\` IN ('DONE', 'CANCELLED')
        AND \`processedAt\` IS NOT NULL
        AND \`processedAt\` < ${catalogJobCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const failedProductJobsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`AiSearchSyncJob\`
      WHERE
        \`status\` = 'FAILED'
        AND \`processedAt\` IS NOT NULL
        AND \`processedAt\` < ${failedProductJobCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const failedCatalogJobsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`AiSearchCatalogSyncJob\`
      WHERE
        \`status\` = 'FAILED'
        AND \`processedAt\` IS NOT NULL
        AND \`processedAt\` < ${failedCatalogJobCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );

  const expiredDevSessionsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`DevSession\`
      WHERE
        (\`expiresAt\` < NOW(3)
          OR \`absoluteExpiresAt\` < NOW(3)
          OR \`revokedAt\` IS NOT NULL)
        AND \`lastSeenAt\` < ${devAuthCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const expiredDevChallengesDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`DevLoginChallenge\`
      WHERE \`expiresAt\` < ${devAuthCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const staleDevThrottleDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`DevAuthThrottle\`
      WHERE \`updatedAt\` < ${devAuthCutoff}
        AND (\`blockedUntil\` IS NULL OR \`blockedUntil\` < NOW(3))
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const adminAuditLogsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`AiSearchAdminAuditLog\`
      WHERE \`createdAt\` < ${auditCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );
  const devAuditLogsDeleted = await deleteInBatches(
    (limit) => db.$executeRaw`
      DELETE FROM \`DevAuditLog\`
      WHERE \`createdAt\` < ${auditCutoff}
      LIMIT ${limit}
    `,
    batchOptions,
  );

  const apiUsageCompaction = await compactApiUsageEvents({
    rawCutoff: apiUsageRawCutoff,
    dailyCutoff: apiUsageDailyCutoff,
    deleteBatchSize: retentionBatchSize,
    maxDeleteBatches: retentionMaxBatches,
  });
  const semanticProfileCompaction =
    await compactLegacySemanticProfiles(2_000);

  let semanticVectorPayloadBackfill = {
    scanned: 0,
    updated: 0,
    missingProfiles: 0,
  };
  try {
    semanticVectorPayloadBackfill = await backfillSemanticVectorPayloads({
      limit: readPositiveInteger(
        "AI_SEARCH_SEMANTIC_PAYLOAD_BACKFILL_PER_RUN",
        1_000,
      ),
      concurrency: readPositiveInteger(
        "AI_SEARCH_SEMANTIC_PAYLOAD_BACKFILL_CONCURRENCY",
        10,
      ),
    });
  } catch (error) {
    console.error("[AI Search] Semantic Qdrant payload backfill failed:", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const usageReservationTtlMs = readPositiveInteger(
    "AI_SEARCH_USAGE_RESERVATION_TTL_MS",
    30 * 60_000,
  );
  const usageReservationRetentionDays = readPositiveInteger(
    "AI_SEARCH_USAGE_RESERVATION_RETENTION_DAYS",
    7,
  );

  const usageReservationsRecovered = await reconcileStaleUsageReservations({
    staleAfterMs: usageReservationTtlMs,
  });
  const resolvedUsageReservationsDeleted =
    await deleteResolvedUsageReservations({
      olderThanDays: usageReservationRetentionDays,
      batchSize: retentionBatchSize,
      maxBatches: retentionMaxBatches,
    });
  const expiredLeasesDeleted = await deleteExpiredLeaseLocks();
  const enrichmentRetries =
    await enqueueDueProductEnrichmentRetries();
  const storefrontCatalogReconciliation =
    await enqueueDueStorefrontCatalogReconciliations();
  const expiredSearchReceiptsDeleted =
    await clearExpiredSearchResults(new Date(), {
      batchSize: retentionBatchSize,
      maxBatches: retentionMaxBatches,
    });

  console.log("[AI Search] Housekeeping completed:", {
    usageEventsDeleted,
    queryLogsDeleted,
    productJobsDeleted,
    catalogJobsDeleted,
    failedProductJobsDeleted,
    failedCatalogJobsDeleted,
    expiredDevSessionsDeleted,
    expiredDevChallengesDeleted,
    staleDevThrottleDeleted,
    adminAuditLogsDeleted,
    devAuditLogsDeleted,
    apiUsageCompaction,
    semanticProfileCompaction,
    semanticVectorPayloadBackfill,
    usageReservationsRecovered,
    resolvedUsageReservationsDeleted,
    expiredLeasesDeleted,
    enrichmentRetries,
    storefrontCatalogReconciliation,
    expiredSearchReceiptsDeleted: expiredSearchReceiptsDeleted.count,
  });

  return {
    usageEventsDeleted,
    queryLogsDeleted,
    productJobsDeleted,
    catalogJobsDeleted,
    failedProductJobsDeleted,
    failedCatalogJobsDeleted,
    expiredDevSessionsDeleted,
    expiredDevChallengesDeleted,
    staleDevThrottleDeleted,
    adminAuditLogsDeleted,
    devAuditLogsDeleted,
    apiUsageCompaction,
    semanticProfileCompaction,
    semanticVectorPayloadBackfill,
    usageReservationsRecovered,
    resolvedUsageReservationsDeleted,
    expiredLeasesDeleted,
    enrichmentRetries,
    storefrontCatalogReconciliation,
    expiredSearchReceiptsDeleted: expiredSearchReceiptsDeleted.count,
  };
}

const housekeepingGlobal = globalThis as typeof globalThis & {
  aiSearchHousekeepingStarted?: boolean;
};

export function startAiSearchHousekeepingWorker() {
  if (!backgroundJobsEnabledInThisProcess()) return;

  if (housekeepingGlobal.aiSearchHousekeepingStarted) return;
  housekeepingGlobal.aiSearchHousekeepingStarted = true;

  const intervalMs = readPositiveInteger(
    "AI_SEARCH_HOUSEKEEPING_INTERVAL_MS",
    6 * 60 * 60 * 1000,
  );

  const run = () => {
    void runAiSearchHousekeeping().catch((error) => {
      console.error("[AI Search] Housekeeping failed:", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const timer = setInterval(
    run,
    jitterInterval(Math.max(60 * 60_000, intervalMs), 0.1),
  );
  timer.unref?.();

  // Queue recovery is more urgent than retention work. Give startup, migration
  // and cache warmup a quiet window before the first maintenance pass.
  const firstRunDelayMs = Math.max(
    30_000,
    readPositiveInteger("AI_SEARCH_HOUSEKEEPING_INITIAL_DELAY_MS", 120_000),
  );
  const firstRun = setTimeout(run, firstRunDelayMs);
  firstRun.unref?.();
}
