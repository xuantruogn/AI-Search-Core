import db from "../../db.server";
import { deleteExpiredLeaseLocks } from "../commerce/lease-lock.server";
import {
  deleteResolvedUsageReservations,
  reconcileStaleUsageReservations,
} from "../commerce/usage.server";
import { enqueueCatalogRefresh } from "../catalog/catalog-sync-job.server";
import { kickCatalogSyncQueue } from "../catalog/catalog-sync-queue.server";
import { clearExpiredSearchResults } from "../search/search-result-cache.server";

function readPositiveInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
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
    SELECT s."shop"
    FROM "AiSearchShop" s
    JOIN "AiSearchSubscription" sub ON sub."shop" = s."shop"
    WHERE
      s."status" = 'ACTIVE'
      AND sub."status" = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM "AiSearchCatalogSyncJob" activeJob
        WHERE activeJob."shop" = s."shop"
          AND activeJob."status" IN ('PENDING', 'PROCESSING')
      )
      AND julianday(COALESCE((
        SELECT MAX(doneJob."processedAt")
        FROM "AiSearchCatalogSyncJob" doneJob
        WHERE doneJob."shop" = s."shop" AND doneJob."status" = 'DONE'
      ), '1970-01-01 00:00:00')) < julianday(${cutoff.toISOString()})
    ORDER BY s."updatedAt" ASC
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

  const usageCutoff = daysAgo(usageRetentionDays);
  const queryLogCutoff = daysAgo(queryLogRetentionDays);
  const productJobCutoff = daysAgo(productJobRetentionDays);
  const catalogJobCutoff = daysAgo(catalogJobRetentionDays);
  const failedProductJobCutoff = daysAgo(failedProductJobRetentionDays);
  const failedCatalogJobCutoff = daysAgo(failedCatalogJobRetentionDays);

  const [
    usageEventsDeleted,
    queryLogsDeleted,
    productJobsDeleted,
    catalogJobsDeleted,
    failedProductJobsDeleted,
    failedCatalogJobsDeleted,
  ] = await db.$transaction([
    db.$executeRaw`
        DELETE FROM "AiSearchUsageEvent"
        WHERE "createdAt" < ${usageCutoff}
      `,
    db.$executeRaw`
        DELETE FROM "AiSearchQueryLog"
        WHERE "createdAt" < ${queryLogCutoff}
      `,
    db.$executeRaw`
        DELETE FROM "AiSearchSyncJob"
        WHERE
          "status" IN ('DONE', 'CANCELLED')
          AND "processedAt" IS NOT NULL
          AND "processedAt" < ${productJobCutoff}
      `,
    db.$executeRaw`
        DELETE FROM "AiSearchCatalogSyncJob"
        WHERE
          "status" IN ('DONE', 'CANCELLED')
          AND "processedAt" IS NOT NULL
          AND "processedAt" < ${catalogJobCutoff}
      `,
    // Exhausted/manual-review failures are intentionally retained much
    // longer than successful jobs, but not forever. This prevents an old
    // store with repeated downstream failures from growing SQLite without
    // bound while preserving a useful troubleshooting window.
    db.$executeRaw`
        DELETE FROM "AiSearchSyncJob"
        WHERE
          "status" = 'FAILED'
          AND "processedAt" IS NOT NULL
          AND "processedAt" < ${failedProductJobCutoff}
      `,
    db.$executeRaw`
        DELETE FROM "AiSearchCatalogSyncJob"
        WHERE
          "status" = 'FAILED'
          AND "processedAt" IS NOT NULL
          AND "processedAt" < ${failedCatalogJobCutoff}
      `,
  ]);

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
    });
  const expiredLeasesDeleted = await deleteExpiredLeaseLocks();
  const storefrontCatalogReconciliation =
    await enqueueDueStorefrontCatalogReconciliations();
  const expiredSearchReceiptsDeleted =
    await clearExpiredSearchResults();

  console.log("[AI Search] Housekeeping completed:", {
    usageEventsDeleted,
    queryLogsDeleted,
    productJobsDeleted,
    catalogJobsDeleted,
    failedProductJobsDeleted,
    failedCatalogJobsDeleted,
    usageReservationsRecovered,
    resolvedUsageReservationsDeleted,
    expiredLeasesDeleted,
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
    usageReservationsRecovered,
    resolvedUsageReservationsDeleted,
    expiredLeasesDeleted,
    storefrontCatalogReconciliation,
    expiredSearchReceiptsDeleted: expiredSearchReceiptsDeleted.count,
  };
}

const housekeepingGlobal = globalThis as typeof globalThis & {
  aiSearchHousekeepingStarted?: boolean;
};

export function startAiSearchHousekeepingWorker() {
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

  const timer = setInterval(run, Math.max(60 * 60_000, intervalMs));
  timer.unref?.();

  // Delay the first pass a little so migrations/startup can finish first.
  const firstRun = setTimeout(run, 30_000);
  firstRun.unref?.();
}
