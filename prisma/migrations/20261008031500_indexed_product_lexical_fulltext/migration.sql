-- Indexed lexical recall for exact title and handle tokens.
-- Replaces unindexed LOWER(title/handle) LIKE '%token%' storefront scans.
ALTER TABLE `AiSearchIndexedProduct`
  ADD FULLTEXT INDEX `idx_indexed_product_lexical_ft` (`title`, `handle`);
