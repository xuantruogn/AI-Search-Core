-- Billing State & Event Master Matrix
-- Extends Billing V2 without changing the canonical Shopify subscription status enum.

ALTER TABLE `billing_subscriptions`
  ADD COLUMN `shopifyCreatedAt` DATETIME(3) NULL,
  ADD COLUMN `shopifyUpdatedAt` DATETIME(3) NULL,
  ADD COLUMN `trialStatus` ENUM('NONE', 'ACTIVE', 'ENDED', 'CANCELLED') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `cancellationStatus` ENUM('NONE', 'REQUESTED', 'NON_RENEWING', 'EFFECTIVE') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `planChangeStatus` ENUM('NONE', 'PENDING', 'APPLIED', 'DECLINED', 'EXPIRED', 'DEFERRED') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `chargeStatus` ENUM('NONE', 'PENDING', 'PAID', 'FAILED') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `paymentStatus` ENUM('NONE', 'PENDING', 'PAID', 'FAILED', 'RECOVERED') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `refundStatus` ENUM('NONE', 'PARTIAL', 'FULL') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `accessStatus` ENUM('NONE', 'BASIC', 'PRO', 'CUSTOM', 'SUSPENDED') NOT NULL DEFAULT 'NONE',
  ADD COLUMN `reconciliationStatus` ENUM('SYNCED', 'MISMATCH', 'REPAIR_REQUIRED') NOT NULL DEFAULT 'SYNCED',
  ADD COLUMN `reconciliationCheckedAt` DATETIME(3) NULL,
  ADD COLUMN `reconciliationReason` VARCHAR(255) NULL,
  ADD COLUMN `repairRequiredAt` DATETIME(3) NULL;

ALTER TABLE `billing_events`
  MODIFY COLUMN `type` ENUM(
    'SUBSCRIPTION_CREATED',
    'SUBSCRIPTION_APPROVED',
    'SUBSCRIPTION_ACTIVATED',
    'SUBSCRIPTION_UPDATED',
    'SUBSCRIPTION_DECLINED',
    'SUBSCRIPTION_EXPIRED',
    'SUBSCRIPTION_CANCELLED',
    'SUBSCRIPTION_FROZEN',
    'SUBSCRIPTION_UNFROZEN',
    'TRIAL_STARTED',
    'TRIAL_EXTENDED',
    'TRIAL_ENDED',
    'TRIAL_CANCELLED',
    'CANCELLATION_REQUESTED',
    'CANCELLATION_EFFECTIVE',
    'PAYMENT_FAILED',
    'PAYMENT_RECOVERED',
    'PLAN_CHANGE_REQUESTED',
    'PLAN_CHANGE_APPLIED',
    'PLAN_CHANGE_DECLINED',
    'PLAN_CHANGE_EXPIRED',
    'PLAN_CHANGE_DEFERRED',
    'REFUND_REQUESTED',
    'REFUND_PARTIAL',
    'REFUND_FULL',
    'PLAN_UPGRADE',
    'PLAN_DOWNGRADE',
    'APP_UNINSTALLED',
    'APP_REINSTALLED',
    'BILLING_RECONCILED',
    'WEBHOOK_DUPLICATE',
    'WEBHOOK_OUT_OF_ORDER',
    'WEBHOOK_RETRY',
    'REDIRECT_BEFORE_WEBHOOK',
    'DB_SHOPIFY_MISMATCH',
    'MISSING_DB_RECORD',
    'MISSING_SHOPIFY_RECORD'
  ) NOT NULL;

CREATE TABLE `billing_charges` (
  `id` VARCHAR(191) NOT NULL,
  `shop` VARCHAR(191) NOT NULL,
  `subscriptionGid` VARCHAR(191) NULL,
  `shopifyChargeId` VARCHAR(191) NULL,
  `status` ENUM('NONE', 'PENDING', 'PAID', 'FAILED') NOT NULL DEFAULT 'NONE',
  `amount` DECIMAL(10, 2) NULL,
  `currency` VARCHAR(10) NULL,
  `billingPeriodStart` DATETIME(3) NULL,
  `billingPeriodEnd` DATETIME(3) NULL,
  `acceptedAt` DATETIME(3) NULL,
  `activatedAt` DATETIME(3) NULL,
  `paidAt` DATETIME(3) NULL,
  `failedAt` DATETIME(3) NULL,
  `cancelledAt` DATETIME(3) NULL,
  `expiredAt` DATETIME(3) NULL,
  `frozenAt` DATETIME(3) NULL,
  `unfrozenAt` DATETIME(3) NULL,
  `testMode` BOOLEAN NULL,
  `rawResponse` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `billing_charges_shopifyChargeId_key`(`shopifyChargeId`),
  UNIQUE INDEX `billing_charges_subscription_period_key`(`subscriptionGid`, `billingPeriodStart`),
  INDEX `billing_charges_shop_status_createdAt_idx`(`shop`, `status`, `createdAt`),
  INDEX `billing_charges_subscriptionGid_idx`(`subscriptionGid`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `billing_refunds` (
  `id` VARCHAR(191) NOT NULL,
  `shop` VARCHAR(191) NOT NULL,
  `chargeId` VARCHAR(191) NOT NULL,
  `status` ENUM('NONE', 'PARTIAL', 'FULL') NOT NULL DEFAULT 'NONE',
  `amount` DECIMAL(10, 2) NULL,
  `currency` VARCHAR(10) NULL,
  `requestedAt` DATETIME(3) NULL,
  `refundedAt` DATETIME(3) NULL,
  `rawResponse` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `billing_refunds_shop_status_createdAt_idx`(`shop`, `status`, `createdAt`),
  INDEX `billing_refunds_chargeId_idx`(`chargeId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `billing_charges`
  ADD CONSTRAINT `billing_charges_shop_fkey`
    FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `billing_charges_subscriptionGid_fkey`
    FOREIGN KEY (`subscriptionGid`) REFERENCES `billing_subscriptions`(`shopifySubscriptionGid`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `billing_refunds`
  ADD CONSTRAINT `billing_refunds_shop_fkey`
    FOREIGN KEY (`shop`) REFERENCES `AiSearchShop`(`shop`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `billing_refunds_chargeId_fkey`
    FOREIGN KEY (`chargeId`) REFERENCES `billing_charges`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;