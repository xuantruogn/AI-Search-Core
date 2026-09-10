-- Commercial / multi-tenant foundation for AI Search Bridge.

CREATE TABLE "AiSearchShop" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "shopifyShopId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AiSearchSubscription" (
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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSearchSubscription_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AiSearchSubscription_shop_key" ON "AiSearchSubscription"("shop");
CREATE INDEX "AiSearchSubscription_plan_status_idx" ON "AiSearchSubscription"("plan", "status");

CREATE TABLE "AiSearchShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "aiSearchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "fallbackEnabled" BOOLEAN NOT NULL DEFAULT true,
    "productLimitOverride" INTEGER,
    "searchLimitOverride" INTEGER,
    "vectorUpdateLimitOverride" INTEGER,
    "resultLimit" INTEGER NOT NULL DEFAULT 20,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSearchShopSettings_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AiSearchUsagePeriod" (
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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSearchUsagePeriod_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AiSearchUsagePeriod_shop_periodKey_key" ON "AiSearchUsagePeriod"("shop", "periodKey");
CREATE INDEX "AiSearchUsagePeriod_shop_periodStart_periodEnd_idx" ON "AiSearchUsagePeriod"("shop", "periodStart", "periodEnd");

CREATE TABLE "AiSearchUsageEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "periodId" INTEGER,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "productId" TEXT,
    "queryHash" TEXT,
    "jobId" INTEGER,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSearchUsageEvent_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AiSearchUsageEvent_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "AiSearchUsagePeriod" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AiSearchUsageEvent_shop_type_createdAt_idx" ON "AiSearchUsageEvent"("shop", "type", "createdAt");
CREATE INDEX "AiSearchUsageEvent_periodId_createdAt_idx" ON "AiSearchUsageEvent"("periodId", "createdAt");

CREATE TABLE "AiSearchIndexedProduct" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSearchIndexedProduct_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AiSearchIndexedProduct_shop_productId_key" ON "AiSearchIndexedProduct"("shop", "productId");
CREATE INDEX "AiSearchIndexedProduct_shop_status_idx" ON "AiSearchIndexedProduct"("shop", "status");
CREATE INDEX "AiSearchIndexedProduct_shop_handle_idx" ON "AiSearchIndexedProduct"("shop", "handle");

CREATE TABLE "AiSearchCatalogSyncJob" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "processedAt" DATETIME,
    CONSTRAINT "AiSearchCatalogSyncJob_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AiSearchCatalogSyncJob_shop_status_createdAt_idx" ON "AiSearchCatalogSyncJob"("shop", "status", "createdAt");
CREATE INDEX "AiSearchCatalogSyncJob_status_createdAt_idx" ON "AiSearchCatalogSyncJob"("status", "createdAt");
