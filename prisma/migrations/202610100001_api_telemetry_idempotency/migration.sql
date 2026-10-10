ALTER TABLE `AiSearchApiUsageEvent`
  ADD COLUMN `idempotencyKey` VARCHAR(64) NULL,
  ADD COLUMN `costEstimateStatus` VARCHAR(32) NOT NULL DEFAULT 'LEGACY_ESTIMATE',
  ADD UNIQUE INDEX `AiSearchApiUsageEvent_idempotencyKey_key` (`idempotencyKey`);
ALTER TABLE `AiSearchApiUsageDaily` ADD COLUMN `unknownCostRequests` INT NOT NULL DEFAULT 0;
