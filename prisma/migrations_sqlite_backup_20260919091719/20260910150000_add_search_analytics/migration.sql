CREATE TABLE "AiSearchQueryLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "normalizedQuery" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "rankedProductsJson" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "topScore" REAL,
    "topCandidateScore" REAL,
    "vectorThreshold" REAL NOT NULL,
    "embeddingCacheHit" BOOLEAN NOT NULL DEFAULT false,
    "llmStatus" TEXT NOT NULL,
    "llmFallbackReason" TEXT,
    "totalDurationMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSearchQueryLog_shop_fkey" FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AiSearchQueryClick" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "searchLogId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSearchQueryClick_searchLogId_fkey" FOREIGN KEY ("searchLogId") REFERENCES "AiSearchQueryLog" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AiSearchQueryLog_shop_createdAt_idx" ON "AiSearchQueryLog"("shop", "createdAt");
CREATE INDEX "AiSearchQueryLog_shop_normalizedQuery_createdAt_idx" ON "AiSearchQueryLog"("shop", "normalizedQuery", "createdAt");
CREATE INDEX "AiSearchQueryLog_shop_resultCount_createdAt_idx" ON "AiSearchQueryLog"("shop", "resultCount", "createdAt");
CREATE UNIQUE INDEX "AiSearchQueryClick_searchLogId_productId_key" ON "AiSearchQueryClick"("searchLogId", "productId");
CREATE INDEX "AiSearchQueryClick_shop_createdAt_idx" ON "AiSearchQueryClick"("shop", "createdAt");
CREATE INDEX "AiSearchQueryClick_searchLogId_createdAt_idx" ON "AiSearchQueryClick"("searchLogId", "createdAt");
