ALTER TABLE `plan_assignments`
  ADD COLUMN `customName` VARCHAR(191) NULL,
  ADD COLUMN `customCurrencyCode` VARCHAR(10) NULL,
  ADD COLUMN `customInterval` ENUM('EVERY_30_DAYS', 'ANNUAL') NULL,
  ADD COLUMN `customTrialDays` INTEGER NULL,
  ADD COLUMN `customUsageBillingEnabled` BOOLEAN NULL,
  ADD COLUMN `customFeatureFlags` JSON NULL,
  ADD COLUMN `updatedAt` DATETIME(3) NULL;

UPDATE `plan_assignments`
SET `updatedAt` = `createdAt`
WHERE `updatedAt` IS NULL;

ALTER TABLE `plan_assignments`
  MODIFY `updatedAt` DATETIME(3) NOT NULL;
