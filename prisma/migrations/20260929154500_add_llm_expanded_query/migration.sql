ALTER TABLE `AiSearchQueryLog`
ADD COLUMN `llmExpandedQuery` TEXT NULL AFTER `analyzedQuery`;
