ALTER TABLE `AiSearchQuotaGrant`
  ADD COLUMN `productPolicyReconciledAt` DATETIME(3) NULL,
  ADD COLUMN `productExpiryReconciledAt` DATETIME(3) NULL;

CREATE INDEX `idx_product_grant_reconcile` ON `AiSearchQuotaGrant`(`kind`, `expiresAt`, `productExpiryReconciledAt`);
