-- CreateTable
CREATE TABLE "AiSearchSyncJob" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "processedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSearchSyncJob_webhookId_key" ON "AiSearchSyncJob"("webhookId");

-- CreateIndex
CREATE INDEX "AiSearchSyncJob_status_createdAt_idx" ON "AiSearchSyncJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AiSearchSyncJob_shop_productId_idx" ON "AiSearchSyncJob"("shop", "productId");
