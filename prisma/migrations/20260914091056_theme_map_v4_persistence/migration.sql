-- CreateTable
CREATE TABLE "AiSearchThemeMapV4" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "themeGid" TEXT NOT NULL,
    "themeName" TEXT,
    "schemaVersion" INTEGER NOT NULL DEFAULT 4,
    "mapStatus" TEXT NOT NULL,
    "sourceMode" TEXT NOT NULL DEFAULT 'COMPILER',
    "themeVersionKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "mapJson" TEXT NOT NULL,
    "dependenciesJson" TEXT NOT NULL,
    "failureReason" TEXT,
    "verifiedThemeVersionKey" TEXT,
    "verifiedFingerprint" TEXT,
    "verifiedMapJson" TEXT,
    "verifiedDependenciesJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastValidatedAt" DATETIME,
    "lastUsedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "AiSearchThemeMapV4_shop_mapStatus_idx" ON "AiSearchThemeMapV4"("shop", "mapStatus");

-- CreateIndex
CREATE INDEX "AiSearchThemeMapV4_shop_updatedAt_idx" ON "AiSearchThemeMapV4"("shop", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiSearchThemeMapV4_shop_themeId_key" ON "AiSearchThemeMapV4"("shop", "themeId");
