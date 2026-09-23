ALTER TABLE `AiSearchIndexedProduct`
  ADD COLUMN `sourceDocumentHash` VARCHAR(64) NULL,
  ADD COLUMN `embeddingPipelineVersion` VARCHAR(64) NULL,
  ADD COLUMN `enrichmentVersion` VARCHAR(64) NULL,
  ADD COLUMN `enrichmentStatus` VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `enrichmentLastError` TEXT NULL,
  ADD COLUMN `enrichmentRetryAt` DATETIME(3) NULL,
  ADD COLUMN `enrichmentUpdatedAt` DATETIME(3) NULL;

UPDATE `AiSearchIndexedProduct`
SET `sourceDocumentHash` = `documentHash`
WHERE `sourceDocumentHash` IS NULL;

CREATE INDEX `idx_enrich_retry`
  ON `AiSearchIndexedProduct`(
    `shop`,
    `enrichmentStatus`,
    `enrichmentRetryAt`
  );