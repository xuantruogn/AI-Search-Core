-- Normalize data ownership and add indexes used by retention/cleanup jobs.
-- Transport search keys are fully derived from the semantic profile and must
-- not be persisted as a second copy of product catalog data.
DROP TABLE IF EXISTS `AiSearchRenderTransportProfile`;
DROP TABLE IF EXISTS `AiSearchRenderTransportKey`;

-- Keep request-level provider telemetry only for a short diagnostic window.
-- Long-term usage/cost reporting reads this daily aggregate table.
CREATE TABLE IF NOT EXISTS `AiSearchApiUsageDaily` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `day` DATE NOT NULL,
  `shop` VARCHAR(191) NOT NULL,
  `provider` VARCHAR(64) NOT NULL,
  `operation` VARCHAR(64) NOT NULL,
  `model` VARCHAR(191) NOT NULL,
  `requestCount` INTEGER NOT NULL DEFAULT 0,
  `inputTokens` BIGINT NOT NULL DEFAULT 0,
  `cachedInputTokens` BIGINT NOT NULL DEFAULT 0,
  `outputTokens` BIGINT NOT NULL DEFAULT 0,
  `totalTokens` BIGINT NOT NULL DEFAULT 0,
  `estimatedCostMicros` BIGINT NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_api_usage_daily` (`day`, `shop`, `provider`, `operation`, `model`),
  INDEX `idx_api_usage_daily_shop_day` (`shop`, `day`),
  INDEX `idx_api_usage_daily_provider_day` (`provider`, `day`),
  INDEX `idx_api_usage_daily_day` (`day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AiSearchProductSemanticProfile`
  MODIFY `schemaVersion` INTEGER NOT NULL DEFAULT 2,
  ADD INDEX `idx_semantic_profile_version_id` (`schemaVersion`, `id`);

ALTER TABLE `AiSearchUsageEvent`
  ADD INDEX `idx_usage_event_created_at` (`createdAt`);

ALTER TABLE `AiSearchQueryLog`
  ADD INDEX `idx_query_log_created_at` (`createdAt`);

ALTER TABLE `AiSearchApiUsageEvent`
  ADD INDEX `idx_api_usage_created_at` (`createdAt`);

ALTER TABLE `AiSearchSyncJob`
  ADD INDEX `idx_sync_job_status_processed` (`status`, `processedAt`);

ALTER TABLE `AiSearchCatalogSyncJob`
  ADD INDEX `idx_catalog_job_status_processed` (`status`, `processedAt`);

ALTER TABLE `DevLoginChallenge`
  ADD INDEX `idx_dev_login_challenge_expires` (`expiresAt`);

ALTER TABLE `DevAuthThrottle`
  ADD INDEX `idx_dev_auth_throttle_updated` (`updatedAt`);
