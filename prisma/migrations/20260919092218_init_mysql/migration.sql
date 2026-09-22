-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `state` VARCHAR(255) NOT NULL,
    `isOnline` BOOLEAN NOT NULL DEFAULT false,
    `scope` TEXT NULL,
    `expires` DATETIME(3) NULL,
    `accessToken` TEXT NOT NULL,
    `userId` BIGINT NULL,
    `firstName` VARCHAR(255) NULL,
    `lastName` VARCHAR(255) NULL,
    `email` VARCHAR(320) NULL,
    `accountOwner` BOOLEAN NOT NULL DEFAULT false,
    `locale` VARCHAR(32) NULL,
    `collaborator` BOOLEAN NULL DEFAULT false,
    `emailVerified` BOOLEAN NULL DEFAULT false,
    `refreshToken` TEXT NULL,
    `refreshTokenExpires` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchSyncJob` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `webhookId` VARCHAR(191) NOT NULL,
    `topic` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `processedAt` DATETIME(3) NULL,

    UNIQUE INDEX `AiSearchSyncJob_webhookId_key`(`webhookId`),
    INDEX `AiSearchSyncJob_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `AiSearchSyncJob_shop_productId_idx`(`shop`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchLeaseLock` (
    `shop` VARCHAR(191) NOT NULL,
    `resource` VARCHAR(191) NOT NULL,
    `ownerToken` VARCHAR(191) NOT NULL,
    `leaseUntil` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiSearchLeaseLock_leaseUntil_idx`(`leaseUntil`),
    PRIMARY KEY (`shop`, `resource`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchShop` (
    `shop` VARCHAR(191) NOT NULL,
    `shopifyShopId` VARCHAR(191) NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'ACTIVE',
    `installedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `uninstalledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`shop`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchSubscription` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `plan` VARCHAR(64) NOT NULL DEFAULT 'NONE',
    `status` VARCHAR(64) NOT NULL DEFAULT 'INACTIVE',
    `planHandle` VARCHAR(191) NULL,
    `shopifySubscriptionId` VARCHAR(191) NULL,
    `billingPeriodStart` DATETIME(3) NULL,
    `billingPeriodEnd` DATETIME(3) NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT 'LOCAL',
    `lastSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AiSearchSubscription_shop_key`(`shop`),
    INDEX `AiSearchSubscription_plan_status_idx`(`plan`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchShopSettings` (
    `searchLanguage` VARCHAR(32) NULL,
    `shop` VARCHAR(191) NOT NULL,
    `aiSearchEnabled` BOOLEAN NOT NULL DEFAULT true,
    `customDataModeEnabled` BOOLEAN NOT NULL DEFAULT false,
    `fallbackEnabled` BOOLEAN NOT NULL DEFAULT true,
    `productLimitOverride` INTEGER NULL,
    `searchLimitOverride` INTEGER NULL,
    `vectorUpdateLimitOverride` INTEGER NULL,
    `resultLimit` INTEGER NOT NULL DEFAULT 20,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`shop`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchUsagePeriod` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `periodKey` VARCHAR(64) NOT NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `searchCount` INTEGER NOT NULL DEFAULT 0,
    `vectorUpdateCount` INTEGER NOT NULL DEFAULT 0,
    `productIndexCount` INTEGER NOT NULL DEFAULT 0,
    `productDeleteCount` INTEGER NOT NULL DEFAULT 0,
    `queryEmbeddingCount` INTEGER NOT NULL DEFAULT 0,
    `productEmbeddingCount` INTEGER NOT NULL DEFAULT 0,
    `fallbackCount` INTEGER NOT NULL DEFAULT 0,
    `blockedSearchCount` INTEGER NOT NULL DEFAULT 0,
    `blockedVectorCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiSearchUsagePeriod_shop_periodStart_periodEnd_idx`(`shop`, `periodStart`, `periodEnd`),
    UNIQUE INDEX `AiSearchUsagePeriod_shop_periodKey_key`(`shop`, `periodKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchUsageEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `periodId` INTEGER NULL,
    `type` VARCHAR(64) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `success` BOOLEAN NOT NULL DEFAULT true,
    `productId` VARCHAR(64) NULL,
    `queryHash` VARCHAR(64) NULL,
    `jobId` INTEGER NULL,
    `metadataJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiSearchUsageEvent_shop_type_createdAt_idx`(`shop`, `type`, `createdAt`),
    INDEX `AiSearchUsageEvent_periodId_createdAt_idx`(`periodId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchQueryLog` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `query` TEXT NOT NULL,
    `normalizedQuery` VARCHAR(500) NOT NULL,
    `queryHash` VARCHAR(64) NOT NULL,
    `queryVectorJson` LONGTEXT NULL,
    `analyzedQuery` TEXT NULL,
    `llmAnalysisJson` LONGTEXT NULL,
    `selectedContextJson` LONGTEXT NULL,
    `rankedProductsJson` LONGTEXT NOT NULL,
    `resultCount` INTEGER NOT NULL DEFAULT 0,
    `candidateCount` INTEGER NOT NULL DEFAULT 0,
    `topScore` DOUBLE NULL,
    `topCandidateScore` DOUBLE NULL,
    `vectorThreshold` DOUBLE NOT NULL,
    `embeddingCacheHit` BOOLEAN NOT NULL DEFAULT false,
    `llmStatus` VARCHAR(64) NOT NULL,
    `llmFallbackReason` TEXT NULL,
    `totalDurationMs` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiSearchQueryLog_shop_createdAt_idx`(`shop`, `createdAt`),
    INDEX `AiSearchQueryLog_shop_normalizedQuery_createdAt_idx`(`shop`, `normalizedQuery`, `createdAt`),
    INDEX `AiSearchQueryLog_shop_resultCount_createdAt_idx`(`shop`, `resultCount`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchQueryClick` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `searchLogId` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `rank` INTEGER NOT NULL,
    `score` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiSearchQueryClick_shop_createdAt_idx`(`shop`, `createdAt`),
    INDEX `AiSearchQueryClick_searchLogId_createdAt_idx`(`searchLogId`, `createdAt`),
    UNIQUE INDEX `AiSearchQueryClick_searchLogId_productId_key`(`searchLogId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchUsageReservation` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `periodId` INTEGER NOT NULL,
    `kind` VARCHAR(64) NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `countsVectorUpdate` BOOLEAN NOT NULL DEFAULT false,
    `productId` VARCHAR(64) NULL,
    `queryHash` VARCHAR(64) NULL,
    `embeddingConsumedAt` DATETIME(3) NULL,
    `effectAppliedAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiSearchUsageReservation_shop_status_createdAt_idx`(`shop`, `status`, `createdAt`),
    INDEX `AiSearchUsageReservation_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `AiSearchUsageReservation_shop_status_updatedAt_idx`(`shop`, `status`, `updatedAt`),
    INDEX `AiSearchUsageReservation_status_updatedAt_idx`(`status`, `updatedAt`),
    INDEX `AiSearchUsageReservation_status_resolvedAt_idx`(`status`, `resolvedAt`),
    INDEX `AiSearchUsageReservation_periodId_status_idx`(`periodId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchIndexedProduct` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `handle` VARCHAR(255) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'INDEXED',
    `hasVector` BOOLEAN NOT NULL DEFAULT false,
    `documentHash` VARCHAR(64) NULL,
    `lastIndexedAt` DATETIME(3) NULL,
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastCatalogSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiSearchIndexedProduct_shop_status_idx`(`shop`, `status`),
    INDEX `AiSearchIndexedProduct_shop_handle_idx`(`shop`, `handle`),
    INDEX `AiSearchIndexedProduct_shop_lastCatalogSeenAt_idx`(`shop`, `lastCatalogSeenAt`),
    UNIQUE INDEX `AiSearchIndexedProduct_shop_productId_key`(`shop`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchCatalogSyncJob` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(64) NOT NULL DEFAULT 'INITIAL',
    `planAtStart` VARCHAR(64) NULL,
    `status` VARCHAR(64) NOT NULL DEFAULT 'PENDING',
    `cursor` TEXT NULL,
    `pagesProcessed` INTEGER NOT NULL DEFAULT 0,
    `productsProcessed` INTEGER NOT NULL DEFAULT 0,
    `productsIndexed` INTEGER NOT NULL DEFAULT 0,
    `productsSkipped` INTEGER NOT NULL DEFAULT 0,
    `productsBlocked` INTEGER NOT NULL DEFAULT 0,
    `productsFailed` INTEGER NOT NULL DEFAULT 0,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `scanStartedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `processedAt` DATETIME(3) NULL,

    INDEX `AiSearchCatalogSyncJob_shop_status_createdAt_idx`(`shop`, `status`, `createdAt`),
    INDEX `AiSearchCatalogSyncJob_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `AiSearchCatalogSyncJob_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopThemeConfig` (
    `shop` VARCHAR(191) NOT NULL,
    `themeId` VARCHAR(64) NOT NULL,
    `appEmbedEnabled` BOOLEAN NOT NULL DEFAULT true,
    `activeThemeJson` LONGTEXT NOT NULL,
    `themeMapJson` LONGTEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`shop`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchThemeMapV4` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `themeId` VARCHAR(64) NOT NULL,
    `themeGid` VARCHAR(191) NOT NULL,
    `themeName` VARCHAR(255) NULL,
    `schemaVersion` INTEGER NOT NULL DEFAULT 4,
    `mapStatus` VARCHAR(64) NOT NULL,
    `sourceMode` VARCHAR(64) NOT NULL DEFAULT 'COMPILER',
    `themeVersionKey` VARCHAR(255) NOT NULL,
    `fingerprint` VARCHAR(64) NOT NULL,
    `mapJson` LONGTEXT NOT NULL,
    `dependenciesJson` LONGTEXT NOT NULL,
    `failureReason` TEXT NULL,
    `verifiedThemeVersionKey` VARCHAR(255) NULL,
    `verifiedFingerprint` VARCHAR(64) NULL,
    `verifiedMapJson` LONGTEXT NULL,
    `verifiedDependenciesJson` LONGTEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `lastValidatedAt` DATETIME(3) NULL,
    `lastUsedAt` DATETIME(3) NULL,

    INDEX `AiSearchThemeMapV4_shop_mapStatus_idx`(`shop`, `mapStatus`),
    INDEX `AiSearchThemeMapV4_shop_updatedAt_idx`(`shop`, `updatedAt`),
    UNIQUE INDEX `AiSearchThemeMapV4_shop_themeId_key`(`shop`, `themeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchResultReceipt` (
    `receiptId` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `query` TEXT NOT NULL,
    `searchLogId` VARCHAR(191) NULL,
    `rankedProductsJson` LONGTEXT NOT NULL,
    `total` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `AiSearchResultReceipt_shop_expiresAt_idx`(`shop`, `expiresAt`),
    INDEX `AiSearchResultReceipt_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`receiptId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchShopContextTerm` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(64) NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `normalizedValue` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiSearchShopContextTerm_shop_kind_idx`(`shop`, `kind`),
    INDEX `AiSearchShopContextTerm_shop_normalizedValue_idx`(`shop`, `normalizedValue`),
    UNIQUE INDEX `AiSearchShopContextTerm_shop_productId_kind_normalizedValue_key`(`shop`, `productId`, `kind`, `normalizedValue`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AiSearchRenderTransportKey` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(64) NOT NULL,
    `signature` VARCHAR(400) NOT NULL,
    `clause` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AiSearchRenderTransportKey_shop_kind_signature_idx`(`shop`, `kind`, `signature`),
    INDEX `AiSearchRenderTransportKey_shop_productId_idx`(`shop`, `productId`),
    UNIQUE INDEX `AiSearchRenderTransportKey_shop_productId_kind_signature_key`(`shop`, `productId`, `kind`, `signature`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AiSearchSubscription` ADD CONSTRAINT `AiSearchSubscription_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchShopSettings` ADD CONSTRAINT `AiSearchShopSettings_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchUsagePeriod` ADD CONSTRAINT `AiSearchUsagePeriod_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchUsageEvent` ADD CONSTRAINT `AiSearchUsageEvent_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchUsageEvent` ADD CONSTRAINT `AiSearchUsageEvent_periodId_fkey` FOREIGN KEY (`periodId`) REFERENCES `AiSearchUsagePeriod`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchQueryLog` ADD CONSTRAINT `AiSearchQueryLog_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchQueryClick` ADD CONSTRAINT `AiSearchQueryClick_searchLogId_fkey` FOREIGN KEY (`searchLogId`) REFERENCES `AiSearchQueryLog`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchUsageReservation` ADD CONSTRAINT `AiSearchUsageReservation_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchUsageReservation` ADD CONSTRAINT `AiSearchUsageReservation_periodId_fkey` FOREIGN KEY (`periodId`) REFERENCES `AiSearchUsagePeriod`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchIndexedProduct` ADD CONSTRAINT `AiSearchIndexedProduct_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchCatalogSyncJob` ADD CONSTRAINT `AiSearchCatalogSyncJob_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchShopContextTerm` ADD CONSTRAINT `AiSearchShopContextTerm_shop_productId_fkey` FOREIGN KEY (`shop`, `productId`) REFERENCES `AiSearchIndexedProduct`(`shop`, `productId`) ON DELETE CASCADE ON UPDATE CASCADE;
