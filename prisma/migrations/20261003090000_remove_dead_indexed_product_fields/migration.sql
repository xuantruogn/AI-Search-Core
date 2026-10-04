-- Remove unused Billing V2 compatibility fields from the hot product registry.
-- Runtime eligibility is defined by hasVector/vectorStatus/searchable and the
-- canonical document/enrichment fields above.
ALTER TABLE `AiSearchIndexedProduct`
  DROP INDEX `AiSearchIndexedProduct_shop_isIndexed_idx`,
  DROP INDEX `AiSearchIndexedProduct_shop_isSearchable_idx`,
  DROP COLUMN `isIndexed`,
  DROP COLUMN `isSearchable`,
  DROP COLUMN `excludedReason`,
  DROP COLUMN `embeddingModel`,
  DROP COLUMN `embeddingVersion`,
  DROP COLUMN `contentHash`,
  DROP COLUMN `lastEmbeddedAt`,
  DROP COLUMN `lastSyncedAt`;
