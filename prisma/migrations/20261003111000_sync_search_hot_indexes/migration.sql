ALTER TABLE `AiSearchSyncJob`
  ADD INDEX `idx_sync_job_status_updated` (`status`, `updatedAt`);

ALTER TABLE `AiSearchIndexedProduct`
  ADD INDEX `idx_enrich_due_global` (`enrichmentStatus`, `enrichmentRetryAt`, `id`),
  ADD INDEX `idx_enrich_version_global` (`enrichmentVersion`, `id`);
