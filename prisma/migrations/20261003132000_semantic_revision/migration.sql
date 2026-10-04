ALTER TABLE `AiSearchShopSettings`
  ADD COLUMN `semanticRevision` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `semanticUpdatedAt` DATETIME(3) NULL;
