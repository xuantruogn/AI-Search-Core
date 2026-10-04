ALTER TABLE `AiSearchIndexedProduct`
  DROP INDEX `AiSearchIndexedProduct_shop_hasVector_idx`,
  DROP INDEX `AiSearchIndexedProduct_shop_searchable_idx`,
  ADD INDEX `idx_indexed_product_active` (`shop`, `searchable`, `hasVector`, `productId`),
  ADD INDEX `idx_indexed_product_catalog_page` (`shop`, `hasVector`, `updatedAt`, `id`);
