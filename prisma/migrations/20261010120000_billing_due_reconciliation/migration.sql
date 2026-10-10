ALTER TABLE `billing_subscriptions`
  ADD COLUMN `nextReconciliationAt` DATETIME(3) NULL,
  ADD COLUMN `reconciliationAttempt` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `frozenFollowupUntil` DATETIME(3) NULL;

CREATE INDEX `billing_subscriptions_next_reconciliation_idx`
  ON `billing_subscriptions`(`nextReconciliationAt`, `status`);
