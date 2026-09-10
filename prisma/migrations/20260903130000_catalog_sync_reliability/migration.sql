-- Keep a stable full-scan marker across retries/reclaims. `startedAt` is a
-- worker-attempt timestamp and is intentionally reset every claim, so it
-- cannot safely drive stale-product cleanup.
ALTER TABLE "AiSearchCatalogSyncJob" ADD COLUMN "scanStartedAt" DATETIME;

-- Catalog presence must be tracked separately from webhook/index activity.
-- Otherwise a webhook update that lands during a full scan can refresh
-- lastSeenAt and accidentally protect a product that is subsequently deleted
-- before the scan reaches it.
ALTER TABLE "AiSearchIndexedProduct" ADD COLUMN "lastCatalogSeenAt" DATETIME;

CREATE INDEX "AiSearchCatalogSyncJob_status_updatedAt_idx"
ON "AiSearchCatalogSyncJob"("status", "updatedAt");

CREATE INDEX "AiSearchIndexedProduct_shop_lastCatalogSeenAt_idx"
ON "AiSearchIndexedProduct"("shop", "lastCatalogSeenAt");
