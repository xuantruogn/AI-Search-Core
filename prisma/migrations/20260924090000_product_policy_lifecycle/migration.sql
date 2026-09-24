ALTER TABLE `AiSearchShopSettings` ADD COLUMN `productPolicyVersion` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `AiSearchSyncJob` ADD COLUMN `policyVersion` INTEGER NULL;
ALTER TABLE `AiSearchIndexedProduct`
  ADD COLUMN `vectorStatus` VARCHAR(32) NOT NULL DEFAULT 'MISSING',
  ADD COLUMN `searchable` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `blockedReason` VARCHAR(64) NULL;
UPDATE `AiSearchIndexedProduct`
SET `vectorStatus` = CASE WHEN `hasVector` = true THEN 'READY' ELSE 'MISSING' END,
    `searchable` = CASE WHEN `status` = 'INDEXED' AND `hasVector` = true THEN true ELSE false END,
    `blockedReason` = CASE WHEN `status` = 'PRODUCT_LIMIT_BLOCKED' THEN 'PRODUCT_LIMIT'
      WHEN `status` = 'SUBSCRIPTION_BLOCKED' THEN 'SUBSCRIPTION'
      WHEN `status` = 'VECTOR_QUOTA_BLOCKED' THEN 'VECTOR_UPDATE_LIMIT' ELSE NULL END;
CREATE INDEX `AiSearchIndexedProduct_shop_searchable_idx` ON `AiSearchIndexedProduct`(`shop`, `searchable`);
CREATE INDEX `AiSearchIndexedProduct_shop_vectorStatus_idx` ON `AiSearchIndexedProduct`(`shop`, `vectorStatus`);
