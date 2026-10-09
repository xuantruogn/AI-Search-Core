ALTER TABLE `AiSearchShopSettings` ADD COLUMN `pendingCatalogLanguage` VARCHAR(32) NULL;
ALTER TABLE `AiSearchIndexedProduct` ADD COLUMN `catalogLanguage` VARCHAR(32) NULL;
ALTER TABLE `AiSearchCatalogSyncJob` ADD COLUMN `languageAtStart` VARCHAR(32) NULL;
