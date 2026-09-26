-- DropForeignKey
ALTER TABLE `aisearchcatalogsyncjob` DROP FOREIGN KEY `AiSearchCatalogSyncJob_shop_aisearchshop_fkey`;

-- DropForeignKey
ALTER TABLE `aisearchindexedproduct` DROP FOREIGN KEY `AiSearchIndexedProduct_shop_aisearchshop_fkey`;

-- DropForeignKey
ALTER TABLE `aisearchquerylog` DROP FOREIGN KEY `AiSearchQueryLog_shop_aisearchshop_fkey`;

-- DropForeignKey
ALTER TABLE `aisearchshopsettings` DROP FOREIGN KEY `AiSearchShopSettings_shop_aisearchshop_fkey`;

-- DropForeignKey
ALTER TABLE `aisearchsubscription` DROP FOREIGN KEY `AiSearchSubscription_shop_aisearchshop_fkey`;

-- DropForeignKey
ALTER TABLE `aisearchusageevent` DROP FOREIGN KEY `AiSearchUsageEvent_shop_aisearchshop_fkey`;

-- DropForeignKey
ALTER TABLE `aisearchusageperiod` DROP FOREIGN KEY `AiSearchUsagePeriod_shop_aisearchshop_fkey`;

-- DropForeignKey
ALTER TABLE `aisearchusagereservation` DROP FOREIGN KEY `AiSearchUsageReservation_shop_aisearchshop_fkey`;

-- AlterTable
ALTER TABLE `aisearchindexedproduct` ADD COLUMN `blockedReason` VARCHAR(64) NULL,
    ADD COLUMN `searchable` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `vectorStatus` VARCHAR(32) NOT NULL DEFAULT 'MISSING';

-- AlterTable
ALTER TABLE `aisearchshop` ADD COLUMN `currentPlanHandle` VARCHAR(191) NULL,
    ADD COLUMN `currentSubscriptionGid` VARCHAR(191) NULL,
    ADD COLUMN `frozenAt` DATETIME(3) NULL,
    ADD COLUMN `installCount` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `pendingChangeAt` DATETIME(3) NULL,
    ADD COLUMN `pendingPlanHandle` VARCHAR(191) NULL,
    ADD COLUMN `pendingSubscriptionGid` VARCHAR(191) NULL,
    ADD COLUMN `reinstalledAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `aisearchshopsettings` ADD COLUMN `productPolicyVersion` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `plans` (
    `id` VARCHAR(191) NOT NULL,
    `handle` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `visibility` ENUM('PUBLIC', 'PRIVATE', 'INTERNAL') NOT NULL DEFAULT 'PUBLIC',
    `billingMode` ENUM('SHOPIFY_APP_PRICING', 'MANUAL_BILLING') NOT NULL DEFAULT 'SHOPIFY_APP_PRICING',
    `interval` ENUM('EVERY_30_DAYS', 'ANNUAL') NOT NULL DEFAULT 'EVERY_30_DAYS',
    `price` DECIMAL(10, 2) NOT NULL,
    `currencyCode` VARCHAR(10) NOT NULL DEFAULT 'USD',
    `trialDays` INTEGER NOT NULL DEFAULT 0,
    `maxIndexedProducts` INTEGER NULL,
    `maxMonthlySearches` INTEGER NULL,
    `maxMonthlyVectorUpdates` INTEGER NULL,
    `usageBillingEnabled` BOOLEAN NOT NULL DEFAULT false,
    `featureFlags` JSON NULL,
    `shopifyPlanHandle` VARCHAR(191) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `plans_handle_key`(`handle`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `plan_assignments` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `customPriceOverride` DECIMAL(10, 2) NULL,
    `notes` TEXT NULL,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `plan_assignments_shop_isActive_idx`(`shop`, `isActive`),
    UNIQUE INDEX `plan_assignments_shop_planId_key`(`shop`, `planId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_subscriptions` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NULL,
    `shopifySubscriptionGid` VARCHAR(191) NULL,
    `shopifyPlanHandle` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'FROZEN', 'CANCELLED', 'DECLINED', 'EXPIRED') NULL,
    `planNameSnapshot` VARCHAR(191) NULL,
    `priceSnapshot` DECIMAL(10, 2) NULL,
    `currencySnapshot` VARCHAR(10) NULL,
    `intervalSnapshot` ENUM('EVERY_30_DAYS', 'ANNUAL') NULL,
    `trialStartsAt` DATETIME(3) NULL,
    `trialEndsAt` DATETIME(3) NULL,
    `currentPeriodStartsAt` DATETIME(3) NULL,
    `currentPeriodEndsAt` DATETIME(3) NULL,
    `activatedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `frozenAt` DATETIME(3) NULL,
    `frozenReason` VARCHAR(255) NULL,
    `replacementBehavior` ENUM('STANDARD', 'APPLY_IMMEDIATELY', 'APPLY_ON_NEXT_BILLING_CYCLE') NULL,
    `isPendingSchedule` BOOLEAN NULL,
    `testMode` BOOLEAN NULL,
    `rawResponse` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `billing_subscriptions_shopifySubscriptionGid_key`(`shopifySubscriptionGid`),
    INDEX `billing_subscriptions_shop_status_idx`(`shop`, `status`),
    INDEX `billing_subscriptions_shop_createdAt_idx`(`shop`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_events` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `subscriptionGid` VARCHAR(191) NULL,
    `type` ENUM('SUBSCRIPTION_CREATED', 'SUBSCRIPTION_APPROVED', 'SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_FROZEN', 'SUBSCRIPTION_UNFROZEN', 'PLAN_UPGRADE', 'PLAN_DOWNGRADE', 'APP_UNINSTALLED', 'APP_REINSTALLED', 'BILLING_RECONCILED') NOT NULL,
    `source` ENUM('CALLBACK', 'WEBHOOK', 'API', 'RECONCILIATION') NOT NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `payload` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `billing_events_idempotencyKey_key`(`idempotencyKey`),
    INDEX `billing_events_shop_occurredAt_idx`(`shop`, `occurredAt`),
    INDEX `billing_events_subscriptionGid_idx`(`subscriptionGid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `usage_counters` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `searches` INTEGER NOT NULL DEFAULT 0,
    `vectorUpdates` INTEGER NOT NULL DEFAULT 0,
    `llmCalls` INTEGER NOT NULL DEFAULT 0,
    `embeddingCalls` INTEGER NOT NULL DEFAULT 0,
    `llmInputTokens` BIGINT NOT NULL DEFAULT 0,
    `llmOutputTokens` BIGINT NOT NULL DEFAULT 0,
    `embeddingInputTokens` BIGINT NOT NULL DEFAULT 0,
    `estimatedCostUsd` DECIMAL(14, 6) NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `usage_counters_shop_periodStart_key`(`shop`, `periodStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `catalog_states` (
    `shop` VARCHAR(191) NOT NULL,
    `shopifyProductCount` INTEGER NOT NULL DEFAULT 0,
    `eligibleProductCount` INTEGER NOT NULL DEFAULT 0,
    `indexedProductCount` INTEGER NOT NULL DEFAULT 0,
    `searchableProductCount` INTEGER NOT NULL DEFAULT 0,
    `lastFullSyncAt` DATETIME(3) NULL,
    `lastDeltaSyncAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`shop`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `AiSearchIndexedProduct_shop_isIndexed_idx` ON `AiSearchIndexedProduct`(`shop`, `isIndexed`);

-- CreateIndex
CREATE INDEX `AiSearchIndexedProduct_shop_isSearchable_idx` ON `AiSearchIndexedProduct`(`shop`, `isSearchable`);

-- CreateIndex
CREATE INDEX `AiSearchIndexedProduct_shop_hasVector_idx` ON `AiSearchIndexedProduct`(`shop`, `hasVector`);

-- CreateIndex
CREATE INDEX `AiSearchIndexedProduct_shop_searchable_idx` ON `AiSearchIndexedProduct`(`shop`, `searchable`);

-- CreateIndex
CREATE INDEX `AiSearchIndexedProduct_shop_vectorStatus_idx` ON `AiSearchIndexedProduct`(`shop`, `vectorStatus`);

-- AddForeignKey
ALTER TABLE `plan_assignments` ADD CONSTRAINT `plan_assignments_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `plan_assignments` ADD CONSTRAINT `plan_assignments_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `billing_subscriptions` ADD CONSTRAINT `billing_subscriptions_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `billing_subscriptions` ADD CONSTRAINT `billing_subscriptions_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `billing_events` ADD CONSTRAINT `billing_events_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `usage_counters` ADD CONSTRAINT `usage_counters_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `catalog_states` ADD CONSTRAINT `catalog_states_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchSubscription` ADD CONSTRAINT `AiSearchSubscription_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchShopSettings` ADD CONSTRAINT `AiSearchShopSettings_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchUsagePeriod` ADD CONSTRAINT `AiSearchUsagePeriod_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchUsageEvent` ADD CONSTRAINT `AiSearchUsageEvent_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchQueryLog` ADD CONSTRAINT `AiSearchQueryLog_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchUsageReservation` ADD CONSTRAINT `AiSearchUsageReservation_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchIndexedProduct` ADD CONSTRAINT `AiSearchIndexedProduct_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiSearchCatalogSyncJob` ADD CONSTRAINT `AiSearchCatalogSyncJob_shop_fkey` FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE;

