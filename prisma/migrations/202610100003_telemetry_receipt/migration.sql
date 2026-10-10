CREATE TABLE `AiSearchTelemetryReceipt` (
  `key` VARCHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`key`),
  INDEX `AiSearchTelemetryReceipt_expiresAt_idx` (`expiresAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
