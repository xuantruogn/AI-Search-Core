ALTER TABLE "AiSearchCatalogSyncJob" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'INITIAL';
ALTER TABLE "AiSearchCatalogSyncJob" ADD COLUMN "planAtStart" TEXT;
