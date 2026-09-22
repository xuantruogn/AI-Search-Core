-- CreateTable
CREATE TABLE "ShopThemeConfig" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "themeId" TEXT NOT NULL,
    "appEmbedEnabled" BOOLEAN NOT NULL DEFAULT true,
    "activeThemeJson" TEXT NOT NULL,
    "themeMapJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiSearchCatalogSyncJob" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'INITIAL',
    "planAtStart" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "cursor" TEXT,
    "pagesProcessed" INTEGER NOT NULL DEFAULT 0,
    "productsProcessed" INTEGER NOT NULL DEFAULT 0,
    "productsIndexed" INTEGER NOT NULL DEFAULT 0,
    "productsSkipped" INTEGER NOT NULL DEFAULT 0,
    "productsBlocked" INTEGER NOT NULL DEFAULT 0,
    "productsFailed" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "scanStartedAt" DATETIME,
    "startedAt" DATETIME,
    "processedAt" DATETIME,
    CONSTRAINT "AiSearchCatalogSyncJob_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiSearchCatalogSyncJob" ("attempts", "createdAt", "cursor", "id", "lastError", "pagesProcessed", "planAtStart", "processedAt", "productsBlocked", "productsFailed", "productsIndexed", "productsProcessed", "productsSkipped", "reason", "scanStartedAt", "shop", "startedAt", "status", "updatedAt") SELECT "attempts", "createdAt", "cursor", "id", "lastError", "pagesProcessed", "planAtStart", "processedAt", "productsBlocked", "productsFailed", "productsIndexed", "productsProcessed", "productsSkipped", "reason", "scanStartedAt", "shop", "startedAt", "status", "updatedAt" FROM "AiSearchCatalogSyncJob";
DROP TABLE "AiSearchCatalogSyncJob";
ALTER TABLE "new_AiSearchCatalogSyncJob" RENAME TO "AiSearchCatalogSyncJob";
CREATE INDEX "AiSearchCatalogSyncJob_shop_status_createdAt_idx" ON "AiSearchCatalogSyncJob"("shop", "status", "createdAt");
CREATE INDEX "AiSearchCatalogSyncJob_status_createdAt_idx" ON "AiSearchCatalogSyncJob"("status", "createdAt");
CREATE INDEX "AiSearchCatalogSyncJob_status_updatedAt_idx" ON "AiSearchCatalogSyncJob"("status", "updatedAt");
CREATE TABLE "new_AiSearchIndexedProduct" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INDEXED',
    "hasVector" BOOLEAN NOT NULL DEFAULT false,
    "documentHash" TEXT,
    "lastIndexedAt" DATETIME,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCatalogSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiSearchIndexedProduct_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiSearchIndexedProduct" ("createdAt", "documentHash", "handle", "hasVector", "id", "lastCatalogSeenAt", "lastIndexedAt", "lastSeenAt", "productId", "shop", "status", "title", "updatedAt") SELECT "createdAt", "documentHash", "handle", "hasVector", "id", "lastCatalogSeenAt", "lastIndexedAt", "lastSeenAt", "productId", "shop", "status", "title", "updatedAt" FROM "AiSearchIndexedProduct";
DROP TABLE "AiSearchIndexedProduct";
ALTER TABLE "new_AiSearchIndexedProduct" RENAME TO "AiSearchIndexedProduct";
CREATE INDEX "AiSearchIndexedProduct_shop_status_idx" ON "AiSearchIndexedProduct"("shop", "status");
CREATE INDEX "AiSearchIndexedProduct_shop_handle_idx" ON "AiSearchIndexedProduct"("shop", "handle");
CREATE INDEX "AiSearchIndexedProduct_shop_lastCatalogSeenAt_idx" ON "AiSearchIndexedProduct"("shop", "lastCatalogSeenAt");
CREATE UNIQUE INDEX "AiSearchIndexedProduct_shop_productId_key" ON "AiSearchIndexedProduct"("shop", "productId");
CREATE TABLE "new_AiSearchShop" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "shopifyShopId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AiSearchShop" ("createdAt", "installedAt", "shop", "shopifyShopId", "status", "uninstalledAt", "updatedAt") SELECT "createdAt", "installedAt", "shop", "shopifyShopId", "status", "uninstalledAt", "updatedAt" FROM "AiSearchShop";
DROP TABLE "AiSearchShop";
ALTER TABLE "new_AiSearchShop" RENAME TO "AiSearchShop";
CREATE TABLE "new_AiSearchShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "aiSearchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "fallbackEnabled" BOOLEAN NOT NULL DEFAULT true,
    "productLimitOverride" INTEGER,
    "searchLimitOverride" INTEGER,
    "vectorUpdateLimitOverride" INTEGER,
    "resultLimit" INTEGER NOT NULL DEFAULT 20,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiSearchShopSettings_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiSearchShopSettings" ("aiSearchEnabled", "createdAt", "fallbackEnabled", "productLimitOverride", "resultLimit", "searchLimitOverride", "shop", "updatedAt", "vectorUpdateLimitOverride") SELECT "aiSearchEnabled", "createdAt", "fallbackEnabled", "productLimitOverride", "resultLimit", "searchLimitOverride", "shop", "updatedAt", "vectorUpdateLimitOverride" FROM "AiSearchShopSettings";
DROP TABLE "AiSearchShopSettings";
ALTER TABLE "new_AiSearchShopSettings" RENAME TO "AiSearchShopSettings";
CREATE TABLE "new_AiSearchSubscription" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'NONE',
    "status" TEXT NOT NULL DEFAULT 'INACTIVE',
    "planHandle" TEXT,
    "shopifySubscriptionId" TEXT,
    "billingPeriodStart" DATETIME,
    "billingPeriodEnd" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'LOCAL',
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiSearchSubscription_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiSearchSubscription" ("billingPeriodEnd", "billingPeriodStart", "createdAt", "id", "lastSyncedAt", "plan", "planHandle", "shop", "shopifySubscriptionId", "source", "status", "updatedAt") SELECT "billingPeriodEnd", "billingPeriodStart", "createdAt", "id", "lastSyncedAt", "plan", "planHandle", "shop", "shopifySubscriptionId", "source", "status", "updatedAt" FROM "AiSearchSubscription";
DROP TABLE "AiSearchSubscription";
ALTER TABLE "new_AiSearchSubscription" RENAME TO "AiSearchSubscription";
CREATE UNIQUE INDEX "AiSearchSubscription_shop_key" ON "AiSearchSubscription"("shop");
CREATE INDEX "AiSearchSubscription_plan_status_idx" ON "AiSearchSubscription"("plan", "status");
CREATE TABLE "new_AiSearchUsagePeriod" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "searchCount" INTEGER NOT NULL DEFAULT 0,
    "vectorUpdateCount" INTEGER NOT NULL DEFAULT 0,
    "productIndexCount" INTEGER NOT NULL DEFAULT 0,
    "productDeleteCount" INTEGER NOT NULL DEFAULT 0,
    "queryEmbeddingCount" INTEGER NOT NULL DEFAULT 0,
    "productEmbeddingCount" INTEGER NOT NULL DEFAULT 0,
    "fallbackCount" INTEGER NOT NULL DEFAULT 0,
    "blockedSearchCount" INTEGER NOT NULL DEFAULT 0,
    "blockedVectorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiSearchUsagePeriod_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiSearchUsagePeriod" ("blockedSearchCount", "blockedVectorCount", "createdAt", "fallbackCount", "id", "periodEnd", "periodKey", "periodStart", "productDeleteCount", "productEmbeddingCount", "productIndexCount", "queryEmbeddingCount", "searchCount", "shop", "updatedAt", "vectorUpdateCount") SELECT "blockedSearchCount", "blockedVectorCount", "createdAt", "fallbackCount", "id", "periodEnd", "periodKey", "periodStart", "productDeleteCount", "productEmbeddingCount", "productIndexCount", "queryEmbeddingCount", "searchCount", "shop", "updatedAt", "vectorUpdateCount" FROM "AiSearchUsagePeriod";
DROP TABLE "AiSearchUsagePeriod";
ALTER TABLE "new_AiSearchUsagePeriod" RENAME TO "AiSearchUsagePeriod";
CREATE INDEX "AiSearchUsagePeriod_shop_periodStart_periodEnd_idx" ON "AiSearchUsagePeriod"("shop", "periodStart", "periodEnd");
CREATE UNIQUE INDEX "AiSearchUsagePeriod_shop_periodKey_key" ON "AiSearchUsagePeriod"("shop", "periodKey");
CREATE TABLE "new_AiSearchUsageReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "periodId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "countsVectorUpdate" BOOLEAN NOT NULL DEFAULT false,
    "productId" TEXT,
    "queryHash" TEXT,
    "embeddingConsumedAt" DATETIME,
    "effectAppliedAt" DATETIME,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiSearchUsageReservation_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiSearchUsageReservation_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AiSearchUsagePeriod" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiSearchUsageReservation" ("countsVectorUpdate", "createdAt", "effectAppliedAt", "embeddingConsumedAt", "id", "kind", "periodId", "productId", "queryHash", "resolvedAt", "shop", "status", "updatedAt") SELECT "countsVectorUpdate", "createdAt", "effectAppliedAt", "embeddingConsumedAt", "id", "kind", "periodId", "productId", "queryHash", "resolvedAt", "shop", "status", "updatedAt" FROM "AiSearchUsageReservation";
DROP TABLE "AiSearchUsageReservation";
ALTER TABLE "new_AiSearchUsageReservation" RENAME TO "AiSearchUsageReservation";
CREATE INDEX "AiSearchUsageReservation_shop_status_createdAt_idx" ON "AiSearchUsageReservation"("shop", "status", "createdAt");
CREATE INDEX "AiSearchUsageReservation_status_createdAt_idx" ON "AiSearchUsageReservation"("status", "createdAt");
CREATE INDEX "AiSearchUsageReservation_shop_status_updatedAt_idx" ON "AiSearchUsageReservation"("shop", "status", "updatedAt");
CREATE INDEX "AiSearchUsageReservation_status_updatedAt_idx" ON "AiSearchUsageReservation"("status", "updatedAt");
CREATE INDEX "AiSearchUsageReservation_status_resolvedAt_idx" ON "AiSearchUsageReservation"("status", "resolvedAt");
CREATE INDEX "AiSearchUsageReservation_periodId_status_idx" ON "AiSearchUsageReservation"("periodId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
