ALTER TABLE `AiSearchShopSettings`
  ADD COLUMN `catalogRevision` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `catalogUpdatedAt` DATETIME(3) NULL;
