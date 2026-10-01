-- Add isolated Dev Center authentication, MFA/session state, throttling and audit tables.
-- Additive only: no existing table/column is dropped or renamed.

CREATE TABLE `DevUser` (
  `id` VARCHAR(191) NOT NULL,
  `email` VARCHAR(320) NOT NULL,
  `passwordHash` VARCHAR(255) NOT NULL,
  `role` ENUM('OWNER', 'ADMIN', 'VIEWER') NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `totpSecretEncrypted` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `lastLoginAt` DATETIME(3) NULL,

  UNIQUE INDEX `DevUser_email_key`(`email`),
  INDEX `DevUser_role_isActive_idx`(`role`, `isActive`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DevSession` (
  `id` VARCHAR(191) NOT NULL,
  `tokenHash` CHAR(64) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NOT NULL,
  `absoluteExpiresAt` DATETIME(3) NOT NULL,
  `lastStrongAuthAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `revokedAt` DATETIME(3) NULL,
  `ipHash` CHAR(64) NULL,
  `userAgent` VARCHAR(512) NULL,

  UNIQUE INDEX `DevSession_tokenHash_key`(`tokenHash`),
  INDEX `DevSession_userId_revokedAt_idx`(`userId`, `revokedAt`),
  INDEX `DevSession_expiresAt_idx`(`expiresAt`),
  INDEX `DevSession_absoluteExpiresAt_idx`(`absoluteExpiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DevLoginChallenge` (
  `id` VARCHAR(191) NOT NULL,
  `tokenHash` CHAR(64) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expiresAt` DATETIME(3) NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `ipHash` CHAR(64) NULL,

  UNIQUE INDEX `DevLoginChallenge_tokenHash_key`(`tokenHash`),
  INDEX `DevLoginChallenge_userId_expiresAt_idx`(`userId`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DevAuthThrottle` (
  `bucketKey` CHAR(64) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `attemptCount` INTEGER NOT NULL DEFAULT 0,
  `windowStart` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `blockedUntil` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `DevAuthThrottle_kind_blockedUntil_idx`(`kind`, `blockedUntil`),
  PRIMARY KEY (`bucketKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DevAuditLog` (
  `id` VARCHAR(191) NOT NULL,
  `devUserId` VARCHAR(191) NULL,
  `action` VARCHAR(96) NOT NULL,
  `resourceType` VARCHAR(96) NULL,
  `resourceId` VARCHAR(191) NULL,
  `result` VARCHAR(32) NOT NULL,
  `requestId` VARCHAR(64) NULL,
  `ipHash` CHAR(64) NULL,
  `userAgent` VARCHAR(512) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `DevAuditLog_devUserId_createdAt_idx`(`devUserId`, `createdAt`),
  INDEX `DevAuditLog_action_createdAt_idx`(`action`, `createdAt`),
  INDEX `DevAuditLog_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DevSession`
  ADD CONSTRAINT `DevSession_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `DevUser`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `DevLoginChallenge`
  ADD CONSTRAINT `DevLoginChallenge_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `DevUser`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `DevAuditLog`
  ADD CONSTRAINT `DevAuditLog_devUserId_fkey`
  FOREIGN KEY (`devUserId`) REFERENCES `DevUser`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
