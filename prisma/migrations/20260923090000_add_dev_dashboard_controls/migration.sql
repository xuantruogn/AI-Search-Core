CREATE TABLE `AiSearchQuotaGrant` (
  `id` VARCHAR(191) NOT NULL,
  `shop` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(64) NOT NULL,
  `amount` INTEGER NOT NULL,
  `reason` TEXT NULL,
  `startsAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `createdBy` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `AiSearchQuotaGrant_shop_kind_startsAt_expiresAt_idx`
    (`shop`, `kind`, `startsAt`, `expiresAt`),
  INDEX `AiSearchQuotaGrant_shop_revokedAt_createdAt_idx`
    (`shop`, `revokedAt`, `createdAt`),
  CONSTRAINT `AiSearchQuotaGrant_shop_fkey`
    FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiSearchAdminAuditLog` (
  `id` VARCHAR(191) NOT NULL,
  `actorShop` VARCHAR(191) NOT NULL,
  `targetShop` VARCHAR(191) NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `reason` TEXT NULL,
  `beforeJson` LONGTEXT NULL,
  `afterJson` LONGTEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `AiSearchAdminAuditLog_targetShop_createdAt_idx`
    (`targetShop`, `createdAt`),
  INDEX `AiSearchAdminAuditLog_actorShop_createdAt_idx`
    (`actorShop`, `createdAt`),
  CONSTRAINT `AiSearchAdminAuditLog_targetShop_fkey`
    FOREIGN KEY (`targetShop`) REFERENCES `AiSearchShop`(`shop`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiSearchApiUsageEvent` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `shop` VARCHAR(191) NULL,
  `provider` VARCHAR(64) NOT NULL DEFAULT 'OPENAI',
  `operation` VARCHAR(64) NOT NULL,
  `model` VARCHAR(191) NOT NULL,
  `requestId` VARCHAR(191) NULL,
  `inputTokens` INTEGER NOT NULL DEFAULT 0,
  `cachedInputTokens` INTEGER NOT NULL DEFAULT 0,
  `outputTokens` INTEGER NOT NULL DEFAULT 0,
  `totalTokens` INTEGER NOT NULL DEFAULT 0,
  `estimatedCostMicros` INTEGER NOT NULL DEFAULT 0,
  `remainingRequests` INTEGER NULL,
  `remainingTokens` INTEGER NULL,
  `resetRequests` VARCHAR(64) NULL,
  `resetTokens` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `AiSearchApiUsageEvent_shop_createdAt_idx` (`shop`, `createdAt`),
  INDEX `AiSearchApiUsageEvent_provider_createdAt_idx` (`provider`, `createdAt`),
  INDEX `AiSearchApiUsageEvent_model_createdAt_idx` (`model`, `createdAt`),
  CONSTRAINT `AiSearchApiUsageEvent_shop_fkey`
    FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
